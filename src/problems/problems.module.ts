import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RequestContextMenu } from '../request-context/request-context.module.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';

/**
 * Shared error/problem-details layer (I7). Registers the global filter once;
 * every module emits errors exclusively as `KalProblemException` with codes
 * from the frozen registry.
 */
@Module({
  imports: [RequestContextMenu],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
  exports: [ProblemDetailsFilter],
})
export class ProblemsModule {}
