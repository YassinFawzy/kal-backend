/**
 * Kal — the frozen `journal_routine` payload validation unit suite (wave-04
 * contract §1.1 — exact bounds; every violation is the per-op
 * `rejected_validation` outcome, never an exception).
 *
 * Pins the parser as the single transcription of the payload shape:
 *   - name REQUIRED 1..120 (empty, absent, over-length rejected)
 *   - exercises REQUIRED 1..20 (empty, absent, over-length rejected)
 *   - exerciseId UUID REQUIRED; position integer ≥ 0 (bound by the INTEGER
 *     column — a larger value is a validation outcome, never a raw abort)
 *   - sets 0..50; the discriminated format XOR with the exact per-format
 *     bounds (weighted/timed/notes; a field its format forbids, an unknown
 *     format, a missing required field ⇒ rejected)
 *   - the local-date parity rule: a routine op carries NO localDate
 *   - stable-id + instant guards (opId/entityId UUIDs; clientUpdatedAt UTC)
 */
import { describe, expect, it } from 'vitest';
import { parseRoutineSnapshot } from './routine-payload.js';

const OP_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const EXERCISE_ID = '00000000-0000-4000-8000-00000000f201';
const UPDATED_AT = '2026-10-12T09:30:00Z';

function op(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}): Parameters<typeof parseRoutineSnapshot>[0] {
  return {
    opId: OP_ID,
    entityId: ENTITY_ID,
    action: 'create',
    clientUpdatedAt: UPDATED_AT,
    payload: {
      name: 'Push day',
      exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 8 }] }],
      ...payloadOverrides,
    },
    ...overrides,
  };
}

const ok = (result: ReturnType<typeof parseRoutineSnapshot>): { name: string; exerciseCount: number } => {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('expected ok');
  }
  return { name: result.snapshot.name, exerciseCount: result.snapshot.exercises.length };
};

describe('routine payload — the frozen §1.1 shape', () => {
  it('accepts the minimal snapshot and preserves name + entries', () => {
    const result = parseRoutineSnapshot(op());
    expect(ok(result)).toEqual({ name: 'Push day', exerciseCount: 1 });
    if (result.ok) {
      expect(result.clientUpdatedAt.toISOString()).toBe('2026-10-12T09:30:00.000Z');
      expect(result.snapshot.exercises[0]?.sets[0]).toEqual({ format: 'weighted', weightKg: 60, reps: 8 });
    }
  });

  it('accepts all three set formats coexisting in one template (planned sets + WOD notes)', () => {
    const result = parseRoutineSnapshot(
      op({}, {
        exercises: [{
          exerciseId: EXERCISE_ID,
          position: 0,
          sets: [
            { format: 'weighted', weightKg: 102.5, reps: 3 },
            { format: 'timed', durationSeconds: 45 },
            { format: 'notes', text: 'AMRAP finisher' },
          ],
        }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a name at both length bounds and exercises at the 20-entry bound', () => {
    expect(parseRoutineSnapshot(op({}, { name: 'x' })).ok).toBe(true);
    expect(parseRoutineSnapshot(op({}, { name: 'x'.repeat(120) })).ok).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, index) => ({ exerciseId: EXERCISE_ID, position: index, sets: [] }));    expect(parseRoutineSnapshot(op({}, { exercises: twenty })).ok).toBe(true);
    const fiftySets = Array.from({ length: 50 }, () => ({ format: 'timed', durationSeconds: 1 }));
    expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: fiftySets }] })).ok).toBe(true);
  });
});

