/**
 * Kal — the `journal_session` delta provider (w4 contract §1.4; the frozen
 * `TrackingDeltaProvider` seam — the w3 §1.6 semantics inherited verbatim,
 * extended by the new kind).
 *
 * The delta feed is the convergence channel: LWW losers change nothing at
 * apply time and rely on this feed to reach every device; tombstones
 * propagate as `delete` changes (no payload) so deleted sessions never
 * reappear on any device, and a stale pull can never resurrect one (the
 * feed simply never emits deleted rows again beyond their one tombstone
 * change — tombstone retention is indefinite, HD-19 untouched).
 *
 * Ordering is the frozen feed order `(updatedAt, kind, entityId)` ascending
 * (§1.6); within this provider the kind is constant, so the resume key is
 * the per-kind cursor state `(updatedAt, entityId)` — a keyset over the
 * user's OWN rows in their current state (not a change log: a tombstoned
 * session appears exactly once, as its payload-free `delete`, sorted at the
 * winning op's substrate). `cursor === null` is the FIRST PULL: the feed
 * starts from its beginning (bootstrap and gap-fill are the same mechanism
 * as an incremental pull).
 *
 * Upsert payloads are the §2 stored-entity PROJECTION — id, localDate,
 * title?, updatedAt, and the ordered non-deleted exercise entries WITH the
 * frozen-at-log-time name snapshots and set rows. SUPERVISOR RULING 4
 * (w04, 2026-10-12) fixes this shape: offline display of PULLED sessions
 * must resolve names from the FROZEN snapshots, never the live catalog (a
 * catalog rename must never rewrite how old sessions display offline — the
 * exact I11-analog bug the snapshots exist to prevent); the client's only
 * offline carriers of snapshots are the feed (sync) and §2 reads (online),
 * so they carry the SAME projection, and s3a's client bridge (Ruling 2)
 * stores exactly these fields from it. Training-day marks NEVER appear in
 * this feed (§1.2 — a projection must not become a sync entity).
 *
 * Session payloads are health data: every query binds the validated
 * context's `userId` explicitly (I1) inside the caller's RLS-postured
 * transaction (I2) — a foreign context receives an empty feed, never
 * another user's rows (I7).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { JournalTx } from '../journal-tx.js';
import { aggregateToSessionView } from './session-snapshot.js';
import { SessionRepository } from './session-repository.js';
import type { DeltaChange, DeltaCursorState, SyncOpContext, SyncOpKind, TrackingDeltaProvider } from '../../tracking/sync-seams.js';

@Injectable()
export class SessionDeltaProvider implements TrackingDeltaProvider {
  readonly kind: SyncOpKind = 'journal_session';

  constructor(private readonly repository: SessionRepository) {}

  async changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: JournalTx,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
    const take = Math.floor(limit);
    if (!Number.isFinite(take) || take < 1) {
      throw new RangeError('journal session delta: limit must be a positive integer (sync owns clamping — seam violation)');
    }
    // Malformed cursor states are refused HERE (fail-closed seam violation)
    // before any SQL — a malformed instant reaching the database would abort
    // the caller's transaction as a raw 22007 instead of a clean refusal.
    if (cursor !== null) {
      parseCursorInstant(cursor.updatedAt);
      if (typeof cursor.entityId !== 'string' || cursor.entityId.length === 0) {
        throw new RangeError('journal session delta: malformed cursor entity (sync owns cursor verification — seam violation)');
      }
    }
    // Millisecond-truncated keyset page mirroring the diary/foods pattern
    // (the W3 supervisor-amendment posture): timestamptz(6) rows can carry
    // microseconds the ms-precision cursor instants cannot express; a raw
    // updatedAt keyset lets sub-ms rows reappear across pages. Ordering and
    // the strictly-after filter both key on date_trunc('millisecond', …) so
    // paging is exact; full rows hydrate through the caller-scoped typed
    // client (page ids → repository) — hydration order never matters.
    const page = await tx.$queryRaw<{ id: string; updatedAt: Date; deletedAt: Date | null }[]>`
      SELECT id::text AS "id", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM journal_sessions
      WHERE user_id = ${ctx.userId}::uuid ${
        cursor === null
          ? Prisma.empty
          : Prisma.sql`AND (date_trunc('millisecond', updated_at), id::text) > (${cursor.updatedAt}::timestamptz, ${cursor.entityId}::text)`
      }
      ORDER BY date_trunc('millisecond', updated_at) ASC, id::text ASC
      LIMIT ${take}`;
    const changes: DeltaChange[] = [];
    for (const pageRow of page) {
      const row = await this.repository.findSessionIncludingDeleted(tx, ctx.userId, pageRow.id);
      if (row === null) {
        continue; // unobservable: page ids come from the same scoped table
      }
      const deleted = row.deletedAt !== null;
      if (deleted) {
        changes.push({
          kind: this.kind,
          entityId: row.id,
          change: 'delete',
          updatedAt: msIso(row.updatedAt),
        });
        continue;
      }
      const aggregate = await this.repository.findSessionAggregate(tx, ctx.userId, row.id);
      if (aggregate === null) {
        continue; // unobservable: the row was visible above in THIS transaction
      }
      changes.push({
        kind: this.kind,
        entityId: row.id,
        change: 'upsert',
        updatedAt: msIso(row.updatedAt),
        payload: aggregateToSessionView(aggregate), // the §2 projection — Ruling 4
      });
    }
    return { changes, exhausted: page.length < take };
  }
}

/** Millisecond-precise ISO instant (matches the truncated cursor ordering).
 * w04 SUPERVISOR AMENDMENT 2 (2026-10-13, finding F-s4-1): exact ms — the
 * whole-second flooring re-qualified sub-second rows against their own
 * floored cursors (never-draining bounded walks; census-pinned by w04-s4-adv).
 * Exact-ms serving equals the date_trunc('millisecond', …) keyset. */
function msIso(instant: Date): string {
  return instant.toISOString();
}

function parseCursorInstant(value: string): Date {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new RangeError('journal session delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('journal session delta: malformed cursor instant (sync owns cursor verification — seam violation)');
  }
  return parsed;
}
