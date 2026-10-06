import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RequestContextMenu } from '../request-context/request-context.module.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';

/**
 * Shared error/problem-details layer (I7). Registers the global filter once;
 * every module emits errors exclusively as `KalProblemException` with codes
 * from the frozen registry. (The filter is registered via APP_FILTER —
 * global, not exported: nothing injects it by class token.)
 */
@Module({
  imports: [RequestContextMenu],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class ProblemsModule {}
