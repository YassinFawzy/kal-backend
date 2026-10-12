/**
 * Kal — the frozen `journal_routine` snapshot (wave-04 contract §1.1).
 *
 * The op `payload` is the FULL entity snapshot (same shape for create and
 * update — no patch semantics): `{ name, exercises[] }`. A routine template
 * carries NO day (the `journal_routine` kind is localDate-FORBIDDEN — the
 * envelope layer and the `sync_operations_local_date_parity` CHECK both
 * enforce it; this parser re-checks defensively). Routines may carry all
 * three set formats (planned sets and WOD-style template notes).
 *
 * EXACT BOUNDS (every violation ⇒ per-op `rejected_validation`, retryable
 * false — the contract's validation list, mirrored by the migration's
 * CHECKs; the database is the last line, not the only one):
 *   - name: REQUIRED, 1..120 chars
 *   - exercises: REQUIRED, 1..20 entries, ordered by the carried `position`
 *   - exerciseId: a UUID referencing an existing catalog row (referential
 *     check runs at apply time, database-backed — the parser is pure)
 *   - position: integer ≥ 0 (bounded by the INTEGER column — a value the
 *     column cannot store must be a per-op validation outcome, never a raw
 *     database abort of the whole batch)
 *   - sets per entry: 0..50, the discriminated XOR —
 *       weighted: weightKg (0 < w ≤ 1000) + reps (integer 1..1000)
 *       timed:    durationSeconds (integer 1..86400)
 *       notes:    text (1..500 chars)
 *     a field present that its format forbids, an unknown `format`, or a
 *     missing field its format requires ⇒ rejected (malformed format mixes)
 *
 * NAME SNAPSHOTS are SERVER-DERIVED at apply time (§1.1): the payload
 * carries only `exerciseId`; the handler freezes the catalog row's current
 * `nameEn`/`nameAr` into the entry's snapshot columns. An edit op that
 * applies later re-freezes at THAT apply — an edit is a new log event.
 * Clients never author display data (I11-analog).
 *
 * This module is the single transcription of the payload shape: validation
 * (pure), and the stored-tree → projection mapping the delta feed and the
 * routine read service serve (full-snapshot upserts; the projection carries
 * the server child ids and the frozen name snapshots — the §2 session
 * projection's shape, mirrored for templates).
 */
import type { Prisma } from '../../../generated/prisma/client.ts';

export type JournalSetFormat = 'weighted' | 'timed' | 'notes';

export const SET_FORMATS: readonly JournalSetFormat[] = ['weighted', 'timed', 'notes'];

export interface RoutineSetSnapshot {
  readonly format: JournalSetFormat;
  readonly weightKg?: number;
  readonly reps?: number;
  readonly durationSeconds?: number;
  readonly text?: string;
}

export interface RoutineExerciseSnapshot {
  readonly exerciseId: string;
  readonly position: number;
  readonly sets: readonly RoutineSetSnapshot[];
}

export interface RoutineSnapshot {
  readonly name: string;
  readonly exercises: readonly RoutineExerciseSnapshot[];
}

export type SnapshotParseResult =
  | { readonly ok: true; readonly snapshot: RoutineSnapshot; readonly clientUpdatedAt: Date }
  | { readonly ok: false };

/** Exact contract bounds (§1.1). */
export const ROUTINE_NAME_MAX = 120;
export const ROUTINE_EXERCISES_MAX = 20;
export const ROUTINE_SETS_MAX = 50;
export const SET_WEIGHT_KG_MAX = 1000;
export const SET_REPS_MAX = 1000;
export const SET_DURATION_SECONDS_MAX = 86_400;
export const SET_TEXT_MAX = 500;
/** The INTEGER columns' bound — a larger position would abort the batch with a raw 22003. */
const POSITION_MAX = 2_147_483_647;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Strict ISO 8601 UTC-instant parsing (conventions §0). Returns null for
 * anything that is not a `Z`-suffixed instant (the schema pins
 * `client_updated_at` as client-authored UTC).
 */
