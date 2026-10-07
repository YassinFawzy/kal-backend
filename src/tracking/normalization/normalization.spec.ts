import { describe, expect, it } from 'vitest';
import { normalize } from './normalization.js';
import { SEED_FOODS } from '../../../prisma/seed-manifest.js';

/**
 * Golden suite for the frozen normalization pipeline (wave-03 contract §7).
 *
 * Pins, per task s2b:
 *   - every golden case on the contract's frozen list: input → exact
 *     normalized key AND the match-equivalence outcome (same food found,
 *     demonstrated with the contract §7 matching model over the seed
 *     manifest's stored normalized targets — search wiring itself is s2a's);
 *   - boundary cases (empty/whitespace-only, pure-Latin/pure-AR/mixed,
 *     Arabic-Indic vs Latin digits, tatweel-elongated, already-normalized,
 *     long strings, Unicode edge forms);
 *   - over-folding guards: pairs that MUST NOT unify stay distinct;
 *   - property-style spot checks: idempotence across the full corpus,
 *     ASCII-case folding monotonicity;
 *   - seed-manifest stability (contract §8): every hand-derived
 *     `*Normalized` field in `prisma/seed-manifest.ts` is reproduced exactly
 *     by the pipeline (48 items, 224 fields).
 *
 * Golden row 3 (شاورما · شاورمة) is ESCALATED — see its describe block.
 */

// -- Test-local matching model (contract §7): exact → prefix → substring. --
// Mirrors what the search surface (s2a) does with normalized keys; lives here
// ONLY to demonstrate match equivalence, never as search implementation.

type MatchRank = 'exact' | 'prefix' | 'substring';

const RANK_ORDER: Readonly<Record<MatchRank, number>> = { exact: 0, prefix: 1, substring: 2 };

interface CorpusHit {
  readonly foodId: string;
  readonly rank: MatchRank;
}

function rankAgainst(queryKey: string, targetKey: string): MatchRank | null {
  const q = queryKey.toLowerCase();
  const t = targetKey.toLowerCase();
  if (q === t) return 'exact';
  if (t.startsWith(q)) return 'prefix';
  if (t.includes(q)) return 'substring';
  return null;
}

/** Contract §7 matching model over the seed manifest's stored normalized targets. */
function searchManifest(query: string): readonly CorpusHit[] {
  const key = normalize(query);
  if (key === '') return []; // empty/whitespace-only query ⇒ empty result set
  const hits: CorpusHit[] = [];
  for (const food of SEED_FOODS) {
    const targets = [food.nameEnNormalized, food.nameArNormalized, ...food.aliasesNormalized];
    let best: MatchRank | null = null;
    for (const target of targets) {
      const rank = rankAgainst(key, target);
      if (rank !== null && (best === null || RANK_ORDER[rank] < RANK_ORDER[best])) best = rank;
    }
    if (best !== null) hits.push({ foodId: food.id, rank: best });
  }
  // Deterministic tiebreak by id ascending (contract §7 matching model).
  return hits.sort((a, b) => (a.foodId < b.foodId ? -1 : a.foodId > b.foodId ? 1 : 0));
}

function expectSameMatches(inputs: readonly string[]): void {
  const results = inputs.map((input) => searchManifest(input));
  for (const result of results) expect(result).toEqual(results[0]);
}

function expectHit(inputs: readonly string[], foodId: string, rank: MatchRank): void {
  for (const input of inputs) {
    expect(searchManifest(input)).toContainEqual({ foodId, rank });
  }
}

// -- The frozen golden-case list (contract §7 table). --

