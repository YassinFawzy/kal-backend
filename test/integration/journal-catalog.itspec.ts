/**
 * Integration — the exercise catalog lane (wave-04, lane s2b) on an
 * EPHEMERAL database (full migration history + the production-faithful
 * exercise seed; the tracking-foods itspec pattern).
 *
 * Required cases proven here (task contract + ledger §3 criterion 3 +
 * s1 verifier finding F1 — the automated seed-idempotence itspec s1 did not
 * ship and this lane MUST):
 *
 *   seed (F1)   — `applyExerciseCatalogSeed` runs TWICE against a cold
 *                 ephemeral database: the count equals the manifest length
 *                 both times (zero duplicates); EVERY row equals its manifest
 *                 constant column-for-column (zero drift — the fidelity check
 *                 IMPORTS the manifest, transcribing nothing); no rows exist
 *                 beyond the manifest's id set; the replay does not rewrite
 *                 `created_at` (a true no-op upsert on unchanged rows); every
 *                 row serves provenance `kal_reviewed` (pinned).
 *   search      — the repository matching model (w3 §7 REUSED, same
 *                 `normalize` implementation over the manifest's stored
 *                 normalized targets): exact → prefix → substring ranks,
 *                 alias-mediated hits, deterministic `id` tiebreak, and
 *                 NORMALIZATION PARITY — equivalent spellings (hamza/alef
 *                 variants, diacritics, tatweel, taa marbuta, Latin
 *                 case/whitespace) produce IDENTICAL result sets.
 *   cursors     — the `(rank, id)` cursor walks the full match set without
 *                 loss or duplication and terminates (drained polarity).
 *   isolation   — the catalog is the same governed rows for every
 *                 authenticated user (platform-owned, RLS declined): A/B/C
 *                 search under their own GUC bindings see identical result
 *                 sets, and the reads run under the `kal_app` role (the
 *                 posture probe proves `current_user` inside the tx).
 *
 * HTTP-level behavior (envelopes, 400 byte-identity, 401, 404 parity, limit
 * clamp) belongs to the e2e suite (`test/e2e/journal-catalog.e2e-spec.ts`);
 * this suite exercises the real database through the sanctioned transaction
 * posture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { normalize } from '../../src/tracking/normalization/normalization.js';
import { inUserScopeTx } from '../../src/journal/journal-tx.js';
import { ExerciseCatalogRepository } from '../../src/journal/catalog/catalog.repository.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import type { ConfigService } from '../../src/config/config.service.js';
import { applyExerciseCatalogSeed } from '../../prisma/seed-apply.ts';
import { SEED_EXERCISES } from '../../prisma/seed-exercises.ts';
import { asUserlessApp, USER_A, USER_B, USER_C } from './helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

let db: EphemeralKalDb;
let prisma: PrismaService;
let repository: ExerciseCatalogRepository;

/** Search helper: the sanctioned user-scoped posture over the real tx client. */
async function searchIds(
  userId: string,
  query: string,
  limit = 100,
  cursor: { rank: number; id: string } | null = null,
): Promise<{ ids: string[]; ranks: number[]; exhausted: boolean }> {
  return inUserScopeTx(prisma, { userId }, async (tx) => {
    const { rows, exhausted } = await repository.searchPage(tx, normalize(query), limit, cursor);
    return { ids: rows.map((row) => row.id), ranks: rows.map((row) => row.rank), exhausted };
  });
}

