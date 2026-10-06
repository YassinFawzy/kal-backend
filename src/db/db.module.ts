import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Database infrastructure module. Exports `PrismaService` so feature
 * modules depend on this seam rather than instantiating clients directly.
 * Bounded-context modules never open transactions outside
 * `PrismaService.transaction` (one unit-of-work path per command).
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DbModule {}
