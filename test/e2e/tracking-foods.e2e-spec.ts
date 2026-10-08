/**
 * Kal API e2e — the tracking foods surface (wave-03 contract §2; lane s2a).
 *
 * Boots the real AppModule against an EPHEMERAL database (the identity-e2e
 * harness pattern), seeds the curated core pack the production-faithful way
 * (the seed-execution module over the admin connection), and proves:
 *
 *   happy      — golden search equivalence over the seed + own user foods
 *                (contract §7 rows + amendment-1 alias-mediated shawarma
 *                pair), serving-variant gram resolution, the barcode
 *                resolution ORDER (platform cache → OFF fixture → not_found,
 *                first-resolution-wins caching), REST user-food create
 *                (201, immediately searchable), cursor pagination.
 *   negative   — byte-identical 404 for absent/malformed/foreign catalog
 *                lookups (I7), B cannot locate/enumerate A's user foods by
 *                search (empty-set parity) or by detail id, generic
 *                barcode not_found, invalid payloads 400 without echoed
 *                values, 401s, foreign-cursor 400 byte-identical, q-boundary
 *                rules (empty q ⇒ 200 empty set — never an error).
 *   rate limit — the shared limiter's REST path: two-config proofs for BOTH
 *                windows (hourly and daily, W2-lockout-proof style): 429 +
 *                server-computed Retry-After over-limit, no food consumed.
 *
 * Sync-op ingestion transport belongs to s2d/s2e; seam-level apply/delta
 * proofs (including the sync-path limiter outcomes) live in the integration
 * suite against the frozen seam interfaces.
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
import { applyFoodCatalogSeed } from '../../prisma/seed-apply.ts';
import { SEED_FOODS } from '../../prisma/seed-manifest.ts';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';

/** Fixture-shaped synthetic key material — placeholder-free (I15-compliant). */
const SIGNING_KEY = 'tracking4e2e4lane4fixed4key4material4with4plenty4entropy0';

const PASSWORD = 'tracking-e2e-password';
const DEVICE_A = 'device-A-tracking';
const DEVICE_B = 'device-B-tracking';

const USER_AMANY = { email: ['amany', 'example.com'].join('@'), phone: '+201000000011', username: 'amany' };
const USER_BASSEM = { email: ['bassem', 'example.com'].join('@'), phone: '+201000000022', username: 'bassem' };

interface TokenPair {
  accessToken: string;
}

let db: EphemeralKalDb;
let databaseUrl = '';
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

