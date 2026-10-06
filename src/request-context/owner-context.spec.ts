import { describe, expect, it } from 'vitest';
import { fixtureOwnerUuid, resolveOwnerCandidates } from './owner-context.js';

describe('owner-context resolution semantics (I2)', () => {
  it('absent when there are zero candidates', () => {
    expect(resolveOwnerCandidates('consumer', [])).toEqual({ status: 'absent' });
  });

  it('resolves a single well-shaped candidate', () => {
    const ownerId = fixtureOwnerUuid('a1');
    expect(resolveOwnerCandidates('consumer', [ownerId])).toEqual({
      status: 'resolved',
      context: { kind: 'consumer', ownerId },
    });
  });

  it('invalid on malformed ids (not a uuid)', () => {
    const result = resolveOwnerCandidates('consumer', ['not-a-uuid']);
    expect(result.status).toBe('invalid');
  });

  it('invalid on duplicated-but-malformed and empty-string candidates', () => {
    expect(resolveOwnerCandidates('admin', ['']).status).toBe('invalid');
    expect(resolveOwnerCandidates('driver', ['   ']).status).toBe('invalid');
  });

  it('ambiguous when two distinct candidates are present', () => {
    const result = resolveOwnerCandidates('consumer', [fixtureOwnerUuid('a1'), fixtureOwnerUuid('b2')]);
    expect(result.status).toBe('ambiguous');
  });

  it('resolves duplicated identical candidates (no ambiguity)', () => {
    const ownerId = fixtureOwnerUuid('a1');
    expect(resolveOwnerCandidates('vendor_branch', [ownerId, ownerId])).toEqual({
      status: 'resolved',
      context: { kind: 'vendor_branch', ownerId },
    });
  });

  it('rejects uppercase-free uuid shape checks consistently', () => {
    // Uppercase hex is still a uuid shape.
    expect(resolveOwnerCandidates('admin', ['00000000-0000-4000-8000-0000000000A1']).status).toBe('resolved');
    // Wrong version nibble is still shape-valid — version semantics are W2's concern.
    expect(resolveOwnerCandidates('admin', ['00000000-0000-1000-8000-0000000000a1']).status).toBe('resolved');
    // Truncated is not.
    expect(resolveOwnerCandidates('admin', ['00000000-0000-4000-8000-0000000000a']).status).toBe('invalid');
  });
});