const TAAMEYA_GROUP = ['طعمية', 'طعميه', 'طَعْمِيَّة', 'طــعمية'] as const; // diacritics + tatweel spellings
const RICE_GROUP = ['أرز', 'إرز', 'اَرز'] as const; // hamza/alef + fatha spellings
const KOSHARI_GROUP = ['كشري', 'كشرى'] as const; // alef maqsura spelling
const LATIN_GROUP = ['Taameya', 'taameya', 'TAAMEYA'] as const;
const FUL_GROUP = ['فول مدمس', 'فول  مدمس ', 'فول\u200F مدمس'] as const; // extra/trailing spaces + RLM
const DIGIT_GROUP = ['كشري٢', 'كشري2'] as const; // Arabic-Indic U+0662 vs ASCII

const GOLDEN_GROUPS: readonly (readonly string[])[] = [
  TAAMEYA_GROUP,
  RICE_GROUP,
  KOSHARI_GROUP,
  LATIN_GROUP,
  FUL_GROUP,
  DIGIT_GROUP,
];

// Manifest raw fields — the corpus the manifest pin and property checks run over.
const MANIFEST_RAW_STRINGS: readonly string[] = SEED_FOODS.flatMap((food) => [
  food.nameEn,
  food.nameAr,
  ...food.aliases,
]);

// Long input: tatween+diacritic-laden words separated by NBSP runs.
const LONG_INPUT = `${'طَعْمِيَّة\u00A0\u00A0'.repeat(2000)}`;
const LONG_EXPECTED = Array.from({ length: 2000 }, () => 'طعميه').join(' ');

const CORPUS: readonly string[] = [
  ...GOLDEN_GROUPS.flat(),
  'شاورما',
  'شاورمة', // escalated row 3 members — keys pinned, equivalence not asserted
  // boundary
  '',
  ' ',
  '\t',
  '\n \u00A0\u2028\u2029\u3000 ',
  '\u200E\u200F',
  'Koshari كشري ٢',
  'فول\u00A0مدمس',
  'مــُــشــوى',
  ' \u200F طعمية \u200E ',
  // Unicode edge forms
  '\uFE8D\uFE94',
  'اة',
  '\u0130',
  'a\u200Eb',
  'فول\u200Bمدمس',
  '\u06D6',
  // over-folding guards
  'ta3meya',
  'مسءول',
  'مسؤول',
  'تعمية',
  'كوشاري',
  'كشري٣',
  'koshary',
  'kunafa',
  'kunafah',
  // long
  LONG_INPUT,
  ...MANIFEST_RAW_STRINGS,
];

describe('golden cases (contract §7 frozen table — input → normalized key)', () => {
  it('row 1: طعمية spellings (hamza-free base, taa-marbuta/haha, diacritics, tatweel) → طعميه', () => {
    for (const input of TAAMEYA_GROUP) expect(normalize(input)).toBe('طعميه');
  });

  it('row 2: أرز/إرز/اَرز (hamza alef variants + bare alef with fatha) → ارز', () => {
    for (const input of RICE_GROUP) expect(normalize(input)).toBe('ارز');
  });

  it('row 4: كشري/كشرى (alef maqsura unification) → كشري', () => {
    for (const input of KOSHARI_GROUP) expect(normalize(input)).toBe('كشري');
  });

  it('row 5: Taameya/taameya/TAAMEYA (locale-independent lowercasing) → taameya', () => {
    for (const input of LATIN_GROUP) expect(normalize(input)).toBe('taameya');
  });

  it('row 6: فول مدمس with extra/trailing whitespace and an RLM mark → فول مدمس', () => {
    for (const input of FUL_GROUP) expect(normalize(input)).toBe('فول مدمس');
  });

  it('row 7: كشري٢/كشري2 (Arabic-Indic vs ASCII digit) → كشري2', () => {
    for (const input of DIGIT_GROUP) expect(normalize(input)).toBe('كشري2');
  });
});

