/**
 * Kal — the `diary_entry` delta provider (wave-03 contract §1.6, the frozen
 * `TrackingDeltaProvider` seam).
 *
 * The delta feed is the convergence channel: LWW losers change nothing at
 * apply time and rely on this feed to reach every device; tombstones
 * propagate as `delete` changes (no payload) so deleted entries never
 * reappear on any device, and a stale pull can never resurrect one (the
 * feed simply never emits deleted rows again beyond their one tombstone
 * change — tombstone retention is indefinite in W3, HD-19 untouched).
 *
 * Ordering is the frozen feed order `(updatedAt, kind, entityId)` ascending
 * (§1.6); within this provider the kind is constant, so the resume key is
 * the per-kind cursor state `(updatedAt, entityId)` — a keyset over the
 * user's OWN rows in their current state (not a change log: a tombstoned
 * row appears exactly once, as its payload-free `delete`, sorted at the
 * winning op's substrate). `cursor === null` is the FIRST PULL: the feed
 * starts from its beginning (bootstrap and gap-fill are the same mechanism
 * as an incremental pull).
 *
 * The opaque, user-bound cursor token itself is minted/verified and
 * decomposed into per-kind states by sync (§4 — cursor mint/verify is
 * sync-owned); the global `(updatedAt, kind, entityId)` merge across the
 * three providers' pages is likewise sync's assembly concern.
 *
 * Payloads are FULL entity snapshots (`upsert`) — the same frozen snapshot
 * shape as the op payload (§1.6). Diary payloads are health data: every
 * query binds the validated context's `userId` explicitly (I1) inside the
 * caller's RLS-postured transaction (I2) — a foreign context receives an
 * empty feed, never another user's rows (I7).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { rowToSnapshot } from './diary-snapshot.js';
import type { DeltaChange, DeltaCursorState, SyncOpContext, SyncOpKind, TrackingDeltaProvider } from '../sync-seams.js';

@Injectable()
export class DiaryDeltaProvider implements TrackingDeltaProvider {
  readonly kind: SyncOpKind = 'diary_entry';

  async changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
    const take = Math.floor(limit);
    if (!Number.isFinite(take) || take < 1) {
      throw new RangeError('diary delta: limit must be a positive integer (sync owns clamping — seam violation)');
    }
    const where: Prisma.DiaryEntryWhereInput = cursor === null
      ? { userId: ctx.userId } // first pull: the feed starts at its beginning
      : this.strictlyAfter(cursor, ctx);
    const rows = await tx.diaryEntry.findMany({
      where,
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take,
    });

    const changes = rows.map<DeltaChange>((row) => {
      const deleted = row.deletedAt !== null;
      return {
        kind: this.kind,
        entityId: row.id,
        change: deleted ? 'delete' : 'upsert',
        updatedAt: row.updatedAt.toISOString(),
        ...(deleted ? {} : { payload: rowToSnapshot(row) }),
      };
    });
    return { changes, exhausted: changes.length < take };
  }

  /** Keyset continuation: rows strictly after `(cursor.updatedAt, cursor.entityId)` within this kind. */
  private strictlyAfter(cursor: DeltaCursorState, ctx: SyncOpContext): Prisma.DiaryEntryWhereInput {
    const cursorUpdatedAt = parseCursorInstant(cursor.updatedAt);
    return {
      userId: ctx.userId,
      OR: [{ updatedAt: { gt: cursorUpdatedAt } }, { updatedAt: { equals: cursorUpdatedAt }, id: { gt: cursor.entityId } }],
    };
  }
}

function parseCursorInstant(value: string): Date {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new RangeError('diary delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('diary delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  return parsed;
}
