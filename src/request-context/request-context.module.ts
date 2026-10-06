import { Module } from '@nestjs/common';
import { USER_CONTEXT_RESOLVER } from './user-context.resolver.js';
import { UserContextGuard } from './user-context.guard.js';
import { NoUserContextResolver } from './user-context.resolver.js';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { RequestContextService } from './request-context.service.js';

/**
 * Request-context plumbing (I2): correlation-id scope + user-context
 * guard/resolver seam. W2 overrides `UserContextResolver` with the
 * identity-module JWT resolver; until then the default resolver refuses
 * everything, so guarded routes fail closed.
 */
@Module({
  providers: [
    RequestContextService,
    RequestContextMiddleware,
    { provide: USER_CONTEXT_RESOLVER, useClass: NoUserContextResolver },
    UserContextGuard,
  ],
  exports: [RequestContextService, RequestContextMiddleware, USER_CONTEXT_RESOLVER, UserContextGuard],
})
export class RequestContextMenu {}
