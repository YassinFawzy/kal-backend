/**
 * Kal — account recovery command service (wave-02 contract §1–§3; lane s2b).
 *
 * Sanctioned mutation flow (CLAUDE.md): controller → command handler here —
 * validate → resolve the account → unit-of-work transaction → events/audit
 * append. Every unit of work runs under `SET LOCAL ROLE kal_app` with the
 * transaction-local TimeZone pinned to UTC (exactly the s2 `inAppRoleTx`
 * posture — ledger F-W2-1: the adapter-pg cluster-timezone hazard), so a
 * runaway statement cannot exceed the least-privilege grants and every
 * timestamptz read back carries an explicit +00 offset.
 *
 * Enumeration resistance (contract §3, invariant I7):
 *   - recovery REQUEST: unknown identifier, known identifier, and known-but-
 *     not-active account all return `200 {"status":"accepted"}` byte-identically
 *     AND timing-equalized (F-S4-1b fix; s4's interleaved medians measured a
 *     stable ~1.8–2.3× relative gap on the pre-fix tree). The ticket mint +
 *     digest runs on BOTH paths before any database access (s2's equalization
 *     pattern), and the unknown path additionally runs the ISSUANCE MIRROR
 *     (`runIssuanceMirror`): the known path's exact ticket INSERT executed
 *     inside a SAVEPOINT and rolled back (statement-for-statement parity — the
 *     same three index insertions, the users(id) FK probe, the CHECKs), then
 *     one COMMITTED 1-row UPDATE of `consumed_at` against a bounded pool of
 *     256 born-consumed sentinel ticket rows. The COMMIT pays the real
 *     load-dependent `synchronous_commit` WAL flush that dominates the known
 *     path's unit of work — a rollback-only mirror provably does NOT pay it
 *     (claim-verifier measurement: COMMIT 3.4–3.8 ms vs ROLLBACK 0.4–0.6 ms).
 *     The mirror writes NO audit event (permanent per-request growth on an
 *     unthrottled surface) and touches NO user-owned row: the pool rows belong
 *     to one closed, credential-less sentinel account and are born consumed
 *     with never-revealed random digests (uncompletable, unenumerable). The
 *     sentinel/pool state is lazily resolved once per process and cached.
 *   - recovery COMPLETE: unknown, malformed, wrong-secret, expired, already-
 *     consumed tickets — and a ticket whose account is no longer active — are
 *     ONE generic `401 UNAUTHENTICATED`, byte-identical for every cause. The
 *     ticket is verified BEFORE the body's password policy (frozen ordering,
 *     contract §2), so a bad ticket never learns anything about the body.
 *
 * Ticket semantics (contract §2): single-use, bounded TTL from the validated
 * `identity.recoveryTicketTtlSeconds` config point, bound to its account, and
 * a new request invalidates ALL prior outstanding tickets (single live ticket).
 *
 * Recovery success invalidates ALL of the account's sessions (PRD §8,
 * contract §1/§2). The revocation runs INSIDE the completion unit of work —
 * atomically with ticket consumption and the credential replacement; partial
 * states are impossible (any throw before commit rolls back all five writes:
 * consume, credential, revocation, new session, audit). Session revocation is
 * performed with the s2 revocation pattern (`updateMany` over the account's
 * active sessions, scoped by the immutable `user_id`) as an identity-module
 * service operating on identity-owned tables: no cross-module gate is crossed,
 * and no path outside this sanctioned unit of work writes session rows.
 *
 * Ticket secrets are stored ONLY as SHA-256 digests, never logged, never
 * returned (I12); the secret leaves the server exclusively through the
 * `KalMailPort` seam (contract §4).
 */
import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.ts';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../db/prisma.service.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { IdentityConfigService } from '../identity.config.js';
import type { TokenPairResponse } from '../identity.service.js';
import { PasswordHasherService } from '../password-hasher.service.js';
import { TokenService } from '../token.service.js';
import { KAL_MAIL_PORT, type KalMailPort } from '../mail/mail.port.js';
import { RecoveryTicketService } from './recovery-ticket.service.js';
import {
  validateRecoveryCompleteBody,
  validateRecoveryRequestBody,
  type RecoveryCompleteInput,
  type RecoveryRequestInput,
} from './recovery-validation.js';

const SYSTEM_ACTOR = 'system:identity';
const RECOVERY_ISSUED_AUDIT_ACTION = 'identity.recovery.ticket_issued';
const RECOVERY_COMPLETED_AUDIT_ACTION = 'identity.recovery.completed';

