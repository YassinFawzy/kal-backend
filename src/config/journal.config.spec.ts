/**
 * Unit spec — journal-module configuration (w4 contract note §6; the
 * tracking/identity config pattern): defaults, bounds, production policy,
 * non-leaking errors. Out-of-bounds values must refuse the boot (I15).
 */
import { describe, expect, it } from 'vitest';
import { JOURNAL_DEFAULTS, JournalConfigService } from './journal.config.js';

/** Fixture-shaped synthetic key material — placeholder-free (I15-compliant). */
const FIXTURE_KEY = 'journal4lane4fixture4signing4material4with4plenty4entropy01';

function configFor(env: Record<string, string | undefined>, nodeEnv: 'development' | 'production' | 'test' = 'test'): JournalConfigService {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return new JournalConfigService(nodeEnv);
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe('JournalConfigService — validated configuration points (w4 contract §6)', () => {
  it('defaults to the engineering-initial values (DEFAULT PENDING APPROVAL, ledger §7-B)', () => {
    const config = configFor({ IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    expect(config.values.sessionCreateMaxPerHour).toBe(JOURNAL_DEFAULTS.sessionCreateMaxPerHour);
    expect(config.values.sessionCreateMaxPerDay).toBe(JOURNAL_DEFAULTS.sessionCreateMaxPerDay);
  });

  it('parses configured values — a changed value must change behavior (two-config basis)', () => {
    const a = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '2', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '3', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    const b = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '5', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '8', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    expect(a.values.sessionCreateMaxPerHour).toBe(2);
    expect(a.values.sessionCreateMaxPerDay).toBe(3);
    expect(b.values.sessionCreateMaxPerHour).toBe(5);
    expect(b.values.sessionCreateMaxPerDay).toBe(8);
  });

  it('rejects out-of-bounds and non-integer values, naming the variable but never the value (I12)', () => {
    for (const [key, value] of [
      ['JOURNAL_SESSION_CREATE_MAX_PER_HOUR', '0'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_HOUR', '101'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_HOUR', '-1'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_HOUR', 'abc'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_HOUR', '1.5'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_DAY', '0'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_DAY', '1001'],
      ['JOURNAL_SESSION_CREATE_MAX_PER_DAY', 'ten'],
    ] as const) {
      expect(() => configFor({ [key]: value, IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY })).toThrowError(new RegExp(key));
      // No value echo (I12): checked for multi-char values only — the fixed
      // bounds text legitimately contains single digits ("1 and 100").
      if (value.length > 2) {
        try {
          configFor({ [key]: value, IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          expect(message).not.toContain(value);
        }
      }
    }
  });

  it('accepts the exact bounds (1..100 hour, 1..1000 day)', () => {
    expect(configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '1', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY }).values.sessionCreateMaxPerHour).toBe(1);
    expect(configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '100', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY }).values.sessionCreateMaxPerDay).toBe(1);
  });

  it('derives a domain-separated search-cursor key (never the raw secret, distinct from tracking)', () => {
    const config = configFor({ IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    expect(config.values.searchCursorKey.length).toBe(32);
    expect(config.values.searchCursorKey.toString('hex')).not.toBe(Buffer.from(FIXTURE_KEY).subarray(0, 32).toString('hex'));
  });

  it('production requires the signing key and refuses placeholder-class values (I15)', () => {
    expect(() => configFor({}, 'production')).toThrowError(/IDENTITY_JWT_SIGNING_KEY/);
    expect(() => configFor({ IDENTITY_JWT_SIGNING_KEY: 'changeme' }, 'production')).toThrowError(/placeholder/);
    // development/test derive an ephemeral key when absent — boot proceeds.
    const ephemeral = configFor({});
    expect(ephemeral.values.searchCursorKey.length).toBe(32);
  });
});
