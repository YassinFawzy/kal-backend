/**
 * Kal — identity HTTP surface (wave-02 contract §2; fixtures `w2`).
 *
 * Exactly the frozen endpoints — nothing beyond the contract. All errors
 * are problem-details envelopes via the global filter (registry codes);
 * validation errors never echo received values (I12). Every 401 this
 * surface emits carries `WWW-Authenticate: Bearer` (conventions §1): the
 * bearer guard sets it before throwing, and handlers route service calls
 * through one wrapper so service-level 401s (e.g. refresh failures) carry
 * it too — the wave-01 filter itself is untouched.
 */
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { RequireIdentityBearer } from './identity-bearer.guard.js';
import { IdentityService } from './identity.service.js';
import { RequestContextService } from '../request-context/request-context.service.js';

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Post('signup')
  @HttpCode(200)
  async signup(@Body() body: unknown): Promise<{ status: 'accepted' }> {
    return this.identity.signup(body);
  }

  @Post('signin')
  @HttpCode(200)
  async signin(
    @Body() body: unknown,
    @Headers('x-device-id') deviceId: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.withBearerChallenge(response, () => this.identity.signin(body, deviceId));
  }

  @Post('token/refresh')
  @HttpCode(200)
  async refresh(
    @Headers('authorization') authorization: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const bearer = typeof authorization === 'string' ? (IdentityController.extractBearer(authorization)) : null;
    return this.withBearerChallenge(response, () => this.identity.refresh(bearer));
  }

  @Get('sessions')
  @RequireIdentityBearer()
  async sessions(
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<unknown> {
    const userId = this.requireUserId();
    return this.identity.listSessions(userId, typeof cursor === 'string' ? cursor : null, typeof limit === 'string' ? limit : null);
  }

  @Delete('sessions/:sessionId')
  @RequireIdentityBearer()
  @HttpCode(204)
  async revoke(@Param('sessionId') sessionId: string): Promise<void> {
    const userId = this.requireUserId();
    await this.identity.revokeSession(userId, sessionId);
  }

  @Get('me')
  @RequireIdentityBearer()
  async me(): Promise<unknown> {
    const userId = this.requireUserId();
    return this.identity.profile(userId);
  }

  /** Guards set the context; absence here is a fail-closed refusal (I2). */
  private requireUserId(): string {
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('UNAUTHENTICATED');
    }
    return context.userId;
  }

  /**
   * The refresh token travels ONLY as the Authorization bearer credential
   * (conventions §1): any other placement is unauthenticated — this handler
   * never reads a body token.
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
