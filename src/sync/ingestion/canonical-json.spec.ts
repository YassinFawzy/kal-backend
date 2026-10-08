/**
 * Unit — canonical JSON serialization and the request digest (conventions
 * §3; wave-03 contract §1.2).
 *
 * Pinned: semantic payload equality (key order and whitespace independence),
 * array-order sensitivity (op order is the frozen semantic), number-form
 * independence (`1` vs `1.0` parse to the same payload), digest stability
 * (SHA-256 hex), and inequality on any data change (the 409 detector).
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonString, canonicalRequestDigest, sha256Hex } from './canonical-json.js';

describe('canonicalJsonString', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJsonString({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order (op order is semantic)', () => {
    expect(canonicalJsonString([{ opId: 'a' }, { opId: 'b' }])).toBe('[{"opId":"a"},{"opId":"b"}]');
    expect(canonicalJsonString([{ opId: 'b' }, { opId: 'a' }])).toBe('[{"opId":"b"},{"opId":"a"}]');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJsonString({ a: [1, 2], b: 'x y' })).toBe('{"a":[1,2],"b":"x y"}');
  });
});

describe('canonicalRequestDigest (the changed-payload detector)', () => {
  const body = {
    deviceId: 'device-01',
    ops: [
      { opId: 'op-1', kind: 'favorite', entityId: 'e-1', action: 'create', clientUpdatedAt: '2026-10-08T07:00:00Z', payload: { foodId: 'f-1' } },
    ],
  };

  it('same payload in different key order ⇒ same digest (semantic equality)', () => {
    const reordered = {
      ops: [
        { payload: { foodId: 'f-1' }, clientUpdatedAt: '2026-10-08T07:00:00Z', action: 'create', entityId: 'e-1', kind: 'favorite', opId: 'op-1' },
      ],
      deviceId: 'device-01',
    };
    expect(canonicalRequestDigest(reordered)).toBe(canonicalRequestDigest(body));
  });

  it('any data change ⇒ different digest (409 detector)', () => {
    const changed = structuredClone(body);
    (changed.ops[0] as Record<string, unknown>)['clientUpdatedAt'] = '2026-10-08T07:00:01Z';
    expect(canonicalRequestDigest(changed)).not.toBe(canonicalRequestDigest(body));

    const otherDevice = structuredClone(body);
    otherDevice['deviceId'] = 'device-02';
    expect(canonicalRequestDigest(otherDevice)).not.toBe(canonicalRequestDigest(body));
  });

  it('is a 64-char lowercase hex string (the column CHECK domain)', () => {
    expect(canonicalRequestDigest(body)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('number forms that parse equal are the same payload', () => {
    const a = { x: 1 };
    const b = { x: 1.0 };
    expect(canonicalRequestDigest(a)).toBe(canonicalRequestDigest(b));
  });
});

describe('sha256Hex (byte-stability substrate)', () => {
  it('is deterministic', () => {
    expect(sha256Hex('kal')).toBe(sha256Hex('kal'));
    expect(sha256Hex('kal')).toMatch(/^[0-9a-f]{64}$/u);
  });
});
