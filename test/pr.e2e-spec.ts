/**
 * Kal — journal PR read e2e (wave-04, lane s2c) — the real AppModule against
 * a real, fully-migrated, EPHEMERAL PostgreSQL database (the harness
 * pattern: `kal_it_*`, created and dropped by this suite; the dev database
 * never touched).
 *
 * The pinned surface is the frozen `journal.exercises.pr.get` read endpoint:
 * `GET /journal/exercises/{exerciseId}/pr` (auth: bearer) → `200 {result,
 * pr?}` · `401` · `404 NOT_FOUND`. Journal mutations do NOT exist over HTTP
 * (the §2 freeze), so sessions are seeded as APPLIED rows (lane s2a owns
 * the session op surface; the post-rebase union suite drives sessions
 * through the real ingestion path) and every assertion runs over HTTP with
 * real signup/signin bearer tokens:
 *
 *   - `401` for missing/invalid credentials.
 *   - `404` byte-identical for malformed ≡ absent catalog ids (no existence
 *     oracle, §3) — compared on raw bytes with only the correlation id
 *     normalized (the W2 raw-byte method).
 *   - `200 {result:"none"}` — the success-shaped empty state for a catalog
 *     row with no qualifying sets; byte-identical across users with no
 *     rows (the C-parity shape proves denials are authorization-driven).
 *   - `200 {result:"pr"}` with the EXACT derived body: 100 kg × 8 →
 *     estimatedOneRepMaxKg 126.67 (Epley), the sourceSet locator, and
 *     achievedOn = the winning session's client-local date; conforming to
 *     the served w4 fixture's bodySchema (drift-free).
 *   - Tombstone honesty: tombstoning the winning session moves the PR to
 *     the next-best applied set (derived-never-stored — no rollup to
 *     invalidate).
 *   - Owning-user-only (I7): B's PR over the same exercise is B's OWN data
 *     only — never any A row.
 *   - No journal mutation route exists (asserted by absence — generic 404,
 *     method-not-allowed posture of the read-only surface).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w4FixturesDocument } from '../src/contracts/w4.fixtures.js';
import { assertConformsToSchema, SchemaNode } from './support/contract-schema.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';
import type { W2EndpointFixture, W2SchemaSubset } from '../src/contracts/w2.fixtures.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4journal4lane4fixed4key4material4with4enough4entropy4000';

const USER_A = { email: 'pr.e2e.a@example.com', phone: '+201223300001', username: 'pr_e2e_a' };
const USER_B = { email: 'pr.e2e.b@example.com', phone: '+201223300002', username: 'pr_e2e_b' };
const PASSWORD = 'pr-e2e-password';

/** Synthetic platform catalog rows (OUTSIDE the seed manifest's reserved …f2nn range). */
const EX_SQUAT = '00000000-0000-4000-8000-00000000f911';
const ABSENT_EXERCISE = '00000000-0000-4000-8000-00000000f999';

/** A's applied sessions (seeded rows; s2a owns the session op surface). */
const S1 = 'c1110000-0000-4000-8000-000000000001'; // 2026-03-01 — 100 kg × 8 (the 126.67 winner)
const S2 = 'c1110000-0000-4000-8000-000000000002'; // 2026-03-05 — 90 kg × 9 (next best after S1 dies)
const E1A = 'd1110000-0000-4000-8000-000000000001';
const E1B = 'd1110000-0000-4000-8000-000000000002';
const SET_A = 'e1110000-0000-4000-8000-000000000001';
const SET_B = 'e1110000-0000-4000-8000-000000000002';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let tokenA = '';
let tokenB = '';
let prFixture: { responses: { status: number; bodySchema?: W2SchemaSubset }[] };

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Normalizes the per-response correlation id so bodies compare byte-level. */
function normalized(body: Record<string, unknown>): string {
  const clone = { ...body };
  delete clone['requestId'];
  return JSON.stringify(clone);
}

