/**
 * Kal — the frozen journal session snapshot (w4 contract §1.1/§1.2/§2).
 *
 * The op `payload` is the FULL entity snapshot (same shape for create and
 * update — no patch semantics); the delta feed's `upsert` payloads are the
 * same snapshot (the w3 §1.6 rule — "the same frozen snapshot shape as the
 * op payload" — is inherited verbatim by w4 §1.4); the REST day/detail read
 * shapes (§2) are projections of the stored aggregate. This module is the
 * single transcription of those shapes: validation (pure), delta payload
 * reconstruction, and read projections.
 *
 * Payload shape (frozen by the w4 contract §1.1):
 *   {
 *     localDate: 'YYYY-MM-DD'  REQUIRED, calendar-valid, shape-only — the
 *                client-local session date; MUST equal the envelope's
 *                `localDate` (day-boundary rule §1.8: the server NEVER
 *                re-derives the day)
 *     title?:    1..120 chars when present
 *     exercises: 1..20 entries, ordered (position; ties break by entry id)
 *       [{ exerciseId: UUID (existing catalog row — validated at apply),
 *          position: integer >= 0,
 *          sets: 0..50, ordered, mixed formats coexist:
 *            { format: 'weighted', weightKg: >0..<=1000, reps: 1..1000 }
 *          | { format: 'timed',   durationSeconds: 1..86400 }
 *          | { format: 'notes',   text: 1..500 chars } }]
 *   }
 *
 * NAME SNAPSHOTS ARE SERVER-DERIVED (§1.1): the payload carries only
 * `exerciseId` — empty/over-length snapshot values are impossible BY
 * CONSTRUCTION because the client never sends them. On apply, the handler
 * freezes the catalog row's current names into the child rows (the I11
 * freeze: later catalog edits never rewrite logged history; an edit op
 * re-freezes at THAT apply — an edit is a new log event).
 *
 * Every violation of the §1.1 bounds is the per-op `rejected_validation`
 * outcome (retryable false) — the parser returns `null`, never throws.
 * The same bounds are CHECK-pinned in the migration; the database is the
 * last line, not the only one.
 */
import type {
  JournalExerciseSet,
  JournalSession,
  JournalSessionExercise,
} from '../../../generated/prisma/client.ts';
import { isValidLocalDate, localDateToDate } from './session-day.js';

export type SessionSetFormat = 'weighted' | 'timed' | 'notes';

export type SessionSet =
  | { readonly format: 'weighted'; readonly weightKg: number; readonly reps: number }
  | { readonly format: 'timed'; readonly durationSeconds: number }
  | { readonly format: 'notes'; readonly text: string };

export interface SessionExerciseEntry {
  readonly exerciseId: string;
  readonly position: number;
  readonly sets: readonly SessionSet[];
}

export interface SessionSnapshot {
  readonly localDate: string;
  readonly title?: string;
  readonly exercises: readonly SessionExerciseEntry[];
}

/** Exact §1.1 bounds — mirrored by the migration's CHECK constraints. */
export const SESSION_BOUNDS = {
  maxTitleLength: 120,
  minExercises: 1,
  maxExercises: 20,
  maxSetsPerExercise: 50,
  maxWeightKg: 1000,
  maxReps: 1000,
  maxDurationSeconds: 86400,
  maxNotesLength: 500,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isSessionUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Strict ISO 8601 UTC-instant parsing (conventions §0; the envelope layer
 * shape-checks first — the handler re-parses for the `Date`). Returns null
 * for anything that is not a `Z`-suffixed instant.
 */
export function parseSessionUtcInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Parses one set against the discriminated format XOR (§1.1): a field
 * present that its format forbids, an unknown `format`, or a missing field
 * its format requires are all malformed format mixes. Non-frozen extra keys
 * are tolerated (the W3 diary parser posture — frozen-field violations are
 * what validation pins).
 */
function parseSessionSet(raw: unknown): SessionSet | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const set = raw as Record<string, unknown>;
  const format = set['format'];
  if (format === 'weighted') {
    if (set['durationSeconds'] !== undefined || set['text'] !== undefined) {
      return null; // a field present that its format forbids
    }
    const weightKg = set['weightKg'];
    const reps = set['reps'];
    if (!isFiniteNumber(weightKg) || weightKg <= 0 || weightKg > SESSION_BOUNDS.maxWeightKg) {
      return null; // negative/zero/over-max weight
    }
    if (!isBoundedInt(reps, 1, SESSION_BOUNDS.maxReps)) {
      return null; // negative/zero/over-max or non-integer reps
    }
    return { format: 'weighted', weightKg, reps };
  }
  if (format === 'timed') {
    if (set['weightKg'] !== undefined || set['reps'] !== undefined || set['text'] !== undefined) {
      return null;
    }
    const durationSeconds = set['durationSeconds'];
    if (!isBoundedInt(durationSeconds, 1, SESSION_BOUNDS.maxDurationSeconds)) {
      return null; // negative/zero/over-24h or non-integer duration
    }
    return { format: 'timed', durationSeconds };
  }
  if (format === 'notes') {
    if (set['weightKg'] !== undefined || set['reps'] !== undefined || set['durationSeconds'] !== undefined) {
      return null;
    }
    const text = set['text'];
    if (typeof text !== 'string' || text.length < 1 || text.length > SESSION_BOUNDS.maxNotesLength) {
      return null; // empty or over-length free text
    }
    return { format: 'notes', text };
  }
  return null; // unknown format
}

