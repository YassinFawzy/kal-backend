/**
 * Kal — the PR/1RM derivation golden suite (wave-04 contract §1.3 — the
 * FROZEN formula and its deterministic semantics, pinned case by case).
 *
 * The contract freezes: Epley `weightKg × (1 + reps / 30)` for every
 * weighted set (reps ≥ 1) in the caller's non-deleted sessions; timed and
 * notes sets never contribute; routines never contribute; the estimate
 * reports ROUNDED TO 2 DECIMAL PLACES, ROUND HALF UP; ties break
 * deterministically to the lowest
 * `(sessionLocalDate, sessionId, exercisePosition, setPosition)` — first
 * achievement wins; the derivation is idempotent (a replayed duplicate
 * session op inserts nothing and can never inflate a PR).
 *
 * Every numeric expectation below is HAND-COMPUTED from the frozen formula:
 *   100 kg × 8  → 100 × 38/30 = 126.666… → 126.67
 *   95 kg × 10  → 95 × 40/30 = 126.666… → 126.67   (ties 100×8 exactly)
 *   60 kg × 5   → 60 × 35/30 = 70 exactly
 *   30 kg × 25  → 30 × 55/30 = 55 exactly
 *   12.5 kg × 10 → 12.5 × 40/30 = 16.666… → 16.67
 *   6.75 kg × 15 → 6.75 × 45/30 = 10.125 → 10.13  (ROUND HALF UP; banker's
 *                 rounding would give 10.12 — this case pins the mode)
 *   0.03 kg × 15 → 0.03 × 45/30 = 0.045 → 0.05   (second half-up pin)
 */
import { describe, expect, it } from 'vitest';
import {
  derivePr,
  epleyExactScoreMilli,
  estimateRounded2dpFromMilliScore,
  weightMilliKg,
  type PrCandidateRow,
} from './pr-math.js';

const date = (day: string): Date => new Date(`${day}T00:00:00Z`);

let seq = 0;
function candidate(overrides: Partial<PrCandidateRow> = {}): PrCandidateRow {
  seq += 1;
  return {
    setId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    setPosition: 0,
    weightKg: 100,
    reps: 8,
    exerciseEntryPosition: 0,
    sessionId: `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`,
    sessionLocalDate: date('2026-03-01'),
    ...overrides,
  };
}

describe('the frozen Epley formula — golden values', () => {
  it('reports 126.67 for 100 kg × 8', () => {
    const derived = derivePr([candidate({ weightKg: 100, reps: 8 })]);
    expect(derived?.estimatedOneRepMaxKg).toBe(126.67);
    expect(derived?.weightKg).toBe(100);
    expect(derived?.reps).toBe(8);
    expect(derived?.sessionLocalDate).toBe('2026-03-01');
  });

  it('reports exact values without spurious decimals (70, 55)', () => {
    expect(derivePr([candidate({ weightKg: 60, reps: 5 })])?.estimatedOneRepMaxKg).toBe(70);
    expect(derivePr([candidate({ weightKg: 30, reps: 25 })])?.estimatedOneRepMaxKg).toBe(55);
  });

  it('reports 16.67 for 12.5 kg × 10', () => {
    expect(derivePr([candidate({ weightKg: 12.5, reps: 10 })])?.estimatedOneRepMaxKg).toBe(16.67);
  });

  it('ROUND HALF UP is pinned at exact halves (banker’s rounding would differ)', () => {
    // 6.75 × 45/30 = 10.125 exactly → half-up 10.13 (half-even 10.12).
    expect(derivePr([candidate({ weightKg: 6.75, reps: 15 })])?.estimatedOneRepMaxKg).toBe(10.13);
    // 0.03 × 45/30 = 0.045 exactly → half-up 0.05 (half-even 0.04).
    expect(derivePr([candidate({ weightKg: 0.03, reps: 15 })])?.estimatedOneRepMaxKg).toBe(0.05);
  });

  it('the arithmetic helpers agree with the formula on milli-kg integers', () => {
    expect(weightMilliKg(100)).toBe(100_000);
    expect(weightMilliKg(0.03)).toBe(30);
    expect(epleyExactScoreMilli(100_000, 8)).toBe(3_800_000);
    // 3,800,000 / 30,000 = 126.666… → 126.67
    expect(estimateRounded2dpFromMilliScore(3_800_000)).toBe(126.67);
  });
});

