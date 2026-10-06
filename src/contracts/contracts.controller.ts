import { Controller, Get, Param } from '@nestjs/common';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { W1_CONTRACT_VERSION, w1FixturesDocument } from './w1.fixtures.js';
import type { ContractFixturesDocument } from './w1.fixtures.js';

/** Served contract-fixture documents by version (additive within a version). */
const DOCUMENTS: ReadonlyMap<string, () => ContractFixturesDocument> = new Map([
  [W1_CONTRACT_VERSION, w1FixturesDocument],
]);

@Controller('contracts')
export class ContractsController {
  @Get(':version')
  fixtures(@Param('version') version: string): ContractFixturesDocument {
    const factory = DOCUMENTS.get(version);
    if (factory === undefined) {
      // Generic NOT_FOUND: unknown versions disclose nothing (I7).
      throw new KalProblemException('NOT_FOUND');
    }
    return factory();
  }
}
