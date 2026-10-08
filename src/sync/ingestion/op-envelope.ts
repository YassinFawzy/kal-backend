/**
 * Kal — sync batch envelope parsing and shape validation (wave-03 contract
 * §1.1/§1.2).
 *
 * Batch shape validation is DATABASE-FREE and runs FIRST: a violation
 * (missing/malformed `Idempotency-Key`, `deviceId` length, op count over
 * `sync.maxOpsPerBatch`, envelope field parity, unknown `kind`/`action`)
 * rejects the WHOLE batch with `400 VALIDATION_FAILED` — zero ops applied,
 * nothing recorded. Shape errors never echo received values (I12): the
 * errors array carries structural field paths and generic messages only
 * (the shared allowlist projection in `src/problems/redact.ts` is the
 * defense in depth).
 *
 * Two frozen layers, deliberately distinct (contract §1.2 vs §4):
 *  - LAYER 1 (here): the `kind`/`action` STRING must be a member of the
 *    frozen W3 registry enums — anything else is a batch-shape error and
 *    rejects the whole batch before the database is touched (§1.2).
 *  - LAYER 2 (the registry, ingestion service): an enum-valid kind whose
 *    handler is not REGISTERED dispatch-fails as a per-op `rejected`
 *    (validation class) — registry dispatch only; never a crash, never an
 *    improvised direct write (§4). In the assembled system tracking
 *    registers all three kinds at module init, so layer 2's miss case is a
 *    defensive seam, not a client-visible shape.
 *
 * Primitives pinned here (all `§1.1`):
 *  - `opId`/`entityId`: UUIDs (the ledger columns are UUID — a non-UUID is a
 *    shape error, deterministically before any dedupe).
 *  - `clientUpdatedAt`: ISO 8601 UTC instant (`Z`/`±00:00` offset, calendar-
 *    valid); the exact client string is preserved on the envelope for
 *    handler-side LWW comparators (timestamptz(6) holds microseconds; JS
 *    Dates do not).
 *  - `localDate`: calendar-valid `YYYY-MM-DD`, REQUIRED on `diary_entry`
 *    ops, ABSENT on all others. Shape only — the server NEVER re-derives a
 *    diary day from receive/sync time (§1.8 day-boundary freeze).
 *  - `payload`: full entity snapshot object for create/update (same shape
 *    both — no patch semantics); ABSENT for delete.
 *  - `deviceId`: 1–128 chars — ordering metadata, never a credential.
 */
import { isUuid } from '../../request-context/user-context.js';
import type {
  SyncEntityAction,
  SyncEntityKind,
  SyncOpEnvelope,
} from './sync-seams.js';

const ENTITY_KINDS: readonly SyncEntityKind[] = ['diary_entry', 'user_food', 'favorite'];
const ENTITY_ACTIONS: readonly SyncEntityAction[] = ['create', 'update', 'delete'];

const LOCAL_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
/**
 * ISO 8601 UTC instant: calendar date, `T` separator, `:`-separated time,
 * optional fraction (up to 6 digits — the timestamptz(6) precision), UTC
 * designator `Z` (or a zero offset). A non-UTC offset is a DIFFERENT
 * contract (conventions §0: timestamps are UTC instants) — shape error.
 */
const UTC_INSTANT_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-]00:00)$/u;

/** Generic constraint messages — no received values, no per-case detail (I12/I7). */
const MESSAGES = {
  invalidFormat: 'Invalid format.',
  invalidLength: 'Invalid length.',
  unexpectedField: 'Unexpected field.',
  exceedsMax: 'Exceeds the maximum.',
} as const;

/** Structural validation error ({field, message} — the shared house shape). */
export interface SyncFieldError {
  readonly field: string;
  readonly message: string;
}

export interface ParsedBatch {
  readonly deviceId: string;
  readonly ops: readonly SyncOpEnvelope[];
}

export type BatchParseOutcome =
  | { readonly ok: true; readonly value: ParsedBatch }
  | { readonly ok: false; readonly errors: readonly SyncFieldError[] };

/**
 * Validates the `Idempotency-Key` header (conventions §3: client-generated
 * UUID, REQUIRED on sync ingestion). Returns the trimmed key or null.
 */
export function validateIdempotencyKey(headerValue: unknown): string | null {
  if (typeof headerValue !== 'string') {
    return null;
  }
  const key = headerValue.trim();
  if (!isUuid(key)) {
    return null;
  }
  return key;
}

