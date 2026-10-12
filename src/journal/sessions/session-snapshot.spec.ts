/**
 * Kal — the frozen journal session snapshot validator (w4 contract §1.1).
 *
 * Pins every validation rule the per-op `rejected_validation` outcome
 * enforces, at the pure layer (no database, no clock): negative/zero reps;
 * negative/zero weight or duration; over-max weight/reps/duration; empty
 * exercise list; over 20 entries; over 50 sets; over-length notes/title;
 * malformed format mixes (forbidden field present, unknown format, missing
 * required field); unknown-shape exercise id; malformed or calendar-invalid
 * localDate; envelope↔payload localDate disagreement; negative position;
 * malformed ids/instants. Also pins the happy parse of a MIXED-FORMAT
 * session (weighted + timed + notes coexisting) and the tolerance of
 * non-frozen extra keys (the W3 diary parser posture).
 */
import { describe, expect, it } from 'vitest';
import { SESSION_BOUNDS, parseSessionSnapshot } from './session-snapshot.js';

const OP_ID = '7d0f0000-0000-4000-8000-00000000a001';
const ENTITY_ID = '7e100000-0000-4000-8000-00000000b001';
const EXERCISE_ID = '00000000-0000-4000-8000-00000000f201';
const T = '2026-10-12T21:59:00.000Z';

function weightedSet(weightKg = 60, reps = 8): Record<string, unknown> {
  return { format: 'weighted', weightKg, reps };
}
function timedSet(durationSeconds = 90): Record<string, unknown> {
  return { format: 'timed', durationSeconds };
}
function notesSet(text = 'AMRAP 12: 15 reps unbroken'): Record<string, unknown> {
  return { format: 'notes', text };
}

function op(overrides: { payload?: unknown; localDate?: unknown; opId?: unknown; entityId?: unknown; clientUpdatedAt?: unknown; action?: unknown } = {}) {
  return {
    opId: OP_ID,
    entityId: ENTITY_ID,
    action: 'create' as const,
    clientUpdatedAt: T,
    localDate: '2026-10-12',
    payload: {
      localDate: '2026-10-12',
      title: 'Push day',
      exercises: [
        { exerciseId: EXERCISE_ID, position: 0, sets: [weightedSet(), timedSet(), notesSet()] },
      ],
    },
    ...overrides,
  };
}

function expectNull(overrides: Parameters<typeof op>[0]): void {
  expect(parseSessionSnapshot(op(overrides))).toBeNull();
}

describe('mixed-format happy path (§1.1)', () => {
  it('parses weighted + timed + notes sets coexisting in one ordered session', () => {
    const parsed = parseSessionSnapshot(op());
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect(parsed.snapshot.localDate).toBe('2026-10-12');
      expect(parsed.snapshot.title).toBe('Push day');
      expect(parsed.snapshot.exercises).toHaveLength(1);
      const sets = parsed.snapshot.exercises[0]?.sets;
      expect(sets).toHaveLength(3);
      expect(sets?.[0]).toEqual({ format: 'weighted', weightKg: 60, reps: 8 });
      expect(sets?.[1]).toEqual({ format: 'timed', durationSeconds: 90 });
      expect(sets?.[2]).toEqual({ format: 'notes', text: 'AMRAP 12: 15 reps unbroken' });
      expect(parsed.clientUpdatedAt.toISOString()).toBe(T);
    }
  });

  it('accepts a title-less session and an exercise entry with ZERO sets (0..50)', () => {
    const parsed = parseSessionSnapshot(
      op({ payload: { localDate: '2026-10-12', exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } }),
    );
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect(parsed.snapshot.title).toBeUndefined();
      expect(parsed.snapshot.exercises[0]?.sets).toEqual([]);
    }
  });

  it('tolerates non-frozen extra keys (the W3 diary parser posture)', () => {
    const parsed = parseSessionSnapshot(
      op({ payload: { localDate: '2026-10-12', memo: 'client-local note', exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [{ ...weightedSet(), feel: 'hard' }] }] } }),
    );
    expect(parsed).not.toBeNull();
  });

  it('accepts the exact boundary values (weight 1000, reps 1000, duration 86400, text 500, title 120)', () => {
    const parsed = parseSessionSnapshot(
      op({
        payload: {
          localDate: '2026-10-12',
          title: 'x'.repeat(SESSION_BOUNDS.maxTitleLength),
          exercises: [
            {
              exerciseId: EXERCISE_ID,
              position: 0,
              sets: [
                weightedSet(SESSION_BOUNDS.maxWeightKg, SESSION_BOUNDS.maxReps),
                timedSet(SESSION_BOUNDS.maxDurationSeconds),
                notesSet('y'.repeat(SESSION_BOUNDS.maxNotesLength)),
              ],
            },
          ],
        },
      }),
    );
    expect(parsed).not.toBeNull();
  });
});