async function signup(http: INestApplication<App>, user: { email: string; phone: string; username: string }): Promise<void> {
  await request(http.getHttpServer()).post('/identity/signup').send({ ...user, password: PASSWORD }).expect(200);
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

interface FoodItem {
  readonly id: string;
  readonly type: string;
  readonly provenance: string;
  readonly nameEn: string | null;
  readonly nameAr: string | null;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
}

async function searchIds(token: string, q: string): Promise<string[]> {
  const response = await request(app.getHttpServer())
    .get('/tracking/foods')
    .set(bearer(token))
    .query({ q })
    .expect(200);
  return (response.body as { data: FoodItem[] }).data.map((item) => item.id);
}

let tokenA = '';
let tokenB = '';
let amanyUserFoodId = '';
let amanyFulFoodId = '';

beforeAll(async () => {
  db = await createEphemeralKalDb('trk-foods');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  databaseUrl = url.toString();

  // Production-faithful catalog seeding: the seed-execution module over an
  // admin connection (the catalog is RLS-declined platform plane; the seed
  // runs like the operator-run seed, not through request-scope code).
  const seedPool = new Pool({ connectionString: databaseUrl, max: 2 });
  // disposeExternalPool: the adapter ends OUR pool on $disconnect — no
  // second end() here (pg-pool refuses double disposal).
  const seedClient = new PrismaClient({ adapter: new PrismaPg(seedPool, { disposeExternalPool: true }) });
  const result = await applyFoodCatalogSeed(seedClient);
  expect(result.foods).toBe(SEED_FOODS.length);
  await seedClient.$disconnect();

  app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });

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

describe('tracking.foods.search — golden equivalence over seed + own user foods (§7, amendment 1)', () => {
  let userFoodFulId = '';
  beforeAll(async () => {
    // A's own foods join the golden sets: a كشري2-labeled food (digit-fold row)
    // and two فول foods (for pagination + ownership equivalence).
    const first = await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({ nameAr: 'كشري2', energyKcal: 300, proteinG: 8, carbsG: 55, fatG: 3 })
      .expect(201);
    amanyUserFoodId = (first.body as { userFood: { id: string } }).userFood.id;
    const fulA = await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({ nameEn: 'Amany ful special', nameAr: 'فول خاص اماني', energyKcal: 120, proteinG: 8, carbsG: 18, fatG: 1 })
      .expect(201);
    userFoodFulId = (fulA.body as { userFood: { id: string } }).userFood.id;
    amanyFulFoodId = userFoodFulId;
    await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({ nameEn: 'Amany ful with oil', nameAr: 'فول خاص اماني بالزيت', energyKcal: 160, proteinG: 8, carbsG: 18, fatG: 6 })
      .expect(201);
  });

  const equivalanceSets: ReadonlyArray<readonly string[]> = [
    ['طعمية', 'طعميه', 'طَعْمِيَّة', 'طــعمية', 'taameya', 'TAAMEYA'],
    ['أرز', 'إرز', 'اَرز'],
    ['كشري', 'كشرى'],
    ['فول مدمس', 'فول  مدمس ', ' فول\u200f مدمس\u200f'],
    ['كشري٢', 'كشري2'],
    // Amendment 1: شاورما / شاورمة are DISTINCT keys — the cross-spelling
    // equivalence is DATA-CARRIED by the f00d/f00e aliases (شاورمه forms).
    ['شاورما', 'شاورمة'],
  ];

  for (const spellings of equivalanceSets) {
    it(`identical result sets for: ${spellings.join(' · ')}`, async () => {
      const baseline = await searchIds(tokenA, spellings[0]!);
      expect(baseline.length).toBeGreaterThan(0);
      for (const spelling of spellings.slice(1)) {
        expect(await searchIds(tokenA, spelling)).toEqual(baseline);
      }
    });
  }

  it('طعمية family surfaces the seeded Taameya row; alias spellings (falafel) hit exactly', async () => {
    const ids = await searchIds(tokenA, 'طعمية');
    expect(ids).toContain('00000000-0000-4000-8000-00000000f002');
    expect(await searchIds(tokenA, 'falafel')).toContain('00000000-0000-4000-8000-00000000f002');
  });

  it('the shawarma pair surfaces BOTH f00d and f00e for both spellings (alias-mediated)', async () => {
    for (const spelling of ['شاورما', 'شاورمة']) {
      const ids = await searchIds(tokenA, spelling);
      expect(ids).toContain('00000000-0000-4000-8000-00000000f00d');
      expect(ids).toContain('00000000-0000-4000-8000-00000000f00e');
    }
  });

  it('every result item carries its provenance tier (FR-011) — platform and user rows alike', async () => {
    const response = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'ful' }).expect(200);
    const items = (response.body as { data: FoodItem[] }).data;
    for (const item of items) {
      expect(['kal_reviewed', 'imported', 'user_created']).toContain(item.provenance);
    }
    expect(items.find((item) => item.id === userFoodFulId)?.provenance).toBe('user_created');
  });

  it('an owner-created user food is immediately searchable by its owner (REST create → search)', async () => {
    expect(await searchIds(tokenA, 'كشري2')).toContain(amanyUserFoodId);
  });
});

describe('tracking.foods.search — query boundaries (§2)', () => {
  it('empty/whitespace-only q ⇒ EMPTY result set, never an error', async () => {
    for (const q of ['', '   ', '\t\u00a0']) {
      const response = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q }).expect(200);
      expect(response.body).toEqual({ data: [], nextCursor: null });
    }
  });

  it('missing q ⇒ 400; q over 80 trimmed chars ⇒ 400 (values never echoed)', async () => {
    const missing = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).expect(400);
    expect((missing.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
    const long = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'a'.repeat(81) }).expect(400);
    expect(JSON.stringify(long.body)).not.toContain('a'.repeat(81));
    const edge = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'a'.repeat(80) }).expect(200);
    expect(Array.isArray((edge.body as { data: unknown[] }).data)).toBe(true);
  });

  it('limit clamps 1–100 (conventions §2); non-numeric limit ⇒ 400', async () => {
    await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'ful', limit: '500' }).expect(200);
    await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'ful', limit: 'abc' }).expect(400);
  });
});

