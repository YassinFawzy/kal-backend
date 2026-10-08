/**
 * Kal diary e2e (wave-03, lane s2c-diary) — the real AppModule against a
 * real, fully-migrated, EPHEMERAL PostgreSQL database (the harness pattern:
 * `kal_it_*`, created and dropped by this suite; the dev database never
 * touched).
 *
 * The diary surface is READ-ONLY over HTTP by design (contract §2 freeze:
 * no `POST/PUT/PATCH/DELETE` on any `/diary` path may exist within `w3` —
 * mutations flow exclusively through sync ingestion, I8). Entries are
 * therefore created through the FROZEN §4 seam with a dispatch test double
 * (one postured transaction per batch + the REAL `DiaryEntryOpHandler` —
 * exactly what sync ingestion does at integration), and the day READ is
 * driven over HTTP with real signup/signin bearer tokens:
 *
 *   - `GET /tracking/diary/days/{localDate}` → 200 `{localDate, totals,
 *     entries}`, conforming to the served w3 fixture's bodySchema for
 *     `tracking.diary.day.get` (drift-free: the schema comes from the
 *     fixture document itself).
 *   - A day with no entries is an EMPTY 200 (no 404 for absent days).
 *   - `400` for malformed dates — byte-identical for every cause.
 *   - `401` with the bearer challenge for missing/invalid credentials.
 *   - B's read of a date A has entries for is byte-identical to an empty
 *     day (the day view is per-authenticated-user by construction — no
 *     existence oracle, I7).
 *   - The 23:59-log / 00:01-sync criterion over the read surface.
 *   - Copy-yesterday and recents are CLIENT compositions: no server surface
 *     exists (asserted by absence — generic 404, no mutation success).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { DiaryEntryOpHandler } from '../src/tracking/diary/diary-apply.service.js';
import { ProblemDetailsBody } from '../src/problems/problem-details.js';
import { w3FixturesDocument } from '../src/contracts/w3.fixtures.js';
import { assertConformsToSchema, SchemaNode } from './support/contract-schema.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4diary4lane4fixed4key4material4with4enough4entropy4chars000';

const USER_A = { email: 'diary.e2e.a@example.com', phone: '+201222222221', username: 'diary_e2e_a' };
const USER_B = { email: 'diary.e2e.b@example.com', phone: '+201222222222', username: 'diary_e2e_b' };
const PASSWORD = 'diary-e2e-password';

const DAY = '2026-05-10';
const FOOD_F001 = '00000000-0000-4000-8000-00000000f001';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let prisma: PrismaService;
let handler: DiaryEntryOpHandler;
let tokenA = '';
let tokenB = '';
let userAId = '';
let userBId = '';

async function bootApp(databaseUrl: string): Promise<INestApplication<App>> {
  const previous: Record<string, string | undefined> = {
    DATABASE_URL: process.env['DATABASE_URL'],
    IDENTITY_JWT_SIGNING_KEY: process.env['IDENTITY_JWT_SIGNING_KEY'],
  };
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['IDENTITY_JWT_SIGNING_KEY'] = SIGNING_KEY;
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    const booted = moduleFixture.createNestApplication();
    await booted.init();
    return booted;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Normalizes the per-response correlation id so bodies compare byte-level. */