describe('golden row 3 — ESCALATED to w03-supervisor (2026-10-08), resolution pending', () => {
  // The frozen §7 golden table claims `شاورما` · `شاورمة` → common key
  // `شاورمه` ("all must produce identical matches"). The frozen §7 RULE LIST
  // cannot produce that: `شاورما` ends in bare alef U+0627 — NO frozen rule
  // maps U+0627 (rule 4 folds only أ إ آ ٱ) — so it normalizes to `شاورما`;
  // `شاورمة` ends in taa marbuta U+0629 → rule 5 → `شاورمه`. Encoding the
  // table's equivalence would require a NEW folding rule (extra foldings are
  // contract changes — task s2b forbids improvising past the freeze).
  // Per the supervisor's written interim approval: pin each member's exact
  // rule-faithful normalized key; assert NEITHER equivalence NOR
  // non-equivalence until the written resolution lands.
  it('normalizes each member to its rule-faithful exact key', () => {
    expect(normalize('شاورما')).toBe('شاورما');
    expect(normalize('شاورمة')).toBe('شاورمه');
  });
});

describe('match equivalence (contract §7 matching model over the manifest corpus)', () => {
  it('each golden group yields identical result sets — the same food is found', () => {
    for (const group of GOLDEN_GROUPS) expectSameMatches(group);
  });

  it('row 1 variants all hit seed f002 (Taameya) at exact rank', () => {
    expectHit([...TAAMEYA_GROUP], '00000000-0000-4000-8000-00000000f002', 'exact');
  });

  it('row 2 variants all hit seed f009 (Cooked white rice)', () => {
    expectHit([...RICE_GROUP], '00000000-0000-4000-8000-00000000f009', 'exact'); // alias `ارز`
  });

  it('row 4 variants all hit seed f003 (Koshari) at exact rank', () => {
    expectHit([...KOSHARI_GROUP], '00000000-0000-4000-8000-00000000f003', 'exact');
  });

  it('row 5 variants all hit seed f002 via its English name at exact rank', () => {
    expectHit([...LATIN_GROUP], '00000000-0000-4000-8000-00000000f002', 'exact');
  });

  it('row 6 variants all hit seed f001 (Ful medames) at exact rank', () => {
    expectHit([...FUL_GROUP], '00000000-0000-4000-8000-00000000f001', 'exact');
  });

  it('row 7 variants yield identical (corpus-empty) results — digit folding is pinned at key level', () => {
    const [arabicIndic, ascii] = DIGIT_GROUP.map((input) => searchManifest(input));
    expect(arabicIndic).toEqual(ascii);
    expect(arabicIndic).toEqual([]); // no seeded item carries a كشري2 target
  });

  it('empty/whitespace-only query ⇒ empty result set (not an error)', () => {
    expect(searchManifest('')).toEqual([]);
    expect(searchManifest('   ')).toEqual([]);
    expect(searchManifest(' \u200F\u200E ')).toEqual([]);
  });
});

