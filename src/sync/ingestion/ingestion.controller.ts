/**
 * Kal — sync ingestion HTTP surface (wave-03 contract §2, `sync.ops.push`).
 *
 * Exactly the frozen endpoint — `POST /sync/ops` (auth: bearer,
 * `Idempotency-Key` required). The bearer guard resolves through the SAME
 * `USER_CONTEXT_RESOLVER` seam as every authenticated route (any non-
 * resolved status ⇒ the generic `401 UNAUTHENTICATED` with
 * `WWW-Authenticate: Bearer`); the validated UserContext is the sole
 * ownership authority passed to the service (I2/I6).
 *
 * The 200 ack is written in CANONICAL byte form with the frozen
 * content-type, so a recorded-outcome replay (conventions §3) is
 * byte-identical to the original response. Every error path is a
 * `KalProblemException` (registry codes) serialized by the global filter —
 * `400 VALIDATION_FAILED` (batch shape, incl. over-limit op count),
 * `401 UNAUTHENTICATED`, `409 CONFLICT` (key reuse with changed payload).
 * No response ever echoes payloads or health data (I12).
 */
import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { SyncIngestionService } from './ingestion.service.js';

@Controller('sync')
export class SyncIngestionController {
  constructor(
    private readonly ingestion: SyncIngestionService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Post('ops')
  @HttpCode(200)
  @RequireIdentityBearer()
  async push(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: unknown,
    @Res() response: Response,
  ): Promise<void> {
    // Fail closed (I2): sync is a consumer-plane surface; the guard has set
    // the context, absence here is a refusal.
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('FORBIDDEN');
    }
    const ack = await this.ingestion.ingest(context, body, idempotencyKey);
    response.status(ack.status).set('Content-Type', 'application/json; charset=utf-8').send(ack.body);
  }
}
