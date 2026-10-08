/**
 * Kal — sync-module configuration (I15, wave-03 contract §6).
 *
 * The `sync.*` keys of contract §6 are validated configuration points
 * carrying their engineering-initial values (PRD §8 family — HD-23-tunable
 * at soft launch). No threshold is hardcoded in behavior: changing a config
 * value must change behavior (two-config proofs are pinned by
 * `sync.config.spec.ts` and the suites).
 *
 * Validation runs in the constructor — during module-graph initialization
 * BEFORE any listener binds — so an out-of-bounds value refuses the boot in
 * every path (real bootstrap, e2e harness, tests), exactly the established
 * identity-config pattern. Error messages name the variable and the failure
 * CLASS only; received values are never echoed (I12/I15).
 *
 * Environment keys (documented additively in `.env.example`):
 *   SYNC_MAX_OPS_PER_BATCH                    — default 100 (bounds 1–500):
 *       max ops per ingestion batch; over-limit ⇒ whole-batch 400
 *       VALIDATION_FAILED, zero ops applied, nothing recorded (§1.2).
 *   SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS    — default 2 592 000 = 30 d
 *       (bounds 3 600–7 776 000): how long a batch `Idempotency-Key`'s
 *       recorded response is replayed byte-identically (conventions §3;
 *       §1.2). After expiry a replayed key is a new operation (per-op dedupe
 *       still prevents every re-application).
 */
import { Injectable } from '@nestjs/common';

/** Contract §6 initial values. */
export const SYNC_DEFAULTS = {
  maxOpsPerBatch: 100,
  idempotencyKeyRetentionSeconds: 2_592_000,
} as const;

export interface SyncConfig {
  readonly maxOpsPerBatch: number;
  readonly idempotencyKeyRetentionSeconds: number;
}

export type SyncConfigValidationResult =
  | { readonly ok: true; readonly config: SyncConfig }
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

export function validateSyncConfig(
  env: Record<string, string | undefined>,
): SyncConfigValidationResult {
  const maxOps = boundedInt(env, 'SYNC_MAX_OPS_PER_BATCH', {
    min: 1,
    max: 500,
    fallback: SYNC_DEFAULTS.maxOpsPerBatch,
  });
  const retention = boundedInt(env, 'SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS', {
    min: 3_600,
    max: 7_776_000,
    fallback: SYNC_DEFAULTS.idempotencyKeyRetentionSeconds,
  });

  const errors = [maxOps, retention]
    .filter((r): r is { error: string } => 'error' in r)
    .map((r) => r.error);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      maxOpsPerBatch: (maxOps as { value: number }).value,
      idempotencyKeyRetentionSeconds: (retention as { value: number }).value,
    },
  };
}

@Injectable()
export class SyncConfigService {
  private readonly config: SyncConfig;

  constructor(env: Record<string, string | undefined> = process.env) {
    const result = validateSyncConfig(env);
    if (!result.ok) {
      // Non-leaking by construction: validateSyncConfig never echoes values.
      throw new Error(
        `config: invalid sync configuration, refusing to start — ${result.errors.join(' ')}`,
      );
    }
    this.config = result.config;
  }

  get values(): SyncConfig {
    return this.config;
  }
}