function normalized(body: ProblemDetailsBody | Record<string, unknown>): string {
  const clone = { ...(body as Record<string, unknown>) };
  delete clone['requestId'];
  return JSON.stringify(clone);
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Real signup → real signin (the identity contract's own surface); the user id comes from the accounts table. */
async function signupSigninAndResolve(user: { email: string; phone: string; username: string }): Promise<{ token: string; userId: string }> {
  await request(app.getHttpServer()).post('/identity/signup').send({ ...user, password: PASSWORD }).expect(200);
  const response = await request(app.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', 'diary-e2e-device')
    .send({ identifier: user.email, password: PASSWORD })
    .expect(200);
  const rows = await db.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [user.email]);
  return { token: (response.body as { accessToken: string }).accessToken, userId: rows.rows[0]!.id };
}

/** The §4 seam dispatch test double — sync's batch posture + the REAL handler. */
function dispatch(op: Record<string, unknown>, userId: string): Promise<unknown> {
  return prisma.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userId}::text, true), set_config('TimeZone', 'UTC', true)`;
    return handler.apply(op as never, { userId, deviceId: 'diary-e2e-device' }, tx);
  });
}

function diaryOp(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: '11111111-1111-4111-8111-000000000001',
    kind: 'diary_entry',
    action: 'create',
    entityId: '11111111-1111-4111-8111-000000000002',
    clientUpdatedAt: '2026-05-10T20:58:00Z',
    localDate: DAY,
    payload: {
      localDate: DAY,
      mealSlot: 'breakfast',
      entryMethod: 'search',
      foodId: FOOD_F001,
      quantity: 2,
      servingLabelEn: 'Bowl',
      servingLabelAr: 'طاسة',
      servingGramWeight: 200,
      energyKcal: 220,
      proteinG: 15.2,
      carbsG: 38.6,
      fatG: 1,
      status: 'confirmed',
      ...payloadOverrides,
    },
    ...overrides,
  };
}

/** The 200 bodySchema for `tracking.diary.day.get`, taken from the served w3 fixture (drift-free). */
function diaryDaySchema(): SchemaNode {
  const entry = w3FixturesDocument().endpoints.find((endpoint) => endpoint.id === 'tracking.diary.day.get');
  const ok = entry?.responses.find((response) => response.status === 200);
  if (ok?.bodySchema === undefined) {
    throw new Error('the w3 fixture must pin the diary day 200 bodySchema');
  }
  return ok.bodySchema;
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('diarye2e');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    // One platform catalog food so the dispatch double's references resolve.
    await db.pool.query(
      `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_ar, name_en_normalized, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
       VALUES ($1, 'dish', 'kal_reviewed', 'proprietary', 'Ful medames', 'فول مدمس', 'ful medames', 'فول مدمس', ARRAY['foul']::text[], ARRAY['foul']::text[], 110, 7.6, 19.3, 0.5)`,
      [FOOD_F001],
    );
    app = await bootApp(url.toString());
    prisma = app.get(PrismaService);
    handler = app.get(DiaryEntryOpHandler);
    ({ token: tokenA, userId: userAId } = await signupSigninAndResolve(USER_A));
    ({ token: tokenB, userId: userBId } = await signupSigninAndResolve(USER_B));
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

// ---------------------------------------------------------------------------

describe('tracking.diary.day.get — the diary READ surface', () => {
  it('create + quick-add through the frozen seam → 200 day view conforming to the w3 fixture schema', async () => {
    const entityId = '11111111-1111-4111-8111-00000000000b';
    await expect(dispatch(diaryOp({ entityId }), userAId)).resolves.toEqual({ outcome: 'applied' });
    const quickAddEntityId = '11111111-1111-4111-8111-00000000000d';
    await expect(
      dispatch(
        diaryOp(
          { opId: '11111111-1111-4111-8111-00000000000c', entityId: quickAddEntityId, clientUpdatedAt: '2026-05-10T21:30:00Z' },
          {
            mealSlot: 'dinner',
            entryMethod: 'quick_add',
            foodId: undefined,
            servingLabelEn: undefined,
            servingLabelAr: undefined,
            servingGramWeight: undefined,
            quantity: 1,
            energyKcal: 350,
            proteinG: 0,
            carbsG: 0,
            fatG: 12,
          },
        ),
        userAId,
      ),
    ).resolves.toEqual({ outcome: 'applied' });

    const response = await request(app.getHttpServer()).get(`/tracking/diary/days/${DAY}`).set(bearer(tokenA)).expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    assertConformsToSchema(response.body, diaryDaySchema(), 'diary.day.200');
    const body = response.body as {
      localDate: string;
      totals: { energyKcal: number; proteinG: number; carbsG: number; fatG: number; entryCount: number };
      entries: Array<Record<string, unknown>>;
    };
    expect(body.localDate).toBe(DAY);
    expect(body.entries).toHaveLength(2);
    expect(body.totals).toEqual({ energyKcal: 570, proteinG: 15.2, carbsG: 38.6, fatG: 13, entryCount: 2 });
    const first = body.entries[0]!;
    expect(first).toMatchObject({ id: entityId, mealSlot: 'breakfast', entryMethod: 'search', sourceKind: 'platform_food', quantity: 2 });
    const quickAdd = body.entries.find((entry) => entry['entryMethod'] === 'quick_add');
    expect(quickAdd).toMatchObject({ sourceKind: 'quick_add', foodId: null, servingGramWeight: null });
  });

  it('a day with no entries is an EMPTY 200 (a date is not an object — never a 404)', async () => {
    const response = await request(app.getHttpServer()).get('/tracking/diary/days/2026-05-11').set(bearer(tokenA)).expect(200);
    expect(response.body).toEqual({
      localDate: '2026-05-11',
      totals: { energyKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entryCount: 0 },
      entries: [],
    });
  });

  it('malformed dates → the generic 400, byte-identical for every cause (no values echoed)', async () => {
    const cases = ['/tracking/diary/days/not-a-date', '/tracking/diary/days/2026-02-30', '/tracking/diary/days/2026-1-15', '/tracking/diary/days/20260510'];
    let reference: string | undefined;
    for (const path of cases) {
      const response = await request(app.getHttpServer()).get(path).set(bearer(tokenA)).expect(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const body = normalized(response.body);
      reference ??= body;
      expect(body).toBe(reference);
      expect((response.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
    }
  });

  it('missing and invalid credentials → 401 with the bearer challenge (byte-identical refusal)', async () => {
    const missing = await request(app.getHttpServer()).get(`/tracking/diary/days/${DAY}`).expect(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    const invalid = await request(app.getHttpServer()).get(`/tracking/diary/days/${DAY}`).set(bearer('not-a-real-token')).expect(401);
    expect(invalid.headers['www-authenticate']).toBe('Bearer');
    expect(normalized(invalid.body)).toBe(normalized(missing.body));
    expect((invalid.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
  });

  it('B\u2019s read of a date A has entries for is byte-identical to an empty day (no existence oracle, I7)', async () => {
    const bView = await request(app.getHttpServer()).get(`/tracking/diary/days/${DAY}`).set(bearer(tokenB)).expect(200);
    const emptyControl = await request(app.getHttpServer()).get('/tracking/diary/days/2026-05-12').set(bearer(tokenB)).expect(200);
    expect(bView.body.entries).toEqual([]);
    const strip = (body: Record<string, unknown>): string => JSON.stringify({ ...body, localDate: '<date>' });
    expect(strip(bView.body as Record<string, unknown>)).toBe(strip(emptyControl.body as Record<string, unknown>));
  });

  it('23:59 log / 00:01 sync: the entry stays on the ORIGINAL carried day over the read surface', async () => {
    const lateOp = diaryOp({
      opId: '11111111-1111-4111-8111-00000000000e',
      entityId: '11111111-1111-4111-8111-00000000000f',
      clientUpdatedAt: '2026-05-11T00:01:00Z', // synced after Cairo midnight
    });
    await expect(dispatch(lateOp, userAId)).resolves.toEqual({ outcome: 'applied' });
    const carriedDay = await request(app.getHttpServer()).get(`/tracking/diary/days/${DAY}`).set(bearer(tokenA)).expect(200);
    expect((carriedDay.body as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toContain(lateOp.entityId);
    const nextDay = await request(app.getHttpServer()).get('/tracking/diary/days/2026-05-11').set(bearer(tokenA)).expect(200);
    expect((nextDay.body as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).not.toContain(lateOp.entityId);
    expect(userBId).not.toBe(userAId); // the two contexts are genuinely distinct
  });
});

describe('the §2 freeze: no diary mutation surface, no recents/copy-yesterday endpoints', () => {
  it('every mutation method on the diary day path is refused generically (diary mutations are sync-ops ONLY, I8)', async () => {
    const path = `/tracking/diary/days/${DAY}`;
    const payload = { mealSlot: 'breakfast', energyKcal: 100 };
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app.getHttpServer())[method](path).set(bearer(tokenA)).send(payload);
      expect(response.status, `${method} /tracking/diary/days must not exist`).toBe(404);
      expect((response.body as ProblemDetailsBody).code).toBe('NOT_FOUND');
    }
    // Nothing was mutated: A's day is unchanged.
    const after = await request(app.getHttpServer()).get(path).set(bearer(tokenA)).expect(200);
    expect((after.body as { totals: { entryCount: number } }).totals.entryCount).toBe(3);
  });

  it('recents and copy-yesterday have NO server surface (client compositions — asserted by absence)', async () => {
    for (const path of ['/tracking/diary/recents', `/tracking/diary/days/${DAY}/copy-yesterday`, '/tracking/diary/days']) {
      const response = await request(app.getHttpServer()).get(path).set(bearer(tokenA));
      expect(response.status, `${path} must not exist`).toBe(404);
      expect((response.body as ProblemDetailsBody).code).toBe('NOT_FOUND');
    }
  });
});
