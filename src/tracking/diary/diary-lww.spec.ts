/**
 * Kal — LWW comparator specs (wave-03 contract §1.4, frozen).
 *
 * `(clientUpdatedAt, opId)` is a total order: higher clientUpdatedAt wins;
 * on equal timestamps the higher opId (lexicographic UUID string compare)
 * wins; a NULL last_op_id row (REST-created — user foods only) loses to ANY
 * sync op. Determinism is the convergence guarantee — pinned here exactly.
 */
import { describe, expect, it } from 'vitest';
import { opWinsLww } from './diary-lww.js';

const T1 = new Date('2026-01-15T10:00:00.000Z');
const T2 = new Date('2026-01-15T11:00:00.000Z');
const OP_AAA = '11111111-1111-4111-8111-000000000aaa';
const OP_BBB = '11111111-1111-4111-8111-000000000bbb';

describe('LWW: higher clientUpdatedAt wins', () => {
  it('a newer op beats the stored row', () => {
    expect(opWinsLww({ clientUpdatedAt: T2, opId: OP_AAA }, { updatedAt: T1, lastOpId: OP_BBB })).toBe(true);
  });
  it('a stale op loses (and changes nothing, but is still acked applied)', () => {
    expect(opWinsLww({ clientUpdatedAt: T1, opId: OP_BBB }, { updatedAt: T2, lastOpId: OP_AAA })).toBe(false);
  });
});

describe('LWW deterministic tiebreak: equal timestamps → higher opId (lexicographic)', () => {
  it('higher opId wins', () => {
    expect(opWinsLww({ clientUpdatedAt: T1, opId: OP_BBB }, { updatedAt: T1, lastOpId: OP_AAA })).toBe(true);
  });
  it('lower opId loses', () => {
    expect(opWinsLww({ clientUpdatedAt: T1, opId: OP_AAA }, { updatedAt: T1, lastOpId: OP_BBB })).toBe(false);
  });
  it('equal timestamp and equal opId never wins (the same op — dedupe has already handled replays)', () => {
    expect(opWinsLww({ clientUpdatedAt: T1, opId: OP_AAA }, { updatedAt: T1, lastOpId: OP_AAA })).toBe(false);
  });
  it('the tiebreak is a TOTAL order (no third state) across arbitrary UUID pairs', () => {
    // Deterministic regardless of insertion history — convergence pinned.
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '11111111-1111-4111-8111-000000000abc',
    ];
    for (const a of ids) {
      for (const b of ids) {
        const forward = opWinsLww({ clientUpdatedAt: T1, opId: b }, { updatedAt: T1, lastOpId: a });
        const backward = opWinsLww({ clientUpdatedAt: T1, opId: a }, { updatedAt: T1, lastOpId: b });
        expect(forward).toBe(b > a);
        expect(backward).toBe(a > b);
        expect(forward || backward || a === b).toBe(true); // no third state
      }
    }
  });
});

describe('LWW: NULL last_op_id (REST-created rows — user foods only) loses to any sync op', () => {
  it('even an older-timestamped op wins', () => {
    expect(opWinsLww({ clientUpdatedAt: T1, opId: OP_AAA }, { updatedAt: T2, lastOpId: null })).toBe(true);
  });
  it('an equal-timestamp op wins too', () => {
    expect(opWinsLww({ clientUpdatedAt: T2, opId: OP_AAA }, { updatedAt: T2, lastOpId: null })).toBe(true);
  });
});
