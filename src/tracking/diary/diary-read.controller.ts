/**
 * Kal — the diary day READ controller (wave-03 contract §2
 * `tracking.diary.day.get`; the ONLY diary HTTP surface — the §2 freeze:
 * no `POST/PUT/PATCH/DELETE` on any `/diary` path may exist within `w3`;
 * diary mutations flow exclusively through sync ingestion, I8).
 *
 * Exactly the frozen endpoint: `GET /tracking/diary/days/{localDate}`
 * (auth: bearer) → `200 {localDate, totals, entries}` · `400` (malformed
 * date) · `401`. Copy-yesterday and recents are client compositions — no
 * server surface exists for them (nothing to assert but absence).
 */
import { Controller, Get, Param } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { DiaryReadService } from './diary-read.service.js';

@Controller('tracking')
export class DiaryReadController {
  constructor(
    private readonly reads: DiaryReadService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Get('diary/days/:localDate')
  @RequireIdentityBearer()
  async readDay(@Param('localDate') localDate: unknown): Promise<unknown> {
    return this.reads.readDay(this.requireConsumerId(), localDate);
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
