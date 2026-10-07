/**
 * Kal — recovery-request throttle (W3 Stage-1 carryover F-S4-1; ledger
 * §7-E4, G2 evidence §6-B).
 *
 * The recovery-request surface was accepted at G2 as unthrottled with a W3
 * config-point disposition: a per-(identifier, device) volume cap on ticket
 * issuance — bounding the targeted ticket-supersession DoS (repeated 200s
 * invalidate the victim's live ticket and ring their inbox). This service
 * enforces it with EXACTLY the auth_attempt_counters posture:
 *
 *   - Counters key on the SAME server-keyed digests the lockout counters
 *     use — HMACs of (canonical identifier, X-Device-Id) — never user_id —
 *     so they tick regardless of identifier existence and the throttle
 *     cannot become an enumeration oracle (I7). The domains are separate by
 *     TABLE (`recovery_request_counters` vs `auth_attempt_counters`): a
 *     recovery-request volume cap and the credential-failure lockout are
 *     two abuse domains, and neither may write the other's state. A pair
 *     locked by failed sign-ins cannot probe recovery either (the
 *     pre-existing `assertPairNotLocked` runs first); this throttle adds
 *     its own domain on top.
 *   - Frozen semantics (mirroring the sign-in lockout shape): requests
 *     1..threshold-1 within the window are accepted (200); the
 *     threshold-crossing request ITSELF is accepted (it sets the lock, for
 *     future requests, in the same unit of work); every later request on the
 *     pair — known identifier or not, valid shape or not (after shape
 *     validation, which stays database-free) — is `429 RATE_LIMITED` +
 *     `Retry-After` (server-computed remaining seconds), body byte-identical
 *     for every cause (I7).
 *   - Fresh-window semantics: a tick on an EXPIRED lock or an EXPIRED window
 *     restarts the count at 1; an active lock is never cleared here (only a
 *     completed sign-in resets the credential counters; recovery requests
 *     never reset anything).
 *   - Lock duration = `identity.lockoutDurationSeconds` (the shared
 *     Retry-After basis); threshold/window are the two new config points
 *     (`identity.recoveryRequestThreshold` default 3,
 *     `identity.recoveryRequestWindowSeconds` default 3 600 —
 *     engineering-initial, HD-23-tunable).
 *
 * Equalization posture (the wave-02 F-S4-1b invariant — response equivalence
 * outranks the throttle): the caller runs check+tick BEFORE the known /
 * unknown divergence, so both paths perform identical work up to the
 * throttle's throw point; the throttle's database work is identical on both
 * paths by construction. The existing timing suite (T4 ≤ 3 ms) stays green
 * and this wave's e2e adds 429-parity cases.
 *
 * Lockout events append via the audit service INSIDE the unit of work
 * (I14), carrying only server-keyed digests — never raw identifiers.
 *
 * Instantiation note: this class is constructed by `RecoveryService` (its
 * only consumer) with the already-injected dependencies — identity.module.ts
 * stays untouched (the scoped grant covers exactly the throttle files plus
 * the minimal RecoveryService hook).
 */
import type { Prisma } from '../../../generated/prisma/client.ts';
import type { AuditService } from '../../audit/audit.service.js';
import type { PrismaService } from '../../db/prisma.service.js';
import type { IdentityConfigService } from '../identity.config.js';

const RECOVERY_THROTTLE_AUDIT_ACTION = 'identity.recovery_throttle.triggered';
const SYSTEM_ACTOR = 'system:identity';