describe('the deterministic winner — max estimate, first achievement wins', () => {
  it('the strictly higher estimate wins regardless of order or age', () => {
    const derived = derivePr([
      candidate({ weightKg: 60, reps: 5, sessionId: '11111111-1111-4111-8111-000000000001', sessionLocalDate: date('2026-03-01') }),
      candidate({ weightKg: 100, reps: 8, sessionId: '11111111-1111-4111-8111-000000000002', sessionLocalDate: date('2026-02-01') }),
    ]);
    expect(derived?.sessionId).toBe('11111111-1111-4111-8111-000000000002');
    expect(derived?.estimatedOneRepMaxKg).toBe(126.67);
  });

  it('ties: the EARLIER session date wins (100×8 ≡ 95×10 — first achievement)', () => {
    const derived = derivePr([
      candidate({ weightKg: 95, reps: 10, sessionId: '11111111-1111-4111-8111-000000000001', sessionLocalDate: date('2026-03-05') }),
      candidate({ weightKg: 100, reps: 8, sessionId: '11111111-1111-4111-8111-000000000002', sessionLocalDate: date('2026-03-01') }),
    ]);
    expect(derived?.sessionId).toBe('11111111-1111-4111-8111-000000000002'); // 2026-03-01
    expect(derived?.sessionLocalDate).toBe('2026-03-01');
  });

  it('ties on the same day: the lower sessionId wins', () => {
    const derived = derivePr([
      candidate({ weightKg: 100, reps: 8, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sessionLocalDate: date('2026-03-01') }),
      candidate({ weightKg: 95, reps: 10, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionLocalDate: date('2026-03-01') }),
    ]);
    expect(derived?.sessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('ties within one session: the lower exercise entry position, then the lower set position, wins', () => {
    const sameSession = '11111111-1111-4111-8111-0000000000aa';
    const derived = derivePr([
      candidate({ weightKg: 100, reps: 8, exerciseEntryPosition: 1, setPosition: 0, sessionId: sameSession, setId: '00000000-0000-4000-8000-0000000000a1' }),
      candidate({ weightKg: 95, reps: 10, exerciseEntryPosition: 0, setPosition: 3, sessionId: sameSession, setId: '00000000-0000-4000-8000-0000000000a2' }),
      candidate({ weightKg: 100, reps: 8, exerciseEntryPosition: 0, setPosition: 1, sessionId: sameSession, setId: '00000000-0000-4000-8000-0000000000a3' }),
    ]);
    // (entry 0, set 1) beats (entry 0, set 3); (entry 1, set 0) loses on entry position.
    expect(derived?.setId).toBe('00000000-0000-4000-8000-0000000000a3');
  });

  it('empty candidates are the success-shaped empty state (never an error)', () => {
    expect(derivePr([])).toBeNull();
  });
});

describe('the mixed-format and idempotence semantics (pure level)', () => {
  it('only weighted sets contribute — a mixed-format session derives from its weighted sets alone', () => {
    // The timed/notes rows of the same session NEVER reach the candidate
    // list (the caller's query filters format='weighted'); this case pins
    // that a weighted-only candidate list from a mixed session derives
    // exactly the weighted value.
    const derived = derivePr([candidate({ weightKg: 100, reps: 8 })]);
    expect(derived?.estimatedOneRepMaxKg).toBe(126.67);
  });

  it('idempotence: re-deriving from the same applied rows is bit-identical (a replayed op inserts nothing → PRs cannot inflate)', () => {
    const rows = [
      candidate({ weightKg: 100, reps: 8, sessionId: '11111111-1111-4111-8111-000000000001', sessionLocalDate: date('2026-03-01') }),
      candidate({ weightKg: 95, reps: 10, sessionId: '11111111-1111-4111-8111-000000000002', sessionLocalDate: date('2026-03-05') }),
    ];
    expect(derivePr(rows)).toEqual(derivePr([...rows].reverse()));
    expect(derivePr(rows)).toEqual(derivePr(rows));
  });

  it('a duplicate equal-estimate set in a LATER session cannot steal the PR', () => {
    const rows = [
      candidate({ weightKg: 100, reps: 8, sessionId: '11111111-1111-4111-8111-000000000001', sessionLocalDate: date('2026-03-01'), setId: '00000000-0000-4000-8000-00000000000a' }),
      candidate({ weightKg: 100, reps: 8, sessionId: '11111111-1111-4111-8111-000000000002', sessionLocalDate: date('2026-03-09'), setId: '00000000-0000-4000-8000-00000000000b' }),
    ];
    expect(derivePr(rows)?.setId).toBe('00000000-0000-4000-8000-00000000000a');
  });
});
