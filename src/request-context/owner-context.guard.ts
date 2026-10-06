/**
 * Kal — fail-closed OwnerContext guard (I2).
 *
 * Opt-in per route/class via `@RequireOwnerContext()`. Any resolution that
 * is not `resolved` (absent, invalid, ambiguous) produces the SAME generic
 * `FORBIDDEN_OWNER` problem-details denial — byte-identical modulo the
 * per-request correlation id, never an oracle about which failure occurred
 * or whether any object exists (I7). The validated context is stored in the
 * request scope for the owning module's services to use (I1).
 */
import { CanActivate, ExecutionContext, Injectable, UseGuards, Inject } from '@nestjs/common';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { OwnerResolution } from './owner-context.js';
import { OWNER_CONTEXT_RESOLVER, type OwnerContextResolver } from './owner-context.resolver.js';
import { RequestContextService } from './request-context.service.js';

@Injectable()
export class OwnerContextGuard implements CanActivate {
  constructor(
    @Inject(OWNER_CONTEXT_RESOLVER)
    private readonly resolver: OwnerContextResolver,
    private readonly requestContext: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const resolution: OwnerResolution = await this.resolver.resolve(request);
    if (resolution.status !== 'resolved') {
      // Fail closed (I2). The internal reason (absent/invalid/ambiguous) is
      // intentionally NOT observable in the response (I7).
      throw new KalProblemException('FORBIDDEN_OWNER');
    }
    this.requestContext.setOwnerContext(resolution.context);
    return true;
  }
}

export const RequireOwnerContext = (): MethodDecorator & ClassDecorator =>
  UseGuards(OwnerContextGuard);
