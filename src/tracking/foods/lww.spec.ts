/**
 * Unit spec — the LWW comparator (contract §1.4): deterministic total order
 * `(clientUpdatedAt, opId)`; REST-created rows (last_op_id NULL) lose to any
 * sync op; equal (timestamp, opId) replays never win twice (replay safety).
 */
import { describe, expect, it } from 'vitest';
import { lwwOpWins } from './lww.js';

const T0 = new Date('2026-10-08T07:00:00.000Z');

describe('lwwOpWins', () => {
  it('higher clientUpdatedAt wins regardless of opId order', () => {
    expect(lwwOpWins(T0.getTime() + 1, 'a', T0, 'f')).toBe(true);
    expect(lwwOpWins(T0.getTime() - 1, 'f', T0, 'a')).toBe(false);
  });

  it('on equal timestamps the lexicographically higher opId wins', () => {
    expect(lwwOpWins(T0.getTime(), 'ffffffff-1111-4111-8111-111111111111', T0, 'aaaa0000-1111-4111-8111-111111111111')).toBe(true);
    expect(lwwOpWins(T0.getTime(), 'aaaa0000-1111-4111-8111-111111111111', T0, 'ffffffff-1111-4111-8111-111111111111')).toBe(false);
  });

  it('REST-created rows (last_op_id NULL) lose to ANY sync op — the contract is unconditional (§1.4)', () => {
    expect(lwwOpWins(T0.getTime(), 'aaaa0000-1111-4111-8111-111111111111', T0, null)).toBe(true);
    expect(lwwOpWins(T0.getTime() - 5_000, 'aaaa0000-1111-4111-8111-111111111111', T0, null)).toBe(true);
    expect(lwwOpWins(T0.getTime() + 5_000, 'aaaa0000-1111-4111-8111-111111111111', T0, null)).toBe(true);
  });

  it('an equal (timestamp, opId) replay never wins — handlers are replay-safe under batch retry (I9)', () => {
    const opId = 'aaaa0000-1111-4111-8111-111111111111';
    expect(lwwOpWins(T0.getTime(), opId, T0, opId)).toBe(false);
  });
});
