/**
 * Kal — the diary day READ service (wave-03 contract §2
 * `tracking.diary.day.get`; I8: READ surface only — diary mutations flow
 * exclusively through sync ingestion).
 *
 * `200 {localDate, totals, entries}` — a day with no entries is an EMPTY 200
 * (a date is not an object; no `404` for absent days). Totals serve from the
 * cached `diary_days` rollup (zeros when the day has no rollup row — same
 * observable as an empty day, no oracle); entries list that day's
 * non-deleted entries in deterministic `(mealSlot, createdAt, id)` order —
 * per-meal grouping is the client's rendering concern (each entry carries
 * its `mealSlot` and frozen macros). Totals ONLY: target comparison is W5
 * (ledger §7-E3).
 *
 * The read is per-authenticated-user by construction (I1/I2/I6): the
 * controller hands in the validated consumer context; every query binds
 * `userId` explicitly and runs under the module's shared per-transaction
 * posture helper (`inUserScopeTx` — `SET LOCAL ROLE kal_app` + `app.user_id`
 * + `TimeZone UTC`; NEVER session-level GUCs on pooled clients, F1).
 * A foreign/absent day is indistinguishable from an empty one (I7): the
 * response shape is byte-stable either way.
 */
import { Injectable } from '@nestjs/common';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx } from '../foods/app-role-tx.js';
import { isValidLocalDate, localDateToDate } from './diary-day.js';
import { EMPTY_DAY_TOTALS, rowToEntryView, type DiaryDayTotals, type DiaryDayView } from './diary-snapshot.js';

@Injectable()
export class DiaryReadService {
  constructor(private readonly db: PrismaService) {}

  async readDay(userId: string, localDate: unknown): Promise<DiaryDayView> {
    // Shape-only validation; one generic, value-free denial for every
    // malformed cause (byte-identical, I7/I12).
    if (!isValidLocalDate(localDate)) {
      throw new KalProblemException('VALIDATION_FAILED');
    }
    const date = localDateToDate(localDate);
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const dayRow = await tx.diaryDay.findUnique({
        where: { userId_localDate: { userId, localDate: date } },
      });
      const entryRows = await tx.diaryEntry.findMany({
        where: { userId, localDate: date, deletedAt: null },
        orderBy: [{ mealSlot: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const totals: DiaryDayTotals =
        dayRow === null
          ? EMPTY_DAY_TOTALS
          : {
              energyKcal: Number(dayRow.energyKcal),
              proteinG: Number(dayRow.proteinG),
              carbsG: Number(dayRow.carbsG),
              fatG: Number(dayRow.fatG),
              entryCount: dayRow.entryCount,
            };
      return {
        localDate,
        totals,
        entries: entryRows.map(rowToEntryView),
      };
    });
  }
}