export function parseUtcInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Guard against permissively-parsed oddities: re-serialize and compare
  // shape-independently by instant round-trip.
  const trimmed = value.replace(/(\.\d{3})\d+Z$/u, '$1Z');
  return parsed.toISOString() === new Date(trimmed).toISOString() ? parsed : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Integer within [min, max] (narrowing — positions/counts/reps are INTEGER columns). */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/**
 * Validates one set against the discriminated format XOR (pure). Every
 * failure is a parse rejection — the caller maps it to the per-op
 * `rejected_validation` outcome, never an exception.
 */
function parseSet(raw: unknown): RoutineSetSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const rawFormat = body['format'];
  if (typeof rawFormat !== 'string' || !SET_FORMATS.includes(rawFormat as JournalSetFormat)) {
    return null;
  }
  const format: JournalSetFormat = rawFormat as JournalSetFormat;
  if (format === 'weighted') {
    if (body['durationSeconds'] !== undefined || body['text'] !== undefined) {
      return null; // a field its format forbids
    }
    const weightKg = body['weightKg'];
    const reps = body['reps'];
    if (!isFiniteNumber(weightKg) || weightKg <= 0 || weightKg > SET_WEIGHT_KG_MAX) {
      return null;
    }
    if (!isIntInRange(reps, 1, SET_REPS_MAX)) {
      return null;
    }
    return { format, weightKg, reps };
  }
  if (format === 'timed') {
    if (body['weightKg'] !== undefined || body['reps'] !== undefined || body['text'] !== undefined) {
      return null;
    }
    if (!isIntInRange(body['durationSeconds'], 1, SET_DURATION_SECONDS_MAX)) {
      return null;
    }
    return { format, durationSeconds: body['durationSeconds'] };
  }
  // notes
  if (body['weightKg'] !== undefined || body['reps'] !== undefined || body['durationSeconds'] !== undefined) {
    return null;
  }
  const text = body['text'];
  if (typeof text !== 'string' || text.length < 1 || text.length > SET_TEXT_MAX) {
    return null;
  }
  return { format, text };
}

function parseExerciseEntry(raw: unknown): RoutineExerciseSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const body = raw as Record<string, unknown>;
  const exerciseId = body['exerciseId'];
  if (!isUuid(exerciseId)) {
    return null;
  }
  const position = body['position'];
  if (!isIntInRange(position, 0, POSITION_MAX)) {
    return null;
  }
  const rawSets = body['sets'];
  if (!Array.isArray(rawSets) || rawSets.length > ROUTINE_SETS_MAX) {
    return null;
  }
  const sets: RoutineSetSnapshot[] = [];
  for (const rawSet of rawSets) {
    const parsed = parseSet(rawSet);
    if (parsed === null) {
      return null;
    }
    sets.push(parsed);
  }
  return { exerciseId, position, sets };
}

/**
 * Validates one `journal_routine` op envelope + payload into the frozen
 * snapshot. Pure: no database, no clock — every failure is the per-op
 * `rejected_validation` outcome (contract §1.3), never an exception.
 */
export function parseRoutineSnapshot(op: {
  readonly opId: unknown;
  readonly entityId: unknown;
  readonly action: unknown;
  readonly clientUpdatedAt: unknown;
  readonly localDate?: unknown;
  readonly payload?: unknown;
}): SnapshotParseResult {
  if (!isUuid(op.opId) || !isUuid(op.entityId)) {
    return { ok: false };
  }
  if (op.action !== 'create' && op.action !== 'update') {
    return { ok: false }; // delete ops never reach here (no snapshot to parse)
  }
  const clientUpdatedAt = parseUtcInstant(op.clientUpdatedAt);
  if (clientUpdatedAt === null) {
    return { ok: false };
  }
  // The local-date parity rule: a routine template has NO day. The envelope
  // layer and the ledger CHECK enforce this; re-checked here defensively —
  // a carried date on a routine op is a shape error, never silently ignored.
  if (op.localDate !== undefined && op.localDate !== null) {
    return { ok: false };
  }
  if (typeof op.payload !== 'object' || op.payload === null || Array.isArray(op.payload)) {
    return { ok: false };
  }
  const body = op.payload as Record<string, unknown>;

  const name = body['name'];
  if (typeof name !== 'string' || name.length < 1 || name.length > ROUTINE_NAME_MAX) {
    return { ok: false };
  }
  const rawExercises = body['exercises'];
  if (!Array.isArray(rawExercises) || rawExercises.length < 1 || rawExercises.length > ROUTINE_EXERCISES_MAX) {
    return { ok: false };
  }
  const exercises: RoutineExerciseSnapshot[] = [];
  for (const rawEntry of rawExercises) {
    const parsed = parseExerciseEntry(rawEntry);
    if (parsed === null) {
      return { ok: false };
    }
    exercises.push(parsed);
  }
  return { ok: true, snapshot: { name, exercises }, clientUpdatedAt };
}

