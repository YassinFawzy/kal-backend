/**
 * Kal — the recent-exercise INPUTS service (wave-04; PRD §10/FR-024 "recents
 * surfaced").
 *
 * Recents are DERIVED INPUTS, never a synced entity and never stored: this
 * service recomputes, on every call, the caller's most recently trained
 * exercises from the caller's OWN applied session rows (the frozen posture:
 * "derived inputs (per-user recent exercises) computed from the user's own
 * session data through journal-module services; no new synced entity"). NO
 * REST endpoint exists for recents in `w4` (contract §9 — the app's recents
 * surface is client-derived offline; this is the server-side module seam
 * the journal module owns for its own consumers). Routines never contribute
 * (templates are not logs).
 *
 * Deterministic ordering (documented, no wall-clock dependence — a pure
 * function of stored rows): an exercise's rank is its best
 * `(localDate DESC, session updatedAt DESC, sessionId ASC, entry position
 * ASC, entry id ASC)` occurrence — the TRAINING DAY leads (an edited old
 * session stays old), session-scoped keys break same-day ties, and the ids
 * make the order total. Output is the distinct-per-exercise newest-first
 * list, `limit`-capped. Names come from the entries' FROZEN name snapshots
 * (I11-analog — display data is never re-resolved from the catalog).
 *
 * The read is per-authenticated-user by construction (I1/I2/I6): the query
 * binds `userId` explicitly and runs under the journal's per-transaction
 * posture (`../user-scope-tx.ts`). Deleted sessions and superseded entries
 * never contribute (tombstone posture). Launch-scale note: DISTINCT ON
 * keeps this one indexed scan over the caller's own rows — no caching layer
 * (ARCHITECTURE §22 posture).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx } from '../user-scope-tx.js';

export interface RecentExerciseInput {
  readonly exerciseId: string;
  /** Frozen-at-log-time display names (never re-resolved from the catalog). */
  readonly nameSnapshotEn: string;
  readonly nameSnapshotAr: string | null;
  /** `YYYY-MM-DD` of the most recent session training this exercise. */
  readonly lastLoggedOn: string;
}

const RECENTS_LIMIT_MAX = 100;

@Injectable()
export class RecentsService {
  constructor(private readonly db: PrismaService) {}

  /**
   * The user's most recent distinct exercises, newest first, `limit`-capped
   * (1..100 — defensive bounds; the caller owns its input).
   */
  async recentExercises(userId: string, limit: number): Promise<readonly RecentExerciseInput[]> {
    const take = Math.floor(limit);
    if (!Number.isFinite(take) || take < 1 || take > RECENTS_LIMIT_MAX) {
      throw new RangeError('recents: limit must be an integer in 1..100');
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      // DISTINCT ON picks each exercise's best-ranked occurrence under the
      // exact rank order; the outer sort re-ranks the survivors newest-first
      // for the output. `(user_id)` joins and predicates are explicit (I1);
      // RLS scopes every row independently (I2 backstop).
      const rows = await tx.$queryRaw<{
        exerciseId: string;
        nameSnapshotEn: string;
        nameSnapshotAr: string | null;
        localDate: Date;
        updatedAt: Date;
        sessionId: string;
        position: number;
        entryId: string;
      }[]>`
        SELECT DISTINCT ON (se.exercise_id)
          se.exercise_id::text AS "exerciseId",
          se.name_snapshot_en AS "nameSnapshotEn",
          se.name_snapshot_ar AS "nameSnapshotAr",
          s.local_date AS "localDate",
          s.updated_at AS "updatedAt",
          s.id::text AS "sessionId",
          se.position AS "position",
          se.id::text AS "entryId"
        FROM journal_session_exercises se
        JOIN journal_sessions s ON s.id = se.session_id AND s.user_id = se.user_id
        WHERE se.user_id = ${userId}::uuid
          AND se.deleted_at IS NULL
          AND s.deleted_at IS NULL
        ORDER BY se.exercise_id, s.local_date DESC, s.updated_at DESC, s.id ASC, se.position ASC, se.id ASC`;
      rows.sort((a, b) => {
        const byDate = b.localDate.getTime() - a.localDate.getTime();
        if (byDate !== 0) {
          return byDate;
        }
        const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
        if (byUpdated !== 0) {
          return byUpdated;
        }
        if (a.sessionId !== b.sessionId) {
          return a.sessionId < b.sessionId ? -1 : 1;
        }
        const byPosition = a.position - b.position;
        if (byPosition !== 0) {
          return byPosition;
        }
        return a.entryId < b.entryId ? -1 : 1;
      });
      return rows.slice(0, take).map((row) => ({
        exerciseId: row.exerciseId,
        nameSnapshotEn: row.nameSnapshotEn,
        nameSnapshotAr: row.nameSnapshotAr,
        lastLoggedOn: row.localDate.toISOString().slice(0, 10),
      }));
    });
  }
}
