/**
 * Kal — tracking-module configuration (I15, wave-03 contract note §6).
 *
 * Every threshold in the frozen contract §6 that belongs to this module's
 * surface is a validated configuration point carrying its PRD §8 /
 * engineering-initial value (HD-23-tunable at soft launch) — NO threshold is
 * hardcoded in behavior; a two-config proof (changing the value changes the
 * behavior) is a required test for both limiter windows. Validation runs in
 * the service constructor, i.e. during module-graph initialization BEFORE any
 * listener binds, so an unsafe configuration refuses the boot in every path —
 * the same fail-fast semantics as the wave-01 ConfigService and the wave-02
 * IdentityConfigService (the established pattern; this class mirrors it).
 *
 * Redaction contract (I12/I15): error messages name the variable and the
 * failure CLASS only; values are never echoed.
 *
 * Environment keys (documented additively in `.env.example`):
 *   TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR — default 20 (PRD §8; bounds 1–1000).
 *   TRACKING_USER_FOOD_CREATE_MAX_PER_DAY  — default 100 (PRD §8; bounds 1–10000).
 *
 * Cursor signing secret: the search-surface pagination cursors are
 * HMAC-tagged, user-bound tokens (conventions §2; contract §3 — a foreign
 * cursor never yields rows). The process's single validated secret material
 * is `IDENTITY_JWT_SIGNING_KEY`; the tracking cursor key is a
 * domain-separated HMAC derivation of it (`kal:tracking:search-cursor:v1` —
 * distinct keys, never the raw secret), exactly the per-purpose key-derivation
 * posture identity's TokenService establishes. The production/dev policy
 * mirrors identity's: REQUIRED and placeholder-checked in `production`
 * (refuses the boot), ephemeral-random per boot in `development`/`test` when
 * absent (process-local tokens; never weakens the placeholder rejection).
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { isPlaceholderSecret } from '../../config/validate-config.js';
import type { KalEnv } from '../../config/validate-config.js';

/** Contract note §6 initial values (PRD §8) for the shared user-food limiter. */
export const TRACKING_DEFAULTS = {
  userFoodCreateMaxPerHour: 20,
  userFoodCreateMaxPerDay: 100,
} as const;

export interface TrackingConfig {
  /** Rolling-hour user-food create cap (shared REST + sync limiter, §1.7). */
  readonly userFoodCreateMaxPerHour: number;
  /** Rolling-24 h user-food create cap (shared REST + sync limiter, §1.7). */
  readonly userFoodCreateMaxPerDay: number;
  /** Domain-separated HMAC key for search-pagination cursors (never logged). */
  readonly searchCursorKey: Buffer;
}

export type TrackingConfigValidationResult =
  | { readonly ok: true; readonly config: TrackingConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

interface BoundedIntSpec {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

/**
 * Parses one bounded non-negative integer environment variable. Error
 * messages name the variable and bounds — never the received value.
 */
function boundedInt(
  env: Record<string, string | undefined>,
  name: string,
  spec: BoundedIntSpec,
): { value: number } | { error: string } {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) {
    return { value: spec.fallback };
  }
  if (!/^[0-9]+$/u.test(raw)) {
    return { error: `${name} must be an integer between ${spec.min} and ${spec.max}.` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    return { error: `${name} must be an integer between ${spec.min} and ${spec.max}.` };
  }
  return { value };
}

function validateTrackingConfig(
  env: Record<string, string | undefined>,
  nodeEnv: KalEnv,
): TrackingConfigValidationResult {
  const errors: string[] = [];

  const hour = boundedInt(env, 'TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR', {
    min: 1,
    max: 1000,
    fallback: TRACKING_DEFAULTS.userFoodCreateMaxPerHour,
  });
  if ('error' in hour) errors.push(hour.error);

  const day = boundedInt(env, 'TRACKING_USER_FOOD_CREATE_MAX_PER_DAY', {
    min: 1,
    max: 10000,
    fallback: TRACKING_DEFAULTS.userFoodCreateMaxPerDay,
  });
  if ('error' in day) errors.push(day.error);

  // Cursor signing secret — the same validated material identity uses, with
  // the same production policy (identity.config.ts pattern; never echoed).
  const raw = env['IDENTITY_JWT_SIGNING_KEY'];
  let searchCursorKey: Buffer;
  if (raw === undefined || raw.length === 0) {
    if (nodeEnv === 'production') {
      errors.push('IDENTITY_JWT_SIGNING_KEY is required in production (cursor signing cannot use an ephemeral key).');
      searchCursorKey = Buffer.alloc(0);
    } else {
      // Ephemeral random per boot — process-local tokens, nothing persisted.
      searchCursorKey = createHmac('sha256', randomBytes(32))
        .update('kal:tracking:search-cursor:v1')
        .digest();
    }
  } else if (isPlaceholderSecret(raw)) {
    errors.push('IDENTITY_JWT_SIGNING_KEY is set to an unsafe placeholder value.');
    searchCursorKey = Buffer.alloc(0);
  } else {
    searchCursorKey = createHmac('sha256', raw).update('kal:tracking:search-cursor:v1').digest();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      userFoodCreateMaxPerHour: (hour as { value: number }).value,
      userFoodCreateMaxPerDay: (day as { value: number }).value,
      searchCursorKey,
    },
  };
}

@Injectable()
export class TrackingConfigService {
  readonly values: TrackingConfig;

  constructor(nodeEnv: KalEnv) {
    const result = validateTrackingConfig(process.env, nodeEnv);
    if (!result.ok) {
      // Fail fast BEFORE any listener binds (I15). Messages name variables and
      // failure classes only — never values (I12/I15).
      throw new Error(`tracking configuration is invalid: ${result.errors.join(' ')}`);
    }
    this.values = result.config;
  }
}