/** A fresh seed-client PrismaClient over the scratch DB (operator posture). */
async function withSeedClient(work: (client: PrismaClient) => Promise<void>): Promise<void> {
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const client = new PrismaClient({
    adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }),
  });
  try {
    await work(client);
  } finally {
    await client.$disconnect();
  }
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('journal-catalog-it');
    db.applyMigrations();
    repository = new ExerciseCatalogRepository();

    const scratchUrl = new URL(process.env['DATABASE_URL'] as string);
    scratchUrl.pathname = `/${db.name}`;

    // Production-faithful exercise seed — FIRST apply (the F1 sequence
    // continues in the seed describe: second apply + drift/fidelity proofs).
    let firstCount = 0;
    await withSeedClient(async (client) => {
      const result = await applyExerciseCatalogSeed(client);
      firstCount = result.exercises;
    });
    expect(firstCount).toBe(SEED_EXERCISES.length);

    prisma = new PrismaService({ databaseUrl: scratchUrl.toString() } as ConfigService);

    // Synthetic A/B/C accounts (the harness convention) — the catalog has no
    // owned rows, but the parity/posture probes prove the reads run as
    // `kal_app` with each account's own GUC binding.
    for (const user of [
      { id: USER_A, email: 'a@journal-catalog-it.invalid', username: 'journal_catalog_it_a' },
      { id: USER_B, email: 'b@journal-catalog-it.invalid', username: 'journal_catalog_it_b' },
      { id: USER_C, email: 'c@journal-catalog-it.invalid', username: 'journal_catalog_it_c' },
    ]) {
      await asUserlessApp(db, async (q) => {
        await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [user.id, user.email, user.username]);
      }, { commit: true });
    }
  })();
}, 240_000);

