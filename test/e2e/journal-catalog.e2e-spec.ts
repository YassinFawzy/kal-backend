/**
 * Kal API e2e — the exercise catalog surface (wave-04 contract note §2;
 * lane s2b). Boots the real AppModule against an EPHEMERAL database (the
 * tracking-foods e2e harness pattern), seeds the 50-exercise manifest the
 * production-faithful way (`applyExerciseCatalogSeed` — the operator
 * posture), and proves:
 *
 *   happy      — search by EN name, AR name, and alias; the §7 rank order
 *                (exact → prefix → substring, id tiebreak) observable in the
 *                served order; detail returns the full AR/EN catalog item
 *                (names, aliases, text instructions, display taxonomy) with
 *                its manifest values.
 *   parity     — THE HEADLINE: the normalization parity matrix (hamza/alef
 *                variants, diacritics, tatweel, taa marbuta, Latin
 *                case/whitespace) yields IDENTICAL result sets over HTTP
 *                (w3 §7 pipeline REUSED — ledger §3 criterion 3).
 *   boundary   — empty/whitespace q ⇒ EMPTY 200 (never an error); missing q
 *                and q over 80 trimmed chars ⇒ 400 (values never echoed);
 *                limit clamp (non-numeric ⇒ 400; 0 clamps UP to 1);
 *                cursor pagination walks the full match set without loss or
 *                duplication and the LAST page serves `nextCursor: null`
 *                (drained polarity, amendment-2).
 *   negative   — a foreign cursor (A's token presented by B), a truncated
 *                cursor, and a garbage cursor get ONE byte-identical generic
 *                400 VALIDATION_FAILED (I7 — the cause is never observable);
 *                unauthenticated ⇒ 401 UNAUTHENTICATED + `WWW-Authenticate:
 *                Bearer`; detail 404 is byte-identical for absent and
 *                malformed ids (no existence oracle); the catalog is the
 *                SAME governed rows for every authenticated user (B parity).
 *   provenance — every one of the 50 manifest items serves provenance
 *                `kal_reviewed` (pinned per-item against the manifest
 *                import), and the served member set is EXACTLY the catalog
 *                projection — HD-26: no media key exists anywhere.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { ProblemDetailsBody } from '../../src/problems/problem-details.js';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { applyExerciseCatalogSeed } from '../../prisma/seed-apply.ts';
import { SEED_EXERCISES } from '../../prisma/seed-exercises.ts';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';

/** Fixture-shaped synthetic key material — placeholder-free (I15-compliant). */
const SIGNING_KEY = 'journal4catalog4e2e4fixed4key4material4with4plenty4entropy';

const PASSWORD = 'journal-catalog-e2e-password';
const DEVICE_A = 'device-A-journal-catalog';
const DEVICE_B = 'device-B-journal-catalog';

const USER_AMANY = { email: ['amany', 'example.com'].join('@'), phone: '+201000000041', username: 'amany_cat' };
const USER_BASSEM = { email: ['bassem', 'example.com'].join('@'), phone: '+201000000042', username: 'bassem_cat' };

interface TokenPair {
  accessToken: string;
}

let db: EphemeralKalDb;
let app: INestApplication<App>;

async function bootApp(env: Record<string, string>): Promise<INestApplication<App>> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    const booted = moduleFixture.createNestApplication();
    await booted.init();
    return booted;
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function signup(http: INestApplication<App>, account: { email: string; phone: string; username: string }): Promise<void> {
  await request(http.getHttpServer())
    .post('/identity/signup')
    .send({ ...account, password: PASSWORD })
    .expect(200);
}