describe('tracking.foods.search — cursor pagination (conventions §2)', () => {
  it('walking nextCursor yields every match exactly once, ending at null', async () => {
    const all = await searchIds(tokenA, 'فول');
    expect(all.length).toBeGreaterThanOrEqual(3); // f001 + two Amany فول foods
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 25; page += 1) {
      const requestBuilder = request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'فول', limit: '2', ...(cursor ? { cursor } : {}) });
      const response = await requestBuilder.expect(200);
      const body = response.body as { data: FoodItem[]; nextCursor: string | null };
      seen.push(...body.data.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(all);
  });

  it('pagination is deterministic — the same query repeats the same pages', async () => {
    const first = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'فول', limit: '1' }).expect(200);
    const second = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'فول', limit: '1' }).expect(200);
    expect(first.body).toEqual(second.body);
  });
});

describe('tracking.foods.get — catalog detail', () => {
  it('serving variants resolve gram weights (FR-012) with the preselected default first', async () => {
    const response = await request(app.getHttpServer())
      .get('/tracking/foods/00000000-0000-4000-8000-00000000f001')
      .set(bearer(tokenA))
      .expect(200);
    const body = response.body as { food: FoodItem; servingVariants: { id: string; labelEn: string; labelAr: string | null; grams: number; isDefault: boolean }[] };
    expect(body.food.provenance).toBe('kal_reviewed');
    expect(body.food.licensePartition).toBe('proprietary');
    expect(body.servingVariants[0]).toMatchObject({ labelEn: 'Bowl', labelAr: 'طاسة', grams: 200, isDefault: true });
    expect(body.servingVariants.map((variant) => variant.grams)).toEqual([200, 150]);
  });

  it('404 NOT_FOUND is byte-identical for absent, malformed, and foreign ids (I7)', async () => {
    const absent = await request(app.getHttpServer()).get('/tracking/foods/00000000-0000-4000-8000-000000009999').set(bearer(tokenA)).expect(404);
    const malformed = await request(app.getHttpServer()).get('/tracking/foods/not-a-uuid').set(bearer(tokenA)).expect(404);
    const foreign = await request(app.getHttpServer()).get(`/tracking/foods/${amanyUserFoodId}`).set(bearer(tokenB)).expect(404);
    // A's OWN user-food id is also NOT a catalog row: same generic 404.
    const ownUserFood = await request(app.getHttpServer()).get(`/tracking/foods/${amanyUserFoodId}`).set(bearer(tokenA)).expect(404);
    expect(normalized(absent.body)).toBe(normalized(malformed.body));
    expect(normalized(absent.body)).toBe(normalized(foreign.body));
    expect(normalized(absent.body)).toBe(normalized(ownUserFood.body));
  });
});

describe('tracking.barcode.resolve — the frozen pipeline order (FR-017)', () => {
  const OFF_BARCODE = '200000000001'; // recorded dev fixture
  const MISS_BARCODE = '299999999999'; // recorded nowhere

  it('adapter hit ⇒ success-shaped resolved with imported/odbl provenance and attribution carrier', async () => {
    const response = await request(app.getHttpServer()).get(`/tracking/barcode/${OFF_BARCODE}`).set(bearer(tokenA)).expect(200);
    const body = response.body as { result: string; food?: FoodItem & { servingVariants: { grams: number }[] } };
    expect(body.result).toBe('resolved');
    expect(body.food?.provenance).toBe('imported');
    expect(body.food?.licensePartition).toBe('odbl');
    expect(body.food?.servingVariants?.[0]?.grams).toBe(330);
  });

  it('the hit is cached: the SECOND resolution is identical (first resolution wins)', async () => {
    const first = await request(app.getHttpServer()).get(`/tracking/barcode/${OFF_BARCODE}`).set(bearer(tokenA)).expect(200);
    const second = await request(app.getHttpServer()).get(`/tracking/barcode/${OFF_BARCODE}`).set(bearer(tokenB)).expect(200);
    expect(second.body).toEqual(first.body);
  });

  it('platform-cache-first: a seeded packaged barcode resolves from the CATALOG with kal partition, then warms the cache', async () => {
    // Production-faithful fixture: catalog rows arrive via the operator seed
    // path (the catalog is platform-authored, kal_app has SELECT only).
    const catalogBarcode = '200000000777';
    await adminQuery(
      db,
      `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized, name_ar, name_ar_normalized,
         aliases, aliases_normalized, barcode, energy_kcal, protein_g, carbs_g, fat_g)
       VALUES ('00000000-0000-4000-8000-00000000bb01', 'packaged', 'kal_reviewed', 'proprietary',
         'Fixture boxed ful', 'fixture boxed ful', 'فول معلب', 'فول معلب',
         ARRAY['boxed ful']::text[], ARRAY['boxed ful']::text[], $1, 110, 7, 18, 0.5)`,
      [catalogBarcode],
    );
    const first = await request(app.getHttpServer()).get(`/tracking/barcode/${catalogBarcode}`).set(bearer(tokenA)).expect(200);
    const body = first.body as { result: string; food?: FoodItem };
    expect(body.result).toBe('resolved');
    expect(body.food?.id).toBe('00000000-0000-4000-8000-00000000bb01');
    expect(body.food?.licensePartition).toBe('proprietary');
    // Cache warmed: a second resolve hits the cache row and resolves identically.
    const second = await request(app.getHttpServer()).get(`/tracking/barcode/${catalogBarcode}`).set(bearer(tokenB)).expect(200);
    expect(second.body).toEqual(first.body);
  });

  it('miss ⇒ success-shaped not_found (the guided label-create entry point), never an error', async () => {
    const response = await request(app.getHttpServer()).get(`/tracking/barcode/${MISS_BARCODE}`).set(bearer(tokenA)).expect(200);
    expect(response.body).toEqual({ result: 'not_found' });
  });

  it('malformed barcode ⇒ 400 VALIDATION_FAILED', async () => {
    await request(app.getHttpServer()).get('/tracking/barcode/abc').set(bearer(tokenA)).expect(400);
    await request(app.getHttpServer()).get('/tracking/barcode/123').set(bearer(tokenA)).expect(400);
  });
});

