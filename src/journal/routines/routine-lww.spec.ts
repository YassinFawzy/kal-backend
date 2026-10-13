/**
 * Kal — the frozen journal LWW comparator unit suite (wave-03 §1.4
 * inherited verbatim; transcription pin of the tracking comparator).
 */
import { describe, expect, it } from 'vitest';
import { opWinsLww } from './routine-lww.js';

const at = (iso: string): Date => new Date(iso);

describe('opWinsLww — the frozen (clientUpdatedAt, opId) total order', () => {
  it('higher clientUpdatedAt wins', () => {
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T10:00:00Z'), opId: 'a' }, { updatedAt: at('2026-10-12T09:00:00Z'), lastOpId: 'b' })).toBe(true);
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T09:00:00Z'), opId: 'b' }, { updatedAt: at('2026-10-12T10:00:00Z'), lastOpId: 'a' })).toBe(false);
  });

  it('equal instants break on the lexicographically HIGHER opId', () => {
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T10:00:00Z'), opId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, { updatedAt: at('2026-10-12T10:00:00Z'), lastOpId: '11111111-1111-4111-8111-111111111111' })).toBe(true);
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T10:00:00Z'), opId: '11111111-1111-4111-8111-111111111111' }, { updatedAt: at('2026-10-12T10:00:00Z'), lastOpId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })).toBe(false);
  });

  it('a replayed identical op never wins (no self-beating; convergence without duplication)', () => {
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T10:00:00Z'), opId: 'op' }, { updatedAt: at('2026-10-12T10:00:00Z'), lastOpId: 'op' })).toBe(false);
  });

  it('a comparator-less row loses to any sync op (fail-closed parity)', () => {
    expect(opWinsLww({ clientUpdatedAt: at('2026-10-12T10:00:00Z'), opId: 'op' }, { updatedAt: at('2099-01-01T00:00:00Z'), lastOpId: null })).toBe(true);
  });
});
