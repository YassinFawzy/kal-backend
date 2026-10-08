/**
 * Kal — barcode product lookup port (FR-017 server pipeline step 3; contract
 * note §2 `tracking.barcode.resolve`).
 *
 * The pipeline (FROZEN order): platform product cache → THIS adapter seam →
 * generic `not_found` (success-shaped — it drives the client's guided
 * label-create). Open Food Facts is the plan-named source — the ONLY provider
 * name sanctioned anywhere in W3 — and lives exclusively behind this port:
 * nothing outside `src/tracking/foods/barcode/**` may know it exists beyond
 * the attribution strings that travel with imported rows (license-partitioned
 * per ARCHITECTURE §11/§19).
 *
 * W3 ships exactly one binding: the recorded-fixture dev adapter
 * (`dev-off.adapter.ts`). NO live network calls exist in this wave — tests
 * and development resolve from recorded, attributed snapshots only. A live
 * adapter is a later change package binding the same port (provider
 * integrations stay unselected human decisions).
 */

/** License partition of adapter-sourced rows (schema CHECK: 'proprietary' | 'odbl'). */
export type LicensePartition = 'proprietary' | 'odbl';

/**
 * Attribution block — rides in the cached payload and travels with every
 * imported catalog row's provenance (ODbL obligations never detached).
 */
export interface OffAttribution {
  /** The plan-named source identifier (the only sanctioned provider name). */
  readonly source: 'open_food_facts';
  /** License of the recorded data — adapter rows are ODbL-partitioned. */
  readonly license: 'odbl';
  /** Attribution/reference URL for the imported product (recorded shape). */
  readonly attributionUrl: string;
  /** Data contributor credit recorded with the snapshot. */
  readonly contributor: string;
}

/**
 * The adapter's normalized product snapshot: the fields the pipeline needs to
 * land an `imported` / `odbl` catalog row plus its default serving. This is a
 * NORMALIZED snapshot — never a raw provider response dump (no user data, no
 * transport envelopes; ARCHITECTURE §11).
 */
export interface OffProductSnapshot {
  readonly barcode: string;
  /** Display names as recorded (EN required — consumer UI is EN-first). */
  readonly nameEn: string;
  readonly nameAr: string | null;
  /** Per-100 g nutrition as recorded. */
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  /** Gram weight of one package/serving unit (the default variant, FR-012). */
  readonly servingGrams: number;
  readonly attribution: OffAttribution;
}

export interface BarcodeLookupPort {
  /**
   * Resolve one barcode against the remote source. Returns `null` on miss
   * (the caller then serves the success-shaped `not_found`). Implementations
   * must be side-effect-free; caching is the pipeline's job (first resolution
   * wins, contract §2).
   */
  lookup(barcode: string): Promise<OffProductSnapshot | null>;
}

/** DI token for the OFF adapter seam binding. */
export const KAL_BARCODE_LOOKUP = Symbol('kal.tracking.barcodeLookup');
