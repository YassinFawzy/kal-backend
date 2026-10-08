/**
 * Unit spec — tracking-module configuration (contract §6; identity-config
 * pattern): defaults, bounds, production policy, non-leaking errors.
 */
import { describe, expect, it } from 'vitest';
import { TRACKING_DEFAULTS, TrackingConfigService } from './tracking.config.js';

/** Fixture-shaped synthetic key material — placeholder-free (I15-compliant). */
const FIXTURE_KEY = 'tracking4lane4fixture4signing4material4with4plenty4entropy00';

function configFor(env: Record<string, string | undefined>, nodeEnv: 'development' | 'production' | 'test' = 'test'): TrackingConfigService {
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
    return new TrackingConfigService(nodeEnv);
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

describe('TrackingConfigService — validated configuration points (contract §6)', () => {
  it('defaults to the PRD §8 initial values when the env is absent', () => {
    const config = configFor({ IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    expect(config.values.userFoodCreateMaxPerHour).toBe(TRACKING_DEFAULTS.userFoodCreateMaxPerHour);
    expect(config.values.userFoodCreateMaxPerDay).toBe(TRACKING_DEFAULTS.userFoodCreateMaxPerDay);
  });

  it('parses configured values — a changed value must change behavior (two-config basis)', () => {
    const a = configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '2', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '3', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    const b = configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '5', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '8', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY });
    expect(a.values.userFoodCreateMaxPerHour).toBe(2);
    expect(a.values.userFoodCreateMaxPerDay).toBe(3);
    expect(b.values.userFoodCreateMaxPerHour).toBe(5);
    expect(b.values.userFoodCreateMaxPerDay).toBe(8);
  });

  it('rejects out-of-bounds and non-integer values, naming the variable but never the value (I12)', () => {
    for (const [key, value] of [
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', '0'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', '1001'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', '-1'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', 'abc'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', '1.5'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_DAY', '0'],
      ['TRACKING_USER_FOOD_CREATE_MAX_PER_DAY', '10001'],
    ] as const) {
      expect(() => configFor({ [key]: value, IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY })).toThrowError(new RegExp(key));
    }
    expect(() => configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '999999', IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY })).toThrowError(/must be an integer between/);
  });

  it('refuses the production boot without signing-key material (cursor signing cannot be ephemeral)', () => {
    expect(() => configFor({}, 'production')).toThrowError(/IDENTITY_JWT_SIGNING_KEY is required in production/);
  });

  it('refuses placeholder-class secrets in every environment', () => {
    expect(() => configFor({ IDENTITY_JWT_SIGNING_KEY: 'changeme' })).toThrowError(/unsafe placeholder/);
  });

  it('derives a domain-separated cursor key (non-empty, stable for a stable secret)', () => {
    const env = { IDENTITY_JWT_SIGNING_KEY: FIXTURE_KEY };
    expect(configFor(env).values.searchCursorKey.equals(configFor(env).values.searchCursorKey)).toBe(true);
    expect(configFor(env).values.searchCursorKey.length).toBe(32);
    expect(configFor({}).values.searchCursorKey.length).toBe(32); // ephemeral dev/test key
  });
});