async function seedSession(
  userId: string,
  sessionId: string,
  localDate: string,
  entryId: string,
  setId: string,
  weightKg: number,
  reps: number,
): Promise<void> {
  await db.pool.query(
    `INSERT INTO journal_sessions (id, user_id, local_date, title, updated_at, deleted_at)
     VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)`,
    [sessionId, userId, localDate, `${localDate}T20:00:00Z`],
  );
  await db.pool.query(
    `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, position, name_snapshot_en, name_snapshot_ar)
     VALUES ($1, $2, $3, $4, 0, 'Seed Squat', 'سكوات تجريبي')`,
    [entryId, sessionId, userId, EX_SQUAT],
  );
  await db.pool.query(
    `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps)
     VALUES ($1, $2, $3, 0, 'weighted', $4, $5)`,
    [setId, entryId, userId, weightKg, reps],
  );
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('s2cpr');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const previous = { DATABASE_URL: process.env['DATABASE_URL'], IDENTITY_JWT_SIGNING_KEY: process.env['IDENTITY_JWT_SIGNING_KEY'] };
    process.env['DATABASE_URL'] = url.toString();
    process.env['IDENTITY_JWT_SIGNING_KEY'] = SIGNING_KEY;
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(READINESS_CHECKS)
        .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
        .compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    // Seed: the platform catalog exercise (admin INSERT — seeding only).
    // The two consumers are created through the REAL identity flow below;
    // their server-side ids are resolved from the accounts table (never
    // assumed) so the seeded sessions bind the verified owner.
    await db.pool.query(
      `INSERT INTO exercises (id, name_en, name_ar, name_en_normalized, name_ar_normalized, aliases, aliases_normalized,
         instructions_en, instructions_ar, muscle_groups, tags, provenance)
       VALUES ($1, 'Fixture Squat', 'سكوات تجريبي', 'fixture squat', 'سكوات تجريبي', ARRAY[]::text[], ARRAY[]::text[],
         'Seed instructions.', 'تعليمات تجريبية.', ARRAY['legs']::text[], ARRAY[]::text[], 'kal_reviewed')`,
      [EX_SQUAT],
    );

    // Real signup → real signin (the identity contract's own surface).
    await request(app.getHttpServer()).post('/identity/signup').send({ ...USER_A, password: PASSWORD }).expect(200);
    const signinA = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', 'pr-e2e-device-a')
      .send({ identifier: USER_A.email, password: PASSWORD })
      .expect(200);
    tokenA = (signinA.body as { accessToken: string }).accessToken;
    await request(app.getHttpServer()).post('/identity/signup').send({ ...USER_B, password: PASSWORD }).expect(200);
    const signinB = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', 'pr-e2e-device-b')
      .send({ identifier: USER_B.email, password: PASSWORD })
      .expect(200);
    tokenB = (signinB.body as { accessToken: string }).accessToken;
    const accounts = await db.pool.query<{ id: string; username: string }>('SELECT id::text AS id, username FROM users WHERE username = ANY($1)', [
      [USER_A.username, USER_B.username],
    ]);
    const idByUsername = new Map(accounts.rows.map((row) => [row.username, row.id]));
    const userAId = idByUsername.get(USER_A.username) as string;
    expect(userAId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    // A's applied sessions (seeded rows; s2a owns the session op surface).
    // 100×8 → 126.67 (winner); 90×9 → 117.00 (next best).
    await seedSession(userAId, S1, '2026-03-01', E1A, SET_A, 100, 8);
    await seedSession(userAId, S2, '2026-03-05', E1B, SET_B, 90, 9);

    // The served w4 fixture entry for this endpoint (drift-free shape checks).
    const document = w4FixturesDocument();
    const entry = document.endpoints.find((candidate): candidate is W2EndpointFixture =>
      (candidate as { id?: string }).id === 'journal.exercises.pr.get',
    ) as unknown as { responses: { status: number; bodySchema?: W2SchemaSubset }[] };
    prFixture = { responses: entry.responses };
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

function schemaFor(status: number): SchemaNode | undefined {
  return prFixture.responses.find((response) => response.status === status)?.bodySchema as SchemaNode | undefined;
}

// ---------------------------------------------------------------------------

describe('journal.exercises.pr.get — the frozen read surface', () => {
  it('401 for missing and invalid credentials (with the registry envelope)', async () => {
    const noAuth = await request(app.getHttpServer()).get(`/journal/exercises/${EX_SQUAT}/pr`).expect(401);
    expect((noAuth.body as { code?: string }).code).toBe('UNAUTHENTICATED');
    const badAuth = await request(app.getHttpServer())
      .get(`/journal/exercises/${EX_SQUAT}/pr`)
      .set('Authorization', 'Bearer not-a-token')
      .expect(401);
    expect((badAuth.body as { code?: string }).code).toBe('UNAUTHENTICATED');
    const schema = schemaFor(401);
    if (schema !== undefined) {
      assertConformsToSchema(badAuth.body, schema, '401');
    }
  });

  it('404 byte-identical for malformed ≡ absent catalog ids (no existence oracle, §3)', async () => {
    const malformed = await request(app.getHttpServer()).get('/journal/exercises/not-a-uuid/pr').set(bearer(tokenA)).expect(404);
    const absent = await request(app.getHttpServer()).get(`/journal/exercises/${ABSENT_EXERCISE}/pr`).set(bearer(tokenA)).expect(404);
    const garbage = await request(app.getHttpServer()).get('/journal/exercises/%20/pr').set(bearer(tokenA)).expect(404);
    expect(normalized(malformed.body as Record<string, unknown>)).toBe(normalized(absent.body as Record<string, unknown>));
    expect(normalized(malformed.body as Record<string, unknown>)).toBe(normalized(garbage.body as Record<string, unknown>));
    expect((malformed.body as { code?: string }).code).toBe('NOT_FOUND');
    const schema = schemaFor(404);
    if (schema !== undefined) {
      assertConformsToSchema(malformed.body, schema, '404');
    }
  });

  it('200 {result:"none"} — the success-shaped empty state, byte-identical across users with no qualifying sets', async () => {
    // B holds no sessions at all; the served none-body must be the canonical
    // empty state (the C-parity shape — denials are authorization-driven,
    // never data-shaped).
    const bNone = await request(app.getHttpServer()).get(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenB)).expect(200);
    expect(bNone.body).toEqual({ result: 'none' });
    const schema = schemaFor(200);
    if (schema !== undefined) {
      assertConformsToSchema(bNone.body, schema, '200-none');
    }
  });

  it('200 {result:"pr"} with the EXACT derived body — 100 kg × 8 → 126.67, sourceSet + achievedOn (§1.3)', async () => {
    const response = await request(app.getHttpServer()).get(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenA)).expect(200);
    expect(response.body).toEqual({
      result: 'pr',
      pr: {
        exerciseId: EX_SQUAT,
        estimatedOneRepMaxKg: 126.67,
        sourceSet: {
          sessionId: S1,
          setId: SET_A,
          weightKg: 100,
          reps: 8,
          sessionLocalDate: '2026-03-01',
        },
        achievedOn: '2026-03-01',
      },
    });
    const schema = schemaFor(200);
    if (schema !== undefined) {
      assertConformsToSchema(response.body, schema, '200-pr');
    }
  });

  it('derived-never-stored: tombstoning the winning session moves the PR to the next-best applied set', async () => {
    await db.pool.query('UPDATE journal_sessions SET deleted_at = now() WHERE id = $1', [S1]);
    try {
      const response = await request(app.getHttpServer()).get(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenA)).expect(200);
      // 90 kg × 9 → 90 × (1 + 9/30) = 117 exactly.
      expect(response.body).toMatchObject({
        result: 'pr',
        pr: { sourceSet: { sessionId: S2, setId: SET_B, weightKg: 90, reps: 9 }, achievedOn: '2026-03-05' },
      });
      expect((response.body as { pr?: { estimatedOneRepMaxKg?: number } }).pr?.estimatedOneRepMaxKg).toBe(117);
    } finally {
      await db.pool.query('UPDATE journal_sessions SET deleted_at = NULL WHERE id = $1', [S1]);
    }
  });

  it('owning-user-only (I7): B never receives any A row — B’s PR over the same exercise is B’s own (or none)', async () => {
    const response = await request(app.getHttpServer()).get(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenB)).expect(200);
    expect(response.body).toEqual({ result: 'none' }); // B has no sessions — the same shape as the empty state
  });

  it('the §2 freeze: no journal mutation route exists (POST/DELETE on the read path is a generic 404)', async () => {
    await request(app.getHttpServer()).post('/journal/exercises').set(bearer(tokenA)).send({}).expect(404);
    await request(app.getHttpServer()).delete(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenA)).expect(404);
    await request(app.getHttpServer()).post(`/journal/exercises/${EX_SQUAT}/pr`).set(bearer(tokenA)).send({}).expect(404);
  });
});
