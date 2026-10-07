/**
 * Unit spec — issuance-mirror pure helpers (F-S4-1b timing equalization).
 *
 * The database-backed behavior of the equalizer lives in
 * test/recovery-equalization.e2e-spec.ts; this file pins the PURE pieces of
 * `recovery.service.ts` that the mirror's safety rests on:
 *
 *   - `isEligibleEqualizerSentinel` — the username-squatter immunity guard:
 *     ONLY a closed account with a NULL password hash may ever be picked as
 *     the mirror sentinel. An active (or any credentialed) account holding
 *     the canonical `kal_eq_sentinel` username is never eligible, and the
 *     resolver falls back to a randomized name.
 *   - `deriveEqualizerPoolRowId` — the deterministic pool-row id derivation
 *     that makes `INSERT ... ON CONFLICT DO NOTHING` idempotent across any
 *     number of process boots (EXACTLY K rows, no duplicate pools) while the
 *     ids stay unguessable (HMAC-derived, not sequential).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveEqualizerPoolRowId,
  EQUALIZER_POOL_SIZE,
  EQUALIZER_SENTINEL_FALLBACK_PREFIX,
  EQUALIZER_SENTINEL_USERNAME,
  isEligibleEqualizerSentinel,
} from './recovery.service.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('isEligibleEqualizerSentinel (username-squatter immunity guard)', () => {
  it('accepts ONLY the closed + credential-less shape (the mirror sentinel)', () => {
    expect(isEligibleEqualizerSentinel({ id: 'd0e1f2a3-b4c5-4d6e-8f90-112233445566', status: 'closed', passwordHash: null })).toBe(true);
  });

  it('refuses every shape a username squatter can present', () => {
    const id = 'd0e1f2a3-b4c5-4d6e-8f90-112233445566';
    // An ACTIVE account holding the canonical name — never picked.
    expect(isEligibleEqualizerSentinel({ id, status: 'active', passwordHash: null })).toBe(false);
    // A closed account that still carries a credential — never picked.
    expect(isEligibleEqualizerSentinel({ id, status: 'closed', passwordHash: '$argon2id$fixture' })).toBe(false);
    // Active + credentialed (the only shape W2 signup can create).
    expect(isEligibleEqualizerSentinel({ id, status: 'active', passwordHash: '$argon2id$fixture' })).toBe(false);
    // The other lifecycle state is equally ineligible.
    expect(isEligibleEqualizerSentinel({ id, status: 'closure_requested', passwordHash: null })).toBe(false);
    // Absent row — nothing to pick.
    expect(isEligibleEqualizerSentinel(null)).toBe(false);
  });

  it('the canonical username shape satisfies the migration username CHECK (bootstrap INSERT cannot 42501)', () => {
    expect(EQUALIZER_SENTINEL_USERNAME).toMatch(/^[a-z0-9_]{3,30}$/u);
    const fallback = `${EQUALIZER_SENTINEL_FALLBACK_PREFIX}${'0123456789ab'}`;
    expect(fallback).toMatch(/^[a-z0-9_]{3,30}$/u);
    expect(fallback.length).toBeLessThanOrEqual(30);
  });
});

describe('deriveEqualizerPoolRowId (idempotent, unguessable pool composition)', () => {
  const SENTINEL = 'd0e1f2a3-b4c5-4d6e-8f90-112233445566';

  it('derives valid UUIDv4-shaped ids', () => {
    for (let index = 0; index < EQUALIZER_POOL_SIZE; index++) {
      expect(deriveEqualizerPoolRowId(SENTINEL, index)).toMatch(UUID_V4);
    }
  });

  it('is deterministic — the same sentinel yields the same pool on every boot (no duplicate pools)', () => {
    const first = Array.from({ length: EQUALIZER_POOL_SIZE }, (_unused, index) => deriveEqualizerPoolRowId(SENTINEL, index));
    const second = Array.from({ length: EQUALIZER_POOL_SIZE }, (_unused, index) => deriveEqualizerPoolRowId(SENTINEL, index));
    expect(first).toEqual(second);
  });

  it('is injective over the pool and changes with the sentinel', () => {
    const ids = new Set(Array.from({ length: EQUALIZER_POOL_SIZE }, (_unused, index) => deriveEqualizerPoolRowId(SENTINEL, index)));
    expect(ids.size).toBe(EQUALIZER_POOL_SIZE);
    expect(deriveEqualizerPoolRowId(SENTINEL, 0)).not.toBe(deriveEqualizerPoolRowId('00000000-0000-4000-8000-000000000000', 0));
  });
});