describe('routine payload — every contract violation rejects', () => {
  it('name: absent, empty, over-length, non-string', () => {
    for (const name of [undefined, null, '', 'x'.repeat(121), 42]) {
      const payload: Record<string, unknown> = { name, exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }] };
      expect(parseRoutineSnapshot(op({}, payload)).ok).toBe(false);
    }
  });

  it('exercises: absent, empty, over 20, non-array', () => {
    for (const exercises of [undefined, null, [], 'nope', Array.from({ length: 21 }, () => ({ exerciseId: EXERCISE_ID, position: 0, sets: [] }))]) {
      const payload: Record<string, unknown> = { name: 'Push day', exercises };
      expect(parseRoutineSnapshot(op({}, payload)).ok).toBe(false);
    }
  });

  it('exercise entries: malformed exerciseId, negative/over-INTEGER position, over-50 sets', () => {
    const bad = [
      { position: 0, sets: [] }, // exerciseId absent
      { exerciseId: 'not-a-uuid', position: 0, sets: [] },
      { exerciseId: '{0f201-guid-object}', position: 0, sets: [] },
      { exerciseId: EXERCISE_ID, position: -1, sets: [] },
      { exerciseId: EXERCISE_ID, position: 2_147_483_648, sets: [] }, // the INTEGER column's bound + 1
      { exerciseId: EXERCISE_ID, position: 1.5, sets: [] },
      { exerciseId: EXERCISE_ID, position: 0, sets: Array.from({ length: 51 }, () => ({ format: 'timed', durationSeconds: 1 })) },
    ];
    for (const entry of bad) {
      expect(parseRoutineSnapshot(op({}, { exercises: [entry] })).ok).toBe(false);
    }
  });

  it('weighted sets: zero/negative/over-1000 weight, zero/over-1000/non-integer reps', () => {
    const bad = [
      { format: 'weighted', weightKg: 0, reps: 5 },
      { format: 'weighted', weightKg: -10, reps: 5 },
      { format: 'weighted', weightKg: 1000.01, reps: 5 },
      { format: 'weighted', weightKg: 60 },
      { format: 'weighted', weightKg: 60, reps: 0 },
      { format: 'weighted', weightKg: 60, reps: -1 },
      { format: 'weighted', weightKg: 60, reps: 1001 },
      { format: 'weighted', weightKg: 60, reps: 7.5 },
      { format: 'weighted', reps: 5 },
    ];
    for (const set of bad) {
      expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [set] }] })).ok).toBe(false);
    }
  });

  it('timed sets: zero/negative/over-86400 duration', () => {
    const bad = [
      { format: 'timed', durationSeconds: 0 },
      { format: 'timed', durationSeconds: -30 },
      { format: 'timed', durationSeconds: 86_401 },
      { format: 'timed' },
      { format: 'timed', durationSeconds: 90.5 },
    ];
    for (const set of bad) {
      expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [set] }] })).ok).toBe(false);
    }
  });

  it('notes sets: empty/over-500 text', () => {
    const bad = [{ format: 'notes', text: '' }, { format: 'notes', text: 'x'.repeat(501) }, { format: 'notes' }];
    for (const set of bad) {
      expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [set] }] })).ok).toBe(false);
    }
  });

  it('malformed format mixes: a forbidden field present, an unknown format, a missing discriminator', () => {
    const bad = [
      { format: 'weighted', weightKg: 60, reps: 5, durationSeconds: 30 }, // forbidden field
      { format: 'weighted', weightKg: 60, reps: 5, text: 'nope' },
      { format: 'timed', durationSeconds: 60, weightKg: 10 },
      { format: 'timed', durationSeconds: 60, text: 'nope' },
      { format: 'notes', text: 'wod', weightKg: 10 },
      { format: 'notes', text: 'wod', durationSeconds: 10 },
      { format: 'isometric', holdSeconds: 30 },
      { weightKg: 60, reps: 5 }, // format absent
    ];
    for (const set of bad) {
      expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [set] }] })).ok).toBe(false);
    }
  });

  it('envelope guards: malformed ids, bad instants, wrong actions, and the local-date parity rule', () => {
    expect(parseRoutineSnapshot(op({ opId: 'not-a-uuid' })).ok).toBe(false);
    expect(parseRoutineSnapshot(op({ entityId: 'not-a-uuid' })).ok).toBe(false);
    expect(parseRoutineSnapshot(op({ clientUpdatedAt: '2026-10-12T09:30:00+03:00' })).ok).toBe(false); // non-UTC offset
    expect(parseRoutineSnapshot(op({ clientUpdatedAt: 'not-a-date' })).ok).toBe(false);
    expect(parseRoutineSnapshot(op({ action: 'delete' })).ok).toBe(false); // deletes never carry a snapshot
    // A routine template has NO day — a carried localDate is a shape error.
    expect(parseRoutineSnapshot(op({ localDate: '2026-10-12' })).ok).toBe(false);
    expect(parseRoutineSnapshot(op({ payload: undefined })).ok).toBe(false);
    expect(parseRoutineSnapshot(op({}, { exercises: [{ exerciseId: EXERCISE_ID, position: 0, sets: [] }], extra: 'ignored-unknown-key' })).ok).toBe(true);
  });
});
