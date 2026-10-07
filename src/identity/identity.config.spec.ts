import { describe, expect, it } from 'vitest';
import { IDENTITY_DEFAULTS, validateIdentityConfig } from './identity.config.js';

/**
 * Identity configuration validation (I15, contract note §6): boot refusal on
 * invalid/placeholder values, PRD §8 initial defaults, and a redaction
 * contract on error messages (values are never echoed — I12).
 */

const BASE = { NODE_ENV: 'test' } as const;

describe('identity config validation', () => {
  it('defaults carry the contract §6 initial values when no keys are set', () => {
    const result = validateIdentityConfig({ ...BASE }, 'test');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.accessTokenTtlSeconds).toBe(IDENTITY_DEFAULTS.accessTokenTtlSeconds);
    expect(result.config.accessTokenTtlSeconds).toBe(900);
    expect(result.config.sessionTtlSeconds).toBe(2_592_000);
    expect(result.config.revocationWindowSeconds).toBe(60);
    expect(result.config.lockoutThresholdAttempts).toBe(3);
    expect(result.config.lockoutDurationSeconds).toBe(900);
    expect(result.config.recoveryTicketTtlSeconds).toBe(1_800);
    expect(result.config.argon2).toEqual({ memoryCostKiB: 65_536, timeCost: 3, parallelism: 1 });
    // development/test without a key: an ephemeral key is generated (never empty).
    expect(result.config.jwtSigningKey.length).toBeGreaterThanOrEqual(32);
  });

  it('changing a value changes the configuration (config points, not constants)', () => {
    const result = validateIdentityConfig(
      { ...BASE, IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS: '5', IDENTITY_LOCKOUT_DURATION_SECONDS: '60' },
      'test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.lockoutThresholdAttempts).toBe(5);
    expect(result.config.lockoutDurationSeconds).toBe(60);
  });

  it('out-of-range, non-integer, and garbage values refuse validation', () => {
    for (const env of [
      { IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS: '0' },
      { IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS: '-3' },
      { IDENTITY_ACCESS_TOKEN_TTL_SECONDS: 'abc' },
      { IDENTITY_SESSION_TTL_SECONDS: '1' },
      { IDENTITY_ARGON2_MEMORY_KIB: '100' },
    ]) {
      const result = validateIdentityConfig({ ...BASE, ...env }, 'test');
      expect(result.ok, JSON.stringify(env)).toBe(false);
    }
  });

  it('production without a configured signing key refuses (ephemeral keys are dev-only)', () => {
    const result = validateIdentityConfig({ NODE_ENV: 'production' }, 'production');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join(' ')).toContain('IDENTITY_JWT_SIGNING_KEY');
  });

  it('placeholder-class signing keys refuse with a non-leaking message', () => {
    for (const key of ['changeme-changeme-changeme-1234567890', 'test-secret-test-secret-test-secret']) {
      const result = validateIdentityConfig({ ...BASE, IDENTITY_JWT_SIGNING_KEY: key }, 'test');
      expect(result.ok, 'placeholder key must refuse').toBe(false);
      if (result.ok) {
        return;
      }
      const message = result.errors.join(' ');
      expect(message).toContain('placeholder-class');
      // The refused value never appears in the message (I12).
      expect(message).not.toContain(key);
    }
  });

  it('a strong configured key is accepted verbatim and short keys refuse', () => {
    const strong = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
    const ok = validateIdentityConfig({ ...BASE, IDENTITY_JWT_SIGNING_KEY: strong }, 'test');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.jwtSigningKey).toBe(strong);
    }
    const short = validateIdentityConfig({ ...BASE, IDENTITY_JWT_SIGNING_KEY: 'short' }, 'test');
    expect(short.ok).toBe(false);
  });
});
