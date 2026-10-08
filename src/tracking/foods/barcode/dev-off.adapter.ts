/**
 * Kal — dev Open Food Facts adapter: RECORDED fixtures, zero network.
 *
 * The single W3 binding of `BarcodeLookupPort` (the FR-017 adapter seam).
 * Serves the recorded, attributed snapshots in `off-fixtures.ts`; any other
 * barcode is a miss (`null`) so the pipeline completes with the success-shaped
 * `not_found` (the guided label-create entry point). NO live calls exist —
 * not in tests, not in development (task contract; a live adapter is a later
 * change package behind the same port).
 */
import { Injectable } from '@nestjs/common';
import type { BarcodeLookupPort, OffProductSnapshot } from './barcode-lookup.port.js';
import { OFF_DEV_FIXTURES } from './off-fixtures.js';

@Injectable()
export class DevBarcodeLookupAdapter implements BarcodeLookupPort {
  private readonly byBarcode: ReadonlyMap<string, OffProductSnapshot>;

  constructor() {
    this.byBarcode = new Map(OFF_DEV_FIXTURES.map((fixture) => [fixture.barcode, fixture]));
  }

  async lookup(barcode: string): Promise<OffProductSnapshot | null> {
    return this.byBarcode.get(barcode) ?? null;
  }
}
