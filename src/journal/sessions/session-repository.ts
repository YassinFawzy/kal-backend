/**
 * Kal — journal session repository (the ONLY data access this lane's
 * services and handlers use).
 *
 * Isolation posture (I1/I2 — every query here is explicit):
 *   - Every journal_sessions / journal_session_exercises /
 *     journal_exercise_sets statement binds `userId` — an absent predicate
 *     is a review-blocking defect; the surrounding transaction also carries
 *     the app-role/GUC posture (`journal-tx.ts`) as the independent
 *     ADR-0002 backstop (handlers run on sync's batch transaction, which
 *     sets the same posture per the frozen seam).
 *   - `exercises` (the platform catalog, RLS declined — w4 note §5) is
 *     read ONLY through the `ExerciseCatalogResolutionPort`, never here.
 *   - No method here queries diary/sync/tracking tables (module gate); sync
 *     talks to this module only through the frozen seam (handlers/providers).
 *
 * The session row's LWW columns (`updated_at` = the winning op's
 * client-authored `clientUpdatedAt`, `last_op_id` = its opId) are written
 * through the typed client — JournalSession carries NO `@updatedAt`
 * directive (unlike its child tables), so Prisma writes exactly the
 * provided client-authored value (the diary pattern). Child tables ARE
 * `@updatedAt` — their timestamps are server bookkeeping, never the LWW
 * substrate, and the grants matrix permits exactly that.
 *
 * Children are written as FULL-SNAPSHOT REPLACEMENTS (the W3 serving-set
 * pattern; observables identical to upsert-in-place): a create or winning
 * update soft-deletes the session's current non-deleted exercise entries
 * (tombstone semantics — never a hard DELETE; the owned history tables
 * carry no DELETE grant) and inserts the new set with fresh server ids.
 */
import { Injectable } from '@nestjs/common';
import type { JournalSession } from '../../../generated/prisma/client.ts';
import type { JournalTx } from '../journal-tx.js';
import type { SessionSnapshot, StoredExerciseAggregate, StoredSessionAggregate } from './session-snapshot.js';

export interface InsertSessionParams {
  readonly userId: string;
  readonly entityId: string;
  readonly snapshot: SessionSnapshot;
  readonly clientUpdatedAt: Date;
  readonly opId: string;
  /** Server-derived display names per exerciseId (frozen at apply time — §1.1). */
  readonly catalogNames: Map<string, { readonly nameEn: string; readonly nameAr: string | null }>;
}

@Injectable()
export class SessionRepository {
  /** The row INCLUDING its tombstone state — the §1.3 state machine reads it whole. */
  findSessionIncludingDeleted(tx: JournalTx, userId: string, entityId: string): Promise<JournalSession | null> {
    return tx.journalSession.findFirst({ where: { id: entityId, userId } });
  }

  /** Create (§1.3): the client entity id IS the row id; LWW columns client-authored. */
  async insertSessionWithChildren(tx: JournalTx, params: InsertSessionParams): Promise<void> {
    await tx.journalSession.create({
      data: {
        id: params.entityId,
        userId: params.userId,
        localDate: localDateColumn(params.snapshot.localDate),
        ...(params.snapshot.title === undefined ? {} : { title: params.snapshot.title }),
        updatedAt: params.clientUpdatedAt,
        lastOpId: params.opId,
      },
    });
    await this.insertChildren(tx, params.userId, params.entityId, params.snapshot, params.catalogNames);
  }

  /**
   * Winning update (§1.3/§1.4): full snapshot replacement — the LWW columns
   * move to the winning op's substrate, the children are replaced. The
   * explicit `userId` predicate is structural (I1): the compound
   * (id, user_id) unique key makes cross-account writes impossible.
   */
  async updateSessionWithChildren(
    tx: JournalTx,
    params: InsertSessionParams & { readonly entityId: string },
  ): Promise<void> {
    const updated = await tx.journalSession.updateMany({
      where: { id: params.entityId, userId: params.userId },
      data: {
        localDate: localDateColumn(params.snapshot.localDate),
        title: params.snapshot.title ?? null,
        updatedAt: params.clientUpdatedAt,
        lastOpId: params.opId,
      },
    });
    if (updated.count !== 1) {
      // The row was visible to the handler's read in THIS transaction —
      // reaching here would mean a broken posture. Refuse rather than
      // half-apply (fail closed).
      throw new Error('journal session apply: winning update matched no row (fail-closed)');
    }
    await this.replaceChildren(tx, params.userId, params.entityId, params.snapshot, params.catalogNames);
  }

  /** Tombstone write (§1.3 delete): `deleted_at` server-side; LWW columns client-authored. */
  async tombstoneSession(
    tx: JournalTx,
    params: { readonly userId: string; readonly entityId: string; readonly clientUpdatedAt: Date; readonly opId: string },
  ): Promise<void> {
    const deleted = await tx.journalSession.updateMany({
      where: { id: params.entityId, userId: params.userId },
      data: {
        deletedAt: new Date(), // server-side tombstone instant (§1.3)
        updatedAt: params.clientUpdatedAt, // the LWW substrate stays client-authored
        lastOpId: params.opId,
      },
    });
    if (deleted.count !== 1) {
      throw new Error('journal session apply: tombstone write matched no row (fail-closed)');
    }
  }

