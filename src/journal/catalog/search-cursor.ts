/**
 * Kal — exercise-search pagination cursor codec (conventions §2; w4 contract
 * note §2 — the `journal.exercises.search` cursor).
 *
 * Opaque, HMAC-SHA256-tagged, USER-BOUND tokens — the tracking foods
 * `search-cursor.ts` mechanics mirrored for the journal module's own
 * domain-separated key (`kal:journal:search-cursor:v1`, derived in
 * `src/config/journal.config.ts`; tracking and journal keys are distinct
 * derivations of the same validated secret — a tracking cursor can never be
 * replayed as a journal cursor or vice versa, and neither ever sees the raw
 * secret). The tag covers the payload AND the authenticated user id, so a
 * cursor presented under a different authenticated context, or
 * tampered/truncated in any way, fails verification with ONE generic
 * `400 VALIDATION_FAILED` body — byte-identically for every cause; a foreign
 * cursor never yields rows (I7).
 *
 * Cursor state is the position in the deterministic result order:
 * `(rank, id)` ascending — exact-normalized-equality first, then prefix, then
 * substring, tiebreak by id (w3 §7 matching model REUSED). Cursor state
 * carries no user data beyond the embedded binding itself.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The journal cursor's domain label (mirrors tracking's, distinct value). */
export const JOURNAL_SEARCH_CURSOR_DOMAIN = 'kal:journal:search-cursor:v1';

export interface ExerciseSearchCursorState {
  /** Result rank tier: 0 exact · 1 prefix · 2 substring (w3 §7 model). */
  readonly rank: number;
  /** The last emitted exercise id (strictly-after tiebreak). */
  readonly id: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function tag(payload: string, userId: string, cursorKey: Buffer): string {
  return base64Url(createHmac('sha256', cursorKey).update(`${userId}|${payload}`).digest());
}

/** Mints an opaque, user-bound cursor token for the given state. */
export function encodeExerciseSearchCursor(
  state: ExerciseSearchCursorState,
  userId: string,
  cursorKey: Buffer,
): string {
  // The payload EMBEDS the user binding (`u`) — the tracking Amendment-3
  // format — so a tag-valid token presented under a foreign account is a
  // server-known cross-tenant fact (I14 audit emit; the response itself is
  // unchanged).
  const payload = base64Url(Buffer.from(JSON.stringify({ ...state, u: userId }), 'utf8'));
  return `${payload}.${tag(payload, userId, cursorKey)}`;
}

/**
 * Verifies and decodes a cursor for the authenticated user. Returns `null`
 * for EVERY failure cause (malformed, truncated, foreign user, bad tag) —
 * callers map `null` to the one generic 400 (I7; the cause is never
 * observable).
 */
export function decodeExerciseSearchCursor(
  token: string,
  userId: string,
  cursorKey: Buffer,
): ExerciseSearchCursorState | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts as [string, string];
  const expected = tag(payload, userId, cursorKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const rank = candidate['rank'];
  const id = candidate['id'];
  if (
    (rank !== 0 && rank !== 1 && rank !== 2) ||
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id) ||
    candidate['u'] !== userId
  ) {
    return null;
  }
  return { rank, id };
}

/**
 * I14 audit side-channel: returns the EMBEDDED user binding of a
 * GENUINELY-MINTED token (tag valid FOR THAT BINDING) — null for garbage,
 * tampered, or shape-invalid tokens. The caller uses this only to record the
 * cross-tenant signal when the binding ≠ the authenticated caller; it never
 * changes any response byte (I7).
 */
export function inspectExerciseSearchCursor(token: string, cursorKey: Buffer): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts as [string, string];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const embedded = (parsed as Record<string, unknown>)['u'];
  if (typeof embedded !== 'string') {
    return null;
  }
  const expected = Buffer.from(tag(payload, embedded, cursorKey));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return null;
  }
  return embedded;
}
