import { Module } from '@nestjs/common';
import { OwnerContextGuard } from './owner-context.guard.js';
import { NoOwnerContextResolver, OwnerContextResolver } from './owner-context.resolver.js';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { RequestContextService } from './request-context.service.js';

/**
 * Request-context plumbing (I2): correlation-id scope + owner-context
 * guard/resolver seam. W2 overrides `OwnerContextResolver` with the
 * identity-module JWT resolver; until then the default resolver refuses
 * everything, so guarded routes fail closed.
 */
@Module({
  providers: [
    RequestContextService,
    RequestContextMiddleware,
    { provide: OwnerContextResolver, useClass: NoOwnerContextResolver },
    OwnerContextGuard,
  ],
  exports: [RequestContextService, RequestContextMiddleware, OwnerContextResolver, OwnerContextGuard],
})
export class RequestContextMenu {}