describe('set-level validation (§1.1 bounds — every violation ⇒ rejected_validation)', () => {
  it('rejects negative, zero, and over-max reps; non-integer reps', () => {
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: 0 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: -3 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: 1001 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: 7.5 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60 }]) }); // missing field its format requires
  });

  it('rejects negative, zero, and over-max weight; missing weight', () => {
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 0, reps: 5 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: -10, reps: 5 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 1000.01, reps: 5 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', reps: 5 }]) });
  });

  it('rejects negative, zero, and over-24h durations; non-integer duration', () => {
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: 0 }]) });
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: -30 }]) });
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: 86401 }]) });
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: 1.5 }]) });
  });

  it('rejects empty and over-length free text; missing text', () => {
    expectNull({ payload: buildWithSets([{ format: 'notes', text: '' }]) });
    expectNull({ payload: buildWithSets([{ format: 'notes', text: 'z'.repeat(501) }]) });
    expectNull({ payload: buildWithSets([{ format: 'notes' }]) });
  });

  it('rejects malformed format mixes: a field present that its format forbids, and an unknown format', () => {
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: 8, durationSeconds: 30 }]) });
    expectNull({ payload: buildWithSets([{ format: 'weighted', weightKg: 60, reps: 8, text: 'no' }]) });
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: 30, weightKg: 20 }]) });
    expectNull({ payload: buildWithSets([{ format: 'timed', durationSeconds: 30, reps: 10 }]) });
    expectNull({ payload: buildWithSets([{ format: 'notes', text: 'ok', durationSeconds: 30 }]) });
    expectNull({ payload: buildWithSets([{ format: 'isometric', seconds: 30 }]) });
    expectNull({ payload: buildWithSets(['weighted']) });
    expectNull({ payload: buildWithSets([null]) });
  });
});

function buildWithSets(sets: unknown[]): Record<string, unknown> {
  return {
    localDate: '2026-10-12',
    exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets }],
  };
}

describe('entry- and session-level validation (§1.1)', () => {
  it('rejects an EMPTY exercise list and over-20 entries', () => {
    expectNull({ payload: { localDate: '2026-10-12', exercises: [] } });
    expectNull({
      payload: {
        localDate: '2026-10-12',
        exercises: Array.from({ length: SESSION_BOUNDS.maxExercises + 1 }, (_, i) => ({
          exerciseId: EXERCISE_ID,
          position: i,
          sets: [],
        })),
      },
    });
  });

  it('rejects over-50 sets and a negative/non-integer position; unknown-shape exerciseId', () => {
    expectNull({
      payload: {
        localDate: '2026-10-12',
        exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: Array.from({ length: SESSION_BOUNDS.maxSetsPerExercise + 1 }, () => weightedSet()) }],
      },
    });
    expectNull({ payload: { localDate: '2026-10-12', exercises: [{ exerciseId: EXERCISE_ID, position: -1, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-12', exercises: [{ exerciseId: EXERCISE_ID, position: 0.5, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-12', exercises: [{ exerciseId: 'not-a-uuid', position: 0, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-12', exercises: [{ position: 0, sets: [] }] } });
  });

  it('rejects over-length and empty-string titles; malformed payload containers', () => {
    expectNull({ payload: { localDate: '2026-10-12', title: 'x'.repeat(121), exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-12', title: '', exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-12', exercises: 'all' } });
    expectNull({ payload: 'nope' });
    expectNull({ payload: null });
    expectNull({ payload: undefined });
  });
});

describe('day-carry and envelope parity (§1.1/§1.8 — shape-only, never re-derived)', () => {
  it('rejects a missing, malformed, or calendar-invalid envelope localDate (2026-02-30 is not a day)', () => {
    expectNull({ localDate: undefined });
    expectNull({ localDate: '2026-10-12T00:00:00Z' });
    expectNull({ localDate: '2026-2-15' });
    expectNull({ localDate: '2026-02-30' });
    expectNull({ localDate: '2026-13-01' });
  });

  it('accepts leap-day 2024-02-29 (strict calendar validity)', () => {
    const parsed = parseSessionSnapshot(op({ localDate: '2024-02-29', payload: { localDate: '2024-02-29', exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } }));
    expect(parsed).not.toBeNull();
  });

  it('rejects payload localDate ABSENT or DISAGREEING with the envelope (handler-domain rejection)', () => {
    expectNull({ payload: { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } });
    expectNull({ payload: { localDate: '2026-10-11', exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] } });
  });

  it('rejects malformed op/entity ids and non-UTC clientUpdatedAt', () => {
    expectNull({ opId: '7d0f0000-0000-4000-8000-00000000a00X' });
    expectNull({ entityId: 'short' });
    expectNull({ clientUpdatedAt: '2026-10-12T21:59:00+03:00' }); // a non-UTC offset is a DIFFERENT contract
    expectNull({ clientUpdatedAt: 'not-an-instant' });
    expectNull({ action: 'upsert' });
  });
});