export class RecoveryThrottleService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: IdentityConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The ONE hook the recovery-request path calls, after shape validation and
   * the credential-lockout pre-check, BEFORE any known/unknown divergence.
   * `subjectDigest`/`deviceDigest` are the caller's server-keyed digests
   * (the identity module's `attemptSubjectDigest`/`attemptDeviceDigest` —
   * opaque, irreversible); the counters table is throttle-exclusive, so the
   * domains stay disjoint even though the digest values are shared:
   * rejects locked pairs (429 + Retry-After), otherwise ticks the pair's
   * window counter and arms the lock on threshold crossing.
   */
  async assertWithinLimit(subjectDigest: string, deviceDigest: string): Promise<void> {
    const { recoveryRequestThreshold, recoveryRequestWindowSeconds, lockoutDurationSeconds } = this.config.values;

    // (a) Locked pairs fail closed here — known or unknown identifier alike.
    const remaining = await this.inAppRoleTx(async (tx) => {
      const rows = await tx.$queryRaw<{ remaining_seconds: number | null }[]>`
        SELECT CASE
          WHEN locked_until IS NOT NULL AND locked_until > now()
            THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int)
          ELSE NULL
        END AS remaining_seconds
        FROM recovery_request_counters
        WHERE subject_key = ${subjectDigest} AND device_key = ${deviceDigest}`;
      return rows[0]?.remaining_seconds ?? null;
    });
    if (remaining !== null) {
      throw new KalRateLimited(remaining);
    }

    // (b) Atomic tick with fresh-window semantics (the
    // `registerSigninFailure` CASE shape — an expired lock OR an expired
    // window restarts the count at 1; an active lock is never cleared here).
    await this.inAppRoleTx(async (tx) => {
      const ticked = await tx.$queryRaw<{ request_count: number }[]>`
        INSERT INTO recovery_request_counters (subject_key, device_key, request_count, window_started_at, locked_until)
        VALUES (${subjectDigest}, ${deviceDigest}, 1, now(), NULL)
        ON CONFLICT (subject_key, device_key) DO UPDATE SET
          request_count = CASE
            WHEN (recovery_request_counters.locked_until IS NOT NULL AND recovery_request_counters.locked_until <= now())
              OR (recovery_request_counters.window_started_at + (${recoveryRequestWindowSeconds}::int * interval '1 second') <= now())
              THEN 1
            ELSE recovery_request_counters.request_count + 1
          END,
          window_started_at = CASE
            WHEN (recovery_request_counters.locked_until IS NOT NULL AND recovery_request_counters.locked_until <= now())
              OR (recovery_request_counters.window_started_at + (${recoveryRequestWindowSeconds}::int * interval '1 second') <= now())
              THEN now()
            ELSE recovery_request_counters.window_started_at
          END,
          locked_until = CASE
            WHEN (recovery_request_counters.locked_until IS NOT NULL AND recovery_request_counters.locked_until <= now())
              OR (recovery_request_counters.window_started_at + (${recoveryRequestWindowSeconds}::int * interval '1 second') <= now())
              THEN NULL
            ELSE recovery_request_counters.locked_until
          END
        RETURNING request_count`;
      const count = Number(ticked[0]?.request_count ?? 1);
      if (count < recoveryRequestThreshold) {
        return;
      }
      // (c) Threshold crossed: arm the lock for FUTURE requests (the
      // crossing request itself still completes — the sign-in lockout shape:
      // the threshold-triggering observable stays the normal one).
      const locked = await tx.$queryRaw<{ locked_until: Date }[]>`
        UPDATE recovery_request_counters
        SET locked_until = now() + (${lockoutDurationSeconds}::int * interval '1 second')
        WHERE subject_key = ${subjectDigest} AND device_key = ${deviceDigest}
          AND locked_until IS NULL AND request_count >= ${recoveryRequestThreshold}::int
        RETURNING locked_until`;
      if (locked.length > 0) {
        // Target carries only server-keyed digests — opaque, irreversible.
        await this.audit.append(
          {
            actor: SYSTEM_ACTOR,
            action: RECOVERY_THROTTLE_AUDIT_ACTION,
            target: `recovery_request:${subjectDigest}:${deviceDigest}`,
            justification:
              'identity: recovery-request threshold reached for an (identifier, device) pair; pair throttled (G2 carryover F-S4-1).',
          },
          tx,
        );
      }
    });
  }

  /**
   * Runs the unit of work inside `SET LOCAL ROLE kal_app` with the
   * transaction-local TimeZone pinned to UTC — the F-W2-1 posture (the
   * recovery service's `inAppRoleTx` shape, replicated here because the
   * service's own helper is private and this file is a separately-owned new
   * file; the SQL and posture are character-identical).
   */
  private async inAppRoleTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`;
      return work(tx);
    });
  }
}

/**
 * Internal rejection carrying the server-computed Retry-After seconds. The
 * recovery service maps it to the frozen generic `429 RATE_LIMITED`
 * problem-details envelope (byte-identical for every cause — I7).
 */
export class KalRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('kal-throttle:rate-limited');
    this.name = 'KalRateLimited';
  }
}
