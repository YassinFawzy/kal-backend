/**
 * Kal — sync pull configuration (the identity-config pattern, pull side).
 *
 * One value: the HMAC key material for the opaque per-user delta cursors
 * (note §1.6 — "the identity wave's session-cursor pattern"). There is no
 * separate sync secret variable: cursors are derived SUBKEYS of the
 * environment's single validated signing root (`IDENTITY_JWT_SIGNING_KEY`,
 * the same root the identity token service derives its purposes from) —
 * never the raw key in a second protocol. Deriving from the same root via
 * a sync-specific purpose label is the established key-separation
 * discipline (src/identity/token.service.ts); the derivation is implemented
 * HERE, without importing identity code (module gate — pattern reference
 * only). Rotation of the root therefore also rotates outstanding pull
 * cursors: clients receive the generic 400 and restart their pull from the
 * beginning (`cursor` is optional on first pull) — acceptable for an
 * ephemeral pagination token.
 *
 * Policy mirrors the identity signing key exactly: REQUIRED and
 * placeholder-checked in production (I15 — a placeholder-class value
 * refuses the boot before any listener binds, never echoing the value);
 * development/test without a configured key get an ephemeral per-boot key
 * (cursors never survive a restart, nothing placeholder-class ever signs).
 * Validation runs in the constructor, which executes during module
 * instantiation — before any listener binds.
 */
import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { isPlaceholderSecret } from '../../config/validate-config.js';
import type { KalEnv } from '../../config/validate-config.js';

export const MIN_SYNC_SIGNING_KEY_LENGTH = 32;

/** Purpose label for the pull-cursor subkey — distinct from every identity purpose. */
export const DELTA_CURSOR_KEY_PURPOSE = 'kal:sync:delta-cursor:v1';

export type SyncPullConfigValidation =
  | { readonly ok: true; readonly signingKey: string }
  | { readonly ok: false; readonly errors: readonly string[] };

export function validateSyncPullConfig(
  env: Record<string, string | undefined>,
  nodeEnv: KalEnv,
): SyncPullConfigValidation {
  const raw = env['IDENTITY_JWT_SIGNING_KEY'];
  if (raw === undefined || raw.length === 0) {
    if (nodeEnv === 'production') {
      return {
        ok: false,
        errors: ['IDENTITY_JWT_SIGNING_KEY is required in production (sync delta cursors cannot use an ephemeral key).'],
      };
    }
    // development/test without a configured key: ephemeral per-boot key —
    // random per process, never placeholder-class.
    return { ok: true, signingKey: randomBytes(48).toString('base64url') };
  }
  if (raw.length < MIN_SYNC_SIGNING_KEY_LENGTH) {
    return {
      ok: false,
      errors: [`IDENTITY_JWT_SIGNING_KEY must be at least ${MIN_SYNC_SIGNING_KEY_LENGTH} characters.`],
    };
  }
  if (isPlaceholderSecret(raw)) {
    return {
      ok: false,
      errors: [
        'IDENTITY_JWT_SIGNING_KEY is empty or placeholder-class; refusing to start. ' +
          'Set a real key in the environment (never in code or fixtures).',
      ],
    };
  }
  return { ok: true, signingKey: raw };
}

@Injectable()
export class SyncPullConfigService {
  /** The derived purpose subkey — the only form the cursor service ever sees. */
  readonly deltaCursorKey: Buffer;

  constructor(nodeEnv: KalEnv) {
    const result = validateSyncPullConfig(process.env, nodeEnv);
    if (!result.ok) {
      // Non-leaking by construction: the validator never echoes values.
      throw new Error(`sync-pull config: invalid configuration, refusing to start — ${result.errors.join(' ')}`);
    }
    this.deltaCursorKey = createHmac('sha256', result.signingKey).update(DELTA_CURSOR_KEY_PURPOSE).digest();
  }
}