function parseSessionExerciseEntry(raw: unknown): SessionExerciseEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const exerciseId = entry['exerciseId'];
  if (!isSessionUuid(exerciseId)) {
    return null; // unknown/nonexistent-shape exercise reference
  }
  const position = entry['position'];
  if (!isBoundedInt(position, 0, Number.MAX_SAFE_INTEGER)) {
    return null; // negative or non-integer position
  }
  const rawSets = entry['sets'];
  if (!Array.isArray(rawSets) || rawSets.length > SESSION_BOUNDS.maxSetsPerExercise) {
    return null; // sets absent or over 50
  }
  const sets: SessionSet[] = [];
  for (const rawSet of rawSets) {
    const parsed = parseSessionSet(rawSet);
    if (parsed === null) {
      return null;
    }
    sets.push(parsed);
  }
  return { exerciseId, position, sets };
}

/**
 * Validates one journal_session op envelope + payload into the frozen
 * snapshot. Pure: no database, no clock — every failure is the per-op
 * `rejected_validation` outcome (w4 §1.1/§1.3 state machine), never an
 * exception.
 */
export function parseSessionSnapshot(op: {
  readonly opId: unknown;
  readonly entityId: unknown;
  readonly action: unknown;
  readonly clientUpdatedAt: unknown;
  readonly localDate?: unknown;
  readonly payload?: unknown;
}): { snapshot: SessionSnapshot; clientUpdatedAt: Date } | null {
  if (!isSessionUuid(op.opId) || !isSessionUuid(op.entityId)) {
    return null; // stable ids are UUIDs; a malformed id must never reach a UUID column
  }
  if (op.action !== 'create' && op.action !== 'update') {
    return null; // delete ops never reach here (no snapshot to parse)
  }
  const clientUpdatedAt = parseSessionUtcInstant(op.clientUpdatedAt);
  if (clientUpdatedAt === null) {
    return null;
  }
  // The carried session date is REQUIRED on the envelope, shape-only valid,
  // and the payload's own localDate must AGREE with it (one snapshot shape;
  // the envelope value is the day rule — §1.8). Payload-localDate ABSENCE is
  // the handler's per-op rejection domain (supervisor ruling 1, 2026-10-12).
  if (typeof op.localDate !== 'string' || !isValidLocalDate(op.localDate)) {
    return null;
  }
  if (typeof op.payload !== 'object' || op.payload === null || Array.isArray(op.payload)) {
    return null;
  }
  const body = op.payload as Record<string, unknown>;
  if (typeof body['localDate'] !== 'string' || body['localDate'] !== op.localDate) {
    return null;
  }

  const rawTitle = body['title'];
  if (rawTitle !== undefined && (typeof rawTitle !== 'string' || rawTitle.length < 1 || rawTitle.length > SESSION_BOUNDS.maxTitleLength)) {
    return null; // over-length title (empty included)
  }

  const rawExercises = body['exercises'];
  if (!Array.isArray(rawExercises) || rawExercises.length < SESSION_BOUNDS.minExercises || rawExercises.length > SESSION_BOUNDS.maxExercises) {
    return null; // empty exercise list or over 20 entries
  }
  const exercises: SessionExerciseEntry[] = [];
  for (const rawEntry of rawExercises) {
    const parsed = parseSessionExerciseEntry(rawEntry);
    if (parsed === null) {
      return null;
    }
    exercises.push(parsed);
  }

  return {
    snapshot: {
      localDate: op.localDate,
      ...(rawTitle === undefined ? {} : { title: rawTitle }),
      exercises,
    },
    clientUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Delta payload + REST projections (§1.4 upserts carry the op snapshot
// shape; §2 reads project the stored aggregate)
// ---------------------------------------------------------------------------

/** One hydrated exercise entry with its set rows (the stored aggregate). */
export interface StoredExerciseAggregate {
  readonly exercise: JournalSessionExercise;
  readonly sets: readonly JournalExerciseSet[];
}

/** A hydrated session row with its (non-deleted) children. */
export interface StoredSessionAggregate {
  readonly session: JournalSession;
  readonly exercises: readonly StoredExerciseAggregate[];
}

/**
 * The delta feed's `upsert` payload: the FULL entity snapshot of a stored
 * aggregate — the same frozen shape as the op payload (§1.4; the w3 §1.6
 * rule). Name snapshots are NOT part of it: they are server-derived state
 * the client reads through the §2 projections and its exercise cache.
 */
export function aggregateToSnapshot(aggregate: StoredSessionAggregate): SessionSnapshot {
  return {
    localDate: formatStoredDate(aggregate.session.localDate),
    ...(aggregate.session.title === null ? {} : { title: aggregate.session.title }),
    exercises: aggregate.exercises.map((entry) => ({
      exerciseId: entry.exercise.exerciseId,
      position: entry.exercise.position,
      sets: entry.sets.map(setRowToPayloadSet),
    })),
  };
}

function setRowToPayloadSet(row: JournalExerciseSet): SessionSet {
  if (row.format === 'weighted') {
    return { format: 'weighted', weightKg: Number(row.weightKg), reps: row.reps ?? 0 };
  }
  if (row.format === 'timed') {
    return { format: 'timed', durationSeconds: row.durationSeconds ?? 0 };
  }
  return { format: 'notes', text: row.notesText ?? '' };
}

function formatStoredDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// §2 read projections
// ---------------------------------------------------------------------------

/** One ordered set as projected by the §2 read surface (the format's fields only). */
export interface SessionSetView {
  readonly id: string;
  readonly position: number;
  readonly format: SessionSetFormat;
  readonly weightKg?: number;
  readonly reps?: number;
  readonly durationSeconds?: number;
  readonly text?: string;
}

/** One ordered exercise entry — carries the frozen-at-log-time name snapshot (the I11 freeze). */
export interface SessionExerciseView {
  readonly id: string;
  readonly position: number;
  readonly exerciseId: string;
  readonly nameSnapshotEn: string;
  readonly nameSnapshotAr: string | null;
  readonly sets: readonly SessionSetView[];
}

/** A session as projected by the day read / detail read (§2). */
export interface SessionView {
  readonly id: string;
  readonly localDate: string;
  readonly title?: string;
  readonly updatedAt: string;
  readonly exercises: readonly SessionExerciseView[];
}

export function aggregateToSessionView(aggregate: StoredSessionAggregate): SessionView {
  return {
    id: aggregate.session.id,
    localDate: formatStoredDate(aggregate.session.localDate),
    ...(aggregate.session.title === null ? {} : { title: aggregate.session.title }),
    updatedAt: aggregate.session.updatedAt.toISOString(),
    exercises: aggregate.exercises.map((entry) => ({
      id: entry.exercise.id,
      position: entry.exercise.position,
      exerciseId: entry.exercise.exerciseId,
      nameSnapshotEn: entry.exercise.nameSnapshotEn,
      nameSnapshotAr: entry.exercise.nameSnapshotAr,
      sets: entry.sets.map(setRowToSetView),
    })),
  };
}

function setRowToSetView(row: JournalExerciseSet): SessionSetView {
  const base = { id: row.id, position: row.position, format: row.format as SessionSetFormat };
  if (row.format === 'weighted') {
    return { ...base, weightKg: Number(row.weightKg), reps: row.reps ?? 0 };
  }
  if (row.format === 'timed') {
    return { ...base, durationSeconds: row.durationSeconds ?? 0 };
  }
  return { ...base, text: row.notesText ?? '' };
}

/** The `journal.sessions.day.get` 200 body — an empty day is an EMPTY 200 (a date is not an object). */
export interface SessionDayView {
  readonly localDate: string;
  readonly sessions: readonly SessionView[];
}

/** Helper kept next to its only user: the DATE-column value from a validated string. */
export function sessionLocalDateColumn(localDate: string): Date {
  return localDateToDate(localDate);
}
