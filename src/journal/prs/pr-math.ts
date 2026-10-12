/**
 * Kal — the PR/1RM derivation arithmetic (wave-04 contract §1.3 — FROZEN).
 *
 * **Formula (frozen, standard Epley):** `estimatedOneRepMaxKg = weightKg ×
 * (1 + reps / 30)` — computed for every **weighted** set (`reps ≥ 1` is
 * enforced by validation) in the caller's **non-deleted** sessions. Timed
 * and notes sets NEVER contribute; routines never contribute (templates are
 * not logs).
 *
 * Determinism (task-contract constraint — "derivation must be a pure
 * function of applied session rows; no wall-clock dependence"):
 *   - Candidate selection is the CALLER's query (owning-user predicate,
 *     non-deleted session/entry/set rows); THIS module is pure over the
 *     candidate rows it receives.
 *   - The winner is the MAXIMUM exact estimate; ties break deterministically
 *     to the LOWEST `(sessionLocalDate, sessionId, exercisePosition,
 *     setPosition)` lexicographic tuple — "first achievement wins".
 *   - EXACTNESS WITHOUT FLOATING POINT: weights live in DECIMAL(9,3)
 *     columns, so every weight is an exact integer count of milli-kilograms
 *     `k` (w = k/1000). The estimate `w(30 + r)/30` is then proportional to
 *     the exact INTEGER `k(30 + r)` (≤ ~1.03e9, far below 2^53), so
 *     comparisons are exact integer compares — no decimal library, no
 *     rounding error can ever enter the winner selection.
 *   - The REPORTED value `estimate × 100 = k(30+r)/300` rounds to 2 decimal
 *     places with ROUND HALF UP: `floor(n/300 + 1/2)/100` for the exact
 *     integer `n = k(30+r)`. The only values within floating-point distance
 *     of a `.5` boundary ARE the exact halves (multiples of 1/300 land
 *     ≥ 1/300 away otherwise), and an exact `m + 0.5` is representable in
 *     binary64 — so the half-up rounding is correctly detected for every
 *     possible input (e.g. 6.75 kg × 15 reps = 10.125 → 10.13, never 10.12).
 *   - Idempotence: re-deriving from the same applied rows yields the same
 *     winner bit-for-bit; a replayed/duplicate session op inserts nothing,
 *     so PRs cannot inflate (the sync dedupe + this purity ARE the
 *     idempotence proof).
 */
import type { Prisma } from '../../../generated/prisma/client.ts';

/** One candidate weighted set with its locating context (from the applied session rows). */
export interface PrCandidateRow {
  readonly setId: string;
  readonly setPosition: number;
  /** DECIMAL(9,3) column value (≤ 3 decimals — the exactness proof's input). */
  readonly weightKg: Prisma.Decimal | number;
  readonly reps: number;
  readonly exerciseEntryPosition: number;
  readonly sessionId: string;
  /** The session's client-local day (DATE column — UTC-midnight `Date`). */
  readonly sessionLocalDate: Date;
}

/** The derived per-exercise best (contract §1.3 read shape, pre-serialization). */
export interface PrDerived {
  readonly setId: string;
  readonly sessionId: string;
  /** The winning weight as a JSON number (DECIMAL(9,3) round-trips losslessly). */
  readonly weightKg: number;
  readonly reps: number;
  /** `YYYY-MM-DD` of the winning set's session (== `achievedOn`). */
  readonly sessionLocalDate: string;
  /** The exact estimate reported rounded to 2 dp, ROUND HALF UP, as a JSON number. */
  readonly estimatedOneRepMaxKg: number;
}

/**
 * The exact integer weight in milli-kilograms: DECIMAL(9,3) ⇒ ≤ 3 decimals;
 * `× 1000` is an exact decimal multiply, and the integer fits binary64
 * exactly (≤ 1,000,000).
 */
export function weightMilliKg(weightKg: Prisma.Decimal | number): number {
  if (typeof weightKg === 'number') {
    return Math.round(weightKg * 1000);
  }
  return Number(weightKg.times(1000));
}

/**
 * The exact Epley score of one candidate: `k(30 + r)` in milli-kg units —
 * proportional to the estimate (identical denominator 30), EXACT integer
 * arithmetic. Comparing scores == comparing estimates.
 */
export function epleyExactScoreMilli(weightMilliKg: number, reps: number): number {
  return weightMilliKg * (30 + reps);
}

/**
 * `n / 30000` reported at 2 dp, ROUND HALF UP (contract §1.3), as a JSON
 * number — `floor(n/300 + 1/2)/100` over the exact integer `n` (the
 * module docblock carries the exactness proof for the `.5` boundary).
 */
export function estimateRounded2dpFromMilliScore(milliScore: number): number {
  return Math.floor(milliScore / 300 + 0.5) / 100;
}

/** `YYYY-MM-DD` of the DATE-column value (UTC-midnight semantics). */
function formatLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Compares two candidate locators for the TIEBREAK: the LOWEST
 * `(sessionLocalDate, sessionId, exercisePosition, setPosition)`
 * lexicographic tuple wins. Pure and total (ids make it total).
 */
function tiebreakCompare(
  a: Pick<PrCandidateRow, 'sessionLocalDate' | 'sessionId' | 'exerciseEntryPosition' | 'setPosition'>,
  b: Pick<PrCandidateRow, 'sessionLocalDate' | 'sessionId' | 'exerciseEntryPosition' | 'setPosition'>,
): number {
  const byDate = a.sessionLocalDate.getTime() - b.sessionLocalDate.getTime();
  if (byDate !== 0) {
    return byDate;
  }
  if (a.sessionId !== b.sessionId) {
    return a.sessionId < b.sessionId ? -1 : 1;
  }
  const byEntry = a.exerciseEntryPosition - b.exerciseEntryPosition;
  if (byEntry !== 0) {
    return byEntry;
  }
  return a.setPosition - b.setPosition;
}

/**
 * Derives the per-exercise PR from the candidate weighted sets. Pure:
 * same rows in ⇒ same result out, always (documented ordering above).
 * `null` when no candidate exists — the success-shaped `result: "none"`
 * empty state, never an error.
 */
export function derivePr(candidates: readonly PrCandidateRow[]): PrDerived | null {
  let best: { readonly row: PrCandidateRow; readonly score: number } | null = null;
  for (const row of candidates) {
    const score = epleyExactScoreMilli(weightMilliKg(row.weightKg), row.reps);
    if (best === null || score > best.score || (score === best.score && tiebreakCompare(row, best.row) < 0)) {
      best = { row, score };
    }
  }
  if (best === null) {
    return null;
  }
  return {
    setId: best.row.setId,
    sessionId: best.row.sessionId,
    weightKg: Number(best.row.weightKg),
    reps: best.row.reps,
    sessionLocalDate: formatLocalDate(best.row.sessionLocalDate),
    estimatedOneRepMaxKg: estimateRounded2dpFromMilliScore(best.score),
  };
}