// ---------------------------------------------------------------------------
// issuance-mirror state (F-S4-1b) — the unknown-identifier path's timing twin
// ---------------------------------------------------------------------------

/** Bounded sentinel pool size (claim-verifier validated design: K = 256). */
export const EQUALIZER_POOL_SIZE = 256;

/** Canonical sentinel username — kept off-limits to the mirror by the eligibility guard below if a squatter ever takes it. */
export const EQUALIZER_SENTINEL_USERNAME = 'kal_eq_sentinel';

/** RFC 2606 reserved TLD — the sentinel can never be a real, mailable address. */
const EQUALIZER_SENTINEL_EMAIL_DOMAIN = 'kal.equalizer.invalid';

const EQUALIZER_SENTINEL_EMAIL = `kal-eq-sentinel@${EQUALIZER_SENTINEL_EMAIL_DOMAIN}`;

/** Namespace of randomized fallback usernames (`kal_eq_sentinel_<12 hex>` — within the 30-char username CHECK). */
export const EQUALIZER_SENTINEL_FALLBACK_PREFIX = 'kal_eq_sentinel_';

/** Maximum randomized-fallback attempts before the resolver refuses (collision of a 48-bit suffix — practically unreachable). */
const EQUALIZER_SENTINEL_FALLBACK_ATTEMPTS = 3;

/**
 * Domain-separation key for the pool-row id derivation. Secrecy of this
 * constant is NOT a control: the ids it derives are inert (born-consumed rows
 * whose digests are never revealed and whose preimage secret does not exist).
 * Determinism is the point — `INSERT ... ON CONFLICT DO NOTHING` over derived
 * ids keeps the pool at EXACTLY K rows across any number of process boots
 * (per-process lazy bootstrap must never grow the pool, even when two boots
 * race).
 */
const EQUALIZER_POOL_DERIVATION_KEY = 'kal/identity/recovery-equalizer/pool-v1';

/**
 * Pool rows are BORN CONSUMED — the expiry only has to satisfy the
 * `recovery_tickets_expiry_after_creation` CHECK while keeping the rows
 * invisible to any future expiry-based housekeeping sweep. No ticket of the
 * pool is ever completable: consumption is already stamped, and the digest
 * needed to complete is never revealed to anyone.
 */
const EQUALIZER_POOL_EXPIRY = new Date('9999-12-31T00:00:00.000Z');

/** The shape of the sentinel row the mirror requires (selected fields only). */
export interface EqualizerSentinelRow {
  readonly id: string;
  readonly status: string;
  readonly passwordHash: string | null;
}

/**
 * Eligibility guard: ONLY a closed account with no credential is ever picked
 * as the sentinel — recovery does not resurrect closed accounts and sign-in
 * refuses them generically, and a NULL password hash cannot authenticate. A
 * username squatter holding `kal_eq_sentinel` as an ACTIVE (or credentialed)
 * account can therefore never be picked; the resolver falls back to a
 * randomized name in that case.
 */
export function isEligibleEqualizerSentinel(row: EqualizerSentinelRow | null): row is EqualizerSentinelRow {
  return row !== null && row.status === 'closed' && row.passwordHash === null;
}

/**
 * Deterministically derives the pool-row UUID for `index` under one sentinel
 * (HMAC-SHA256 over `sentinelUserId:index`, version/variant bits set). Pure
 * so the pool composition is unit-testable without a database.
 */
