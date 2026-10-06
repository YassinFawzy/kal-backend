import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { PrismaService } from '../db/prisma.service.js';
import { RequestContextMenu } from '../request-context/request-context.module.js';
import { HealthController, ProbeController } from './health.controller.js';
import { READINESS_CHECKS, defaultReadinessChecks } from './readiness.js';

/**
 * Health/readiness + contract probes. `READINESS_CHECKS` is exported so
 * later waves extend it via provider override (additive readiness).
 */
@Module({
  imports: [DbModule, RequestContextMenu],
  controllers: [HealthController, ProbeController],
  providers: [
    {
      provide: READINESS_CHECKS,
      useFactory: defaultReadinessChecks,
      inject: [PrismaService],
    },
  ],
  exports: [READINESS_CHECKS],
})
export class HealthModule {}