  // -------------------------------------------------------------------------
  // Reads (day read + delta hydration + mark recompute inputs)
  // -------------------------------------------------------------------------

  /** One session aggregate for reads (non-deleted children, deterministic order). */
  async findSessionAggregate(tx: JournalTx, userId: string, sessionId: string): Promise<StoredSessionAggregate | null> {
    const session = await tx.journalSession.findFirst({
      where: { id: sessionId, userId, deletedAt: null },
    });
    if (session === null) {
      return null;
    }
    return { session, exercises: await this.findExerciseAggregates(tx, userId, session.id) };
  }

  /** One session's non-deleted children in the frozen total order (position, then entry id). */
  private async findExerciseAggregates(tx: JournalTx, userId: string, sessionId: string): Promise<StoredExerciseAggregate[]> {
    const exerciseRows = await tx.journalSessionExercise.findMany({
      where: { sessionId, userId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    if (exerciseRows.length === 0) {
      return [];
    }
    const setRows = await tx.journalExerciseSet.findMany({
      where: { sessionExerciseId: { in: exerciseRows.map((row) => row.id) }, userId, deletedAt: null },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    const setsByExercise = new Map<string, typeof setRows>();
    for (const setRow of setRows) {
      const bucket = setsByExercise.get(setRow.sessionExerciseId);
      if (bucket === undefined) {
        setsByExercise.set(setRow.sessionExerciseId, [setRow]);
      } else {
        bucket.push(setRow);
      }
    }
    return exerciseRows.map((exercise) => ({
      exercise,
      sets: setsByExercise.get(exercise.id) ?? [],
    }));
  }

  /** A day's active sessions, deterministic order (creation, then id — the diary-day posture). */
  async findDayAggregates(tx: JournalTx, userId: string, localDate: Date): Promise<StoredSessionAggregate[]> {
    const sessionRows = await tx.journalSession.findMany({
      where: { userId, localDate, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const aggregates: StoredSessionAggregate[] = [];
    for (const session of sessionRows) {
      aggregates.push({ session, exercises: await this.findExerciseAggregates(tx, userId, session.id) });
    }
    return aggregates;
  }

  /** The mark-recompute input: how many ACTIVE sessions the user has on the day. */
  async countActiveSessionsOnDay(tx: JournalTx, userId: string, localDate: Date): Promise<number> {
    return tx.journalSession.count({ where: { userId, localDate, deletedAt: null } });
  }

  // -------------------------------------------------------------------------
  // Child writes (full-snapshot replacement — the W3 serving-set pattern)
  // -------------------------------------------------------------------------

  private async insertChildren(
    tx: JournalTx,
    userId: string,
    sessionId: string,
    snapshot: SessionSnapshot,
    catalogNames: InsertSessionParams['catalogNames'],
  ): Promise<void> {
    for (const entry of snapshot.exercises) {
      const names = requireNames(catalogNames, entry.exerciseId);
      const exerciseRow = await tx.journalSessionExercise.create({
        data: {
          sessionId,
          userId,
          exerciseId: entry.exerciseId,
          nameSnapshotEn: names.nameEn,
          nameSnapshotAr: names.nameAr,
          position: entry.position,
        },
      });
      // Payload sets carry NO position field (§1.1 — only exercise entries
      // do): the stored set position IS the payload array index, which the
      // §1.3 PR tiebreak and the §2 projections then read back.
      let setPosition = 0;
      for (const set of entry.sets) {
        await tx.journalExerciseSet.create({
          data: {
            sessionExerciseId: exerciseRow.id,
            userId,
            position: setPosition,
            format: set.format,
            ...(set.format === 'weighted' ? { weightKg: set.weightKg, reps: set.reps } : {}),
            ...(set.format === 'timed' ? { durationSeconds: set.durationSeconds } : {}),
            ...(set.format === 'notes' ? { notesText: set.text } : {}),
          },
        });
        setPosition += 1;
      }
    }
  }

  /** Soft-deletes the superseded children, then inserts the new snapshot's set. */
  private async replaceChildren(
    tx: JournalTx,
    userId: string,
    sessionId: string,
    snapshot: SessionSnapshot,
    catalogNames: InsertSessionParams['catalogNames'],
  ): Promise<void> {
    await tx.journalSessionExercise.updateMany({
      where: { sessionId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.insertChildren(tx, userId, sessionId, snapshot, catalogNames);
  }
}

function requireNames(
  catalogNames: InsertSessionParams['catalogNames'],
  exerciseId: string,
): { readonly nameEn: string; readonly nameAr: string | null } {
  const names = catalogNames.get(exerciseId);
  if (names === undefined) {
    // The handler validated every id before calling — reaching here would
    // mean a broken posture. Refuse rather than write a fabricated snapshot.
    throw new Error('journal session apply: catalog names missing for a validated exercise (fail-closed)');
  }
  return names;
}

function localDateColumn(localDate: string): Date {
  return new Date(`${localDate}T00:00:00Z`);
}
