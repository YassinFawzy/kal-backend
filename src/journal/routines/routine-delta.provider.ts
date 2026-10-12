/**
 * Kal — the `journal_routine` delta provider (wave-04 contract §1.4; the
 * frozen wave-03 §1.6 feed semantics inherited verbatim).
 *
 * The delta feed is the convergence channel: LWW losers change nothing at
 * apply time and rely on this feed to reach every device; tombstones
 * propagate as `delete` changes (no payload) so deleted templates never
 * reappear on any device, and a stale pull can never resurrect one (the
 * feed simply never emits deleted rows again beyond their one tombstone
 * change — tombstone retention is indefinite, HD-19 untouched).
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
 * Payloads are FULL entity snapshots (`upsert`) — the stored-tree projection
 * of `./routine-payload.ts` (server child ids + frozen name snapshots; the
 * §2 session projection's shape mirrored for templates). Routine payloads
 * are health data: every query binds the validated context's `userId`
 * explicitly (I1) inside the caller's RLS-postured transaction (I2) — a
 * foreign context receives an empty feed, never another user's rows (I7).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { routineToProjection } from './routine-payload.js';
import type {
  RoutineDeltaChange,
  RoutineDeltaCursorState,
  RoutineDeltaProvider,
  RoutineOpContext,
} from './routine-seams.js';

@Injectable()
export class RoutineDeltaProviderService implements RoutineDeltaProvider {
  readonly kind = 'journal_routine' as const;

  async changesSince(
    cursor: RoutineDeltaCursorState | null,
    limit: number,
    ctx: RoutineOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: RoutineDeltaChange[]; exhausted: boolean }> {
    const take = Math.floor(limit);
    if (!Number.isFinite(take) || take < 1) {
      throw new RangeError('routine delta: limit must be a positive integer (sync owns clamping — seam violation)');
    }
    // Malformed cursor states are refused HERE (fail-closed seam violation)
    // before any SQL — a malformed instant reaching the database would abort
    // the caller's transaction as a raw 22007 instead of a clean refusal.
    if (cursor !== null) {
      parseCursorInstant(cursor.updatedAt);
      if (typeof cursor.entityId !== 'string' || cursor.entityId.length === 0) {
        throw new RangeError('routine delta: malformed cursor entity (sync owns cursor verification — seam violation)');
      }
    }
    // Millisecond-truncated keyset page (the wave-03 SUPERVISOR AMENDMENT 2
    // pattern, pinned for the diary provider): timestamptz(6) rows can carry
    // microseconds the ms-precision cursor instants cannot express; a raw
    // updatedAt keyset lets sub-ms rows reappear across pages. Ordering and
    // the strictly-after filter both key on date_trunc('millisecond', …) so
    // paging is exact; full trees hydrate through the caller-scoped typed
    // client (page ids → findMany) — hydration order never matters.
    const page = await tx.$queryRaw<{ id: string; updatedAt: Date; deletedAt: Date | null }[]>`
      SELECT id::text AS "id", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM journal_routines
      WHERE user_id = ${ctx.userId}::uuid ${
        cursor === null
          ? Prisma.empty
          : Prisma.sql`AND (date_trunc('millisecond', updated_at), id::text) > (${cursor.updatedAt}::timestamptz, ${cursor.entityId}::text)`
      }
      ORDER BY date_trunc('millisecond', updated_at) ASC, id::text ASC
      LIMIT ${take}`;
    if (page.length === 0) {
      return { changes: [], exhausted: true };
    }
    const rows = await tx.journalRoutine.findMany({
      where: { userId: ctx.userId, id: { in: page.map((row) => row.id) } },
      select: {
        id: true,
        name: true,
        exercises: {
          where: { deletedAt: null },
          select: {
            id: true,
            position: true,
            exerciseId: true,
            nameSnapshotEn: true,
            nameSnapshotAr: true,
            sets: { where: { deletedAt: null }, select: { id: true, position: true, format: true, weightKg: true, reps: true, durationSeconds: true, notesText: true } },
          },
        },
      },
    });
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const changes = page.flatMap((pageRow): RoutineDeltaChange[] => {
      const row = rowById.get(pageRow.id);
      if (row === undefined) {
        return []; // unobservable: page ids come from the same scoped table
      }
      const deleted = pageRow.deletedAt !== null;
      return [{
        kind: this.kind,
        entityId: row.id,
        change: deleted ? ('delete' as const) : ('upsert' as const),
        updatedAt: msIso(pageRow.updatedAt),
        ...(deleted ? {} : { payload: routineToProjection(row) }),
      }];
    });
    return { changes, exhausted: changes.length < take };
  }
}

/**
 * Millisecond-precise ISO instant — EXACTLY the stored `updated_at` (the
 * amendment-2 keyset orders on `date_trunc('millisecond', …)`, so the served
 * instant must carry millisecond precision for strict same-second keyset
 * continuation; the seam docblock pins "the stored updated_at as an ISO
 * instant"). Cross-kind note: a coarser-served sibling kind stays
 * convergence-safe against this precision (a finer cursor can only
 * re-emit already-emitted rows — LWW-guarded overlays are idempotent;
 * nothing can be skipped that the global order did not already serve).
 */
function msIso(instant: Date): string {
  return instant.toISOString();
}

function parseCursorInstant(value: string): Date {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new RangeError('routine delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('routine delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  return parsed;
}
