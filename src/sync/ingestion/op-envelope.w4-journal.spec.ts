/**
 * Kal — layer-1 envelope acceptance for the `journal_session` kind (w4
 * contract §1.1; supervisor-blessed seam widening, ruling 1, 2026-10-12).
 *
 * Pins exactly the widened batch-shape rules, at the DATABASE-FREE layer:
 *   - a well-formed `journal_session` op parses (create/update/delete) —
 *     the kind rides the existing `POST /sync/ops` envelope unchanged;
 *   - `localDate` is REQUIRED on `journal_session` ops (mirrors
 *     `diary_entry` — the client-local session date; calendar-valid,
 *     shape-only; the server never re-derives the day, §1.8);
 *   - `localDate` on `user_food`/`favorite` stays a whole-batch error;
 *   - envelope↔payload `localDate` DISAGREEMENT is a whole-batch 400 class
 *     (the W3 2026-10-08 envelope-field-parity ruling extended to the w4
 *     day-carrying kind); payload-localDate ABSENCE is NOT a batch error —
 *     it is the journal handler's per-op `rejected_validation` domain;
 *   - `journal_routine` is still an UNKNOWN kind at this layer (w04-s2c's
 *     registration union adds it later — the seam stays clean).
 *
 * A batch-shape failure here rejects the WHOLE batch with
 * `400 VALIDATION_FAILED`, zero ops applied, nothing recorded (§1.2) — the
 * ingestion service maps `parseBatchBody` errors to that response.
 */
import { describe, expect, it } from 'vitest';
import { parseBatchBody } from './op-envelope.js';

const MAX_OPS = 100; // any positive cap — the shape layer is cap-independent

function sessionOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: '7d0f0000-0000-4000-8000-00000000a001',
    kind: 'journal_session',
    entityId: '7e100000-0000-4000-8000-00000000b001',
    action: 'create',
    clientUpdatedAt: '2026-10-12T21:59:00.000Z',
    localDate: '2026-10-12',
    payload: {
      localDate: '2026-10-12',
      exercises: [
        {
          exerciseId: '00000000-0000-4000-8000-00000000f201',
          position: 0,
          sets: [{ format: 'weighted', weightKg: 60, reps: 8 }],
        },
      ],
    },
    ...overrides,
  };
}

function parseOps(...ops: Record<string, unknown>[]) {
  return parseBatchBody({ deviceId: 'device-1', ops }, MAX_OPS);
}

describe('journal_session layer-1 acceptance (w4 §1.1, ruling 1)', () => {
  it('a well-formed journal_session create parses; the envelope is unchanged otherwise', () => {
    const parsed = parseOps(sessionOp());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.ops).toHaveLength(1);
      expect(parsed.value.ops[0]?.kind).toBe('journal_session');
      expect(parsed.value.ops[0]?.localDate).toBe('2026-10-12');
    }
  });

  it('update parses with the full-snapshot payload; delete parses with localDate and NO payload', () => {
    const update = parseOps(sessionOp({ action: 'update', opId: '7d0f0000-0000-4000-8000-00000000a002' }));
    expect(update.ok).toBe(true);
    const del = parseOps(
      sessionOp({
        action: 'delete',
        opId: '7d0f0000-0000-4000-8000-00000000a003',
        payload: undefined,
      }),
    );
    expect(del.ok).toBe(true);
  });

  it('localDate is REQUIRED on journal_session ops — absence is a whole-batch shape error', () => {
    const { localDate: _omitted, ...withoutDate } = sessionOp();
    const parsed = parseOps(withoutDate);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.field === 'ops[0].localDate')).toBe(true);
    }
  });

  it('a calendar-INVALID localDate is a whole-batch shape error (shape-only validation)', () => {
    const parsed = parseOps(sessionOp({ localDate: '2026-02-30' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.field === 'ops[0].localDate')).toBe(true);
    }
  });

  it('localDate stays FORBIDDEN on user_food ops (unchanged W3 rule)', () => {
    const parsed = parseOps({
      opId: '7d0f0000-0000-4000-8000-00000000a004',
      kind: 'user_food',
      entityId: '7e100000-0000-4000-8000-00000000b002',
      action: 'create',
      clientUpdatedAt: '2026-10-12T21:59:00.000Z',
      localDate: '2026-10-12',
      payload: {},
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.field === 'ops[0].localDate')).toBe(true);
    }
  });

  it('payload localDate EQUAL to the envelope localDate parses (parity, direction A)', () => {
    const parsed = parseOps(sessionOp({ payload: { localDate: '2026-10-12', exercises: [] } }));
    expect(parsed.ok).toBe(true);
  });

  it('payload localDate DISAGREEING with the envelope localDate is the whole-batch 400 class (parity, direction B)', () => {
    const parsed = parseOps(sessionOp({ payload: { localDate: '2026-10-11', exercises: [] } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.field === 'ops[0].localDate')).toBe(true);
    }
  });

  it('payload localDate ABSENCE is NOT a batch error — the journal handler owns it per-op (rejected_validation domain)', () => {
    const parsed = parseOps(sessionOp({ payload: { exercises: [] } }));
    expect(parsed.ok).toBe(true);
  });

  it('journal_routine is still an UNKNOWN kind at this layer (s2c adds it in the union)', () => {
    const parsed = parseOps(
      sessionOp({
        kind: 'journal_routine',
        localDate: undefined,
        payload: { name: 'Day A', exercises: [] },
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((e) => e.field === 'ops[0].kind')).toBe(true);
    }
  });
});
