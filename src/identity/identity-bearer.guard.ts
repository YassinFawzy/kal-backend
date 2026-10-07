/**
 * Kal — identity bearer guard (conventions §1; wave-02 contract §2).
 *
 * Guards the identity module's bearer-authenticated routes. Resolves the
 * request through the SAME `USER_CONTEXT_RESOLVER` seam every other
 * authenticated route uses (one JWT→UserContext resolution path), then
 * maps the outcome per the frozen identity contract: any non-`resolved`
 * status (missing, malformed, expired, revoked — never states which) is
 * the generic `401 UNAUTHENTICATED` problem-details body with a
 * `WWW-Authenticate: Bearer` response header. Fail closed; no default
 * tenant; the validated context lands in the request scope (I2).
 */
import { CanActivate, ExecutionContext, Inject, Injectable, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { RequestContextService } from '../request-context/request-context.service.js';
import { USER_CONTEXT_RESOLVER, type UserContextResolver } from '../request-context/user-context.resolver.js';

@Injectable()
export class IdentityBearerGuard implements CanActivate {
  constructor(
    @Inject(USER_CONTEXT_RESOLVER)
    private readonly resolver: UserContextResolver,
    private readonly requestContext: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const resolution = await this.resolver.resolve(http.getRequest<IncomingMessage>());
    if (resolution.status !== 'resolved') {
      // One generic refusal for every failure class (I2/I7); the challenge
      // header accompanies the 401 per conventions §1.
      http.getResponse<Response>().header('WWW-Authenticate', 'Bearer');
      throw new KalProblemException('UNAUTHENTICATED');
    }
    this.requestContext.setUserContext(resolution.context);
    return true;
  }
}

export const RequireIdentityBearer = (): MethodDecorator & ClassDecorator => UseGuards(IdentityBearerGuard);
