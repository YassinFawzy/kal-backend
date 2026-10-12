/**
 * Kal journal sessions e2e (wave-04, task s2a-sessions) — the real
 * AppModule against a real, fully-migrated, EPHEMERAL PostgreSQL database
 * (the established harness pattern; the dev database is never touched).
 *
 * The sync module registers the journal module's REAL `journal_session`
 * handler and delta provider at AppModule init (supervisor-blessed seam
 * widening, ruling 1) — this suite exercises the assembled surface end to
 * end over HTTP: identity signup/sign-in → `POST /sync/ops` with the
 * frozen envelope → the §2 read surface (`GET /journal/sessions/days/…`,
 * `GET /journal/sessions/…`) → `GET /sync/changes` carrying the
 * journal_session changes.
 *
 * Covered required cases (task contract):
 *   - the mixed-format session round-trips over the real HTTP boundary;
 *     the §2 projections conform to the served `w4` fixture schemas;
 *   - the 404 denial set is BYTE-IDENTICAL for absent ≡ malformed ≡
 *     tombstoned ≡ foreign ids (I7 — no existence oracle), pinned with a
 *     pinned X-Request-Id so the echoed requestId does not perturb bytes;
 *   - malformed day ⇒ the generic 400; unauthenticated reads/pushes ⇒ 401;
 *   - tombstone via HTTP ⇒ the delta feed surfaces the payload-free
 *     delete; a stale pull can never resurrect;
 *   - the training-day flag is NOT enumerable by any HTTP surface (§3).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w4FixturesDocument } from '../src/contracts/w4.fixtures.js';
import { assertConformsToSchema } from './support/contract-schema.js';
import { applyExerciseCatalogSeed } from '../prisma/seed-apply.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4journal4sessions4lane4fixed4key4material4with4enough4entropy';
const PASSWORD = 'journal-e2e-password-01';
const DEVICE = 'journal-e2e-device-01';
const PINNED_REQUEST_ID = 'jrn-e2e-pinned-request-id';

const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let tokenA = '';
let tokenB = '';

const USER_A = { email: ['journal-a', 'example.com'].join('@'), phone: '+201200000001', username: 'journal_e2e_a' };
const USER_B = { email: ['journal-b', 'example.com'].join('@'), phone: '+201200000002', username: 'journal_e2e_b' };

const DAY = '2026-10-12';
const T0 = '2026-10-12T17:00:00.000Z';
const T1 = '2026-10-12T18:00:00.000Z';

function fixtureUuid(n: number): string {
  return `5cf10000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
function opId(n: number): string {
  return `7d0f0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
function keyId(n: number): string {
  return `7cef0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function mixedSnapshot(localDate: string): Record<string, unknown> {
  return {
    localDate,
    title: 'E2E push day',
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 82.5, reps: 5 }, { format: 'timed', durationSeconds: 90 }, { format: 'notes', text: 'AMRAP finisher — felt strong' }] },
    ],
  };
}

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
      } else if (previous[key] !== undefined) {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

async function signupAndSignin(user: { email: string; phone: string; username: string }, suffix: number): Promise<{ token: string; userId: string }> {
  const http = app.getHttpServer();
  await request(http).post('/identity/signup').send({ ...user, password: PASSWORD });
  const signin = await request(http)
    .post('/identity/signin')
    .set('X-Device-Id', `${DEVICE}-${String(suffix)}`)
    .send({ identifier: user.username, password: PASSWORD });
  expect(signin.status).toBe(200);
  const token = (signin.body as { accessToken: string }).accessToken;
  // The verified database binding is server truth — never parsed from a token (I6).
  const rows = await adminQuery(db, `SELECT id FROM users WHERE email = $1`, [user.email]);
  return { token, userId: rows.rows[0]?.id as string };
}

function push(http: App, token: string, ops: unknown[], key: string) {
  return request(http)
    .post('/sync/ops')
    .set(bearer(token))
    .set('Idempotency-Key', key)
    .set('X-Request-Id', PINNED_REQUEST_ID)
    .send({ deviceId: DEVICE, ops });
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('jrn-sessions-e2e');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      await applyExerciseCatalogSeed(seedClient);
    } finally {
      await seedClient.$disconnect();
    }

    process.env['DATABASE_URL'] = url.toString();
    app = await bootApp({
      DATABASE_URL: url.toString(),
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    });

    const a = await signupAndSignin(USER_A, 1);
    tokenA = a.token;
    const b = await signupAndSignin(USER_B, 2);
    tokenB = b.token;
  })();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('journal_session over the real HTTP boundary (§1)', () => {
  let sessionId = '';

  it('applies a mixed-format session; the w4 day read conforms to the frozen fixture schema', async () => {
    sessionId = fixtureUuid(1);
    const pushResult = await push(app.getHttpServer(), tokenA, [
      {
        opId: opId(1),
        kind: 'journal_session',
        entityId: sessionId,
        action: 'create',
        clientUpdatedAt: T0,
        localDate: DAY,
        payload: mixedSnapshot(DAY),
      },
    ], keyId(1));
    expect(pushResult.status).toBe(200);
    expect(pushResult.body).toMatchObject({ results: [{ opId: opId(1), outcome: 'applied' }] });

    const day = await request(app.getHttpServer())
      .get(`/journal/sessions/days/${DAY}`)
      .set(bearer(tokenA))
      .set('X-Request-Id', PINNED_REQUEST_ID);
    expect(day.status).toBe(200);
    expect(day.headers['content-type']).toBe('application/json; charset=utf-8');
    const dayFixture = w4FixturesDocument().endpoints.find((e) => e.id === 'journal.sessions.day.get');
    const okSchema = dayFixture?.responses.find((r) => r.status === 200);
    assertConformsToSchema(day.body, okSchema?.bodySchema, 'journal.sessions.day.get 200');

    const sessions = (day.body as { sessions: { id: string; exercises: { exerciseId: string; nameSnapshotEn: string; sets: { format: string }[] }[] }[] }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(sessionId);
    expect(sessions[0]?.exercises[0]?.nameSnapshotEn).toBe('Barbell back squat');
    expect(sessions[0]?.exercises[0]?.sets.map((s) => s.format)).toEqual(['weighted', 'timed', 'notes']);
  });

  it('the detail read returns the owning user’s session; B (foreign) gets the SAME bytes as absent/malformed/tombstoned', async () => {
    const own = await request(app.getHttpServer()).get(`/journal/sessions/${sessionId}`).set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    expect(own.status).toBe(200);
    const detailFixture = w4FixturesDocument().endpoints.find((e) => e.id === 'journal.sessions.get');
    const okSchema = detailFixture?.responses.find((r) => r.status === 200);
    assertConformsToSchema(own.body, okSchema?.bodySchema, 'journal.sessions.get 200');

    // Tombstone it (a NEW op id — deletes are their own ops).
    await push(app.getHttpServer(), tokenA, [
      {
        opId: opId(2),
        kind: 'journal_session',
        entityId: sessionId,
        action: 'delete',
        clientUpdatedAt: T1,
        localDate: DAY,
      },
    ], keyId(2));

    const foreign = await request(app.getHttpServer()).get(`/journal/sessions/${sessionId}`).set(bearer(tokenB)).set('X-Request-Id', PINNED_REQUEST_ID);
    const absent = await request(app.getHttpServer()).get(`/journal/sessions/${fixtureUuid(999)}`).set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    const malformed = await request(app.getHttpServer()).get('/journal/sessions/not-a-uuid').set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    const tombstoned = await request(app.getHttpServer()).get(`/journal/sessions/${sessionId}`).set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);

    for (const denial of [foreign, absent, malformed, tombstoned]) {
      expect(denial.status).toBe(404);
      expect(denial.headers['content-type']).toContain('application/problem+json');
    }
    // Byte-identical: absent ≡ malformed ≡ tombstoned ≡ foreign (I7).
    expect(tombstoned.text).toBe(absent.text);
    expect(malformed.text).toBe(absent.text);
    expect(foreign.text).toBe(absent.text);

    // The day read no longer lists the tombstoned session (empty sessions array).
    const day = await request(app.getHttpServer()).get(`/journal/sessions/days/${DAY}`).set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    expect((day.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('malformed day ⇒ the generic 400; unauthenticated reads and pushes ⇒ 401', async () => {
    const badDay = await request(app.getHttpServer()).get('/journal/sessions/days/2026-02-30').set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    expect(badDay.status).toBe(400);
    expect(badDay.headers['content-type']).toContain('application/problem+json');
    expect(badDay.text).not.toContain('2026-02-30'); // value-free denial (I12)

    const noAuthDay = await request(app.getHttpServer()).get(`/journal/sessions/days/${DAY}`).set('X-Request-Id', PINNED_REQUEST_ID);
    expect(noAuthDay.status).toBe(401);
    const noAuthDetail = await request(app.getHttpServer()).get(`/journal/sessions/${fixtureUuid(5)}`).set('X-Request-Id', PINNED_REQUEST_ID);
    expect(noAuthDetail.status).toBe(401);
    const noAuthPush = await request(app.getHttpServer())
      .post('/sync/ops')
      .set('Idempotency-Key', keyId(9))
      .send({ deviceId: DEVICE, ops: [] });
    expect(noAuthPush.status).toBe(401);
  });

  it('the delta feed carries the journal_session upsert, then the payload-free tombstone — a later pull never re-emits the upsert (no resurrection)', async () => {
    const sessionId2 = fixtureUuid(3);
    await push(app.getHttpServer(), tokenA, [
      {
        opId: opId(3),
        kind: 'journal_session',
        entityId: sessionId2,
        action: 'create',
        clientUpdatedAt: T0,
        localDate: DAY,
        payload: mixedSnapshot(DAY),
      },
    ], keyId(3));

    const pullAfterCreate = await request(app.getHttpServer()).get('/sync/changes').set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    expect(pullAfterCreate.status).toBe(200);
    const created = (pullAfterCreate.body as { changes: { kind: string; entityId: string; change: string; payload?: { exercises: unknown[] } }[] }).changes;
    const upsert = created.find((c) => c.entityId === sessionId2);
    expect(upsert?.kind).toBe('journal_session');
    expect(upsert?.change).toBe('upsert');
    expect(upsert?.payload?.exercises).toHaveLength(1);
    // Training-day flags never ride the feed (§1.2 — sync kinds only).
    expect(created.every((c) => ['diary_entry', 'user_food', 'favorite', 'journal_session'].includes(c.kind))).toBe(true);

    await push(app.getHttpServer(), tokenA, [
      {
        opId: opId(4),
        kind: 'journal_session',
        entityId: sessionId2,
        action: 'delete',
        clientUpdatedAt: T1,
        localDate: DAY,
      },
    ], keyId(4));

    const pullAfterDelete = await request(app.getHttpServer()).get('/sync/changes').set(bearer(tokenA)).set('X-Request-Id', PINNED_REQUEST_ID);
    const changes = (pullAfterDelete.body as { changes: { kind: string; entityId: string; change: string; payload?: unknown }[] }).changes;
    const tombstone = changes.find((c) => c.entityId === sessionId2);
    expect(tombstone?.change).toBe('delete');
    expect(tombstone?.payload).toBeUndefined();
    // The feed serves CURRENT state, not a change log: the tombstoned
    // session's upsert is gone — a stale pull can never resurrect it (§1.5).
    expect(changes.some((c) => c.entityId === sessionId2 && c.change === 'upsert')).toBe(false);
  });

  it('B cannot see A’s training data over any journal HTTP surface; the training-day flag is not enumerable', async () => {
    const bDay = await request(app.getHttpServer()).get(`/journal/sessions/days/${DAY}`).set(bearer(tokenB)).set('X-Request-Id', PINNED_REQUEST_ID);
    expect((bDay.body as { sessions: unknown[] }).sessions).toEqual([]);
    // There is no /journal/training-days route — the flag surface is
    // service-seam only (§3). A miss on the read path is a 401 (no bearer)
    // or 404 (unknown route for an authenticated caller), never data.
    const probe = await request(app.getHttpServer()).get('/journal/training-days').set(bearer(tokenB));
    expect([401, 404]).toContain(probe.status);
    expect(probe.text).not.toContain(DAY);
  });
});
