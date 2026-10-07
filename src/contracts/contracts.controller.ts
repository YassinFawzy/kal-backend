import { Controller, Get, Param } from '@nestjs/common';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { W1_CONTRACT_VERSION, w1FixturesDocument } from './w1.fixtures.js';
import type { ContractFixturesDocument } from './w1.fixtures.js';
import { W2ContractFixturesDocument, W2_CONTRACT_VERSION, w2FixturesDocument } from './w2.fixtures.js';
import { W3_CONTRACT_VERSION, w3FixturesDocument } from './w3.fixtures.js';

/** Structural supertype of every served contract document (w1, w2, w3, …). */
type ServedContractDocument = ContractFixturesDocument | W2ContractFixturesDocument | ReturnType<typeof w3FixturesDocument>;

/** Served contract-fixture documents by version (additive within a version). */
const DOCUMENT_FACTORIES: readonly (readonly [string, () => ServedContractDocument])[] = [
  [W1_CONTRACT_VERSION, w1FixturesDocument],
  [W2_CONTRACT_VERSION, w2FixturesDocument],
  [W3_CONTRACT_VERSION, w3FixturesDocument],
];

const DOCUMENTS: ReadonlyMap<string, () => ServedContractDocument> = new Map(DOCUMENT_FACTORIES);

@Controller('contracts')
export class ContractsController {
  @Get(':version')
  fixtures(@Param('version') version: string): ServedContractDocument {
    const factory = DOCUMENTS.get(version);
    if (factory === undefined) {
      // Generic NOT_FOUND: unknown versions disclose nothing (I7).
      throw new KalProblemException('NOT_FOUND');
    }
    return factory();
  }
}
