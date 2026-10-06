import { describe, expect, it } from 'vitest';
import { fixtureUserUuid, resolveUserCandidates } from './user-context.js';

describe('user-context resolution semantics (I2)', () => {
  it('absent when there are zero candidates', () => {
    expect(resolveUserCandidates('consumer', [])).toEqual({ status: 'absent' });
  });

  it('resolves a single well-shaped candidate', () => {
    const userId = fixtureUserUuid('a1');
    expect(resolveUserCandidates('consumer', [userId])).toEqual({
      status: 'resolved',
      context: { kind: 'consumer', userId },
    });
  });

  it('invalid on malformed ids (not a uuid)', () => {
    const result = resolveUserCandidates('consumer', ['not-a-uuid']);
    expect(result.status).toBe('invalid');
  });

  it('invalid on duplicated-but-malformed and empty-string candidates', () => {
    expect(resolveUserCandidates('admin', ['']).status).toBe('invalid');
    expect(resolveUserCandidates('driver', ['   ']).status).toBe('invalid');
  });

  it('ambiguous when two distinct candidates are present', () => {
    const result = resolveUserCandidates('consumer', [fixtureUserUuid('a1'), fixtureUserUuid('b2')]);
    expect(result.status).toBe('ambiguous');
  });

  it('resolves duplicated identical candidates (no ambiguity)', () => {
    const userId = fixtureUserUuid('a1');
    expect(resolveUserCandidates('vendor_branch', [userId, userId])).toEqual({
      status: 'resolved',
      context: { kind: 'vendor_branch', userId },
    });
  });

  it('rejects uppercase-free uuid shape checks consistently', () => {
    // Uppercase hex is still a uuid shape.
    expect(resolveUserCandidates('admin', ['00000000-0000-4000-8000-0000000000A1']).status).toBe('resolved');
    // Wrong version nibble is still shape-valid — version semantics are W2's concern.
    expect(resolveUserCandidates('admin', ['00000000-0000-1000-8000-0000000000a1']).status).toBe('resolved');
    // Truncated is not.
    expect(resolveUserCandidates('admin', ['00000000-0000-4000-8000-0000000000a']).status).toBe('invalid');
  });
});