async function signin(http: INestApplication<App>, identifier: string, deviceId: string): Promise<TokenPair> {
  const response = await request(http.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', deviceId)
    .send({ identifier, password: PASSWORD })
    .expect(200);
  return response.body as TokenPair;
}

/** Normalizes away the per-request correlation id for byte-level comparisons. */
function normalized(body: ProblemDetailsBody | Record<string, unknown>): string {
  const clone = { ...(body as Record<string, unknown>) };
  delete clone['requestId'];
  return JSON.stringify(clone);
}

interface ExerciseItem {
  readonly id: string;
  readonly provenance: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly aliases: readonly string[];
  readonly instructionsEn: string;
  readonly instructionsAr: string;
  readonly muscleGroups: readonly string[];
  readonly tags: readonly string[];
}

async function searchIds(token: string, q: string, extra: Record<string, string> = {}): Promise<string[]> {
  const response = await request(app.getHttpServer())
    .get('/journal/exercises')
    .set(bearer(token))
    .query({ q, ...extra })
    .expect(200);
  return (response.body as { data: ExerciseItem[] }).data.map((item) => item.id);
}

const EXERCISE_F201 = '00000000-0000-4000-8000-00000000f201';
const EXERCISE_F203 = '00000000-0000-4000-8000-00000000f203';
const EXERCISE_F204 = '00000000-0000-4000-8000-00000000f204';
const EXERCISE_F210 = '00000000-0000-4000-8000-00000000f210';
const EXERCISE_F21D = '00000000-0000-4000-8000-00000000f21d';
const EXERCISE_F228 = '00000000-0000-4000-8000-00000000f228';

let tokenA = '';
let tokenB = '';

beforeAll(async () => {
  db = await createEphemeralKalDb('journal-catalog-e2e');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;

  // Production-faithful catalog seeding: the seed-execution module over an
  // admin connection (the catalog is RLS-declined platform plane; the seed
  // runs like the operator-run seed, not through request-scope code).
  const seedPool = new Pool({ connectionString: url.toString(), max: 2 });
  const seedClient = new PrismaClient({ adapter: new PrismaPg(seedPool, { disposeExternalPool: true }) });
  try {
    const result = await applyExerciseCatalogSeed(seedClient);
    expect(result.exercises).toBe(SEED_EXERCISES.length);
  } finally {
    await seedClient.$disconnect();
  }

  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });

  await signup(app, USER_AMANY);
  await signup(app, USER_BASSEM);
  tokenA = (await signin(app, USER_AMANY.username, DEVICE_A)).accessToken;
  tokenB = (await signin(app, USER_BASSEM.username, DEVICE_B)).accessToken;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('journal.exercises.search — happy paths (w4 note §2)', () => {
  it('finds exercises by EN name, AR name, and dialect alias', async () => {
    expect(await searchIds(tokenA, 'Barbell back squat')).toEqual([EXERCISE_F201]);
    expect(await searchIds(tokenA, 'سكوات بالبار')).toEqual([EXERCISE_F201]);
    expect(await searchIds(tokenA, 'skull crusher')).toEqual(['00000000-0000-4000-8000-00000000f20a']);
  });

  it('serves the §7 rank order: prefix tier before substring, id tiebreak inside a tier', async () => {
    // 'سكوات' prefix-matches f201/f202/f21d/f228 (rank 1) and sits inside
    // 'جوبلت سكوات' (f210, rank 2).
    expect(await searchIds(tokenA, 'سكوات')).toEqual([EXERCISE_F201, '00000000-0000-4000-8000-00000000f202', EXERCISE_F21D, EXERCISE_F228, EXERCISE_F210]);
    // 'bench press': f203 exact (rank 0); f204 ('incline bench press') and
    // f20b ('dumbbell bench press') substring (rank 2), id tiebreak.
    expect(await searchIds(tokenA, 'bench press')).toEqual([EXERCISE_F203, EXERCISE_F204, '00000000-0000-4000-8000-00000000f20b']);
  });

  it('every item carries the full catalog shape (the client-cache payload: names, aliases, instructions, taxonomy)', async () => {
    const response = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'سكوات بالبار' }).expect(200);
    const item = (response.body as { data: ExerciseItem[] }).data[0]!;
    expect(item.id).toBe(EXERCISE_F201);
    expect(item.provenance).toBe('kal_reviewed');
    expect(item.nameEn).toBe('Barbell back squat');
    expect(item.nameAr).toBe('سكوات بالبار');
    expect(item.aliases).toContain('اسكوات');
    expect(item.instructionsEn).toContain('Bar across the upper back');
    expect(item.instructionsAr).toContain('حط البار');
    expect(item.muscleGroups).toEqual(['legs']);
    expect(item.tags).toEqual(['compound', 'barbell']);
  });
});

