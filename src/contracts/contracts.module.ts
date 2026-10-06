import { Module } from '@nestjs/common';
import { ContractsController } from './contracts.controller.js';

/** Serves the machine-readable contract fixtures (conventions.md §6.1). */
@Module({
  controllers: [ContractsController],
})
export class ContractsModule {}
