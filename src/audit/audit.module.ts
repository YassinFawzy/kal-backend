import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AuditService } from './audit.service.js';

/**
 * Audit module (I14). Other modules append privileged-action events through
 * `AuditService` — they never touch the `audit_events` table themselves
 * (module gate: no module queries another module's tables; audit_events is
 * this module's).
 */
@Module({
  imports: [DbModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