export function deriveEqualizerPoolRowId(sentinelUserId: string, index: number): string {
  const mac = createHmac('sha256', EQUALIZER_POOL_DERIVATION_KEY).update(`${sentinelUserId}:${index}`).digest();
  mac[6] = (mac[6] & 0x0f) | 0x40; // UUID version 4
  mac[8] = (mac[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = mac.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Sentinel-pool bookkeeping resolved lazily, once per process. */
interface EqualizerState {
  readonly sentinelUserId: string;
  readonly poolRowIds: readonly string[];
}

@Injectable()
export class RecoveryService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly config: IdentityConfigService,
    private readonly hasher: PasswordHasherService,
    private readonly tokens: TokenService,
    private readonly tickets: RecoveryTicketService,
    @Inject(KAL_MAIL_PORT) private readonly mail: KalMailPort,
  ) {}

  /** Lazily-resolved mirror state — one promise per process, shared by concurrent requests. */
  private equalizerState: Promise<EqualizerState> | null = null;

  // ---------------------------------------------------------------------------
  // recovery request — POST /identity/recovery/request (contract §2)
  // ---------------------------------------------------------------------------

  /**
   * `200 {"status":"accepted"}` whether or not the identifier exists (§3).
   * When the account exists and is active, a single-use ticket is issued
   * (prior outstanding tickets invalidated in the same unit of work) and
   * delivered through the `KalMailPort` seam after the commit. Locked pairs
   * fail closed with the generic `429` regardless of identifier existence.
   */
  async requestRecovery(body: unknown, deviceIdHeader: unknown): Promise<{ status: 'accepted' }> {
    const validation = validateRecoveryRequestBody(body, deviceIdHeader);
    if (!validation.ok) {
      throw new KalProblemException('VALIDATION_FAILED', { errors: validation.errors });
    }
    const input: RecoveryRequestInput = validation.value;

    // The pair lock is checked (never ticked — a recovery request is not a
    // credential attempt) so a locked pair cannot probe this surface either.
    const subjectDigest = this.tokens.attemptSubjectDigest(input.identifier);
    const deviceDigest = this.tokens.attemptDeviceDigest(input.deviceId);
    await this.assertPairNotLocked(subjectDigest, deviceDigest);

    // Equalized work (§3): the ticket mint + digest run on BOTH paths before
    // any database access; the unknown path simply discards the result.
    const minted = this.tickets.mint();

    const account = await this.findActiveAccountByIdentifier(input.identifier, input.identifierClass);
    if (account === null) {
      // Unknown identifier — and known-but-closed accounts, which recovery
      // does not resurrect (lifecycle is not this flow's concern): identical
      // observable, no ticket, no mail, no audit. The ISSUANCE MIRROR (below)
      // equalizes the timing oracle (F-S4-1b) without writing any user-owned
      // row or audit event.
      const state = await this.ensureEqualizerState();
      const expiresAt = new Date(Date.now() + this.config.values.recoveryTicketTtlSeconds * 1000);
      const issuedAt = new Date();
      await this.runIssuanceMirror(minted, state, expiresAt, issuedAt);
      return { status: 'accepted' };
    }

    const expiresAt = new Date(Date.now() + this.config.values.recoveryTicketTtlSeconds * 1000);
    const issuedAt = new Date();
    await this.inAppRoleTx(async (tx) => {
      // Single live ticket (§2): a new request invalidates all prior
      // outstanding tickets — stamped consumed, which makes every later
      // presentation of them the generic already-used 401.
      await tx.recoveryTicket.updateMany({
        where: { userId: account.id, consumedAt: null },
        data: { consumedAt: issuedAt },
      });
      await tx.recoveryTicket.create({
        data: { id: minted.ticketId, userId: account.id, tokenHash: minted.digest, expiresAt },
      });
      // Target carries the server-generated ticket id only — no identifier,
      // no digest, no secret (I12/I14).
      await this.audit.append(
        {
          actor: SYSTEM_ACTOR,
          action: RECOVERY_ISSUED_AUDIT_ACTION,
          target: `recovery_ticket:${minted.ticketId}`,
          justification:
            'identity: single-use recovery ticket issued for an account identifier; prior outstanding tickets invalidated (contract §2).',
        },
        tx,
      );
    });

    // Delivery happens after the unit of work commits: the ticket exists even
    // if the seam fails (the user simply requests again; the failed attempt's
    // ticket dies at the next issuance). A seam failure surfaces as the one
    // generic internal error — never a delivery-provider detail (I7/I12).
    await this.mail.sendAccountRecoveryMail(account.email, { secret: minted.secret, expiresAt });

    return { status: 'accepted' };
  }

  // ---------------------------------------------------------------------------
  // issuance mirror — F-S4-1b timing equalization for the unknown-identifier path
  // ---------------------------------------------------------------------------

  /**
   * The unknown path's timing twin of the known path's unit of work, inside
   * ONE `inAppRoleTx` (the F-W2-1 posture — first statement pins the role and
   * the transaction-local TimeZone, exactly like every other recovery touch):
   *
   *   1. `SAVEPOINT kal_eq_mirror`;
   *   2. `recoveryTicket.create` with the SAME already-minted ticket (same
   *      id, same digest, same expiry the known path would insert) bound to
   *      the sentinel — statement-for-statement parity with the known path's
   *      INSERT: the same three index insertions (PK, token_hash unique,
   *      user_id/created_at), the users(id) FK probe, the CHECKs;
   *   3. `ROLLBACK TO SAVEPOINT kal_eq_mirror` — zero storage;
   *   4. the COMMITTED write: a 1-row UPDATE of `consumed_at` (exactly the
   *      granted column) against a per-request-randomly-chosen row of the
   *      bounded sentinel pool.
   *
   * The COMMIT pays the real `synchronous_commit` WAL flush — the dominant
   * load-dependent cost a rollback-only mirror provably does not pay. No
   * audit event is appended on this path (permanent per-request growth on an
   * unthrottled surface would trade a timing oracle for an unbounded-growth
   * defect), and no user-owned row is touched.
   */
  private async runIssuanceMirror(minted: { ticketId: string; digest: string }, state: EqualizerState, expiresAt: Date, issuedAt: Date): Promise<void> {
    await this.inAppRoleTx(async (tx) => {
      await tx.$executeRaw`SAVEPOINT kal_eq_mirror`;
      try {
        await tx.recoveryTicket.create({
          data: { id: minted.ticketId, userId: state.sentinelUserId, tokenHash: minted.digest, expiresAt },
        });
      } finally {
        // A failed create must still disarm the savepoint so the committed
        // write below proceeds on a healthy transaction — the observable
        // never depends on mirror internals.
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT kal_eq_mirror`;
      }
      const poolRowId = state.poolRowIds[randomInt(0, state.poolRowIds.length)];
      await tx.recoveryTicket.update({ where: { id: poolRowId }, data: { consumedAt: issuedAt } });
    });
  }

  /**
   * Resolves the sentinel + pool once per process and caches the promise
   * (concurrent first requests share one resolution; a failed resolution is
   * NOT cached — the next request retries instead of poisoning the process).
   */
  private ensureEqualizerState(): Promise<EqualizerState> {
    if (this.equalizerState === null) {
      const resolution = this.resolveEqualizerState();
      this.equalizerState = resolution.catch((error: unknown) => {
        if (this.equalizerState === resolution) {
          this.equalizerState = null;
        }
        throw error;
      });
    }
    return this.equalizerState;
  }

  /**
   * Establishes (or, across boots, RECOGNIZES) the mirror's supporting state:
   * one closed, credential-less sentinel account and K = 256 born-consumed
   * sentinel ticket rows. All of it idempotent:
   *
   *   - the sentinel is created with a raw `INSERT ... ON CONFLICT DO
   *     NOTHING` (never create()+catch(P2002) — a duplicate-key PG log line
   *     per process boot is log noise);
   *   - the canonical username is only used when it is ELIGIBLE (closed AND
   *     password NULL — `isEligibleEqualizerSentinel`); a username
   *     squatter holding it can never be picked, and the resolver falls back
   *     to a randomized name, reusing an existing fallback sentinel before
   *     minting a new one so repeated boots converge on ONE row;
   *   - pool-row ids are deterministically derived from the sentinel id, so
   *     re-running the INSERT across any number of boots is a no-op beyond
   *     the first — the pool is EXACTLY K rows, even when two processes boot
   *     concurrently;
   *   - pool digests are fresh random 64-hex values, never revealed, never
   *     logged — a pool ticket is uncompletable (consumed) and unenumerable
   *     (ids are 128-bit derived values, digests never leave the table).
   */
  private async resolveEqualizerState(): Promise<EqualizerState> {
    return this.inAppRoleTx(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "users" ("email", "username", "status")
        VALUES (${EQUALIZER_SENTINEL_EMAIL}, ${EQUALIZER_SENTINEL_USERNAME}, 'closed')
        ON CONFLICT DO NOTHING`;
      let sentinel = await tx.user.findFirst({
        where: { username: EQUALIZER_SENTINEL_USERNAME },
        select: { id: true, status: true, passwordHash: true },
      });
      if (!isEligibleEqualizerSentinel(sentinel)) {
        // Canonical name unavailable to the mirror (squatter or otherwise
        // ineligible): reuse an existing fallback sentinel from a prior boot
        // before minting a new one — repeated boots converge on one row.
        sentinel = await tx.user.findFirst({
          where: { username: { startsWith: EQUALIZER_SENTINEL_FALLBACK_PREFIX }, status: 'closed', passwordHash: null },
          select: { id: true, status: true, passwordHash: true },
          orderBy: { createdAt: 'asc' },
        });
        for (let attempt = 0; !isEligibleEqualizerSentinel(sentinel) && attempt < EQUALIZER_SENTINEL_FALLBACK_ATTEMPTS; attempt++) {
          const suffix = randomBytes(6).toString('hex');
          await tx.$executeRaw`
            INSERT INTO "users" ("email", "username", "status")
            VALUES (${'kal-eq-sentinel-' + suffix + '@' + EQUALIZER_SENTINEL_EMAIL_DOMAIN}, ${EQUALIZER_SENTINEL_FALLBACK_PREFIX + suffix}, 'closed')
            ON CONFLICT DO NOTHING`;
          sentinel = await tx.user.findFirst({
            where: { username: EQUALIZER_SENTINEL_FALLBACK_PREFIX + suffix },
            select: { id: true, status: true, passwordHash: true },
          });
        }
        if (!isEligibleEqualizerSentinel(sentinel)) {
          // The 48-bit-suffix namespace collided three times, or another
          // actor is racing ineligible rows into it — fail the request with
          // the one generic internal error rather than guess further.
          throw new KalProblemException('INTERNAL_ERROR');
        }
      }

      const sentinelUserId = sentinel.id;
      const poolRowIds = Array.from({ length: EQUALIZER_POOL_SIZE }, (_unused, index) => deriveEqualizerPoolRowId(sentinelUserId, index));
      await tx.$executeRaw`
        INSERT INTO "recovery_tickets" ("id", "user_id", "token_hash", "consumed_at", "expires_at")
        VALUES ${Prisma.join(
          poolRowIds.map((poolRowId) => Prisma.sql`(${poolRowId}, ${sentinelUserId}, ${randomBytes(32).toString('hex')}, now(), ${EQUALIZER_POOL_EXPIRY})`),
        )}
        ON CONFLICT DO NOTHING`;
      return { sentinelUserId, poolRowIds };
    });
  }

  // ---------------------------------------------------------------------------
  // recovery complete — POST /identity/recovery/complete (contract §2)
  // ---------------------------------------------------------------------------

  /**
   * Verifies the ticket FIRST (frozen ordering): every failure cause is the
   * one generic 401. With a verified ticket, a shape-invalid password is the
   * field-generic 400 and consumes nothing. Success atomically consumes the
   * ticket, stores the new argon2id hash, revokes ALL of the account's prior
   * sessions, and creates the brand-new session the response carries
   * (contract §1: "the response carries a brand-new session pair").
   */
  async completeRecovery(bearerTicket: string | null, body: unknown): Promise<TokenPairResponse> {
    const verified = await this.verifyTicket(bearerTicket);
    if (verified === null) {
      throw new KalProblemException('UNAUTHENTICATED');
    }

    const validation = validateRecoveryCompleteBody(body);
    if (!validation.ok) {
      // Verified ticket + invalid password: 400, nothing consumed — the
      // ticket stays live for a corrected retry (failed completion leaves
      // tickets consistent; required atomicity case).
      throw new KalProblemException('VALIDATION_FAILED', { errors: validation.errors });
    }
    const input: RecoveryCompleteInput = validation.value;

    // The expensive credential work runs before the unit of work opens (the
    // s2 pattern: hashing never extends a transaction).
    const passwordHash = await this.hasher.hash(input.newPassword);
    const sessionId = randomUUID();
    const refreshToken = this.tokens.mintRefreshToken(sessionId);
    const refreshHash = this.tokens.refreshDigest(refreshToken);
    const expiresAt = new Date(Date.now() + this.config.values.sessionTtlSeconds * 1000);

    const session = await this.inAppRoleTx(async (tx) => {
      // Single use is a conditional consume: under two concurrent completions
      // of the same ticket exactly one UPDATE matches; the loser sees count 0
      // and collapses to the same generic 401 as every other failure.
      const consumed = await tx.recoveryTicket.updateMany({
        where: { id: verified.ticketId, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count === 0) {
        return null;
      }
      // Credential replacement (the migration grants exactly this UPDATE:
      // password + the @updatedAt companion).
      await tx.user.update({
        where: { id: verified.userId },
        data: { passwordHash },
      });
      // ALL of the account's prior sessions die here (PRD §8; contract §1) —
      // inside the completion unit of work, so a crash leaves either the old
      // world intact or the new world complete.
      const revoked = await tx.session.updateMany({
        where: { userId: verified.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const created = await tx.session.create({
        data: { id: sessionId, userId: verified.userId, deviceLabel: null, expiresAt, refreshTokenHash: refreshHash },
      });
      await this.audit.append(
        {
          actor: SYSTEM_ACTOR,
          action: RECOVERY_COMPLETED_AUDIT_ACTION,
          target: `user:${verified.userId}`,
          justification: `identity: recovery completed; ticket consumed, credential replaced, ${revoked.count} prior session(s) revoked (contract §1/§2).`,
        },
        tx,
      );
      return created;
    });
    if (session === null) {
      // Lost the single-use race (or the ticket expired between verification
      // and consumption): the same generic 401 as every other ticket failure.
      throw new KalProblemException('UNAUTHENTICATED');
    }

    const now = new Date();
    const access = await this.tokens.issueAccessToken(verified.userId, session.id, this.config.values.accessTokenTtlSeconds, now);
    return {
      accessToken: access.token,
      refreshToken,
      session: {
        id: session.id,
        deviceLabel: session.deviceLabel,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // ticket verification (generic-401 funnel)
  // ---------------------------------------------------------------------------

  /**
   * Verifies the presented bearer ticket. Returns null for EVERY failure
   * class — absent, malformed, unknown id, digest mismatch, already consumed,
   * expired, or an account that is no longer active — and the caller maps all
   * of them to the ONE byte-identical generic 401 (contract §2/§3; I7).
   */
  private async verifyTicket(bearerTicket: string | null): Promise<{ ticketId: string; userId: string } | null> {
    if (bearerTicket === null) {
      return null;
    }
    const ticketId = this.tickets.ticketIdOf(bearerTicket);
    if (ticketId === null) {
      return null;
    }
    const row = await this.inAppRoleTx(async (tx) =>
      tx.recoveryTicket.findUnique({
        where: { id: ticketId },
        select: { id: true, userId: true, tokenHash: true, consumedAt: true, expiresAt: true, user: { select: { status: true } } },
      }),
    );
    if (row === null) {
      return null;
    }
    if (!this.tickets.matches(bearerTicket, row.tokenHash)) {
      return null;
    }
    if (row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    if (row.user.status !== 'active') {
      // A ticket can never complete recovery for a closed account (and the
      // observable stays the one generic 401 — never an account-state oracle).
      return null;
    }
    return { ticketId: row.id, userId: row.userId };
  }

  // ---------------------------------------------------------------------------
  // shared identity-module internals (replicated from the s2 service's
  // private helpers — that file is outside this lane's owned paths; the
  // SQL and posture are character-identical)
  // ---------------------------------------------------------------------------

  /** Lookup by canonical identifier — one class, no per-class errors; active accounts only. */
  private async findActiveAccountByIdentifier(
    identifier: string,
    identifierClass: 'email' | 'phone' | 'username',
  ): Promise<{ id: string; email: string } | null> {
    return this.inAppRoleTx(async (tx) => {
      const where =
        identifierClass === 'email'
          ? { email: identifier }
          : identifierClass === 'phone'
            ? { phone: identifier }
            : { username: identifier };
      return tx.user.findFirst({
        where: { ...where, status: 'active' },
        select: { id: true, email: true },
      });
    });
  }

  /**
   * Lock pre-check (§3): every request on a locked pair — including a
   * well-formed identifier that does not exist — is `429 RATE_LIMITED` +
   * `Retry-After`. The remaining-seconds arithmetic runs SERVER-SIDE in
   * PostgreSQL so the header never depends on client clocks.
   */
  private async assertPairNotLocked(subjectDigest: string, deviceDigest: string): Promise<void> {
    const row = await this.inAppRoleTx(async (tx) => {
      const remaining = await tx.$queryRaw<{ remaining_seconds: number | null }[]>`
        SELECT CASE
          WHEN locked_until IS NOT NULL AND locked_until > now()
            THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - now())))::int)
          ELSE NULL
        END AS remaining_seconds
        FROM auth_attempt_counters
        WHERE subject_key = ${subjectDigest} AND device_key = ${deviceDigest}`;
      return remaining[0]?.remaining_seconds ?? null;
    });
    if (row !== null) {
      throw new KalProblemException('RATE_LIMITED', { retryAfterSeconds: row });
    }
  }

  // ---------------------------------------------------------------------------
  // unit-of-work plumbing — the s2 inAppRoleTx posture, verbatim
  // ---------------------------------------------------------------------------

  /**
   * Runs the unit of work inside `SET LOCAL ROLE kal_app` (per-transaction;
   * reverts at commit/rollback) with the transaction-local TimeZone pinned to
   * UTC, so every timestamptz the driver serializes back carries an explicit
   * `+00` offset regardless of the server cluster's local timezone (ledger
   * F-W2-1). EVERY recovery database touch goes through this — no exceptions.
   */
  private async inAppRoleTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`;
      return work(tx);
    });
  }
}
