/**
 * Kal — JWT→UserContext resolver (I2/I6; wave-01 `USER_CONTEXT_RESOLVER` seam).
 *
 * The W2 implementation of `UserContextResolver`: verifies the Bearer
 * access JWT (signature, expiry, exact claim set), then RE-VERIFIES the
 * session record and its `user_id` binding on EVERY request (I6 — stable
 * ids are never authorization): the session must exist, be unrevoked and
 * unexpired, own the token's `sub`, and belong to an `active` account.
 * Any failure — absent header, malformed scheme, bad signature, expired
 * token, unknown/revoked/expired session, foreign binding, closed account —
 * collapses to one of the fail-closed resolutions; the wave-01 guard and
 * the identity bearer guard map every non-`resolved` outcome to a single
 * generic refusal and never state which (I7). No default tenant exists.
 *
 * This is the seam every later authenticated route resolves through: the
 * identity module provides it app-wide via `USER_CONTEXT_RESOLVER`, so
 * `@RequireUserContext()` consumers get JWT-backed resolution without
 * touching this file.
 */
import { Injectable } from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import { PrismaService } from '../db/prisma.service.js';
import {
  USER_CONTEXT_RESOLVER,
  type UserContextResolver,
} from '../request-context/user-context.resolver.js';
import type { UserResolution } from '../request-context/user-context.js';
import { TokenService } from './token.service.js';

/** RFC 7235 scheme matching (case-insensitive), one SP, no inner whitespace. */
const BEARER_PATTERN = /^bearer[ ](\S+)$/iu;

@Injectable()
export class JwtUserContextResolver implements UserContextResolver {
  constructor(
    private readonly tokens: TokenService,
    private readonly db: PrismaService,
  ) {}

  async resolve(request: IncomingMessage): Promise<UserResolution> {
    const rawHeader = request.headers['authorization'];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof header !== 'string') {
      return { status: 'absent' };
    }
    const match = BEARER_PATTERN.exec(header);
    if (match === null) {
      return { status: 'invalid', reason: 'authorization header is not a bearer credential' };
    }

    const claims = await this.tokens.verifyAccessToken(match[1] as string);
    if (claims === null) {
      return { status: 'invalid', reason: 'bearer credential did not verify' };
    }

    // I6: the session record and its user binding are re-verified per request.
    // TimeZone is pinned UTC in-transaction (see identity.service inAppRoleTx).
    const session = await this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`;
      const row = await tx.session.findFirst({
        where: { id: claims.sid, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { userId: true, user: { select: { status: true } } },
      });
      return row;
    });
    if (session === null) {
      return { status: 'invalid', reason: 'session is absent, revoked, or expired' };
    }
    if (session.userId !== claims.sub) {
      return { status: 'invalid', reason: 'token does not belong to the session owner' };
    }
    if (session.user.status !== 'active') {
      return { status: 'invalid', reason: 'owning account is not active' };
    }
    return { status: 'resolved', context: { kind: 'consumer', userId: session.userId } };
  }
}

/** Re-exported so the module file stays the single wiring point. */
export { USER_CONTEXT_RESOLVER };
