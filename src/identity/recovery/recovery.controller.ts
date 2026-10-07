/**
 * Kal — account recovery HTTP surface (wave-02 contract §2; fixtures `w2`).
 *
 * Exactly the two frozen endpoints — nothing beyond the contract. Errors are
 * problem-details envelopes via the global filter (registry codes); validation
 * errors never echo received values (I12). The completion ticket travels ONLY
 * as the `Authorization: Bearer` credential (conventions §1 — the same single
 * credential channel as every other Kal credential); any other placement is
 * unauthenticated, and every 401 this surface emits carries
 * `WWW-Authenticate: Bearer`. The recovery ticket is NOT an access JWT: this
 * controller deliberately does not use the JWT bearer guard — ticket
 * verification is the command service's first step (frozen ordering, §2).
 */
import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RecoveryService } from './recovery.service.js';

@Controller('identity')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Post('recovery/request')
  @HttpCode(200)
  async request(@Body() body: unknown, @Headers('x-device-id') deviceId: unknown): Promise<{ status: 'accepted' }> {
    return this.recovery.requestRecovery(body, deviceId);
  }

  @Post('recovery/complete')
  @HttpCode(200)
  async complete(
    @Headers('authorization') authorization: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const bearer = typeof authorization === 'string' ? RecoveryController.extractBearer(authorization) : null;
    return this.withBearerChallenge(response, () => this.recovery.completeRecovery(bearer, body));
  }

  /**
   * The recovery ticket travels ONLY as the Authorization bearer credential
   * (conventions §1): any other placement is unauthenticated — this handler
   * never reads a body token. (Same frozen transport rule as the s2 surface.)
   */
  private static extractBearer(header: string): string | null {
    const match = /^bearer[ ](\S+)$/iu.exec(header);
    return match === null ? null : (match[1] as string);
  }

  /** Service-level 401s still carry the bearer challenge (conventions §1). */
  private async withBearerChallenge<T>(response: Response, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof KalProblemException && error.code === 'UNAUTHENTICATED') {
        response.header('WWW-Authenticate', 'Bearer');
      }
      throw error;
    }
  }
}