describe('boundary cases', () => {
  it('empty and whitespace-only inputs normalize to the empty string', () => {
    expect(normalize('')).toBe('');
    expect(normalize(' ')).toBe('');
    expect(normalize('\t')).toBe('');
    expect(normalize('\n \u00A0\u2028\u2029\u3000 ')).toBe('');
    expect(normalize('\u200E\u200F')).toBe(''); // direction marks alone strip to nothing
  });

  it('pure-Latin input lowercases', () => {
    expect(normalize('Falafel')).toBe('falafel');
    expect(normalize('FAVA BEANS STEW')).toBe('fava beans stew');
  });

  it('pure-Arabic input applies the Arabic folds', () => {
    expect(normalize('شاورمة')).toBe('شاورمه');
    expect(normalize('مدرسة')).toBe('مدرسه');
  });

  it('mixed-script input folds both scripts in one pass', () => {
    expect(normalize('Koshari كشري ٢')).toBe('koshari كشري 2');
    expect(normalize('Ta3meyeT شاورمة')).toBe('ta3meyet شاورمه');
  });

  it('Arabic-Indic AND Extended Arabic-Indic digits fold to ASCII; ASCII digits pass through', () => {
    expect(normalize('٣٤٥')).toBe('345');
    expect(normalize('۴۵')).toBe('45'); // U+06F4/U+06F5 (Extended block)
    expect(normalize('2024')).toBe('2024');
    expect(normalize('٤:٣٠')).toBe('4:30');
  });

  it('tatween-elongated and fully-diacritized strings strip to their base spelling', () => {
    expect(normalize('مــُــشــوى')).toBe('مشوي'); // tatweel runs + damas + alef maqsura
    expect(normalize('طــعْـمِـيّـة')).toBe('طعميه');
    expect(normalize('عَــلَى')).toBe('علي'); // fathas + tatweel + alef maqsura → ya
  });

  it('direction marks are REMOVED (not turned into spaces)', () => {
    expect(normalize('a\u200Eb')).toBe('ab');
    expect(normalize('\u202Bفول\u202C مدمس')).toBe('فول مدمس');
  });

  it('already-normalized input passes through unchanged', () => {
    expect(normalize('طعميه')).toBe('طعميه');
    expect(normalize('ارز')).toBe('ارز');
    expect(normalize('فول مدمس')).toBe('فول مدمس');
    expect(normalize('taameya')).toBe('taameya');
    expect(normalize('كشري2')).toBe('كشري2');
  });

  it('long inputs stay stable and well-formed', () => {
    expect(normalize(LONG_INPUT)).toBe(LONG_EXPECTED);
    expect(normalize(LONG_INPUT)).toBe(normalize(LONG_EXPECTED));
  });

  it('Unicode edge forms: NFC (not NFKC) leaves presentation-form ligatures untouched', () => {
    expect(normalize('\uFE8D\uFE94')).toBe('\uFE8D\uFE94'); // presentation-form alef + teh marbuta
    expect(normalize('اة')).toBe('اه'); // contrast: the base characters DO fold
    expect(normalize('\uFDFA')).toBe('\uFDFA'); // Arabic ligature (compatibility decomposition exists — NFC does not apply it)
  });

  it('Unicode edge forms: step 8 is JavaScript toLowerCase, including its multi-codepoint maps', () => {
    expect(normalize('\u0130')).toBe('i\u0307'); // İ → i + combining dot above (U+0307 is not a frozen strip target)
  });

  it('zero-width space U+200B is NOT JavaScript whitespace — left untouched (no extra folding)', () => {
    expect(normalize('فول\u200Bمدمس')).toBe('فول\u200Bمدمس');
    expect(normalize('a\u200Bb')).toBe('a\u200Bb');
  });

  it('Quranic annotation marks OUTSIDE the frozen ranges are left untouched', () => {
    expect(normalize('\u06D6')).toBe('\u06D6'); // U+06D6 is not in U+064B–U+065F nor U+0670
  });
});

