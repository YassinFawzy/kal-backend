/**
 * Kal — fail-closed UserContext guard (I2).
 *
 * Opt-in per route/class via `@RequireUserContext()`. Any resolution that
 * is not `resolved` (absent, invalid, ambiguous) produces the SAME generic
 * `FORBIDDEN` problem-details denial — byte-identical modulo the
 * per-request correlation id, never an oracle about which failure occurred
 * or whether any object exists (I7). The validated context is stored in the
 * request scope for the owning module's services to use (I1).
 */
import { CanActivate, ExecutionContext, Injectable, UseGuards, Inject } from '@nestjs/common';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { UserResolution } from './user-context.js';
import { USER_CONTEXT_RESOLVER, type UserContextResolver } from './user-context.resolver.js';
import { RequestContextService } from './request-context.service.js';

@Injectable()
export class UserContextGuard implements CanActivate {
  constructor(
    @Inject(USER_CONTEXT_RESOLVER)
    private readonly resolver: UserContextResolver,
    private readonly requestContext: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const resolution: UserResolution = await this.resolver.resolve(request);
    if (resolution.status !== 'resolved') {
      // Fail closed (I2). The internal reason (absent/invalid/ambiguous) is
      // intentionally NOT observable in the response (I7).
      throw new KalProblemException('FORBIDDEN');
    }
    this.requestContext.setUserContext(resolution.context);
    return true;
  }
}

export const RequireUserContext = (): MethodDecorator & ClassDecorator =>
  UseGuards(UserContextGuard);
