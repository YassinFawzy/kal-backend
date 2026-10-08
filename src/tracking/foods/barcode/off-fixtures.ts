/**
 * Kal — RECORDED dev fixtures for the Open Food Facts adapter seam.
 *
 * Recorded, attributed test data ONLY (task contract: "OFF fixtures are
 * recorded, attributed test data only; no live OFF calls in tests"). The
 * products below are synthetic: invented barcodes (the 20x in-store range),
 * invented producers, plausible per-100 g values. Nothing here is a real
 * product identity; the attribution URLs follow the recorded shape for the
 * plan-named source without asserting any real record.
 */
import type { OffProductSnapshot } from './barcode-lookup.port.js';

export const OFF_DEV_FIXTURES: readonly OffProductSnapshot[] = [
  {
    barcode: '200000000001',
    nameEn: 'Fixture Cola 330ml',
    nameAr: 'كولا تجريبية ٣٣٠ مل',
    energyKcal: 42,
    proteinG: 0,
    carbsG: 10.6,
    fatG: 0,
    servingGrams: 330,
    attribution: {
      source: 'open_food_facts',
      license: 'odbl',
      attributionUrl: 'https://world.openfoodfacts.org/product/200000000001/fixture-cola',
      contributor: 'kal-fixtures',
    },
  },
  {
    barcode: '200000000002',
    nameEn: 'Fixture Salted Chips 60g',
    nameAr: null,
    energyKcal: 536,
    proteinG: 6.6,
    carbsG: 53,
    fatG: 34,
    servingGrams: 60,
    attribution: {
      source: 'open_food_facts',
      license: 'odbl',
      attributionUrl: 'https://world.openfoodfacts.org/product/200000000002/fixture-chips',
      contributor: 'kal-fixtures',
    },
  },
];
