/**
 * Kal — the sync delta pull service: `GET /sync/changes` (wave-03 contract
 * note §1.6).
 *
 * One sanctioned read path: verify the opaque user-bound cursor (every
 * failure class — foreign/expired/malformed/truncated — is the ONE generic
 * `400 VALIDATION_FAILED`, byte-identically, I7; W3 has no expiry
 * dimension, note §1.6), then compose the page inside ONE user-scoped
 * transaction under the per-transaction posture (`SET LOCAL ROLE kal_app`
 * + `app.user_id` GUC + TimeZone UTC — the identity inAppRoleTx pattern,
 * per-transaction, never session-level GUCs on pooled clients). Provider
 * SQL runs under RLS as the second, independent scoping layer; a foreign
 * cursor can therefore never yield another user's rows at any layer.
 *
 * No health data touches logs; failures are registry codes through the
 * global problem-details filter only (I12). The composition reads tracking
 * data exclusively through the frozen provider registry — never its tables
 * (module gate); kinds without a registered provider contribute nothing.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.ts';
import { PrismaService } from '../../db/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { isUuid } from '../../request-context/user-context.js';
import { SyncDeltaComposer, type ComposedPullPage } from './delta-composer.service.js';
import { SyncDeltaCursorService } from './delta-cursor.service.js';
import { SyncDeltaRegistry } from './delta-registry.js';
import type { GlobalCursorPosition, SyncOpContext } from './seams.js';

/** Server-keyed opaque digest (I14 audit payloads — ids become digests). */
function digestId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The frozen pull envelope (note §1.6). */
export interface SyncPullPage {
  readonly changes: ComposedPullPage['changes'];
  readonly nextCursor: string | null;
}

const MAX_CURSOR_LENGTH = 512;

@Injectable()
export class SyncPullService {
  constructor(
    private readonly db: PrismaService,
    private readonly registry: SyncDeltaRegistry,
    private readonly composer: SyncDeltaComposer,
    private readonly cursors: SyncDeltaCursorService,
    private readonly audit: AuditService,
  ) {}

  async pull(userId: string, rawCursor: string | null, rawLimit: string | null): Promise<SyncPullPage> {
    // Fail closed (I2): the context must be a validated consumer id before
    // any database work — an absent/ambiguous context is never defaulted.
    if (!isUuid(userId)) {
      throw new KalProblemException('FORBIDDEN');
    }
    const limit = this.parseLimit(rawLimit);

    let cursor: GlobalCursorPosition | null = null;
    if (rawCursor !== null) {
      if (rawCursor.length > MAX_CURSOR_LENGTH) {
        throw new KalProblemException('VALIDATION_FAILED');
      }
      cursor = this.cursors.verify(rawCursor, userId);
      if (cursor === null) {
        // AMENDMENT 3 (I14 audit emit): a signature-VALID cursor minted for
        // another account is a server-known cross-tenant fact — emit ONE
        // fire-and-forget audit row (NEVER awaited: a latency-detectable
        // branch would be an authenticity oracle; failure-tolerant), digests
        // only, then reject with the SAME byte-identical generic 400 below.
        const embedded = this.cursors.inspectBinding(rawCursor);
        if (embedded !== null && embedded !== userId) {
          void this.audit
            .append({
              actor: 'system:sync',
              action: 'sync.cursor.foreign_binding',
              target: `cursor:${digestId(userId)}:${digestId(embedded)}`,
              justification: 'A signature-valid delta cursor minted for another account was presented by the caller (I14 cross-tenant signal; response unchanged).',
            })
            .catch(() => undefined);
        }
        // One generic body for every cursor failure class (conventions §2):
        // foreign user, tampered, truncated, malformed — indistinguishable.
        throw new KalProblemException('VALIDATION_FAILED');
      }
    }

    // Pull requests carry no device identity (note §2 pull parameters:
    // cursor/limit only) — see seams.ts SyncOpContext.deviceId.
    const ctx: SyncOpContext = { userId, deviceId: '' };

    const composed = await this.inAppRoleTx(userId, async (tx) =>
      this.composer.compose(cursor, limit, ctx, tx),
    );

    const nextCursor =
      composed.endOfCollection || composed.lastState === null
        ? null
        : this.cursors.mint(userId, composed.lastState);
    return { changes: composed.changes, nextCursor };
  }

  /**
   * `limit` clamps to 1–100 with default 50 (conventions §2); non-integer
   * strings are malformed (the identity session-list precedent).
   */
  private parseLimit(rawLimit: string | null): number {
    if (rawLimit === null || rawLimit === '') {
      return 50;
    }
    if (!/^[0-9]+$/u.test(rawLimit)) {
      throw new KalProblemException('VALIDATION_FAILED');
    }
    return Math.min(100, Math.max(1, Number(rawLimit)));
  }

  /**
   * The pull unit of work under the per-transaction posture (identity
   * inAppRoleTx pattern + the RLS user binding): `SET LOCAL ROLE kal_app`
   * reverts at commit/rollback, the `app.user_id` GUC scopes every adopted
   * table's fail-closed policy to the authenticated account, and the
   * transaction-local TimeZone is pinned UTC so every serialized instant
   * is exact (conventions §0). NEVER session-level GUCs on pooled clients.
   */
  private async inAppRoleTx<T>(userId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userId}, true), set_config('TimeZone', 'UTC', true)`;
      return work(tx);
    });
  }
}
