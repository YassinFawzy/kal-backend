/**
 * Kal — the journal session LWW comparator (w3 §1.4, inherited verbatim by
 * w4 §1; frozen): higher `clientUpdatedAt` wins; on equal timestamps the
 * HIGHER opId (lexicographic UUID compare) wins — a deterministic total
 * order with no third state.
 */
import { describe, expect, it } from 'vitest';
import { opWinsSessionLww } from './session-lww.js';

const T0 = new Date('2026-10-12T10:00:00.000Z');
const T1 = new Date('2026-10-12T10:00:00.001Z');
const OP_A = '7d0f0000-0000-4000-8000-00000000000a';
const OP_B = '7d0f0000-0000-4000-8000-00000000000b';

describe('session LWW (§1.4 — the frozen comparator)', () => {
  it('a strictly newer clientUpdatedAt wins; a strictly older one loses', () => {
    expect(opWinsSessionLww({ clientUpdatedAt: T1, opId: OP_A }, { updatedAt: T0, lastOpId: OP_B })).toBe(true);
    expect(opWinsSessionLww({ clientUpdatedAt: T0, opId: OP_B }, { updatedAt: T1, lastOpId: OP_A })).toBe(false);
  });

  it('equal timestamps break on the HIGHER opId, lexicographically (the deterministic tiebreak)', () => {
    expect(opWinsSessionLww({ clientUpdatedAt: T0, opId: OP_B }, { updatedAt: T0, lastOpId: OP_A })).toBe(true);
    expect(opWinsSessionLww({ clientUpdatedAt: T0, opId: OP_A }, { updatedAt: T0, lastOpId: OP_B })).toBe(false);
    expect(opWinsSessionLww({ clientUpdatedAt: T0, opId: OP_A }, { updatedAt: T0, lastOpId: OP_A })).toBe(false); // equal (op, row) — never re-writes
  });

  it('a row without a comparator (defensive; no REST path exists for sessions) loses to any sync op', () => {
    expect(opWinsSessionLww({ clientUpdatedAt: T0, opId: OP_A }, { updatedAt: T0, lastOpId: null })).toBe(true);
  });
});
