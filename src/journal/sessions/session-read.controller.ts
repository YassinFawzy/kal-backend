/**
 * Kal — the journal session READ controller (w4 contract §2
 * `journal.sessions.day.get` + `journal.sessions.get`; the §2 freeze:
 * no `POST/PUT/PATCH/DELETE` on any `/journal` path may exist within `w4`
 * — journal mutations flow exclusively through sync ingestion).
 *
 * Exactly the frozen endpoints (auth: bearer):
 *   `GET /journal/sessions/days/{localDate}` → `200 {localDate, sessions}`
 *     · `400` (malformed date) · `401`;
 *   `GET /journal/sessions/{sessionId}` → `200 {session}` · `401` ·
 *     `404 NOT_FOUND` (byte-identical for absent, malformed, tombstoned,
 *     or foreign ids — I7).
 *
 * Route order matters: the literal `days/…` path is declared BEFORE the
 * parameterized session-id path so Nest matches it first.
 */
import { Controller, Get, Param } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { SessionReadService } from './session-read.service.js';

@Controller('journal')
export class SessionReadController {
  constructor(
    private readonly reads: SessionReadService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Get('sessions/days/:localDate')
  @RequireIdentityBearer()
  async readDay(@Param('localDate') localDate: unknown): Promise<unknown> {
    return this.reads.readDay(this.requireConsumerId(), localDate);
  }

  @Get('sessions/:sessionId')
  @RequireIdentityBearer()
  async readSession(@Param('sessionId') sessionId: unknown): Promise<unknown> {
    // The frozen §2 body: `{session}` (the day read is `{localDate, sessions}`).
    return { session: await this.reads.readSession(this.requireConsumerId(), sessionId) };
  }

  /** Guards set the context; absence here is a fail-closed refusal (I2). */
  private requireConsumerId(): string {
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('UNAUTHENTICATED');
    }
    return context.userId;
  }
}