describe('journal.exercises.get — catalog detail (w4 note §2)', () => {
  it('returns the full AR/EN item with instructions and display taxonomy', async () => {
    const response = await request(app.getHttpServer()).get(`/journal/exercises/${EXERCISE_F201}`).set(bearer(tokenA)).expect(200);
    const exercise = (response.body as { exercise: ExerciseItem }).exercise;
    const manifest = SEED_EXERCISES.find((row) => row.id === EXERCISE_F201)!;
    expect(exercise.id).toBe(manifest.id);
    expect(exercise.provenance).toBe(manifest.provenance);
    expect(exercise.nameEn).toBe(manifest.nameEn);
    expect(exercise.nameAr).toBe(manifest.nameAr);
    expect(exercise.aliases).toEqual([...manifest.aliases]);
    expect(exercise.instructionsEn).toBe(manifest.instructionsEn);
    expect(exercise.instructionsAr).toBe(manifest.instructionsAr);
    expect(exercise.muscleGroups).toEqual([...manifest.muscleGroups]);
    expect(exercise.tags).toEqual([...manifest.tags]);
  });

  it('HD-26 structural pin: the served member set is EXACTLY the catalog projection — no media key', async () => {
    const response = await request(app.getHttpServer()).get(`/journal/exercises/${EXERCISE_F201}`).set(bearer(tokenA)).expect(200);
    const exercise = (response.body as { exercise: Record<string, unknown> }).exercise;
    expect(Object.keys(exercise).sort()).toEqual(
      ['aliases', 'id', 'instructionsAr', 'instructionsEn', 'muscleGroups', 'nameAr', 'nameEn', 'provenance', 'tags'].sort(),
    );
    const searchResponse = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'plank' }).expect(200);
    for (const item of (searchResponse.body as { data: Record<string, unknown>[] }).data) {
      expect(Object.keys(item).sort()).toEqual(
        ['aliases', 'id', 'instructionsAr', 'instructionsEn', 'muscleGroups', 'nameAr', 'nameEn', 'provenance', 'tags'].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Normalization parity — THE HEADLINE CASES (ledger §3 criterion 3)
// ---------------------------------------------------------------------------

describe('journal.exercises.search — normalization parity (w3 §7 REUSED, identical result sets)', () => {
  const equivalenceSets: ReadonlyArray<readonly string[]> = [
    // Hamza/alef family (pipeline step 4): the manifest alias اسكوات with
    // each alef/hamza spelling — identical normalized key.
    ['اسكوات', 'أسكوات', 'إسكوات', 'آسكوات'],
    // Diacritics (step 2) + tatweel (step 3) + whitespace (step 9).
    ['سكوات بالبار', 'سُكوات بالبَار', 'ســكوات بالبار', ' سكوات  بالبار '],
    // Taa marbuta (step 5): ة spelling vs ه spelling (f216's AR name).
    ['رفع سمانة', 'رفع سمانه'],
    // Diacritic + taa-marbuta alias family (f216: سمّانة / سمانه).
    ['سمّانة', 'سمانه', 'سمانة'],
    // Pull-up family: عقلة folds to عقله; the prefix reach includes f21b.
    ['عقلة', 'عُقلة', 'عقله'],
    // Latin case + whitespace (steps 8/9): f203 exact + f204 substring.
    ['bench press', 'BENCH PRESS', ' Bench  Press '],
    // Hamza in a vernacular alias (f219: ضغط أرض folds to ضغط ارض).
    ['ضغط أرض', 'ضغط ارض'],
  ];

  for (const spellings of equivalenceSets) {
    it(`identical result sets for: ${spellings.join(' · ')}`, async () => {
      const baseline = await searchIds(tokenA, spellings[0]!);
      expect(baseline.length).toBeGreaterThan(0);
      for (const spelling of spellings.slice(1)) {
        expect(await searchIds(tokenA, spelling)).toEqual(baseline);
      }
    });
  }

  it('the catalog is public-to-authenticated: B gets the SAME governed rows (no per-user divergence)', async () => {
    for (const q of ['bench press', 'سكوات', 'عقلة']) {
      expect(await searchIds(tokenB, q)).toEqual(await searchIds(tokenA, q));
    }
  });
});

// ---------------------------------------------------------------------------
// Query boundaries (§2)
// ---------------------------------------------------------------------------

describe('journal.exercises.search — query boundaries (§2)', () => {
  it('empty/whitespace-only q ⇒ EMPTY result set, never an error', async () => {
    for (const q of ['', '   ', '\t\u00a0']) {
      const response = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q }).expect(200);
      expect(response.body).toEqual({ data: [], nextCursor: null });
    }
  });

  it('missing q ⇒ 400; q over 80 trimmed chars ⇒ 400 (values never echoed); exactly 80 ⇒ 200', async () => {
    const missing = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).expect(400);
    expect((missing.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
    const long = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'ا'.repeat(81) }).expect(400);
    expect(JSON.stringify(long.body)).not.toContain('ا'.repeat(81));
    const edge = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'ا'.repeat(80) }).expect(200);
    expect(Array.isArray((edge.body as { data: unknown[] }).data)).toBe(true);
  });

  it('limit clamps per conventions §2: non-numeric ⇒ 400; 0 clamps UP to 1 (multi-match query serves exactly one)', async () => {
    await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'سكوات', limit: 'abc' }).expect(400);
    const clampedUp = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'سكوات', limit: '0' }).expect(200);
    expect(((clampedUp.body as { data: unknown[] }).data).length).toBe(1);
  });

  it('limit=500 (clamp ceiling above the 50-item catalog) serves the full match set — the ≤100 bound holds', async () => {
    const ids = await searchIds(tokenA, 'ا', { limit: '500' });
    expect(ids.length).toBeGreaterThan(20);
    expect(ids.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination (conventions §2; drained polarity per amendment-2)
// ---------------------------------------------------------------------------

describe('journal.exercises.search — cursor pagination (conventions §2)', () => {
  it('walks the full match set without loss or duplication; the LAST page serves nextCursor: null', async () => {
    const q = 'ا';
    const baseline = await searchIds(tokenA, q, { limit: '100' });
    expect(baseline.length).toBeGreaterThan(20);

    const seen: string[] = [];
    let cursor: string | null = null;
    let lastBody: { data: ExerciseItem[]; nextCursor: string | null } | null = null;
    for (let page = 0; ; page += 1) {
      const response = await request(app.getHttpServer())
        .get('/journal/exercises')
        .set(bearer(tokenA))
        .query({ q, limit: '7', ...(cursor ? { cursor } : {}) })
        .expect(200);
      lastBody = response.body as { data: ExerciseItem[]; nextCursor: string | null };
      seen.push(...lastBody.data.map((item) => item.id));
      cursor = lastBody.nextCursor;
      if (cursor === null) {
        break;
      }
      expect(page).toBeLessThan(50); // runaway guard — the walk must terminate
    }
    expect(seen).toEqual(baseline);
    expect(new Set(seen).size).toBe(seen.length);
    // The terminal page ALWAYS carries nextCursor: null (amendment-2) —
    // and a 50-row set over limit 7 paginated more than once.
    expect(lastBody!.nextCursor).toBeNull();
    expect(lastBody!.data.length).toBeGreaterThan(0);
  });

  it('a mid-walk page resumes exactly where it stopped (deterministic order, no overlap)', async () => {
    const q = 'ا';
    const first = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q, limit: '3' }).expect(200);
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    expect(cursor).toBeTruthy();
    const second = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q, limit: '3', cursor }).expect(200);
    const firstIds = (first.body as { data: ExerciseItem[] }).data.map((item) => item.id);
    const secondIds = (second.body as { data: ExerciseItem[] }).data.map((item) => item.id);
    expect(secondIds.length).toBe(3);
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative / non-disclosure observables (I7; conventions §1/§2)
// ---------------------------------------------------------------------------

describe('journal cursor — foreign, truncated, and malformed get ONE byte-identical generic 400 (I7)', () => {
  it('B presenting A\'s cursor, a truncated cursor, and garbage get the SAME body', async () => {
    const firstPage = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'ا', limit: '1' }).expect(200);
    const aCursor = (firstPage.body as { nextCursor: string }).nextCursor;
    expect(aCursor).toBeTruthy();

    const foreign = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenB)).query({ q: 'ا', cursor: aCursor }).expect(400);
    const truncated = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenB)).query({ q: 'ا', cursor: `${(aCursor as string).slice(0, -4)}` }).expect(400);
    const malformed = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenB)).query({ q: 'ا', cursor: 'garbage.cursor' }).expect(400);
    const notAString = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenB)).query({ q: 'ا', cursor: '1' }).expect(400);
    expect(normalized(foreign.body)).toBe(normalized(malformed.body));
    expect(normalized(foreign.body)).toBe(normalized(truncated.body));
    expect(normalized(foreign.body)).toBe(normalized(notAString.body));
    expect((foreign.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(foreign.body)).not.toContain((aCursor as string).slice(0, 12)); // the token itself is never echoed
  });

  it('a foreign cursor never yields rows (the 400 is the whole answer)', async () => {
    const firstPage = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenA)).query({ q: 'ا', limit: '1' }).expect(200);
    const aCursor = (firstPage.body as { nextCursor: string }).nextCursor;
    const response = await request(app.getHttpServer()).get('/journal/exercises').set(bearer(tokenB)).query({ q: 'ا', cursor: aCursor }).expect(400);
    expect(response.body).not.toHaveProperty('data');
  });
});

