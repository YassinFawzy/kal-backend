/**
 * Kal — Arabic/Latin normalization pipeline (wave-03 contract §7, FR-010).
 *
 * THE FROZEN RULE SET. This file implements `docs/api/wave-03-contract.md` §7
 * exactly: a pure function `normalize(input) → normalized` applied by writers
 * to stored forms (`name_ar_normalized`, `name_en_normalized`,
 * `aliases_normalized`) and by search to the query — the database never
 * re-derives normalized forms. Equivalent spellings must produce identical
 * normalized keys, so equivalent queries produce identical result sets.
 *
 * Canonicalization steps, in the frozen order (contract §7 — deviations are
 * contract changes, never implementation freedom):
 *
 *   1. Unicode normalization: NFC.
 *   2. Strip Arabic diacritics (harakat) and Quranic marks:
 *      U+064B–U+0652, U+0653–U+065F, U+0670.
 *   3. Strip tatweel: U+0640.
 *   4. Unify alef/hamza forms: U+0623 (أ), U+0625 (إ), U+0622 (آ),
 *      U+0671 (ٱ) → U+0627 (ا). Standalone hamza U+0621 (ء) is unchanged
 *      (consonantal).
 *   5. Taa marbuta: U+0629 (ة) → U+0647 (ه).
 *   6. Alef maqsura: U+0649 (ى) → U+064A (ي).
 *   7. Fold Arabic-Indic digits: U+0660–U+0669 (٠–٩) and U+06F0–U+06F9
 *      (۰–۹) → ASCII `0`–`9`.
 *   8. Latin lowercasing: JavaScript `toLowerCase()` (locale-independent).
 *   9. Whitespace collapse: strip Unicode direction marks (U+200E, U+200F,
 *      U+202A–U+202E), trim, collapse every whitespace run (including NBSP
 *      U+00A0 and tabs) to a single U+0020.
 *
 * Frozen non-goals (nothing added — any extra folding is a contract change
 * routed through w03-supervisor, never an implementation choice here):
 *   - Arabizi numerals (`3`, `7` as letters) are OUT OF SCOPE: no
 *     transformation; such strings only ever match verbatim.
 *   - Presentation forms (U+FB50–U+FDFF, U+FE70–U+FEFF) are NOT folded:
 *     step 1 is NFC, not NFKC, and NFC does not decompose them.
 *   - Standalone hamza ء and the hamza-carrying letters ؤ ئ are NOT
 *     unified with anything (only the four alef variants of step 4 fold).
 *   - Whitespace is the JavaScript `\s` class (the same language baseline
 *     step 8 names), which includes NBSP U+00A0 and tab U+0009 but NOT
 *     zero-width space U+200B (a format character, left untouched).
 *
 * Purity contract: same input ⇒ same output, always. No clock, randomness,
 * network, database, locale-dependent ICU behavior, or side effects. The
 * pipeline is idempotent: normalize(normalize(x)) === normalize(x).
 */

/**
 * Step 2 — Arabic diacritics (harakat), Quranic marks, and superscript alef,
 * exactly the contract's ranges: U+064B–U+0652 (fathatan…sukun),
 * U+0653–U+065F (maddah…Quranic contour marks), U+0670 (superscript alef).
 * Quranic annotation marks OUTSIDE these ranges (e.g. U+06D6–U+06ED) are not
 * in the freeze and are therefore left untouched.
 */
const HARAKAT_PATTERN = /[\u064B-\u0652\u0653-\u065F\u0670]/gu;

/** Step 3 — tatweel (kashida elongation). */
const TATWEEL_PATTERN = /\u0640/gu;

/** Step 4 — alef/hamza variants that unify with bare alef U+0627. */
const ALEF_PATTERN = /[\u0623\u0625\u0622\u0671]/gu;
const BARE_ALEF = '\u0627';

/** Step 5 — taa marbuta folds to heh. */
const TAA_MARBUTA = '\u0629';
const HEH = '\u0647';

/** Step 6 — alef maqsura folds to ya. */
const ALEF_MAQSURA = '\u0649';
const YA = '\u064A';

/** Step 7 — Arabic-Indic and Extended (Persian) digit blocks → ASCII 0–9. */
const ARABIC_INDIC_DIGIT_PATTERN = /[\u0660-\u0669\u06F0-\u06F9]/gu;

/** Step 9 — Unicode direction marks: LRM, RLM, LRE, RLE, PDF, LRO, RLO. */
const DIRECTION_MARK_PATTERN = /[\u200E\u200F\u202A-\u202E]/gu;

/**
 * Step 9 — JavaScript whitespace, collapsed to a single U+0020. The JS `\s`
 * class covers every Unicode whitespace character, including the contract's
 * named examples (NBSP U+00A0, tab U+0009) and line/paragraph separators.
 */
const WHITESPACE_RUN_PATTERN = /\s+/gu;
const SPACE = '\u0020';

/** Folds one Arabic-Indic digit (either block) to its ASCII digit. */
function foldDigit(ch: string): string {
  const cp = ch.codePointAt(0) as number;
  const base = cp >= 0x06f0 ? 0x06f0 : 0x0660;
  return String.fromCharCode(cp - base + 0x30);
}

/**
 * The frozen normalization pipeline (contract §7). Deterministic, pure, and
 * idempotent; total over all strings (empty input → empty output).
 *
 * Search normalizes the query ONCE and matches it against stored normalized
 * targets (contract §7 matching model: case-insensitive-exact → prefix →
 * substring); matching itself lives with the search surface, not here.
 */
export function normalize(input: string): string {
  // 1. Unicode normalization: NFC (canonical composition — NOT NFKC, which
  //    would additionally fold compatibility forms; the freeze names NFC).
  let out = input.normalize('NFC');
  // 2. Strip harakat and Quranic marks.
  out = out.replace(HARAKAT_PATTERN, '');
  // 3. Strip tatweel.
  out = out.replace(TATWEEL_PATTERN, '');
  // 4. Unify alef/hamza forms → bare alef (standalone hamza ء untouched).
  out = out.replace(ALEF_PATTERN, BARE_ALEF);
  // 5. Taa marbuta → heh.
  out = out.split(TAA_MARBUTA).join(HEH);
  // 6. Alef maqsura → ya.
  out = out.split(ALEF_MAQSURA).join(YA);
  // 7. Arabic-Indic digits → ASCII.
  out = out.replace(ARABIC_INDIC_DIGIT_PATTERN, foldDigit);
  // 8. Latin lowercasing (locale-independent JavaScript toLowerCase).
  out = out.toLowerCase();
  // 9. Strip direction marks, trim, collapse whitespace runs to one space.
  out = out.replace(DIRECTION_MARK_PATTERN, '');
  out = out.replace(WHITESPACE_RUN_PATTERN, SPACE).trim();
  return out;
}