// ---------------------------------------------------------------------------
// Negative / isolation
// ---------------------------------------------------------------------------

describe('non-disclosure — A/B search isolation (I7)', () => {
  it('B never locates A\'s user foods by search — empty-set parity with a nonsense query', async () => {
    const bSeesAmany = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenB)).query({ q: 'اماني' }).expect(200);
    const bNonsense = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenB)).query({ q: 'zzz_no_such_food_zzz' }).expect(200);
    expect((bSeesAmany.body as { data: unknown[] }).data).toEqual([]);
    expect(normalized(bSeesAmany.body)).toBe(normalized(bNonsense.body));
  });

  it('A\'s own search carries A\'s foods; the OWNER sees exactly their own rows', async () => {
    const aSeesOwn = await searchIds(tokenA, 'اماني');
    expect(aSeesOwn.length).toBe(2); // both Amany فول foods
    expect(aSeesOwn).toContain(amanyFulFoodId);
  });
});

describe('foreign cursor — byte-identical generic 400, never rows (I7, conventions §2)', () => {
  it('B presenting A\'s cursor, and any malformed cursor, get ONE identical body', async () => {
    const firstPage = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenA)).query({ q: 'ful', limit: '1' }).expect(200);
    const aCursor = (firstPage.body as { nextCursor: string | null }).nextCursor;
    expect(aCursor).not.toBeNull();
    const foreign = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenB)).query({ q: 'ful', cursor: aCursor }).expect(400);
    const malformed = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenB)).query({ q: 'ful', cursor: 'garbage.cursor' }).expect(400);
    const truncated = await request(app.getHttpServer()).get('/tracking/foods').set(bearer(tokenB)).query({ q: 'ful', cursor: 'abc' }).expect(400);
    expect(normalized(foreign.body)).toBe(normalized(malformed.body));
    expect(normalized(foreign.body)).toBe(normalized(truncated.body));
    expect((foreign.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
  });
});

