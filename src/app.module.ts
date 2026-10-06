import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { ConfigModule } from './config/config.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { RequestContextMenu, RequestContextMiddleware } from './request-context/index.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

/**
 * Kal API — NestJS modular monolith (ARCHITECTURE §6/§9). Phase 1 infra
 * modules only: config (I15), problem-details (I7), request/owner context
 * (I2), audit (I14), scheduler, health/contracts fixtures.
 */
@Module({
  imports: [
    ConfigModule,
    RequestContextMenu,
    ProblemsModule,
    DbModule,
    AuditModule,
    SchedulerModule,
    HealthModule,
    ContractsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Opens the request scope (correlation id + owner-context storage)
    // around every route.
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
