/**
 * Kal — identity command/query service (wave-02 contract §1–§3).
 *
 * Sanctioned mutation flow (CLAUDE.md): controller → command handler here —
 * validate → resolve/authorize the UserContext → unit-of-work transaction
 * → events/audit append. One path per mutation type. Every unit of work
 * runs under `SET LOCAL ROLE kal_app` (README "Roles & row-level
 * security"): the request-scope role holds only the least-privilege grants
 * the identity migration ships, so a runaway statement cannot exceed them.
 * The identity module never queries another module's tables (module gate);
 * audit events go through the audit service INSIDE the unit of work.
 *
 * Enumeration resistance (contract §3, invariant I7): unknown identifier,
 * wrong password, and closed account produce byte-identical UNAUTHENTICATED
 * bodies at every attempt count, with equalized work (a dummy argon2id
 * verification on the unknown path). Lockout counters tick per submitted
 * identifier regardless of existence, keyed by server-keyed digests.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.ts';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../db/prisma.service.js';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { IdentityConfigService } from './identity.config.js';
import { validateSigninBody, validateSignupBody, type SigninInput, type SignupInput } from './identity-validation.js';
import { PasswordHasherService } from './password-hasher.service.js';
import { TokenService } from './token.service.js';
import { isUuid } from '../request-context/user-context.js';

const SYSTEM_ACTOR = 'system:identity';
const LOCKOUT_AUDIT_ACTION = 'identity.lockout.triggered';
const CHAIN_REVOKE_AUDIT_ACTION = 'identity.session.chain_revoked';

export interface TokenPairResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly session: {
    readonly id: string;
    readonly deviceLabel: string | null;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

export interface SessionListItem {
  readonly id: string;
  readonly deviceLabel: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SessionListPage {
  readonly data: readonly SessionListItem[];
  readonly nextCursor: string | null;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly config: IdentityConfigService,
    private readonly hasher: PasswordHasherService,
    private readonly tokens: TokenService,
  ) {}

  // ---------------------------------------------------------------------------
  // signup — POST /identity/signup (contract §2)
  // ---------------------------------------------------------------------------

  /**
   * `200 {"status":"accepted"}` for a fresh account AND a duplicate alike:
   * uniqueness is structural, the duplicate observable is a generic success
   * (§3). The argon2id hash is computed BEFORE any database access, so both
   * outcomes perform the same work. No partial rows on failure: the insert
   * is one unit of work.
   */
  async signup(body: unknown): Promise<{ status: 'accepted' }> {
    const validation = validateSignupBody(body);
    if (!validation.ok) {
      throw new KalProblemException('VALIDATION_FAILED', { errors: validation.errors });
    }
    const input: SignupInput = validation.value;
    const passwordHash = await this.hasher.hash(input.password);
    try {
      await this.inAppRoleTx(async (tx) => {
        await tx.user.create({
          data: {
            email: input.email,
            phone: input.phone,
            username: input.username,
            passwordHash,
            status: 'active',
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Duplicate identifier: the generic success (§3) — never an oracle.
        return { status: 'accepted' };
      }
      throw error;
    }
    return { status: 'accepted' };
  }

  // ---------------------------------------------------------------------------
  // signin — POST /identity/signin (contract §2/§3)
  // ---------------------------------------------------------------------------

  async signin(body: unknown, deviceIdHeader: unknown): Promise<TokenPairResponse> {
    const validation = validateSigninBody(body, deviceIdHeader);
    if (!validation.ok) {
      throw new KalProblemException('VALIDATION_FAILED', { errors: validation.errors });
    }
    const input: SigninInput = validation.value;
    const subjectDigest = this.tokens.attemptSubjectDigest(input.identifier);
    const deviceDigest = this.tokens.attemptDeviceDigest(input.deviceId);

    await this.assertPairNotLocked(subjectDigest, deviceDigest);

    const user = await this.findByIdentifier(input.identifier, input.identifierClass);

    // Equalized work: a real verification for existing accounts, a dummy
    // verification of the same cost for unknown identifiers and for rows
    // that can never verify (null hash, deferred social-login shape).
    let verified = false;
    if (user !== null && user.passwordHash !== null) {
      verified = await this.hasher.verifyAgainst(user.passwordHash, input.password);
    } else {
      await this.hasher.verifyAgainstDummy(input.password);
    }

    if (!verified || user === null) {
      await this.registerSigninFailure(subjectDigest, deviceDigest);
      // One generic 401 for unknown identifier / wrong password / closed
      // account — byte-identical at every attempt count (§3).
      throw new KalProblemException('UNAUTHENTICATED');
    }
    if (user.status !== 'active') {
      // Closure never becomes an existence oracle (§1/§3): same 401, and the
      // pair ticks (the credentials did not admit the caller).
      await this.registerSigninFailure(subjectDigest, deviceDigest);
      throw new KalProblemException('UNAUTHENTICATED');
    }

    return this.establishSession(user.id, input.password, user.passwordHash, input.deviceLabel, subjectDigest, deviceDigest);
  }

  /** Lookup by canonical identifier — one class, no per-class errors. */
  private async findByIdentifier(
    identifier: string,
    identifierClass: 'email' | 'phone' | 'username',
  ): Promise<{ id: string; passwordHash: string | null; status: string } | null> {
    return this.inAppRoleTx(async (tx) => {
      const where =
        identifierClass === 'email'
          ? { email: identifier }
          : identifierClass === 'phone'
            ? { phone: identifier }
            : { username: identifier };
      return tx.user.findFirst({
        where,
        select: { id: true, passwordHash: true, status: true },
      });
    });
  }

  /**
   * Lock pre-check (§3): every attempt on a locked pair — including valid
   * credentials — is `429 RATE_LIMITED` + `Retry-After`; no hashing work is
   * spent on a locked pair (fail closed). The remaining-seconds arithmetic
   * runs SERVER-SIDE in PostgreSQL so the header never depends on client
   * clock or driver timestamp-parsing quirks.
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

  /**
   * One atomic tick (INSERT … ON CONFLICT … UPDATE — concurrency-safe per
   * §3 "counter increments are atomic under concurrent attempts"). A lock
   * that has EXPIRED opens a fresh window on the next failure (the count
   * restarts at 1); an ACTIVE lock is never cleared here. When the tick
   * crosses the configured threshold, the lock is set by a conditional
   * UPDATE and the lockout event is appended via the audit service in the
   * same unit of work (I14).
   */
  private async registerSigninFailure(subjectDigest: string, deviceDigest: string): Promise<void> {
    const { lockoutThresholdAttempts, lockoutDurationSeconds } = this.config.values;
    await this.inAppRoleTx(async (tx) => {
      const ticked = await tx.$queryRaw<{ failed_count: number }[]>`
        INSERT INTO auth_attempt_counters (subject_key, device_key, failed_count, first_failed_at, last_failed_at, locked_until)
        VALUES (${subjectDigest}, ${deviceDigest}, 1, now(), now(), NULL)
        ON CONFLICT (subject_key, device_key) DO UPDATE SET
          failed_count = CASE
            WHEN auth_attempt_counters.locked_until IS NOT NULL AND auth_attempt_counters.locked_until <= now()
              THEN 1
            ELSE auth_attempt_counters.failed_count + 1
          END,
          first_failed_at = CASE
            WHEN auth_attempt_counters.locked_until IS NOT NULL AND auth_attempt_counters.locked_until <= now()
              THEN now()
            ELSE auth_attempt_counters.first_failed_at
          END,
          last_failed_at = now(),
          locked_until = CASE
            WHEN auth_attempt_counters.locked_until IS NOT NULL AND auth_attempt_counters.locked_until <= now()
              THEN NULL
            ELSE auth_attempt_counters.locked_until
          END
        RETURNING failed_count`;
      const failedCount = Number(ticked[0]?.failed_count ?? 1);
      if (failedCount < lockoutThresholdAttempts) {
        return;
      }
      const locked = await tx.$queryRaw<{ locked_until: Date }[]>`
        UPDATE auth_attempt_counters
        SET locked_until = now() + (${lockoutDurationSeconds}::int * interval '1 second')
        WHERE subject_key = ${subjectDigest} AND device_key = ${deviceDigest}
          AND locked_until IS NULL AND failed_count >= ${lockoutThresholdAttempts}::int
        RETURNING locked_until`;
      if (locked.length > 0) {
        // Target carries only server-keyed digests — opaque, irreversible.
        await this.audit.append(
          {
            actor: SYSTEM_ACTOR,
            action: LOCKOUT_AUDIT_ACTION,
            target: `auth_attempt:${subjectDigest}:${deviceDigest}`,
            justification:
              'identity: failed-attempt threshold reached for an (identifier, device) pair; pair locked (PRD §8).',
          },
          tx,
        );
      }
    });
  }

  /**
   * Success path unit of work: transparent rehash (ADR-0003 upgrade path)
   * + session row + counter reset, atomically. The refresh token is minted
   * before the transaction (needs the session id) and only its digest is
   * stored (§1).
   */
  private async establishSession(
    userId: string,
    password: string,
    storedHash: string | null,
    deviceLabel: string | null,
    subjectDigest: string,
    deviceDigest: string,
  ): Promise<TokenPairResponse> {
    const rehashed =
      storedHash !== null && this.hasher.needsRehash(storedHash) ? await this.hasher.rehash(password) : null;
    const sessionId = randomUUID();
    const refreshToken = this.tokens.mintRefreshToken(sessionId);
    const refreshHash = this.tokens.refreshDigest(refreshToken);
    const expiresAt = new Date(Date.now() + this.config.values.sessionTtlSeconds * 1000);

    const session = await this.inAppRoleTx(async (tx) => {
      if (rehashed !== null) {
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: rehashed }, // updated_at follows (@updatedAt)
        });
      }
      const created = await tx.session.create({
        data: { id: sessionId, userId, deviceLabel, expiresAt, refreshTokenHash: refreshHash },
      });
      await tx.$queryRaw`UPDATE auth_attempt_counters
        SET failed_count = 0, locked_until = NULL
        WHERE subject_key = ${subjectDigest} AND device_key = ${deviceDigest}`;
      return created;
    });

    const now = new Date();
    const access = await this.tokens.issueAccessToken(userId, session.id, this.config.values.accessTokenTtlSeconds, now);
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
  // token refresh — POST /identity/token/refresh (contract §1)
  // ---------------------------------------------------------------------------

  /**
   * Rotation on use; reuse of a superseded token revokes the whole session
   * (theft signal) with the generic 401 — byte-identical to every other
   * refresh failure. The rotate is a conditional UPDATE on the presented
   * generation's digest: under two concurrent uses of the same token
   * exactly one rotation matches; the loser revokes the chain.
   */
  async refresh(bearerToken: string | null): Promise<TokenPairResponse> {
    if (bearerToken === null) {
      throw new KalProblemException('UNAUTHENTICATED');
    }
    const sessionId = this.tokens.refreshSessionId(bearerToken);
    if (sessionId === null) {
      throw new KalProblemException('UNAUTHENTICATED');
    }

    const current = await this.inAppRoleTx(async (tx) =>
      tx.session.findUnique({
        where: { id: sessionId },
        select: {
          userId: true,
          deviceLabel: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          refreshTokenHash: true,
        },
      }),
    );
    if (current === null || current.revokedAt !== null || current.expiresAt.getTime() <= Date.now()) {
      throw new KalProblemException('UNAUTHENTICATED');
    }

    if (this.tokens.digestsMatch(bearerToken, current.refreshTokenHash)) {
      const nextRefresh = this.tokens.mintRefreshToken(sessionId);
      const nextHash = this.tokens.refreshDigest(nextRefresh);
      // Sliding window (founder CR, 2026-10-07): every successful refresh
      // re-arms the session lifetime — an active user is never logged out by
      // the timer. Only inactivity for the full TTL expires the session.
      const slidingExpiry = new Date(Date.now() + this.config.values.sessionTtlSeconds * 1000);
      const rotated = await this.inAppRoleTx(async (tx) =>
        tx.session.updateMany({
          where: { id: sessionId, refreshTokenHash: current.refreshTokenHash, revokedAt: null },
          data: { refreshTokenHash: nextHash, refreshGeneration: { increment: 1 }, lastRefreshedAt: new Date(), expiresAt: slidingExpiry },
        }),
      );
      if (rotated.count === 1) {
        const now = new Date();
        const access = await this.tokens.issueAccessToken(
          current.userId,
          sessionId,
          this.config.values.accessTokenTtlSeconds,
          now,
        );
        return {
          accessToken: access.token,
          refreshToken: nextRefresh,
          session: {
            id: sessionId,
            deviceLabel: current.deviceLabel,
            createdAt: current.createdAt.toISOString(),
            expiresAt: slidingExpiry.toISOString(),
          },
        };
      }
      // A concurrent rotation won: this presentation is a reuse.
    }

    await this.revokeChain(sessionId);
    throw new KalProblemException('UNAUTHENTICATED');
  }

  /** Chain revocation (theft signal) — audited in the same unit of work (I14). */
  private async revokeChain(sessionId: string): Promise<void> {
    await this.inAppRoleTx(async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count > 0) {
        await this.audit.append(
          {
            actor: SYSTEM_ACTOR,
            action: CHAIN_REVOKE_AUDIT_ACTION,
            target: `session:${sessionId}`,
            justification: 'identity: superseded refresh token presented; session chain revoked (contract §1).',
          },
          tx,
        );
      }
    });
  }

  // ---------------------------------------------------------------------------
  // sessions — GET /identity/sessions, DELETE /identity/sessions/{id} (§2)
  // ---------------------------------------------------------------------------

  /**
   * Active sessions ("signed-in devices"), keyset-paginated. Ordering:
   * createdAt descending with id descending tiebreak — evaluated on the
   * millisecond-truncated creation instant, which is exactly the precision
   * the API serializes (ISO 8601), so the served order is the order a
   * client can reproduce. Cursors are opaque, signed, and user-bound.
   */
  async listSessions(userId: string, rawCursor: string | null, rawLimit: string | null): Promise<SessionListPage> {
    const limit = this.parseLimit(rawLimit);
    if (rawCursor !== null && (typeof rawCursor !== 'string' || rawCursor.length > 512)) {
      throw new KalProblemException('VALIDATION_FAILED');
    }
    let cursor: { createdAt: Date; sessionId: string } | null = null;
    if (rawCursor !== null) {
      cursor = this.tokens.decodeSessionCursor(rawCursor, userId);
      if (cursor === null) {
        // One generic body for every cursor failure class (conventions §2).
        throw new KalProblemException('VALIDATION_FAILED');
      }
    }

    const rows = await this.inAppRoleTx(async (tx) => {
      const cursorFilter =
        cursor === null
          ? Prisma.empty
          : Prisma.sql`AND (date_trunc('millisecond', created_at) < ${cursor.createdAt} OR (date_trunc('millisecond', created_at) = ${cursor.createdAt} AND id < ${cursor.sessionId}::uuid))`;
      return tx.$queryRaw<{ id: string; device_label: string | null; created_at: Date; expires_at: Date }[]>`
        SELECT id, device_label, created_at, expires_at
        FROM sessions
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
          ${cursorFilter}
        ORDER BY date_trunc('millisecond', created_at) DESC, id DESC
        LIMIT ${limit + 1}`;
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? this.tokens.encodeSessionCursor(userId, page[page.length - 1].created_at, page[page.length - 1].id)
        : null;
    return {
      data: page.map((row) => ({
        id: row.id,
        deviceLabel: row.device_label,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      })),
      nextCursor,
    };
  }

  /** `limit` clamps to 1–100 with default 50 (conventions §2); non-integers are malformed. */
  private parseLimit(rawLimit: string | null): number {
    if (rawLimit === null || rawLimit === '') {
      return 50;
    }
    if (typeof rawLimit !== 'string' || !/^[0-9]+$/u.test(rawLimit)) {
      throw new KalProblemException('VALIDATION_FAILED');
    }
    return Math.min(100, Math.max(1, Number(rawLimit)));
  }

  /**
   * User-scoped revocation (§2): the caller's own session — including an
   * already-revoked one — revokes idempotently (204); a session the caller
   * does not own, an absent id, and a malformed id share ONE byte-identical
   * 404 (I7 — no existence oracle). Revoking the presented session is
   * sign-out; the bounded-window guarantee (§1) holds because session state
   * is verified per request (no caching — window ≈ 0 ≤ config bound).
   */
  async revokeSession(userId: string, rawSessionId: string): Promise<void> {
    if (!isUuid(rawSessionId)) {
      throw new KalProblemException('NOT_FOUND');
    }
    const claimed = await this.inAppRoleTx(async (tx) =>
      tx.session.updateMany({
        where: { id: rawSessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    if (claimed.count >= 1) {
      return;
    }
    const ownAlreadyRevoked = await this.inAppRoleTx(async (tx) =>
      tx.session.findFirst({ where: { id: rawSessionId, userId }, select: { id: true } }),
    );
    if (ownAlreadyRevoked === null) {
      throw new KalProblemException('NOT_FOUND');
    }
  }

  // ---------------------------------------------------------------------------
  // profile — GET /identity/me (§2)
  // ---------------------------------------------------------------------------

  async profile(userId: string): Promise<{ user: { id: string; username: string; email: string; phone: string | null; createdAt: string } }> {
    const user = await this.inAppRoleTx(async (tx) =>
      tx.user.findFirst({
        where: { id: userId },
        select: { id: true, username: true, email: true, phone: true, status: true, createdAt: true },
      }),
    );
    if (user === null || user.status !== 'active') {
      // Fail closed (I2): the context no longer resolves to a live account.
      throw new KalProblemException('UNAUTHENTICATED');
    }
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // unit-of-work plumbing
  // ---------------------------------------------------------------------------

  /**
   * Runs the unit of work inside `SET LOCAL ROLE kal_app` (per-transaction;
   * reverts at commit/rollback): request-scope data access holds only the
   * least-privilege grants the migrations ship (README "Roles & row-level
   * security"). The transaction-local timezone is pinned to UTC so every
   * timestamptz the driver serializes back carries an explicit `+00` offset —
   * the API treats timestamps as UTC instants (conventions §0), and this
   * keeps reads exact regardless of the server cluster's local timezone.
   */
  private async inAppRoleTx<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`;
      return work(tx);
    });
  }
}
