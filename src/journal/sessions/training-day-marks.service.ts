/**
 * Kal — training-day marks (PRD §21 "Training-day marking", FR-025; w4
 * contract §1.2).
 *
 * THE TRAINING-DAY RULE (frozen — this comment is the normative statement
 * the tests pin): the mark row `(user_id, local_date)` exists **iff** at
 * least one ACTIVE (non-deleted) session exists for that user+day. Marks
 * are DERIVED-NEVER-SYNCED:
 *   - derived server-side INSIDE the session-apply unit of work on every
 *     applied op that touches a day (create / winning update / delete) — a
 *     rollup failure aborts the same batch as the session write (no drift
 *     window);
 *   - idempotent: re-applying any op of the same day converges to the same
 *     flag (recompute is a pure function of the day's active sessions);
 *   - tombstoning the LAST active session on a day removes the mark (the
 *     ONE documented DELETE grant on an owned table — a derived cache, not
 *     history: no tombstone semantics to preserve; the projection must
 *     stay exact: ∃ active session ⇔ row);
 *   - an edit op that MOVES a session between client-local days recomputes
 *     BOTH buckets (each from its own active sessions only);
 *   - never client-written, never REST-mutable, NEVER in the delta feed
 *     (a projection must not become a sync entity — the client derives the
 *     flag from its own merged view);
 *   - W5 consumes the flag ONLY through the exported
 *     `JournalTrainingDayReader` (module gates — no table reads across
 *     modules); the flag is not enumerable by any HTTP surface this wave.
 *
 * The carried `local_date` is the only bucketing key (day-boundary rule
 * §1.8): no receive-time, no server-clock re-derivation ever enters this
 * computation.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx, type JournalTx } from '../journal-tx.js';
import { formatLocalDate, isValidLocalDate, localDateToDate } from './session-day.js';
import { SessionRepository } from './session-repository.js';

@Injectable()
export class TrainingDayMarksService {
  constructor(
    private readonly db: PrismaService,
    private readonly repository: SessionRepository,
  ) {}

  /**
   * Recomputes the day's mark from the user's ACTIVE sessions — inside the
   * given transaction (the batch's unit of work). Idempotent by
   * construction: the write converges the projection to the rule's truth.
   */
  async recomputeDay(tx: JournalTx, userId: string, localDate: Date): Promise<void> {
    const activeCount = await this.repository.countActiveSessionsOnDay(tx, userId, localDate);
    if (activeCount > 0) {
      // The flag is the row's EXISTENCE; marked_at is bookkeeping only.
      await tx.journalTrainingDay.upsert({
        where: { userId_localDate: { userId, localDate } },
        create: { userId, localDate },
        update: {},
      });
      return;
    }
    // Zero active sessions ⇒ the mark must NOT exist. The one documented
    // DELETE on an owned table (w4 note §5): a derived cache row removed
    // when its reason disappears — RLS still scopes the delete to the
    // caller's own rows.
    await tx.journalTrainingDay.deleteMany({ where: { userId, localDate } });
  }
}

/**
 * The training-day flag surface (w4 contract §4) — the ONLY sanctioned
 * goals→journal path (W5 consumption; W5 target cycling itself is NOT
 * built this wave). Dates are `YYYY-MM-DD` strings in client-local
 * semantics; the goals module never converts timezones through this seam.
 * Every read runs under the module's per-transaction posture
 * (`kal_app` + `app.user_id` + `TimeZone UTC`) with the explicit user
 * predicate (I1/I2/I6); a foreign context sees only its own marks.
 */
@Injectable()
export class JournalTrainingDayReader {
  constructor(
    private readonly db: PrismaService,
  ) {}

  /** True iff ≥1 ACTIVE session exists for (user, localDate) — the derived mark. */
  async isTrainingDay(userId: string, localDate: string): Promise<boolean> {
    const date = requireValidDay(localDate);
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const row = await tx.journalTrainingDay.findUnique({
        where: { userId_localDate: { userId, localDate: date } },
        select: { userId: true },
      });
      return row !== null;
    });
  }

  /** The derived marks in [from, to] (inclusive, client-local dates) — W5 cycling inputs. */
  async trainingDaysBetween(userId: string, from: string, to: string): Promise<readonly string[]> {
    const fromDate = requireValidDay(from);
    const toDate = requireValidDay(to);
    if (fromDate.getTime() > toDate.getTime()) {
      return [];
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const rows = await tx.journalTrainingDay.findMany({
        where: { userId, localDate: { gte: fromDate, lte: toDate } },
        orderBy: { localDate: 'asc' },
        select: { localDate: true },
      });
      return rows.map((row) => formatLocalDate(row.localDate));
    });
  }
}

function requireValidDay(localDate: string): Date {
  // Internal seam (goals module, W5): a malformed date is a programming
  // error, not a client input — refuse loudly rather than answer wrongly.
  if (!isValidLocalDate(localDate)) {
    throw new RangeError('training-day reader: localDate is not a calendar-valid YYYY-MM-DD date');
  }
  return localDateToDate(localDate);
}
