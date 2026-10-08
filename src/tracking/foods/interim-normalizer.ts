/**
 * Kal — INTERIM normalization implementation (wave-03 contract §7 rule set).
 *
 * ⚠️ INTERIM ONLY — used by `tracking.module.ts` until lane s2b's merged
 * `src/tracking/normalization/**` lands (s2b merges before s2a; the module
 * binding swaps to it at rebase and THIS FILE IS DELETED). It exists so the
 * s2a branch is verifiable standalone while coding against the frozen
 * normalization INTERFACE, per the lane contract.
 *
 * It implements the FROZEN §7 rule set exactly, in the frozen order — the
 * same determinism contract s2b's pipeline is held to (its golden suite pins
 * these transformations; s2a's search-equivalence suite pins the behavioral
 * outcomes over the seed). Nothing may be added: "helpful" extra foldings
 * are contract changes.
 *
 * Canonicalization steps, in order (contract §7):
 *   1. Unicode NFC.
 *   2. Strip Arabic diacritics (harakat) and Quranic marks:
 *      U+064B–U+0652, U+0653–U+065F, U+0670.
 *   3. Strip tatweel: U+0640.
 *   4. Unify alef/hamza forms: U+0623 أ, U+0625 إ, U+0622 آ, U+0671 ٱ →
 *      U+0627 ا. Standalone hamza U+0621 ء is unchanged (consonantal).
 *   5. Taa marbuta: U+0629 ة → U+0647 ه.
 *   6. Alef maqsura: U+0649 ى → U+064A ي.
 *   7. Fold Arabic-Indic digits: U+0660–U+0669 and U+06F0–U+06F9 → ASCII 0–9.
 *   8. Latin lowercasing: JavaScript toLowerCase() (locale-independent).
 *   9. Whitespace collapse: strip direction marks (U+200E, U+200F,
 *      U+202A–U+202E), trim, collapse every whitespace run (incl. NBSP
 *      U+00A0 and tabs) to a single U+0020.
 *
 * Arabizi numerals (`3`, `7` as letters) are out of scope — no transformation.
 */

// Steps 2–7 are single-codepoint rewrites — one pass, order preserved.
const CHAR_FOLDS: ReadonlyMap<string, string> = new Map([
  ...[...Array(0x0653 - 0x064b).keys()].map((i) => [String.fromCodePoint(0x064b + i), ''] as const), // harakat U+064B–U+0652
  ...[...Array(0x0660 - 0x0653).keys()].map((i) => [String.fromCodePoint(0x0653 + i), ''] as const), // Quranic marks U+0653–U+065F
  [String.fromCodePoint(0x0670), ''], // superscript alef (Quranic)
  [String.fromCodePoint(0x0640), ''], // tatweel
  [String.fromCodePoint(0x0623), String.fromCodePoint(0x0627)], // أ → ا
  [String.fromCodePoint(0x0625), String.fromCodePoint(0x0627)], // إ → ا
  [String.fromCodePoint(0x0622), String.fromCodePoint(0x0627)], // آ → ا
  [String.fromCodePoint(0x0671), String.fromCodePoint(0x0627)], // ٱ → ا
  [String.fromCodePoint(0x0629), String.fromCodePoint(0x0647)], // ة → ه
  [String.fromCodePoint(0x0649), String.fromCodePoint(0x064a)], // ى → ي
  ...[...Array(10).keys()].map((i) => [String.fromCodePoint(0x0660 + i), String(i)] as const), // ٠–٩
  ...[...Array(10).keys()].map((i) => [String.fromCodePoint(0x06f0 + i), String(i)] as const), // ۰–۹
]);

// Step 9's direction marks (U+200E, U+200F, U+202A–U+202E) — stripped outright.
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e]/gu;

export function normalizeArabicLatin(input: string): string {
  // 1. Unicode normalization: NFC.
  let out = input.normalize('NFC');
  // 2–7. Single-codepoint strips and folds (one ordered pass; Array.from
  // iterates code points — every folded character is a single BMP codepoint).
  out = Array.from(out)
    .map((ch) => CHAR_FOLDS.get(ch) ?? ch)
    .join('');
  // 8. Latin lowercasing (locale-independent JavaScript semantics).
  out = out.toLowerCase();
  // 9. Strip direction marks, trim, collapse whitespace runs to one U+0020.
  out = out.replace(DIRECTION_MARKS, '');
  out = out.trim().replace(/\s+/gu, ' ');
  return out;
}
