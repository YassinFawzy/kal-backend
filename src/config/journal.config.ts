/**
 * Kal — journal-module configuration (I15, wave-04 contract note §6).
 *
 * Lives in `src/config/` (the wave-04 Stage-1 lane owns journal config
 * points; `src/journal/**` is Stage-2-owned — the journal module constructs
 * this service exactly the way the tracking module constructs
 * `TrackingConfigService`). Every threshold in the frozen contract §6 that
 * belongs to this module's surface is a validated configuration point
 * carrying its engineering-initial value — NO threshold is hardcoded in
 * behavior; a two-config proof (changing the value changes the behavior) is
 * a required Stage-2/4 limiter test. Validation runs in the service
 * constructor, i.e. during module-graph initialization BEFORE any listener
 * binds, so an unsafe configuration refuses the boot in every path — the
 * same fail-fast semantics as the wave-01 ConfigService, the wave-02
 * IdentityConfigService and the wave-03 TrackingConfigService (the
 * established pattern; this class mirrors it).
 *
 * Redaction contract (I12/I15): error messages name the variable and the
 * failure CLASS only; values are never echoed.
 *
 * Values are ENGINEERING-INITIAL **DEFAULT PENDING APPROVAL** (ledger §7-B):
 * PRD §8 sets no journal limits; the founder ratifies at the G4 gate. They
 * are config points, never product rulings.
 *
 * Environment keys (documented additively in `.env.example`):
 *   JOURNAL_SESSION_CREATE_MAX_PER_HOUR — default 10 (bounds 1–100).
 *   JOURNAL_SESSION_CREATE_MAX_PER_DAY  — default 40 (bounds 1–1000).
 *
 * Cursor signing secret: the exercise-catalog search surface paginates with
 * the same opaque user-bound HMAC cursors as foods (conventions §2; contract
 * note §2). The process's single validated secret material is
 * `IDENTITY_JWT_SIGNING_KEY`; the journal cursor key is a domain-separated
 * HMAC derivation of it (`kal:journal:search-cursor:v1` — distinct key from
 * tracking's, never the raw secret), exactly the per-purpose key-derivation
 * posture identity's TokenService and the tracking config establish. The
 * production/dev policy mirrors both: REQUIRED and placeholder-checked in
 * `production` (refuses the boot), ephemeral-random per boot in
 * `development`/`test` when absent.
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { isPlaceholderSecret } from './validate-config.js';
import type { KalEnv } from './validate-config.js';

/** Contract note §6 initial values for the session-create rate guard. */
export const JOURNAL_DEFAULTS = {
  sessionCreateMaxPerHour: 10,
  sessionCreateMaxPerDay: 40,
} as const;

export interface JournalConfig {
  /** Rolling-hour session-create cap (sync-apply limiter, note §1/§6). */
  readonly sessionCreateMaxPerHour: number;
  /** Rolling-24 h session-create cap (sync-apply limiter, note §1/§6). */
  readonly sessionCreateMaxPerDay: number;
  /** Domain-separated HMAC key for exercise-search cursors (never logged). */
  readonly searchCursorKey: Buffer;
}

export type JournalConfigValidationResult =
  | { readonly ok: true; readonly config: JournalConfig }
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

function validateJournalConfig(
  env: Record<string, string | undefined>,
  nodeEnv: KalEnv,
): JournalConfigValidationResult {
  const errors: string[] = [];

  const hour = boundedInt(env, 'JOURNAL_SESSION_CREATE_MAX_PER_HOUR', {
    min: 1,
    max: 100,
    fallback: JOURNAL_DEFAULTS.sessionCreateMaxPerHour,
  });
  if ('error' in hour) errors.push(hour.error);

  const day = boundedInt(env, 'JOURNAL_SESSION_CREATE_MAX_PER_DAY', {
    min: 1,
    max: 1000,
    fallback: JOURNAL_DEFAULTS.sessionCreateMaxPerDay,
  });
  if ('error' in day) errors.push(day.error);

  // Exercise-search cursor signing secret — the same validated material
  // identity uses, with the same production policy (identity.config.ts
  // pattern; never echoed).
  const raw = env['IDENTITY_JWT_SIGNING_KEY'];
  let searchCursorKey: Buffer;
  if (raw === undefined || raw.length === 0) {
    if (nodeEnv === 'production') {
      errors.push('IDENTITY_JWT_SIGNING_KEY is required in production (cursor signing cannot use an ephemeral key).');
      searchCursorKey = Buffer.alloc(0);
    } else {
      // Ephemeral random per boot — process-local tokens, nothing persisted.
      searchCursorKey = createHmac('sha256', randomBytes(32))
        .update('kal:journal:search-cursor:v1')
        .digest();
    }
  } else if (isPlaceholderSecret(raw)) {
    errors.push('IDENTITY_JWT_SIGNING_KEY is set to an unsafe placeholder value.');
    searchCursorKey = Buffer.alloc(0);
  } else {
    searchCursorKey = createHmac('sha256', raw).update('kal:journal:search-cursor:v1').digest();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      sessionCreateMaxPerHour: (hour as { value: number }).value,
      sessionCreateMaxPerDay: (day as { value: number }).value,
      searchCursorKey,
    },
  };
}

@Injectable()
export class JournalConfigService {
  readonly values: JournalConfig;

  constructor(nodeEnv: KalEnv) {
    const result = validateJournalConfig(process.env, nodeEnv);
    if (!result.ok) {
      // Fail fast BEFORE any listener binds (I15). Messages name variables
      // and failure classes only — never values (I12/I15).
      throw new Error(`journal configuration is invalid: ${result.errors.join(' ')}`);
    }
    this.values = result.config;
  }
}
