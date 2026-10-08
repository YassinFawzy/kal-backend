/**
 * Kal — normalization port for the tracking module (wave-03 contract §7).
 *
 * Search and every user-food write path normalize through THIS port; the
 * database never re-derives normalized forms (§7: writers apply the frozen
 * pipeline to stored forms, search normalizes the query once). The binding
 * lives in `tracking.module.ts`:
 *
 *   - INTERIM (pre-rebase): `interim-normalizer.ts` — an in-lane implementation
 *     of the frozen §7 rule set used only until lane s2b's merged module lands;
 *     deleted at rebase.
 *   - FINAL: s2b's `src/tracking/normalization/**` pure pipeline — the frozen
 *     implementation this lane consumes (its golden suite pins the rule set).
 *
 * The port is deliberately the contract's own shape: a pure function
 * `normalize(input) → normalized` (§7) — no DB, no clock, no locale.
 */
export interface TrackingNormalizer {
  normalize(input: string): string;
}

/** DI token for the frozen normalization pipeline binding. */
export const TRACKING_NORMALIZER = Symbol('kal.tracking.normalizer');