// ---------------------------------------------------------------------------
// stored tree → projection (the delta feed's `upsert` payload and the read
// service's shape — full entity snapshot with server child ids and the
// frozen name snapshots; mirrors the §2 session projection)
// ---------------------------------------------------------------------------

export interface ProjectedRoutineSet {
  readonly id: string;
  readonly position: number;
  readonly format: JournalSetFormat;
  readonly weightKg?: number;
  readonly reps?: number;
  readonly durationSeconds?: number;
  readonly text?: string;
}

export interface ProjectedRoutineExercise {
  readonly id: string;
  readonly position: number;
  readonly exerciseId: string;
  readonly nameSnapshotEn: string;
  readonly nameSnapshotAr: string | null;
  readonly sets: readonly ProjectedRoutineSet[];
}

export interface RoutineProjection {
  readonly name: string;
  readonly exercises: readonly ProjectedRoutineExercise[];
}

/** Structural view of one stored set row (a Prisma model satisfies it; the
 * delta provider's `select` projection satisfies it too). */
export interface StoredSetRow {
  readonly id: string;
  readonly position: number;
  readonly format: string;
  readonly weightKg: Prisma.Decimal | number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly notesText: string | null;
}

/** Structural view of one stored exercise-entry row (non-deleted only by the
 * caller's query — the projection never surfaces superseded children). */
export interface StoredExerciseRow {
  readonly id: string;
  readonly position: number;
  readonly exerciseId: string;
  readonly nameSnapshotEn: string;
  readonly nameSnapshotAr: string | null;
  readonly sets: readonly StoredSetRow[];
}

/** Structural view of the stored routine row. */
export interface StoredRoutineRow {
  readonly id: string;
  readonly name: string;
  readonly exercises: readonly StoredExerciseRow[];
}

/** Deterministic list order inside the stored tree: `(position, id)`. */
export function byPositionThenId(
  a: { readonly position: number; readonly id: string },
  b: { readonly position: number; readonly id: string },
): number {
  return a.position - b.position || (a.id < b.id ? -1 : 1);
}

function projectSet(row: StoredSetRow): ProjectedRoutineSet {
  // The discriminated XOR (CHECK-pinned) projects ONLY the format's fields —
  // never a null-padded union (the §2 projection posture).
  switch (row.format as JournalSetFormat) {
    case 'weighted':
      return {
        id: row.id,
        position: row.position,
        format: 'weighted',
        weightKg: row.weightKg === null ? undefined : Number(row.weightKg),
        reps: row.reps ?? undefined,
      };
    case 'timed':
      return {
        id: row.id,
        position: row.position,
        format: 'timed',
        durationSeconds: row.durationSeconds ?? undefined,
      };
    default:
      return { id: row.id, position: row.position, format: 'notes', text: row.notesText ?? undefined };
  }
}

/**
 * Projects the stored routine tree into the feed/read snapshot. Pure: the
 * ordering is the deterministic `(position, id)` — no clock, no
 * environment. Decimal weight values serialize as JSON numbers (DECIMAL(9,3)
 * is exact within double precision; `Number()` round-trips losslessly — the
 * foods projection precedent; never served raw as a string).
 */
export function routineToProjection(tree: StoredRoutineRow): RoutineProjection {
  const exercises = [...tree.exercises].sort(byPositionThenId).map((entry) => ({
    id: entry.id,
    position: entry.position,
    exerciseId: entry.exerciseId,
    nameSnapshotEn: entry.nameSnapshotEn,
    nameSnapshotAr: entry.nameSnapshotAr,
    sets: [...entry.sets].sort(byPositionThenId).map(projectSet),
  }));
  return { name: tree.name, exercises };
}
