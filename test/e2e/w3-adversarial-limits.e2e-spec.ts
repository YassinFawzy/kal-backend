/**
 * Kal W3 ADVERSARIAL e2e — user-food rate limits (wave-03 task s4a-adversarial;
 * contract §1.7, PRD §8, conventions §4). Attacks BOTH enforcement paths with
 * the shared-limiter property and the two-config proof style (the W2
 * lockout-proof precedent):
 *
 *   - CONFIG 1 (hour=2, day=100): the 3rd create trips the HOUR window — REST
 *     ⇒ `429 RATE_LIMITED` + `Retry-After` ≲ 1 h; sync ⇒ per-op
 *     `rejected_rate_limited`, retryable true. Diary ops in the same batch
 *     are NEVER limited (§1.7: logging is never rate-limited — the durability
 *     guarantee holds without exception for the diary).
 *   - CONFIG 2 (hour=100, day=2): the SAME 3rd create trips the DAY window —
 *     `Retry-After` ≈ 24 h. Two configs, same call count, different trip
 *     window ⇒ the thresholds are honored, not hardcoded (two-config proof).
 *   - ONE shared counter: REST ticks are visible to the sync path and vice
 *     versa (both paths, one implementation — §1.7).
 *   - The §1.7 directed resolution pinned at the DB layer: the over-limit
 *     sync create is acked NOT recorded (no `sync_operations` row), does NOT
 *     tick the counter, and the SAME opId retried after a harness-clock
 *     window lapse re-runs the real handler and APPLIES (ledger 0→1).
 *   - Byte-parity of 429s across accounts (the denial never depends on who
 *     is calling — raw-byte, pinned `X-Request-Id`), and outcome parity of
 *     sync rejections across accounts (opId-projected — acks echo the
 *     caller's own opId).
 *   - The recorded replay of a batch containing a rate-limited op is
 *     byte-identical (the key record stores the ack verbatim) and re-ticks
 *     nothing.
 *
 * Ephemeral database per boot (`kal_it_s4advlim*`); synthetic accounts; no
 * real health content. Findings are REPORTED, never fixed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';
import {
  advUuid,
  createThreeUserHarness,
  diaryCreateOp,
  expectAckOutcomesIdentical,
  lapseLimiterWindows,
  ledgerRowCount,
  limiterCounters,
  pushBatch,
  type OpInput,
  type ThreeUserHarness,
  userFoodCreateOp,
} from '../integration/helpers/three-user-harness.js';

const NS = 'b2e4';
const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';

interface BootedApp {
  app: INestApplication<App>;
  db: EphemeralKalDb;
  users: ThreeUserHarness;
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
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

async function bootWithLimits(
  label: string,
  env: Record<string, string>,
  accounts: { a: { email: string; phone: string; username: string }; b: { email: string; phone: string; username: string }; c: { email: string; phone: string; username: string } },
): Promise<BootedApp> {
  const db = await createEphemeralKalDb(label);
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const app = await bootApp({
    DATABASE_URL: url.toString(),
    IDENTITY_JWT_SIGNING_KEY: 's4advlim8lane8fixed8key8material8with8enough8entropy88',
    NODE_ENV: 'test',
    ...env,
  });
  const users = await createThreeUserHarness(app, db, accounts);
  return { app, db, users };
}

async function restCreate(boot: BootedApp, token: string, nameEn: string): Promise<request.Response> {
  return request(boot.app.getHttpServer())
    .post('/tracking/user-foods')
    .set('X-Request-Id', 's4a limits pinned request id 00')
    .set('Authorization', `Bearer ${token}`)
    .send({ nameEn, energyKcal: 120, proteinG: 4, carbsG: 15, fatG: 3 });
}

// ---------------------------------------------------------------------------
// CONFIG 1 — hour=2 trips on the 3rd create
// ---------------------------------------------------------------------------

describe('CONFIG hour=2/day=100 — the hour window trips on the 3rd create (both paths)', () => {
  let boot: BootedApp;

  beforeAll(async () => {
    boot = await bootWithLimits('s4advlim1', { TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '2', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '100' }, {
      a: { email: 'lim1-a@example.com', phone: '+201700000301', username: 'lim1_owner_a' },
      b: { email: 'lim1-b@example.com', phone: '+201700000302', username: 'lim1_attacker_b' },
      c: { email: 'lim1-c@example.com', phone: '+201700000303', username: 'lim1_control_c' },
    });
  }, 180_000);

  afterAll(async () => {
    await boot?.app?.close();
    await boot?.db?.drop();
  }, 60_000);

  it('REST: A trips the hourly window on the 3rd create — 429 with an hourly Retry-After', async () => {
    expect((await restCreate(boot, boot.users.a.token, 'lim1 rest food 1')).status).toBe(201);
    expect((await restCreate(boot, boot.users.a.token, 'lim1 rest food 2')).status).toBe(201);
    const third = await restCreate(boot, boot.users.a.token, 'lim1 rest food 3');
    expect(third.status).toBe(429);
    expect((third.body as { code: string }).code).toBe('RATE_LIMITED');
    const retryAfter = Number(third.headers['retry-after']);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After ${retryAfter}`).toBe(true);
    expect(retryAfter, 'hourly Retry-After is at most one hour').toBeLessThanOrEqual(3600);
  });

  it('429 byte-parity across accounts: B\'s independent trip renders A\'s exact bytes', async () => {
    expect((await restCreate(boot, boot.users.b.token, 'lim1 b food 1')).status).toBe(201);
    expect((await restCreate(boot, boot.users.b.token, 'lim1 b food 2')).status).toBe(201);
    const bThird = await restCreate(boot, boot.users.b.token, 'lim1 b food 3');
    expect(bThird.status).toBe(429);
    const aThird = await restCreate(boot, boot.users.a.token, 'lim1 rest food 3 again');
    expect(aThird.status).toBe(429);
    expect(bThird.text).toBe(aThird.text);
    expect(Number(bThird.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('SYNC: B\'s 3rd user_food create is rejected_rate_limited (retryable) inside a batch whose DIARY ops all apply — logging is never limited (§1.7)', async () => {
    // B's earlier REST ticks (byte-parity test) consumed this hour window —
    // lapse the clock so the batch below starts from a fresh, known state.
    await lapseLimiterWindows(boot.db, boot.users.b.userId);
    const ops: OpInput[] = [
      diaryCreateOp(NS, 'h101', 'he101', T0, DAY),
      userFoodCreateOp(NS, 'h102', 'hf101', T0, 'lim1 sync food 1'),
      userFoodCreateOp(NS, 'h103', 'hf102', T0, 'lim1 sync food 2'),
      diaryCreateOp(NS, 'h104', 'he102', T0, DAY),
      userFoodCreateOp(NS, 'h105', 'hf103', T0, 'lim1 sync food 3'), // the 3rd create ⇒ hour window
      diaryCreateOp(NS, 'h106', 'he103', T0, DAY),
    ];
    const response = await pushBatch(boot.app, boot.users.b.token, ops, advUuid(NS, 'kh101'));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      results: [
        { opId: advUuid(NS, 'h101'), outcome: 'applied' },
        { opId: advUuid(NS, 'h102'), outcome: 'applied' },
        { opId: advUuid(NS, 'h103'), outcome: 'applied' },
        { opId: advUuid(NS, 'h104'), outcome: 'applied' },
        { opId: advUuid(NS, 'h105'), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true },
        { opId: advUuid(NS, 'h106'), outcome: 'applied' },
      ],
    });
  });

  it('the over-limit create did NOT tick and left NO ledger row (§1.7 directed resolution, DB-verified)', async () => {
    const counters = await limiterCounters(boot.db, boot.users.b.userId);
    expect(counters).toEqual({ hourCount: 2, dayCount: 2 }); // two applied ticks only
    expect(await ledgerRowCount(boot.db, boot.users.b.userId, advUuid(NS, 'h105'))).toBe(0);
    // …and the batch's key record IS present (the batch committed with its applied ops).
    const keyRows = await boot.db.pool.query(
      'SELECT count(*)::int AS n FROM sync_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
      [boot.users.b.userId, advUuid(NS, 'kh101')],
    );
    expect((keyRows.rows[0] as { n: number }).n).toBe(1);
  });

  it('the recorded replay of that batch is byte-identical and re-ticks nothing; a fresh-key same-op retry re-runs the handler', async () => {
    const countersBefore = await limiterCounters(boot.db, boot.users.b.userId);
    const ops: OpInput[] = [
      diaryCreateOp(NS, 'h101', 'he101', T0, DAY),
      userFoodCreateOp(NS, 'h102', 'hf101', T0, 'lim1 sync food 1'),
      userFoodCreateOp(NS, 'h103', 'hf102', T0, 'lim1 sync food 2'),
      diaryCreateOp(NS, 'h104', 'he102', T0, DAY),
      userFoodCreateOp(NS, 'h105', 'hf103', T0, 'lim1 sync food 3'),
      diaryCreateOp(NS, 'h106', 'he103', T0, DAY),
    ];
    const replay = await pushBatch(boot.app, boot.users.b.token, ops, advUuid(NS, 'kh101'));
    expect(replay.status).toBe(200);
    // Recorded replay: byte-identical to the original ack (rate-limited result included).
    const original = [
      { opId: advUuid(NS, 'h101'), outcome: 'applied' },
      { opId: advUuid(NS, 'h102'), outcome: 'applied' },
      { opId: advUuid(NS, 'h103'), outcome: 'applied' },
      { opId: advUuid(NS, 'h104'), outcome: 'applied' },
      { opId: advUuid(NS, 'h105'), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true },
      { opId: advUuid(NS, 'h106'), outcome: 'applied' },
    ];
    expect(JSON.parse(replay.text)).toEqual({ results: original });
    expect(await limiterCounters(boot.db, boot.users.b.userId)).toEqual(countersBefore);

    // Fresh key, same op (nothing recorded for h105): the handler re-runs —
    // still rate-limited while the window is live, still not recorded.
    const retryLive = await pushBatch(boot.app, boot.users.b.token, [userFoodCreateOp(NS, 'h105', 'hf103', T0, 'lim1 sync food 3')], advUuid(NS, 'kh102'));
    expect(retryLive.status).toBe(200);
    expect(retryLive.body).toMatchObject({
      results: [{ opId: advUuid(NS, 'h105'), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true }],
    });
    expect(await limiterCounters(boot.db, boot.users.b.userId)).toEqual(countersBefore);
    expect(await ledgerRowCount(boot.db, boot.users.b.userId, advUuid(NS, 'h105'))).toBe(0);
  });

  it('ONE shared counter: C\'s REST ticks trip C\'s SYNC create — and after a harness-clock lapse the same opId APPLIES (ledger 0→1)', async () => {
    expect((await restCreate(boot, boot.users.c.token, 'lim1 c food 1')).status).toBe(201);
    expect((await restCreate(boot, boot.users.c.token, 'lim1 c food 2')).status).toBe(201);
    const syncThird = await pushBatch(boot.app, boot.users.c.token, [userFoodCreateOp(NS, 'h201', 'hc101', T0, 'lim1 c sync food 3')], advUuid(NS, 'kh201'));
    expect(syncThird.body).toMatchObject({
      results: [{ opId: advUuid(NS, 'h201'), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true }],
    });

    // Lapse both windows (harness clock — the app role holds no such grant).
    await lapseLimiterWindows(boot.db, boot.users.c.userId);

    // SAME opId, fresh key: the handler re-runs and APPLIES — the §1.7 retry contract.
    const retryLapsed = await pushBatch(boot.app, boot.users.c.token, [userFoodCreateOp(NS, 'h201', 'hc101', T0, 'lim1 c sync food 3')], advUuid(NS, 'kh202'));
    expect(retryLapsed.body).toMatchObject({ results: [{ opId: advUuid(NS, 'h201'), outcome: 'applied' }] });
    expect(await ledgerRowCount(boot.db, boot.users.c.userId, advUuid(NS, 'h201'))).toBe(1);
    expect(await limiterCounters(boot.db, boot.users.c.userId)).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('sync rejection outcome parity across accounts (opId-projected): A\'s and B\'s over-limit ops ack identically', async () => {
    const aOp = await pushBatch(boot.app, boot.users.a.token, [userFoodCreateOp(NS, 'h301', 'hfa01', T0, 'lim1 a sync retry')], advUuid(NS, 'kh301'));
    const bOp = await pushBatch(boot.app, boot.users.b.token, [userFoodCreateOp(NS, 'h302', 'hfb01', T0, 'lim1 b sync retry')], advUuid(NS, 'kh302'));
    expectAckOutcomesIdentical(aOp, bOp, 'sync rate-limit ack A vs B');
  });

  it('REST lapse: after the harness-clock window lapse A\'s REST create succeeds again (the retry path on the online surface)', async () => {
    await lapseLimiterWindows(boot.db, boot.users.a.userId);
    const recovered = await restCreate(boot, boot.users.a.token, 'lim1 rest food after lapse');
    expect(recovered.status).toBe(201);
    // The immediately-following create trips the fresh hour window again.
    const next = await restCreate(boot, boot.users.a.token, 'lim1 rest food after lapse 2');
    expect(next.status).toBe(201);
    const third = await restCreate(boot, boot.users.a.token, 'lim1 rest food after lapse 3');
    expect(third.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// CONFIG 2 — day=2 trips on the 3rd create (the two-config proof)
// ---------------------------------------------------------------------------

describe('CONFIG hour=100/day=2 — the SAME 3rd create now trips the DAY window (two-config proof)', () => {
  let boot: BootedApp;

  beforeAll(async () => {
    boot = await bootWithLimits('s4advlim2', { TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '100', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '2' }, {
      a: { email: 'lim2-a@example.com', phone: '+201700000401', username: 'lim2_owner_a' },
      b: { email: 'lim2-b@example.com', phone: '+201700000402', username: 'lim2_attacker_b' },
      c: { email: 'lim2-c@example.com', phone: '+201700000403', username: 'lim2_control_c' },
    });
  }, 180_000);

  afterAll(async () => {
    await boot?.app?.close();
    await boot?.db?.drop();
  }, 60_000);

  it('REST: the 3rd create trips with a DAILY Retry-After — different window than CONFIG 1 at the same call count', async () => {
    expect((await restCreate(boot, boot.users.a.token, 'lim2 a food 1')).status).toBe(201);
    expect((await restCreate(boot, boot.users.a.token, 'lim2 a food 2')).status).toBe(201);
    const third = await restCreate(boot, boot.users.a.token, 'lim2 a food 3');
    expect(third.status).toBe(429);
    expect((third.body as { code: string }).code).toBe('RATE_LIMITED');
    const retryAfter = Number(third.headers['retry-after']);
    expect(retryAfter, 'daily Retry-After approaches 24 h').toBeGreaterThan(80_000);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  it('SYNC: the 3rd user_food create is rejected_rate_limited under the day cap; A\'s and B\'s acks are outcome-identical', async () => {
    // A's earlier REST ticks consumed the day window — lapse the clock so
    // both accounts start the batch from a fresh, known state.
    await lapseLimiterWindows(boot.db, boot.users.a.userId);
    const opsA: OpInput[] = [
      userFoodCreateOp(NS, 'd101', 'df101', T0, 'lim2 a sync 1'),
      userFoodCreateOp(NS, 'd102', 'df102', T0, 'lim2 a sync 2'),
      userFoodCreateOp(NS, 'd103', 'df103', T0, 'lim2 a sync 3'),
    ];
    const a = await pushBatch(boot.app, boot.users.a.token, opsA, advUuid(NS, 'kd101'));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      results: [
        { outcome: 'applied' },
        { outcome: 'applied' },
        { opId: advUuid(NS, 'd103'), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true },
      ],
    });

    const opsB: OpInput[] = [
      userFoodCreateOp(NS, 'd104', 'df104', T0, 'lim2 b sync 1'),
      userFoodCreateOp(NS, 'd105', 'df105', T0, 'lim2 b sync 2'),
      userFoodCreateOp(NS, 'd106', 'df106', T0, 'lim2 b sync 3'),
    ];
    const b = await pushBatch(boot.app, boot.users.b.token, opsB, advUuid(NS, 'kd104'));
    expectAckOutcomesIdentical(a, b, 'daily-window sync ack A vs B');
    expect(await limiterCounters(boot.db, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
  });

  it('DIARY remains unlimited under the day cap: 30 diary creates in one batch all apply (§1.7 durability without exception)', async () => {
    const ops: OpInput[] = Array.from({ length: 30 }, (_v, i) =>
      diaryCreateOp(NS, `dg${i.toString(16).padStart(2, '0')}`, `de${i.toString(16).padStart(2, '0')}`, T0, DAY),
    );
    const response = await pushBatch(boot.app, boot.users.c.token, ops, advUuid(NS, 'kdg01'));
    expect(response.status).toBe(200);
    const results = (response.body as { results: { outcome: string }[] }).results;
    expect(results).toHaveLength(30);
    expect(results.every((r) => r.outcome === 'applied')).toBe(true);
    expect(await limiterCounters(boot.db, boot.users.c.userId)).toBeNull(); // C never touched the food counter
  });
});
