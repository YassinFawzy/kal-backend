/**
 * Kal — diary-day cached rollups (wave-03 contract §1.5/§2; PRD §21).
 *
 * The `diary_days` row per (user, local_date) is the cached rollup the day
 * read serves totals from. It is recomputed TRANSACTIONALLY on every apply
 * that touches an entry of the day (create / winning update / delete) —
 * inside the caller's unit of work, so a rollup failure aborts the same
 * batch as the entry write (no drift window). Recomputation always reads
 * from NON-DELETED entries only (contract §1.5: tombstones never contribute;
 * a day emptied by deletions legitimately rolls up to zeros).
 *
 * The carried `local_date` is the only bucketing key (day-boundary rule):
 * no receive-time, no server-clock re-derivation ever enters this
 * computation. Target comparison is W5 (ledger §7-E3) — totals only here.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { DiaryDayTotals } from './diary-snapshot.js';

@Injectable()
export class DiaryRollupsService {
  /**
   * Recomputes the day's cached rollup from the user's non-deleted entries
   * and upserts it — inside the given transaction (the batch's unit of work).
   */
  async recomputeDay(tx: Prisma.TransactionClient, userId: string, localDate: Date): Promise<DiaryDayTotals> {
    const aggregate = await tx.diaryEntry.aggregate({
      where: { userId, localDate, deletedAt: null },
      _sum: { energyKcal: true, proteinG: true, carbsG: true, fatG: true },
      _count: { _all: true },
    });
    const totals = {
      energyKcal: aggregate._sum.energyKcal ?? 0,
      proteinG: aggregate._sum.proteinG ?? 0,
      carbsG: aggregate._sum.carbsG ?? 0,
      fatG: aggregate._sum.fatG ?? 0,
      entryCount: aggregate._count._all,
    };
    await tx.diaryDay.upsert({
      where: { userId_localDate: { userId, localDate } },
      create: { userId, localDate, ...totals },
      update: {
        energyKcal: totals.energyKcal,
        proteinG: totals.proteinG,
        carbsG: totals.carbsG,
        fatG: totals.fatG,
        entryCount: totals.entryCount,
      },
    });
    return {
      energyKcal: Number(totals.energyKcal),
      proteinG: Number(totals.proteinG),
      carbsG: Number(totals.carbsG),
      fatG: Number(totals.fatG),
      entryCount: totals.entryCount,
    };
  }
}
