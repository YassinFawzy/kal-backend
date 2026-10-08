/**
 * Unit — sync-module configuration (wave-03 contract §6, I15).
 *
 * Pinned: default values, exact bounds, fail-fast on out-of-bounds /
 * non-integer values, non-leaking error messages (values never echoed), and
 * the two-config proof (changing a config value changes the validated
 * behavior — no threshold is hardcoded).
 */
import { describe, expect, it } from 'vitest';
import {
  SYNC_DEFAULTS,
  SyncConfigService,
  validateSyncConfig,
} from './sync.config.js';

function envWith(overrides: Record<string, string>): Record<string, string | undefined> {
  return { ...overrides };
}

describe('validateSyncConfig (§6)', () => {
  it('defaults to the contract-initial values when the environment is silent', () => {
    const result = validateSyncConfig(envWith({}));
    expect(result).toEqual({
      ok: true,
      config: {
        maxOpsPerBatch: SYNC_DEFAULTS.maxOpsPerBatch,
        idempotencyKeyRetentionSeconds: SYNC_DEFAULTS.idempotencyKeyRetentionSeconds,
      },
    });
    expect(SYNC_DEFAULTS.maxOpsPerBatch).toBe(100);
    expect(SYNC_DEFAULTS.idempotencyKeyRetentionSeconds).toBe(2_592_000);
  });

  it('accepts in-bounds values', () => {
    const result = validateSyncConfig(
      envWith({ SYNC_MAX_OPS_PER_BATCH: '1', SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '3600' }),
    );
    expect(result).toEqual({ ok: true, config: { maxOpsPerBatch: 1, idempotencyKeyRetentionSeconds: 3600 } });
    const upper = validateSyncConfig(
      envWith({ SYNC_MAX_OPS_PER_BATCH: '500', SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '7776000' }),
    );
    expect(upper).toEqual({
      ok: true,
      config: { maxOpsPerBatch: 500, idempotencyKeyRetentionSeconds: 7_776_000 },
    });
  });

  it.each([
    ['SYNC_MAX_OPS_PER_BATCH', '0'],
    ['SYNC_MAX_OPS_PER_BATCH', '501'],
    ['SYNC_MAX_OPS_PER_BATCH', '-3'],
    ['SYNC_MAX_OPS_PER_BATCH', 'abc'],
    ['SYNC_MAX_OPS_PER_BATCH', '1.5'],
    ['SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS', '3599'],
    ['SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS', '7776001'],
    ['SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS', 'nope'],
  ])('refuses out-of-bounds/malformed %s=%s', (name, value) => {
    const result = validateSyncConfig(envWith({ [name]: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('error messages name the variable and never echo the received value', () => {
    const secretLooking = 'totally-secret-value-9817';
    const result = validateSyncConfig(envWith({ SYNC_MAX_OPS_PER_BATCH: secretLooking }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(' ');
      expect(joined).toContain('SYNC_MAX_OPS_PER_BATCH');
      expect(joined).not.toContain(secretLooking);
    }
  });
});

describe('SyncConfigService (boot-path, I15)', () => {
  it('constructs with defaults and exposes the values', () => {
    const service = new SyncConfigService(envWith({}));
    expect(service.values.maxOpsPerBatch).toBe(100);
    expect(service.values.idempotencyKeyRetentionSeconds).toBe(2_592_000);
  });

  it('refuses to construct (serve) when a value is out of bounds — fail before any listener binds', () => {
    expect(() => new SyncConfigService(envWith({ SYNC_MAX_OPS_PER_BATCH: '99999' }))).toThrow(
      /refusing to start/u,
    );
  });

  it('failure messages never contain the refused value', () => {
    let message = '';
    try {
      new SyncConfigService(envWith({ SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '12' })); // eslint-disable-line no-new
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS');
    expect(message).not.toContain('12');
  });
});

describe('two-config proofs (§6 — values are behavior, not constants)', () => {
  it('the batch cap is whatever the environment validated', () => {
    const strict = new SyncConfigService(envWith({ SYNC_MAX_OPS_PER_BATCH: '2' })).values;
    const loose = new SyncConfigService(envWith({ SYNC_MAX_OPS_PER_BATCH: '200' })).values;
    expect(strict.maxOpsPerBatch).toBe(2);
    expect(loose.maxOpsPerBatch).toBe(200);
  });

  it('the retention window is whatever the environment validated', () => {
    const short = new SyncConfigService(envWith({ SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '3600' })).values;
    const long = new SyncConfigService(envWith({ SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '7776000' })).values;
    expect(short.idempotencyKeyRetentionSeconds).toBe(3_600);
    expect(long.idempotencyKeyRetentionSeconds).toBe(7_776_000);
  });
});
