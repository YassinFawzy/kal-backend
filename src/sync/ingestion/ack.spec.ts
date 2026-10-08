/**
 * Unit — the ingestion ack envelope (wave-03 contract §1.2).
 *
 * Pinned: the frozen field projection (`opId`+`outcome` always; `code`+
 * `retryable` exactly when `outcome` is `rejected`; nothing else — the ack
 * never echoes payloads or health data, I12), the outcome vocabulary, and
 * canonical byte stability (key-order independence of the serialization).
 */
import { describe, expect, it } from 'vitest';
import { buildAckEnvelope, serializeAckEnvelope } from './ack.js';

describe('ack envelope (§1.2 — 200 {"results": [...]})', () => {
  it('projects applied/duplicate results without code/retryable', () => {
    const envelope = buildAckEnvelope([
      { opId: 'op-1', outcome: 'applied' },
      { opId: 'op-2', outcome: 'duplicate' },
    ]);
    expect(envelope.results).toEqual([
      { opId: 'op-1', outcome: 'applied' },
      { opId: 'op-2', outcome: 'duplicate' },
    ]);
    expect(Object.keys(envelope.results[0] ?? {}).sort()).toEqual(['opId', 'outcome']);
  });

  it('projects rejected results with code and retryable', () => {
    const envelope = buildAckEnvelope([
      { opId: 'op-1', outcome: 'rejected', code: 'rejected_validation', retryable: false },
      { opId: 'op-2', outcome: 'rejected', code: 'rejected_rate_limited', retryable: true },
    ]);
    expect(envelope.results[0]).toEqual({
      opId: 'op-1',
      outcome: 'rejected',
      code: 'rejected_validation',
      retryable: false,
    });
    expect(envelope.results[1]).toEqual({
      opId: 'op-2',
      outcome: 'rejected',
      code: 'rejected_rate_limited',
      retryable: true,
    });
  });

  it('keeps request order (the frozen ack ordering)', () => {
    const envelope = buildAckEnvelope([
      { opId: 'c', outcome: 'applied' },
      { opId: 'a', outcome: 'applied' },
      { opId: 'b', outcome: 'applied' },
    ]);
    expect(envelope.results.map((r) => r.opId)).toEqual(['c', 'a', 'b']);
  });
});

describe('canonical byte serialization (recorded-outcome replay stability)', () => {
  it('the same envelope always serializes to the same bytes regardless of construction key order', () => {
    const a = { results: [{ opId: 'op-1', outcome: 'rejected', code: 'rejected_conflict', retryable: false }] };
    // JSONB round-trip shape: keys re-sorted (code before opId lexicographically).
    const b = { results: [{ code: 'rejected_conflict', opId: 'op-1', outcome: 'rejected', retryable: false }] };
    expect(serializeAckEnvelope(a as never)).toBe(serializeAckEnvelope(b as never));
    expect(serializeAckEnvelope(a as never)).toBe(
      '{"results":[{"code":"rejected_conflict","opId":"op-1","outcome":"rejected","retryable":false}]}',
    );
  });

  it('a replayed stored envelope (JSONB round-trip) is byte-identical to the original serialization', () => {
    const original = buildAckEnvelope([
      { opId: 'op-1', outcome: 'applied' },
      { opId: 'op-2', outcome: 'duplicate' },
    ]);
    const originalBytes = serializeAckEnvelope(original);
    // Simulate the JSONB storage round-trip (key reordering, no semantics change).
    const roundTripped = JSON.parse(originalBytes) as unknown;
    expect(serializeAckEnvelope(roundTripped as never)).toBe(originalBytes);
  });
});
