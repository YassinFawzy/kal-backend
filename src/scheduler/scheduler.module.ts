import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service.js';

/**
 * In-process scheduler skeleton (ARCHITECTURE §9: background jobs are
 * in-process, every job idempotent). No queue worker, no broker, no external
 * cron — later waves register their jobs here and call start() at boot.
 */
@Module({
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