describe('journal auth + 404 — conventions §1 / I7 parity', () => {
  it('unauthenticated search and detail ⇒ 401 UNAUTHENTICATED + WWW-Authenticate: Bearer', async () => {
    const search = await request(app.getHttpServer()).get('/journal/exercises').query({ q: 'squat' }).expect(401);
    expect((search.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
    expect(search.headers['www-authenticate']).toBe('Bearer');
    const detail = await request(app.getHttpServer()).get(`/journal/exercises/${EXERCISE_F201}`).expect(401);
    expect((detail.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
    expect(detail.headers['www-authenticate']).toBe('Bearer');
  });

  it('detail 404 is byte-identical for absent and malformed ids (no existence oracle)', async () => {
    const absent = await request(app.getHttpServer()).get('/journal/exercises/00000000-0000-4000-8000-00000000f299').set(bearer(tokenA)).expect(404);
    const malformed = await request(app.getHttpServer()).get('/journal/exercises/not-a-uuid').set(bearer(tokenA)).expect(404);
    const foreignUser = await request(app.getHttpServer()).get(`/journal/exercises/${EXERCISE_F201}`).set(bearer(tokenB)).expect(200);
    expect(normalized(absent.body)).toBe(normalized(malformed.body));
    expect((absent.body as ProblemDetailsBody).code).toBe('NOT_FOUND');
    // The catalog is public to authenticated users: B CAN read the same row.
    expect((foreignUser.body as { exercise: ExerciseItem }).exercise.id).toBe(EXERCISE_F201);
  });
});

// ---------------------------------------------------------------------------
// Provenance — every catalog row serves kal_reviewed (the manifest value)
// ---------------------------------------------------------------------------

describe('provenance + manifest coverage (pinned per-item against the manifest import)', () => {
  it('ALL 50 manifest items are served, each with provenance kal_reviewed and its manifest names', async () => {
    expect(SEED_EXERCISES.length).toBe(50);
    let served = 0;
    for (const manifest of SEED_EXERCISES) {
      const response = await request(app.getHttpServer()).get(`/journal/exercises/${manifest.id}`).set(bearer(tokenA)).expect(200);
      const exercise = (response.body as { exercise: ExerciseItem }).exercise;
      expect(exercise.provenance, manifest.id).toBe('kal_reviewed');
      expect(exercise.nameEn, manifest.id).toBe(manifest.nameEn);
      expect(exercise.nameAr, manifest.id).toBe(manifest.nameAr);
      served += 1;
    }
    expect(served).toBe(50);
  });

  it('the persisted catalog holds exactly the manifest rows (server-side count — zero extras)', async () => {
    const rows = await adminQuery(db, 'SELECT id::text FROM exercises');
    expect(rows.rowCount).toBe(SEED_EXERCISES.length);
    expect(new Set(rows.rows.map((row) => (row as { id: string }).id))).toEqual(new Set(SEED_EXERCISES.map((exercise) => exercise.id)));
  });
});
