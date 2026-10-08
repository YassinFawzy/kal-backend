/**
 * Unit spec — interim normalization pipeline (wave-03 contract §7 golden
 * cases + amendment 1's distinctness case; idempotence; over-folding guards).
 *
 * ⚠️ This pins the INTERIM in-lane implementation; at rebase the module
 * binding swaps to s2b's merged pipeline (whose own golden suite pins the
 * rule set) and this file is deleted with the interim module.
 */
import { describe, expect, it } from 'vitest';
import { normalizeArabicLatin } from './interim-normalizer.js';

describe('normalizeArabicLatin — contract §7 golden cases', () => {
  const golden: ReadonlyArray<readonly [readonly string[], string]> = [
    // Row 1 — طعمية family: diacritics, tatweel, taa marbuta.
    [['طعمية', 'طعميه', 'طَعْمِيَّة', 'طــعمية'], 'طعميه'],
    // Row 2 — أرز family: alef/hamza unification.
    [['أرز', 'إرز', 'اَرز'], 'ارز'],
    // Row 3 — AMENDMENT 1: شاورما / شاورمة are DISTINCT keys (bare-final-alef
    // is not mapped; taa marbuta is). Equivalence for the shawarma items is
    // DATA-CARRIED (manifest aliases), never a folding rule.
    [['شاورما'], 'شاورما'],
    [['شاورمة'], 'شاورمه'],
    // Row 4 — كشري family: alef maqsura.
    [['كشري', 'كشرى'], 'كشري'],
    // Row 5 — Latin casing.
    [['Taameya', 'taameya', 'TAAMEYA'], 'taameya'],
    // Row 6 — whitespace collapse incl. direction marks (RLM) and runs.
    [['فول مدمس', 'فول  مدمس ', ' فول\u200f مدمس\u200f', 'فول\t مدمس', 'فول\u00a0مدمس'], 'فول مدمس'],
    // Row 7 — Arabic-Indic digit folding.
    [['كشري٢', 'كشري2'], 'كشري2'],
  ];

  for (const [inputs, expected] of golden) {
    it(`maps ${inputs.map((input) => JSON.stringify(input)).join(' · ')} → ${JSON.stringify(expected)}`, () => {
      for (const input of inputs) {
        expect(normalizeArabicLatin(input)).toBe(expected);
      }
    });
  }

  it('is idempotent across the golden corpus (normalize(normalize(x)) === normalize(x))', () => {
    for (const [inputs] of golden) {
      for (const input of inputs) {
        const once = normalizeArabicLatin(input);
        expect(normalizeArabicLatin(once)).toBe(once);
      }
    }
  });
});

describe('normalizeArabicLatin — over-folding guards (distinct pairs MUST stay distinct)', () => {
  const distinctPairs: ReadonlyArray<readonly [string, string]> = [
    ['شاورما', 'شاورمه'], // amendment 1 — no word-final ا→ه fold
    ['شفا', 'شفه'],
    ['علا', 'عله'],
    ['هما', 'همه'],
    ['ء', 'ا'], // standalone hamza is consonantal — never folds to alef
    ['ز', 'ذ'],
  ];

  for (const [left, right] of distinctPairs) {
    it(`${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`, () => {
      expect(normalizeArabicLatin(left)).not.toBe(normalizeArabicLatin(right));
    });
  }

  it('leaves Arabizi numerals (3/7 as letters) untouched', () => {
    expect(normalizeArabicLatin('ta3meya')).toBe('ta3meya');
    expect(normalizeArabicLatin('sha7ma')).toBe('sha7ma');
  });

  it('empty/whitespace-only input collapses to the empty string (search short-circuits)', () => {
    expect(normalizeArabicLatin('')).toBe('');
    expect(normalizeArabicLatin('   \t\u00a0')).toBe('');
  });
});