/** Parses and shape-validates a `POST /sync/ops` batch body (§1.2). */
export function parseBatchBody(body: unknown, maxOpsPerBatch: number): BatchParseOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: MESSAGES.invalidFormat }] };
  }
  const record = body as Record<string, unknown>;
  const errors: SyncFieldError[] = [];

  for (const key of Object.keys(record)) {
    if (key !== 'deviceId' && key !== 'ops') {
      errors.push({ field: 'body', message: MESSAGES.unexpectedField });
      break;
    }
  }

  const rawDeviceId = record['deviceId'];
  const deviceId =
    typeof rawDeviceId === 'string' && rawDeviceId.length >= 1 && rawDeviceId.length <= 128
      ? rawDeviceId
      : null;
  if (deviceId === null) {
    errors.push({ field: 'deviceId', message: MESSAGES.invalidLength });
  }

  const rawOps = record['ops'];
  if (!Array.isArray(rawOps)) {
    errors.push({ field: 'ops', message: MESSAGES.invalidFormat });
    return finish(errors, deviceId);
  }
  if (rawOps.length > maxOpsPerBatch) {
    // Batch cap (config) — whole-batch 400, nothing recorded (§1.2).
    errors.push({ field: 'ops', message: MESSAGES.exceedsMax });
    return finish(errors, deviceId);
  }

  const ops: SyncOpEnvelope[] = [];
  for (let index = 0; index < rawOps.length; index += 1) {
    const parsed = parseOp(rawOps[index]);
    if (typeof parsed === 'string') {
      errors.push({ field: `ops[${String(index)}].${parsed}`, message: MESSAGES.invalidFormat });
    } else {
      ops.push(parsed);
    }
  }
  return finish(errors, deviceId, ops);
}

function finish(
  errors: SyncFieldError[],
  deviceId: string | null,
  ops: SyncOpEnvelope[] = [],
): BatchParseOutcome {
  if (errors.length > 0 || deviceId === null) {
    return { ok: false, errors };
  }
  return { ok: true, value: { deviceId, ops } };
}

function parseOp(value: unknown): SyncOpEnvelope | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const record = value as Record<string, unknown>;

  const opId = record['opId'];
  if (typeof opId !== 'string' || !isUuid(opId)) {
    return 'opId';
  }
  const rawKind = record['kind'];
  if (typeof rawKind !== 'string' || !ENTITY_KINDS.includes(rawKind as SyncEntityKind)) {
    return 'kind';
  }
  const kind = rawKind as SyncEntityKind;
  const entityId = record['entityId'];
  if (typeof entityId !== 'string' || !isUuid(entityId)) {
    return 'entityId';
  }
  const rawAction = record['action'];
  if (typeof rawAction !== 'string' || !ENTITY_ACTIONS.includes(rawAction as SyncEntityAction)) {
    return 'action';
  }
  const action = rawAction as SyncEntityAction;
  const clientUpdatedAtIso = record['clientUpdatedAt'];
  if (
    typeof clientUpdatedAtIso !== 'string' ||
    !UTC_INSTANT_PATTERN.test(clientUpdatedAtIso) ||
    !isCalendarValidInstant(clientUpdatedAtIso)
  ) {
    return 'clientUpdatedAt';
  }

  // Field parity (§1.1): localDate REQUIRED on diary_entry ops, ABSENT on
  // all others; payload REQUIRED on create/update, ABSENT on delete.
  const rawLocalDate = record['localDate'];
  let localDate: string | null = null;
  if (rawLocalDate !== undefined && rawLocalDate !== null) {
    if (
      kind !== 'diary_entry' ||
      typeof rawLocalDate !== 'string' ||
      !LOCAL_DATE_PATTERN.test(rawLocalDate) ||
      !isCalendarValidLocalDate(rawLocalDate)
    ) {
      return 'localDate';
    }
    localDate = rawLocalDate;
  } else if (kind === 'diary_entry') {
    return 'localDate';
  }

  const rawPayload = record['payload'];
  let payload: Readonly<Record<string, unknown>> | null = null;
  if (rawPayload !== undefined && rawPayload !== null) {
    if (action === 'delete' || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return 'payload';
    }
    payload = rawPayload as Readonly<Record<string, unknown>>;
  } else if (action !== 'delete') {
    return 'payload';
  }

  // Canonical diary-op shape (supervisor-routed s2c freeze): localDate rides
  // BOTH the envelope AND the payload, with PARITY — a payload localDate
  // that disagrees with the envelope field is an envelope/payload parity
  // violation (the §1.2 whole-batch class). Payload-localDate ABSENCE is the
  // handler domain's business (the real diary handler validates its frozen
  // payload shape at dispatch).
  if (kind === 'diary_entry' && payload !== null && payload['localDate'] !== undefined) {
    if (payload['localDate'] !== localDate) {
      return 'localDate';
    }
  }

  return {
    opId,
    kind,
    entityId,
    action,
    clientUpdatedAt: new Date(clientUpdatedAtIso),
    clientUpdatedAtIso,
    localDate,
    payload,
  };
}

/** Calendar validity for the date part of an instant (shape-only, §1.1). */
function isCalendarValidInstant(iso: string): boolean {
  const datePart = iso.slice(0, 10);
  return isCalendarValidLocalDate(datePart);
}

function isCalendarValidLocalDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}
