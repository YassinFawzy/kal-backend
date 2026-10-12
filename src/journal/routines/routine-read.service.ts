/**
 * Kal — the routine READ service (wave-04; owning-user-only reads).
 *
 * Routine MUTATIONS exist exclusively as `journal_routine` sync ops (the §2
 * freeze — no POST/PUT/PATCH/DELETE on any `/journal` path); reads flow
 * through the sync delta feed for the client. This service is the journal
 * module's sanctioned in-module read model (owning-user-only by
 * construction): it projects stored templates in the deterministic
 * `(updatedAt DESC, id ASC)` order for module-internal consumers and suites,
 * with the same full-snapshot projection the delta feed serves.
 *
 * The read is per-authenticated-user by construction (I1/I2/I6): every
 * query binds `userId` explicitly and runs under the journal's shared
 * per-transaction posture (`../journal-tx.ts` — `SET LOCAL ROLE kal_app`
 * + `app.user_id` + `TimeZone UTC`). A foreign or absent id is
 * indistinguishable from "no such template" (I7): the outcome is `undefined`
 * either way, never an existence oracle.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx } from '../journal-tx.js';
import { routineToProjection, type RoutineProjection } from './routine-payload.js';

@Injectable()
export class RoutineReadService {
  constructor(private readonly db: PrismaService) {}

  /** The owning user's non-deleted templates, newest-edit first. */
  async listRoutines(userId: string): Promise<{ readonly id: string; readonly projection: RoutineProjection }[]> {
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const rows = await tx.journalRoutine.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
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
              sets: {
                where: { deletedAt: null },
                select: { id: true, position: true, format: true, weightKg: true, reps: true, durationSeconds: true, notesText: true },
              },
            },
          },
        },
      });
      return rows.map((row) => ({ id: row.id, projection: routineToProjection(row) }));
    });
  }

  /**
   * One template by id, owning-user-only. `undefined` for absent, tombstoned
   * AND foreign ids alike (I7 — no existence oracle; the sync feed surfaces
   * tombstones as `delete` changes, this service only serves live rows).
   */
  async getRoutine(userId: string, routineId: string): Promise<RoutineProjection | undefined> {
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const row = await tx.journalRoutine.findFirst({
        where: { id: routineId, userId, deletedAt: null },
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
              sets: {
                where: { deletedAt: null },
                select: { id: true, position: true, format: true, weightKg: true, reps: true, durationSeconds: true, notesText: true },
              },
            },
          },
        },
      });
      return row === null ? undefined : routineToProjection(row);
    });
  }
}
