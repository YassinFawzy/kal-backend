/**
 * Kal — the journal session READ service (w4 contract §2
 * `journal.sessions.day.get` + `journal.sessions.get`; the §2 freeze:
 * journal mutations do NOT exist over REST — they flow exclusively through
 * sync ingestion; REST is reads only).
 *
 * `journal.sessions.day.get` — `200 {localDate, sessions}`: a day with no
 * sessions is an EMPTY 200 (a date is not an object; no `404` for absent
 * days). Sessions list that day's non-deleted sessions in deterministic
 * `(createdAt, id)` order; each projects its ordered non-deleted exercise
 * entries (frozen name snapshots included — the I11 freeze) and sets.
 *
 * `journal.sessions.get` — `200 {session}` · `404 NOT_FOUND`
 * byte-identical for absent, malformed, tombstoned, AND foreign ids (I7;
 * no existence oracle — the denial set is exactly the w3 posture).
 *
 * Every read is per-authenticated-user by construction (I1/I2/I6): the
 * controller hands in the validated consumer context; every query binds
 * `userId` explicitly and runs under the module's shared per-transaction
 * posture (`inUserScopeTx` — `SET LOCAL ROLE kal_app` +
 * `app.user_id` + `TimeZone UTC`; NEVER session-level GUCs on pooled
 * clients, F1).
 */
import { Injectable } from '@nestjs/common';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx } from '../journal-tx.js';
import { isValidLocalDate, localDateToDate } from './session-day.js';
import { isSessionUuid } from './session-snapshot.js';
import { SessionRepository } from './session-repository.js';
import type { SessionDayView, SessionView } from './session-snapshot.js';
import { aggregateToSessionView } from './session-snapshot.js';

@Injectable()
export class SessionReadService {
  constructor(
    private readonly db: PrismaService,
    private readonly repository: SessionRepository,
  ) {}

  async readDay(userId: string, localDate: unknown): Promise<SessionDayView> {
    // Shape-only validation; one generic, value-free denial for every
    // malformed cause (byte-identical, I7/I12).
    if (!isValidLocalDate(localDate)) {
      throw new KalProblemException('VALIDATION_FAILED');
    }
    const date = localDateToDate(localDate);
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const aggregates = await this.repository.findDayAggregates(tx, userId, date);
      const sessions: SessionView[] = aggregates.map(aggregateToSessionView);
      return { localDate, sessions };
    });
  }

  /**
   * One session, same projection. Absent/malformed/tombstoned/foreign ids
   * are the SAME generic 404 (I7 — the controller maps null to the generic
   * NOT_FOUND; no cause is distinguishable).
   */
  async readSession(userId: string, sessionId: unknown): Promise<SessionView> {
    if (!isSessionUuid(sessionId)) {
      // Malformed ids take the identical generic denial as every other
      // miss — never a 400 that would distinguish malformed from absent.
      throw new KalProblemException('NOT_FOUND');
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const aggregate = await this.repository.findSessionAggregate(tx, userId, sessionId);
      if (aggregate === null) {
        throw new KalProblemException('NOT_FOUND');
      }
      return aggregateToSessionView(aggregate);
    });
  }
}