afterAll(async () => {
  await prisma?.onModuleDestroy();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------
// F1 — seed idempotence + manifest fidelity (verifier finding F1, routed to
// s2b; ledger §3 criterion 3 "seed idempotent")
// ---------------------------------------------------------------------------

describe('exercise seed — idempotence + manifest fidelity (F1)', () => {
  it('the catalog contains EXACTLY the manifest: no duplicates, no extra rows', async () => {
    const rows = await adminQuery(db, 'SELECT id::text FROM exercises');
    const ids = rows.rows.map((row) => (row as { id: string }).id);
    expect(rows.rowCount).toBe(SEED_EXERCISES.length);
    expect(new Set(ids).size).toBe(SEED_EXERCISES.length);
    expect(new Set(ids)).toEqual(new Set(SEED_EXERCISES.map((exercise) => exercise.id)));
  });

  it('SECOND apply is a no-op upsert: zero duplicates, zero drift vs the manifest constants', async () => {
    let replayCount = 0;
    await withSeedClient(async (client) => {
      const replay = await applyExerciseCatalogSeed(client);
      replayCount = replay.exercises;
    });
    expect(replayCount).toBe(SEED_EXERCISES.length);

    // Zero drift: EVERY row equals its manifest constant COLUMN-FOR-COLUMN
    // (the fidelity check imports the manifest — nothing transcribed).
    const rows = await adminQuery(db, `SELECT id::text, provenance, name_en, name_en_normalized, name_ar,
      name_ar_normalized, aliases, aliases_normalized, instructions_en, instructions_ar,
      muscle_groups, tags FROM exercises ORDER BY id`);
    expect(rows.rowCount).toBe(SEED_EXERCISES.length);
    const manifestById = new Map(SEED_EXERCISES.map((exercise) => [exercise.id, exercise]));
    for (const raw of rows.rows) {
      const row = raw as {
        id: string; provenance: string; name_en: string; name_en_normalized: string;
        name_ar: string; name_ar_normalized: string; aliases: string[]; aliases_normalized: string[];
        instructions_en: string; instructions_ar: string; muscle_groups: string[]; tags: string[];
      };
      const manifest = manifestById.get(row.id);
      expect(manifest, `row ${row.id} must be a manifest row`).toBeDefined();
      expect(row.provenance, `${row.id} provenance`).toBe(manifest!.provenance);
      expect(row.name_en, `${row.id} name_en`).toBe(manifest!.nameEn);
      expect(row.name_en_normalized, `${row.id} name_en_normalized`).toBe(manifest!.nameEnNormalized);
      expect(row.name_ar, `${row.id} name_ar`).toBe(manifest!.nameAr);
      expect(row.name_ar_normalized, `${row.id} name_ar_normalized`).toBe(manifest!.nameArNormalized);
      expect(row.aliases, `${row.id} aliases`).toEqual([...manifest!.aliases]);
      expect(row.aliases_normalized, `${row.id} aliases_normalized`).toEqual([...manifest!.aliasesNormalized]);
      expect(row.instructions_en, `${row.id} instructions_en`).toBe(manifest!.instructionsEn);
      expect(row.instructions_ar, `${row.id} instructions_ar`).toBe(manifest!.instructionsAr);
      expect(row.muscle_groups, `${row.id} muscle_groups`).toEqual([...manifest!.muscleGroups]);
      expect(row.tags, `${row.id} tags`).toEqual([...manifest!.tags]);
    }
  });

  it('replay rewrites nothing: created_at is untouched by the second apply', async () => {
    const before = await adminQuery(db, 'SELECT id::text, created_at FROM exercises ORDER BY id');
    await withSeedClient(async (client) => {
      await applyExerciseCatalogSeed(client);
    });
    const after = await adminQuery(db, 'SELECT id::text, created_at FROM exercises ORDER BY id');
    expect(after.rows).toEqual(before.rows);
  });

  it('every row serves provenance kal_reviewed (the manifest value — pinned)', async () => {
    const rows = await adminQuery(db, 'SELECT DISTINCT provenance FROM exercises');
    expect(rows.rows.map((row) => (row as { provenance: string }).provenance)).toEqual(['kal_reviewed']);
  });

  it('the stored normalized targets reproduce the frozen pipeline exactly (w3 §7 parity at rest)', async () => {
    const rows = await adminQuery(db, `SELECT id::text, name_en, name_ar, name_en_normalized,
      name_ar_normalized, aliases, aliases_normalized FROM exercises`);
    for (const raw of rows.rows) {
      const row = raw as {
        id: string; name_en: string; name_ar: string; name_en_normalized: string;
        name_ar_normalized: string; aliases: string[]; aliases_normalized: string[];
      };
      expect(row.name_en_normalized, `${row.id} name_en`).toBe(normalize(row.name_en));
      expect(row.name_ar_normalized, `${row.id} name_ar`).toBe(normalize(row.name_ar));
      expect(row.aliases_normalized, `${row.id} aliases`).toEqual(row.aliases.map((alias) => normalize(alias)));
    }
  });
});

// ---------------------------------------------------------------------------
// Search — the w3 §7 matching model REUSED (repository level)
// ---------------------------------------------------------------------------

describe('catalog search — matching model + normalization parity (repository, w3 §7 REUSED)', () => {
  it('exact EN name, exact AR name, and alias hits are all rank 0', async () => {
    const en = await searchIds(USER_A, 'Barbell back squat');
    expect(en.ids).toEqual(['00000000-0000-4000-8000-00000000f201']);
    expect(en.ranks).toEqual([0]);
    const ar = await searchIds(USER_A, 'سكوات بالبار');
    expect(ar.ids).toEqual(['00000000-0000-4000-8000-00000000f201']);
    expect(ar.ranks).toEqual([0]);
    const alias = await searchIds(USER_A, 'skull crusher');
    expect(alias.ids).toEqual(['00000000-0000-4000-8000-00000000f20a']);
    expect(alias.ranks).toEqual([0]);
  });

  it('prefix beats substring; deterministic id tiebreak inside a rank tier', async () => {
    // 'سكوات' prefix-matches f201/f202/f21d/f228 (rank 1) and sits inside
    // 'جوبلت سكوات' (f210, rank 2) — tiers ordered, ids ascending within.
    const { ids, ranks } = await searchIds(USER_A, 'سكوات');
    expect(ids).toEqual([
      '00000000-0000-4000-8000-00000000f201',
      '00000000-0000-4000-8000-00000000f202',
      '00000000-0000-4000-8000-00000000f21d',
      '00000000-0000-4000-8000-00000000f228',
      '00000000-0000-4000-8000-00000000f210',
    ]);
    expect(ranks).toEqual([1, 1, 1, 1, 2]);
  });

  it('NORMALIZATION PARITY — equivalent spellings yield identical result sets (the golden matrix)', async () => {
    const paritySets: ReadonlyArray<readonly string[]> = [
      // Hamza/alef family (step 4): the manifest alias اسكوات with each
      // alef/hamza spelling — identical normalized key.
      ['اسكوات', 'أسكوات', 'إسكوات', 'آسكوات'],
      // Diacritics (step 2) + tatweel (step 3) + whitespace (step 9).
      ['سكوات بالبار', 'سُكوات بالبَار', 'ســكوات بالبار', ' سكوات  بالبار '],
      // Taa marbuta (step 5): ة spelling vs ه spelling (f216 name).
      ['رفع سمانة', 'رفع سمانه'],
      // Diacritic + taa-marbuta alias family (f216: سمّانة / سمانه).
      ['سمّانة', 'سمانه', 'سمانة'],
      // Pull-up family: عقلة folds to عقله; prefix reaches f21b too.
      ['عقلة', 'عُقلة', 'عقله'],
      // Latin case + whitespace (step 8/9): f203 exact + f204 substring.
      ['bench press', 'BENCH PRESS', ' Bench  Press '],
      // Hamza in a vernacular alias (f219: ضغط أرض folds to ضغط ارض).
      ['ضغط أرض', 'ضغط ارض'],
    ];
    for (const spellings of paritySets) {
      const keys = spellings.map((spelling) => normalize(spelling));
      expect(new Set(keys).size, `parity set ${spellings.join(' · ')} must normalize to ONE key`).toBe(1);
      const baseline = await searchIds(USER_A, spellings[0]!);
      expect(baseline.ids.length, `parity set ${spellings[0]} must match the catalog`).toBeGreaterThan(0);
      for (const spelling of spellings.slice(1)) {
        expect(await searchIds(USER_A, spelling), spelling).toEqual(baseline);
      }
    }
  });

  it('parity is user-independent: A, B, and C get identical sets (public-to-authenticated catalog)', async () => {
    for (const query of ['bench press', 'سكوات', 'عقلة']) {
      const a = await searchIds(USER_A, query);
      expect(await searchIds(USER_B, query)).toEqual(a);
      expect(await searchIds(USER_C, query)).toEqual(a);
    }
  });

  it('the (rank, id) cursor walks the full match set without loss or duplication', async () => {
    const baseline = await searchIds(USER_A, 'ا', 100); // broad alef query — most rows match
    expect(baseline.ids.length).toBeGreaterThan(20);
    // The service's walk condition, mirrored at repository level: advance
    // the cursor IFF `exhausted` (searchPage fetched limit+1 and got more —
    // exactly the rows for which the service emits a nextCursor); stop at
    // the FIRST page with exhausted === false — that page is the LAST page
    // (the drained polarity; an exactly-full final page does NOT emit a
    // dangling cursor, so no empty page is ever served mid-walk).
    const seen: string[] = [];
    let cursor: { rank: number; id: string } | null = null;
    let lastDrained = false;
    for (let page = 0; ; page += 1) {
      const result = await searchIds(USER_A, 'ا', 7, cursor);
      seen.push(...result.ids);
      lastDrained = !result.exhausted;
      if (!result.exhausted) {
        expect(result.ids.length, 'the drained page is non-empty').toBeGreaterThan(0);
        break;
      }
      cursor = { rank: result.ranks.at(-1)!, id: result.ids.at(-1)! };
      expect(page).toBeLessThan(50); // runaway guard — the walk must terminate
    }
    expect(lastDrained).toBe(true);
    expect(seen).toEqual(baseline.ids);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a query matching nothing yields the empty set (and no cursor state)', async () => {
    const none = await searchIds(USER_A, 'zzz-no-such-exercise-zzz');
    expect(none).toEqual({ ids: [], ranks: [], exhausted: false });
  });
});

// ---------------------------------------------------------------------------
// Posture — reads run as kal_app under the caller's GUC (least privilege)
// ---------------------------------------------------------------------------

describe('catalog read posture', () => {
  it('catalog reads run under the kal_app role inside the user-scoped posture', async () => {
    const currentUser = await inUserScopeTx(prisma, { userId: USER_A }, async (tx) => {
      const rows = await tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      return rows[0]!.current_user;
    });
    expect(currentUser).toBe('kal_app');
  });
});
