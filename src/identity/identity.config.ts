/**
 * Kal — identity-module configuration (I15, wave-02 contract note §6).
 *
 * Every threshold in `docs/api/wave-02-contract.md` §6 is a validated
 * configuration point carrying the PRD §8 initial value (HD-23-tunable at
 * soft launch) — no threshold is hardcoded in behavior. Validation runs in
 * the service constructor, i.e. during module-graph initialization BEFORE
 * any listener binds, so an unsafe configuration refuses the boot in every
 * path (real bootstrap, e2e harness, tests) — the same fail-fast semantics
 * as the wave-01 `ConfigService`.
 *
 * Redaction contract (I12/I15): error messages name the variable and the
 * failure CLASS only; values are never echoed. Placeholder-class secrets are
 * rejected via the wave-01 `isPlaceholderSecret` classifier (single shared
 * detector — no re-implementation, no divergence).
 *
 * Environment keys (documented additively in `.env.example`):
 *   IDENTITY_JWT_SIGNING_KEY             — HMAC-SHA256 key material (≥32 chars).
 *   IDENTITY_ACCESS_TOKEN_TTL_SECONDS    — default 900 (15 min; contract §6).
 *   IDENTITY_SESSION_TTL_SECONDS         — default 2 592 000 (30 d; contract §6).
 *   IDENTITY_REVOCATION_WINDOW_SECONDS   — default 60 (hard bound; contract §6).
 *   IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS  — default 3 (PRD §8 confirmed value).
 *   IDENTITY_LOCKOUT_DURATION_SECONDS    — default 900 (also the Retry-After basis).
 *   IDENTITY_RECOVERY_TICKET_TTL_SECONDS — default 1 800 (consumed by s2b's lane).
 *   IDENTITY_RECOVERY_REQUEST_THRESHOLD  — default 3 (W3 Stage-1 carryover
 *                                          F-S4-1: recovery-request throttle,
 *                                          HD-23-family — engineering-initial,
 *                                          founder-tunable).
 *   IDENTITY_RECOVERY_REQUEST_WINDOW_SECONDS — default 3 600 (the throttle's
 *                                          counting window; lock duration is
 *                                          lockoutDurationSeconds).
 *   IDENTITY_ARGON2_MEMORY_KIB           — default 65536 (ADR-0003; ADR: "tunable
 *                                          via validated config").
 *   IDENTITY_ARGON2_TIME_COST            — default 3 (ADR-0003).
 *   IDENTITY_ARGON2_PARALLELISM          — default 1 (ADR-0003).
 *
 * JWT signing key policy: REQUIRED and placeholder-checked in every
 * environment when provided. When absent in `development`/`test`, an
 * EPHEMERAL RANDOM key is generated per boot (process-local tokens, nothing
 * hardcoded, nothing persisted — a dev convenience that never weakens the
 * placeholder rejection rule). `production` refuses to boot without a
 * configured key: a missing production credential is an unsafe placeholder
 * state by definition (CLAUDE.md: configuration validates secrets and
 * rejects unsafe placeholders before serving traffic).
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { isPlaceholderSecret } from '../config/validate-config.js';
import type { KalEnv } from '../config/validate-config.js';

/** ADR-0003 default argon2id parameters (OWASP-aligned). */
export const ARGON2_DEFAULTS = {
  memoryCostKiB: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

/** Contract note §6 initial values (PRD §8). */
export const IDENTITY_DEFAULTS = {
  accessTokenTtlSeconds: 900,
  sessionTtlSeconds: 2_592_000,
  revocationWindowSeconds: 60,
  lockoutThresholdAttempts: 3,
  lockoutDurationSeconds: 900,
  recoveryTicketTtlSeconds: 1_800,
  // W3 Stage-1 carryover F-S4-1 (HD-23 family): recovery-request throttle —
  // engineering-initial values, founder-tunable at soft launch. The lock
  // DURATION reuses lockoutDurationSeconds (one Retry-After basis).
  recoveryRequestThreshold: 3,
  recoveryRequestWindowSeconds: 3_600,
} as const;

const MIN_SIGNING_KEY_LENGTH = 32;

export interface IdentityConfig {
  /** HMAC-SHA256 key material for access tokens (never logged, never echoed). */
  readonly jwtSigningKey: string;
  readonly accessTokenTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly revocationWindowSeconds: number;
  readonly lockoutThresholdAttempts: number;
  readonly lockoutDurationSeconds: number;
  readonly recoveryTicketTtlSeconds: number;
  readonly recoveryRequestThreshold: number;
  readonly recoveryRequestWindowSeconds: number;
  readonly argon2: {
    readonly memoryCostKiB: number;
    readonly timeCost: number;
    readonly parallelism: number;
  };
}

export type IdentityConfigValidationResult =
  | { readonly ok: true; readonly config: IdentityConfig }
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
function boundedInt(env: Record<string, string | undefined>, name: string, spec: BoundedIntSpec): { value: number } | { error: string } {
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

function validateSigningKey(env: Record<string, string | undefined>, nodeEnv: KalEnv): { value: string } | { error: string } {
  const raw = env['IDENTITY_JWT_SIGNING_KEY'];
  if (raw === undefined || raw.length === 0) {
    if (nodeEnv === 'production') {
      return {
        error:
          'IDENTITY_JWT_SIGNING_KEY is required in production (token signing cannot use an ephemeral key).',
      };
    }
    // development/test without a configured key: ephemeral per-boot key.
    // Random per process — tokens never survive a restart, and nothing
    // placeholder-class ever signs a token.
    return { value: randomBytes(48).toString('base64url') };
  }
  if (raw.length < MIN_SIGNING_KEY_LENGTH) {
    return { error: `IDENTITY_JWT_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters.` };
  }
  if (isPlaceholderSecret(raw)) {
    return {
      error:
        'IDENTITY_JWT_SIGNING_KEY is empty or placeholder-class; refusing to start. ' +
        'Set a real key in the environment (never in code or fixtures).',
    };
  }
  return { value: raw };
}

export function validateIdentityConfig(
  env: Record<string, string | undefined>,
  nodeEnv: KalEnv,
): IdentityConfigValidationResult {
  const errors: string[] = [];

  const signingKey = validateSigningKey(env, nodeEnv);
  if ('error' in signingKey) {
    errors.push(signingKey.error);
  }

  const parsed: Partial<IdentityConfig> = {};
  const intSpecs: readonly (readonly [keyof IdentityConfig, BoundedIntSpec])[] = [
    ['accessTokenTtlSeconds', { min: 30, max: 3_600, fallback: IDENTITY_DEFAULTS.accessTokenTtlSeconds }],
    ['sessionTtlSeconds', { min: 600, max: 31_536_000, fallback: IDENTITY_DEFAULTS.sessionTtlSeconds }],
    ['revocationWindowSeconds', { min: 0, max: 3_600, fallback: IDENTITY_DEFAULTS.revocationWindowSeconds }],
    ['lockoutThresholdAttempts', { min: 1, max: 100, fallback: IDENTITY_DEFAULTS.lockoutThresholdAttempts }],
    ['lockoutDurationSeconds', { min: 1, max: 86_400, fallback: IDENTITY_DEFAULTS.lockoutDurationSeconds }],
    ['recoveryTicketTtlSeconds', { min: 60, max: 86_400, fallback: IDENTITY_DEFAULTS.recoveryTicketTtlSeconds }],
    ['recoveryRequestThreshold', { min: 1, max: 100, fallback: IDENTITY_DEFAULTS.recoveryRequestThreshold }],
    ['recoveryRequestWindowSeconds', { min: 60, max: 86_400, fallback: IDENTITY_DEFAULTS.recoveryRequestWindowSeconds }],
  ];
  for (const [key, spec] of intSpecs) {
    const envName = `IDENTITY_${key.replace(/[A-Z]/gu, (c) => `_${c}`).toUpperCase()}`;
    const result = boundedInt(env, envName, spec);
    if ('error' in result) {
      errors.push(result.error);
    } else {
      (parsed as Record<string, unknown>)[key] = result.value;
    }
  }

  const argon2Memory = boundedInt(env, 'IDENTITY_ARGON2_MEMORY_KIB', {
    min: 8_192,
    max: 1_048_576,
    fallback: ARGON2_DEFAULTS.memoryCostKiB,
  });
  const argon2Time = boundedInt(env, 'IDENTITY_ARGON2_TIME_COST', {
    min: 1,
    max: 10,
    fallback: ARGON2_DEFAULTS.timeCost,
  });
  const argon2Parallelism = boundedInt(env, 'IDENTITY_ARGON2_PARALLELISM', {
    min: 1,
    max: 8,
    fallback: ARGON2_DEFAULTS.parallelism,
  });
  const argon2Errors = [argon2Memory, argon2Time, argon2Parallelism].filter((r): r is { error: string } => 'error' in r);
  errors.push(...argon2Errors.map((r) => r.error));

  if (errors.length > 0 || 'error' in signingKey) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      jwtSigningKey: (signingKey as { value: string }).value,
      accessTokenTtlSeconds: parsed.accessTokenTtlSeconds as number,
      sessionTtlSeconds: parsed.sessionTtlSeconds as number,
      revocationWindowSeconds: parsed.revocationWindowSeconds as number,
      lockoutThresholdAttempts: parsed.lockoutThresholdAttempts as number,
      lockoutDurationSeconds: parsed.lockoutDurationSeconds as number,
      recoveryTicketTtlSeconds: parsed.recoveryTicketTtlSeconds as number,
      recoveryRequestThreshold: parsed.recoveryRequestThreshold as number,
      recoveryRequestWindowSeconds: parsed.recoveryRequestWindowSeconds as number,
      argon2: {
        memoryCostKiB: (argon2Memory as { value: number }).value,
        timeCost: (argon2Time as { value: number }).value,
        parallelism: (argon2Parallelism as { value: number }).value,
      },
    },
  };
}

@Injectable()
export class IdentityConfigService {
  private readonly config: IdentityConfig;

  constructor(nodeEnv: KalEnv, env: Record<string, string | undefined> = process.env) {
    const result = validateIdentityConfig(env, nodeEnv);
    if (!result.ok) {
      // Non-leaking by construction: validateIdentityConfig never echoes values.
      throw new Error(
        `config: invalid identity configuration, refusing to start — ${result.errors.join(' ')}`,
      );
    }
    this.config = result.config;
  }

  get values(): IdentityConfig {
    return this.config;
  }
}
