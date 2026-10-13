/**
 * Kal — the PR read endpoint (wave-04 contract §2 `journal.exercises.pr.get`).
 *
 * Exactly the frozen endpoint: `GET /journal/exercises/{exerciseId}/pr`
 * (auth: bearer) → `200 {result, pr?}` · `401` · `404 NOT_FOUND` (unknown
 * catalog id — byte-identical generic denial for malformed ids too, §3).
 * READ-ONLY: journal mutations exist ONLY as sync operations (the §2
 * freeze — no POST/PUT/PATCH/DELETE on any `/journal` path may be added
 * within `w4`).
 */
import { Controller, Get, Param } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { PrService } from './pr.service.js';

@Controller('journal')
export class PrController {
  constructor(
    private readonly prs: PrService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Get('exercises/:exerciseId/pr')
  @RequireIdentityBearer()
  async readPr(@Param('exerciseId') exerciseId: unknown): Promise<unknown> {
    return this.prs.readPr(this.requireConsumerId(), typeof exerciseId === 'string' ? exerciseId : '');
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