describe('over-folding guards (distinct foods must stay distinct)', () => {
  it('standalone hamza ء never unifies with alef', () => {
    expect(normalize('ء')).toBe('ء');
    expect(normalize('مسءول')).not.toBe(normalize('مسؤول'));
  });

  it('hamza-carrying letters ؤ/ئ are outside the frozen map and stay distinct from ي/و', () => {
    expect(normalize('ؤ')).toBe('ؤ');
    expect(normalize('ئ')).toBe('ئ');
    expect(normalize('مسؤول')).not.toBe(normalize('مسول'));
  });

  it('distinct Arabic consonants are never folded into each other', () => {
    expect(normalize('طعمية')).not.toBe(normalize('تعمية')); // ط ≠ ت
    expect(normalize('كوشاري')).not.toBe(normalize('كشري')); // no vowel insertion/removal
  });

  it('Arabizi numerals are letters, not digits — no transformation, no transliteration', () => {
    expect(normalize('ta3meya')).toBe('ta3meya');
    expect(normalize('ta3meya')).not.toBe(normalize('taameya')); // franco-arab aliases are data, not algorithm
  });

  it('Latin alias spellings stay distinct (aliases are data in the manifest)', () => {
    expect(normalize('koshari')).not.toBe(normalize('koshary'));
    expect(normalize('kunafa')).not.toBe(normalize('kunafah'));
  });

  it('different digits never unify', () => {
    expect(normalize('كشري٢')).not.toBe(normalize('كشري٣'));
    expect(normalize('2')).not.toBe(normalize('٣'));
  });

  it('every base Arabic letter maps ONLY per the frozen step 4–6 map (exhaustive sweep U+0621–U+064A)', () => {
    const frozenFolds: ReadonlyMap<number, number> = new Map([
      [0x0623, 0x0627], // أ → ا
      [0x0625, 0x0627], // إ → ا
      [0x0622, 0x0627], // آ → ا
      [0x0671, 0x0627], // ٱ → ا
      [0x0629, 0x0647], // ة → ه
      [0x0649, 0x064a], // ى → ي
    ]);
    for (let cp = 0x0621; cp <= 0x064a; cp++) {
      if (cp === 0x0640) continue; // tatweel is not a letter — rule 3 strips it (pinned below)
      const expected = String.fromCodePoint(frozenFolds.get(cp) ?? cp);
      expect(normalize(String.fromCodePoint(cp))).toBe(expected);
    }
  });

  it('every frozen mark range strips to nothing (exhaustive sweep U+064B–U+065F, U+0670, U+0640)', () => {
    for (let cp = 0x064b; cp <= 0x065f; cp++) {
      expect(normalize(String.fromCodePoint(cp))).toBe('');
    }
    expect(normalize('\u0670')).toBe('');
    expect(normalize('\u0640')).toBe('');
  });
});

describe('property-style spot checks', () => {
  it('idempotence across the full corpus: normalize(normalize(x)) === normalize(x)', () => {
    for (const input of CORPUS) {
      expect(normalize(normalize(input))).toBe(normalize(input));
    }
  });

  it('ASCII-case folding monotonicity: case permutation never changes a Latin key', () => {
    const latinInputs = ['Taameya', 'taameya', 'TAAMEYA', 'Falafel', 'FAVA Beans', 'koshary', 'ta3meya', 'kunafah', 'MixedCase AliAs'];
    for (const input of latinInputs) {
      expect(normalize(input.toUpperCase())).toBe(normalize(input));
      expect(normalize(input.toLowerCase())).toBe(normalize(input));
    }
  });

  it('output is always trim-collapsed lowercase-normal: no leading/trailing/double spaces', () => {
    for (const input of CORPUS) {
      const out = normalize(input);
      expect(out).toBe(out.trim());
      expect(out).not.toMatch(/ {2}/u);
    }
  });

  it('determinism: repeated normalization of the same input is byte-identical', () => {
    for (const input of CORPUS.slice(0, 32)) {
      expect(normalize(input)).toBe(normalize(input));
    }
  });
});

describe('seed-manifest stability pin (contract §8)', () => {
  it('reproduces every hand-derived normalized field exactly (48 items)', () => {
    expect(SEED_FOODS.length).toBe(48);
    let fields = 0;
    for (const food of SEED_FOODS) {
      expect(normalize(food.nameEn), `${food.id} nameEnNormalized`).toBe(food.nameEnNormalized);
      fields++;
      expect(normalize(food.nameAr), `${food.id} nameArNormalized`).toBe(food.nameArNormalized);
      fields++;
      expect(food.aliasesNormalized.length, `${food.id} alias list parity`).toBe(food.aliases.length);
      for (let i = 0; i < food.aliases.length; i++) {
        expect(normalize(food.aliases[i]), `${food.id} aliasesNormalized[${i}]`).toBe(food.aliasesNormalized[i]);
        fields++;
      }
    }
    expect(fields).toBe(224);
  });
});
