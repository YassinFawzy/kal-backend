import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { ConfigModule } from './config/config.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { RequestContextMiddleware } from './request-context/index.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';
import { TrackingModule } from './tracking/tracking.module.js';
import { SyncModule } from './sync/sync.module.js';

/**
 * Kal API — NestJS modular monolith (ARCHITECTURE §6/§9). Phase 1 infra
 * modules plus the W2 identity module, which re-exports the request-context
 * plumbing and overrides `USER_CONTEXT_RESOLVER` with the JWT-backed
 * resolver (I2 — see identity.module.ts); hosting authenticated routes
 * means importing IdentityModule. W3 adds the tracking module (s2a/s2c)
 * and the sync module — ingestion (s2d) + delta pull (s2e) in one module.
 */
@Module({
  imports: [
    ConfigModule,
    IdentityModule,
    ProblemsModule,
    DbModule,
    AuditModule,
    SchedulerModule,
    HealthModule,
    ContractsModule,
    // W3 tracking module (additive registration per merge order — lanes
    // s2a foods + s2c diary): the tracking surfaces + the frozen
    // sync↔tracking seam implementations.
    TrackingModule,
    // w03-s2d (additive): the sync ingestion write path (POST /sync/ops).
    SyncModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the request scope (correlation id + user-context storage)
    // around every route.
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