describe('tracking.user-foods.create — validation', () => {
  it('invalid payloads ⇒ 400 VALIDATION_FAILED with structural field paths, values never echoed', async () => {
    const response = await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({ nameAr: '', energyKcal: -5, servings: [{ grams: 0 }] })
      .expect(400);
    const body = response.body as ProblemDetailsBody & { errors: { field: string }[] };
    expect(body.code).toBe('VALIDATION_FAILED');
    const fields = body.errors.map((error) => error.field);
    expect(fields).toContain('energyKcal');
    expect(JSON.stringify(body)).not.toContain('-5');
  });

  it('macronutrient snapshot round-trips exactly (per-100 g, number serialization)', async () => {
    const response = await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({
        nameEn: 'Precision check food',
        nameAr: 'طعام فحص الدقة',
        energyKcal: 123.45,
        proteinG: 1.234,
        carbsG: 12.345,
        fatG: 4.321,
        servings: [{ labelEn: 'Cup', labelAr: 'كوب', grams: 120 }],
      })
      .expect(201);
    const userFood = (response.body as { userFood: FoodItem & { servings: { grams: number }[]; updatedAt: string } }).userFood;
    expect(userFood.energyKcal).toBe(123.45);
    expect(userFood.proteinG).toBe(1.234);
    expect(userFood.carbsG).toBe(12.345);
    expect(userFood.fatG).toBe(4.321);
    expect(userFood.provenance).toBe('user_created');
    expect(userFood.servings.map((serving) => serving.grams)).toEqual([120]);
  });

  it('two servings ⇒ 400 — the schema allows exactly one ACTIVE serving per user food', async () => {
    const response = await request(app.getHttpServer())
      .post('/tracking/user-foods')
      .set(bearer(tokenA))
      .send({
        nameEn: 'Two-serving probe',
        energyKcal: 100,
        proteinG: 1,
        carbsG: 10,
        fatG: 1,
        servings: [{ grams: 100 }, { grams: 50 }],
      })
      .expect(400);
    expect((response.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
  });
});

describe('authentication — 401 UNAUTHENTICATED on every surface (conventions §1)', () => {
  it('search/detail/barcode/create refuse unauthenticated callers with the challenge header', async () => {
    const http = app.getHttpServer();
    const search = await request(http).get('/tracking/foods').query({ q: 'ful' }).expect(401);
    expect(search.headers['www-authenticate']).toBe('Bearer');
    expect((search.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');

    const detail = await request(http).get('/tracking/foods/00000000-0000-4000-8000-00000000f001').expect(401);
    expect(detail.headers['www-authenticate']).toBe('Bearer');

    const barcode = await request(http).get('/tracking/barcode/200000000001').expect(401);
    expect(barcode.headers['www-authenticate']).toBe('Bearer');

    const create = await request(http)
      .post('/tracking/user-foods')
      .send({ nameEn: 'x', energyKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 })
      .expect(401);
    expect(create.headers['www-authenticate']).toBe('Bearer');
  });
});

// ---------------------------------------------------------------------------
// Shared limiter — REST path, two-config proofs (PRD §8; §1.7; W2-lockout style)
// ---------------------------------------------------------------------------

describe('the shared user-food create limiter (REST path)', () => {
  it('hourly window: two-config proof — cap 2 trips on the 3rd create with hourly Retry-After', async () => {
    const limited = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '2',
      TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '100',
    });
    try {
      await signup(limited, { email: ['hourly', 'example.com'].join('@'), phone: '+201000000033', username: 'hourly_cap' });
      const token = (await signin(limited, 'hourly_cap', 'device-hourly')).accessToken;
      const payload = { nameEn: 'Rate probe', energyKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 };
      await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(201);
      await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(201);
      const third = await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(429);
      expect((third.body as ProblemDetailsBody).code).toBe('RATE_LIMITED');
      const retryAfter = Number(third.headers['retry-after']);
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(3600); // hourly window arithmetic, server-computed
      // Over-limit consumed nothing: exactly two foods exist for the account.
      const search = await request(limited.getHttpServer()).get('/tracking/foods').set(bearer(token)).query({ q: 'Rate probe' }).expect(200);
      expect((search.body as { data: unknown[] }).data).toHaveLength(2);
    } finally {
      await limited.close();
    }
  }, 120_000);

  it('daily window: two-config proof — cap 2 trips on the 3rd create with DAILY Retry-After', async () => {
    const limited = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '100',
      TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '2',
    });
    try {
      await signup(limited, { email: ['daily', 'example.com'].join('@'), phone: '+201000000044', username: 'daily_cap' });
      const token = (await signin(limited, 'daily_cap', 'device-daily')).accessToken;
      const payload = { nameEn: 'Daily probe', energyKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 };
      await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(201);
      await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(201);
      const third = await request(limited.getHttpServer()).post('/tracking/user-foods').set(bearer(token)).send(payload).expect(429);
      expect((third.body as ProblemDetailsBody).code).toBe('RATE_LIMITED');
      const retryAfter = Number(third.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(3600); // only the 24 h window is exhausted
      expect(retryAfter).toBeLessThanOrEqual(86_400);
    } finally {
      await limited.close();
    }
  }, 120_000);
});
