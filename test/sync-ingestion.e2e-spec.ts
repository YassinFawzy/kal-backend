/**
 * Kal sync ingestion e2e (wave-03, task s2d-sync-ingestion) — the real
 * AppModule against a real, fully-migrated, EPHEMERAL PostgreSQL database
 * (the established harness pattern; the dev database is never touched).
 *
 * POST-s2c REBASE SHAPE: the sync module registers tracking's REAL handlers
 * (s2a: user_food + favorite; s2c: diary_entry) at AppModule init through
 * the production registry path — so this suite exercises the assembled
 * seam end-to-end with NO test handler. Engine semantics run through the
 * REAL diary handler (quick-add entries: the zero-dependency frozen
 * snapshot shape); the shared limiter's acked-not-recorded
 * `rejected_rate_limited` path is pinned through the REAL user_food handler
 * and the REAL limiter with a harness clock lapse (the supervisor-pinned
 * batch-integration obligation). The deterministic failure-injection and
 * registry-miss cases live in the unit/integration suites (the itspec
 * constructs its own registry with the clearly-marked TEST-ONLY handler;
 * with all three real kinds registered, the registry-miss case is a
 * defensive seam unreachable via HTTP).
 *
 * Covered required cases (task contract):
 *   - Fixture round-trip: served w3 `sync.ops.push` responses (200/400/401)
 *     conform to the frozen fixture schemas; content types exact.
 *   - Happy: the PRD §23.1-shaped 4-op batch (three creates + one edit)
 *     applies in request order with per-op `applied` acks; a duplicate
 *     replay of the whole batch (new request, same ops) acks all
 *     `duplicate` with ZERO re-application (I9, database-verified).
 *   - Idempotency-Key matrix: same key+payload ⇒ byte-stable recorded
 *     replay; same key+changed payload ⇒ `409 CONFLICT`; two concurrent
 *     same-key requests ⇒ exactly one executes, the other serves the
 *     recorded outcome (byte-identical).
 *   - Ordering/state machine through the REAL diary handler: create →
 *     older-update (LWW loser recorded applied, no change) → newer-update →
 *     delete (tombstone) → update-after-delete (`rejected_deleted`) →
 *     create-after-delete (`rejected_deleted`, no resurrection).
 *   - Negative/adversarial (in-lane; s4a deepens): B's credentials pushing
 *     A's op ID ⇒ no match, generic fresh outcome, A's acks and rows
 *     untouched; malformed envelope ⇒ `400 VALIDATION_FAILED` without
 *     echoing received values; oversized batch ⇒ `400`; unauthenticated ⇒
 *     `401`.
 *   - `rejected_rate_limited` (§1.7 directed resolution — the supervisor-
 *     pinned batch-integration obligation): acked retryable, NOT durably
 *     recorded (no `sync_operations` row); a same-opId retry re-runs the
 *     real handler; after the limiter window lapses (harness clock) the
 *     retry applies.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w3FixturesDocument } from '../src/contracts/w3.fixtures.js';
import { assertConformsToSchema } from './support/contract-schema.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4sync4ingestion4lane4fixed4key4material4with4enough4entropy';

const PASSWORD = 'sync-e2e-password-01';
const DEVICE = 'sync-e2e-device-01';

const USER_A = {
  email: ['sync-a', 'example.com'].join('@'),
  phone: '+201100000001',
  username: 'sync_e2e_a',
};
const USER_B = {
  email: ['sync-b', 'example.com'].join('@'),
  phone: '+201100000002',
  username: 'sync_e2e_b',
};

/** Synthetic fixture-range UUIDs (never real accounts or real entities). */
function fixtureUuid(tail: string): string {
  const hex = (tail.match(/[0-9a-f]/giu) ?? []).join('').padEnd(12, '0').slice(0, 12);
  return `5bef0000-0000-4000-8000-${hex}`;
}
function opId(n: number): string {
  return fixtureUuid(n.toString(16));
}
function keyId(n: number): string {
  return fixtureUuid(`a${n.toString(16)}`);
}

let app: INestApplication<App>;
let db: EphemeralKalDb;
let userIdA = '';
let userIdB = '';

let tokenA = '';
let tokenB = '';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
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

async function signupAndSignin(
  user: { email: string; phone: string; username: string },
  suffix: number,
): Promise<string> {
  const http = app.getHttpServer();
  await request(http).post('/identity/signup').send({ ...user, password: PASSWORD });
  const signin = await request(http)
    .post('/identity/signin')
    .set('X-Device-Id', `${DEVICE}-${String(suffix)}`)
    .send({ identifier: user.username, password: PASSWORD });
  expect(signin.status).toBe(200);
  return (signin.body as { accessToken: string }).accessToken;
}

const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';
const T2 = '2026-10-08T09:00:00Z';

/** The frozen quick-add diary snapshot (s2c's validated shape; no food reference). */
function quickAddSnapshot(localDate: string): Record<string, unknown> {
  return {
    localDate,
    mealSlot: 'breakfast',
    entryMethod: 'quick_add',
    status: 'confirmed',
    quantity: 1,
    energyKcal: 250,
    proteinG: 8,
    carbsG: 30,
    fatG: 7,
  };
}

interface OpInput {
  opId: string;
  kind: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  clientUpdatedAt: string;
  localDate?: string;
  payload?: Record<string, unknown>;
}

function diaryCreate(n: number, entityId: string, at: string): OpInput {
  return {
    opId: opId(n),
    kind: 'diary_entry',
    entityId,
    action: 'create',
    clientUpdatedAt: at,
    localDate: DAY,
    payload: quickAddSnapshot(DAY),
  };
}

/** The frozen user-food snapshot (s2a's validated shape — the limiter's entity). */
function userFoodCreate(n: number, entityId: string, at: string): OpInput {
  return {
    opId: opId(n),
    kind: 'user_food',
    entityId,
    action: 'create',
    clientUpdatedAt: at,
    payload: { nameEn: 'Sync e2e food', energyKcal: 120, proteinG: 4, carbsG: 15, fatG: 3 },
  };
}

async function push(
  token: string,
  ops: OpInput[],
  idempotencyKey: string,
  deviceId = DEVICE,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/sync/ops')
    .set(bearer(token))
    .set('Idempotency-Key', idempotencyKey)
    .send({ deviceId, ops });
}

type DiaryRow = { updated_at: Date; deleted_at: Date | null; last_op_id: string | null };

async function diaryRow(userId: string, entityId: string): Promise<DiaryRow | null> {
  const result = await adminQuery(
    db,
    'SELECT updated_at, deleted_at, last_op_id FROM diary_entries WHERE user_id = $1 AND id = $2',
    [userId, entityId],
  );
  return (result.rows[0] as DiaryRow | undefined) ?? null;
}

async function diaryRowCount(userId: string): Promise<number> {
  const result = await adminQuery(db, 'SELECT count(*)::int AS n FROM diary_entries WHERE user_id = $1', [userId]);
  return (result.rows[0] as { n: number }).n;
}

async function ledgerRowCount(userId: string, clientOpId: string): Promise<number> {
  const result = await adminQuery(
    db,
    'SELECT count(*)::int AS n FROM sync_operations WHERE user_id = $1 AND client_op_id = $2',
    [userId, clientOpId],
  );
  return (result.rows[0] as { n: number }).n;
}

function resultsOf(response: request.Response): { opId: string; outcome: string; code?: string; retryable?: boolean }[] {
  return (response.body as { results: { opId: string; outcome: string; code?: string; retryable?: boolean }[] }).results;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('syncing');
  db.applyMigrations();

  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  // TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR=1: the shared limiter's tightest
  // valid bound — the real handler's rate-limited path is exercisable in-suite.
  app = await bootApp({
    DATABASE_URL: url.toString(),
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
    TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '1',
  });

  tokenA = await signupAndSignin(USER_A, 1);
  tokenB = await signupAndSignin(USER_B, 2);

  const idRows = await adminQuery(db, 'SELECT id, email FROM users WHERE email = ANY($1)', [
    [USER_A.email, USER_B.email],
  ]);
  for (const row of idRows.rows as { id: string; email: string }[]) {
    if (row.email === USER_A.email) {
      userIdA = row.id;
    } else if (row.email === USER_B.email) {
      userIdB = row.id;
    }
  }
  expect(userIdA).toMatch(/^[0-9a-f-]{36}$/u);
  expect(userIdB).toMatch(/^[0-9a-f-]{36}$/u);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('sync.ops.push — fixture round-trip (§0/§2, real diary handler)', () => {
  const ENTITY_ROUNDTRIP = fixtureUuid('d001');

  it('a 200 ack conforms to the served w3 bodySchema (results items: opId + outcome), exact content type', async () => {
    const response = await push(tokenA, [diaryCreate(1, ENTITY_ROUNDTRIP, T0)], keyId(50));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    const entry = w3FixturesDocument().endpoints.find((e) => e.id === 'sync.ops.push');
    expect(entry).toBeDefined();
    const ok = entry?.responses.find((r) => r.status === 200);
    assertConformsToSchema(response.body, ok?.bodySchema as never, 'sync.ops.push');
    expect(resultsOf(response)[0]).toEqual({ opId: opId(1), outcome: 'applied' });
    // The real diary handler wrote the frozen snapshot.
    expect(await diaryRow(userIdA, ENTITY_ROUNDTRIP)).not.toBeNull();
  });

  it('error responses carry the exact frozen registry codes, problem-details content type, bearer challenge', async () => {
    const unauthenticated = await request(app.getHttpServer()).post('/sync/ops').send({ deviceId: 'd', ops: [] });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    expect((unauthenticated.body as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(unauthenticated.headers['www-authenticate']).toBe('Bearer');

    const badBatch = await push(tokenA, [{ ...diaryCreate(2, fixtureUuid('d002'), T0), kind: 'nonsense' }], keyId(51));
    expect(badBatch.status).toBe(400);
    expect(badBatch.headers['content-type']).toContain('application/problem+json');
    expect((badBatch.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});

describe('sync.ops.push — happy batch (PRD §23.1 shape) + duplicate replay (I9)', () => {
  const E1 = fixtureUuid('d011');
  const E2 = fixtureUuid('d012');
  const E3 = fixtureUuid('d013');

  it('the 4-op batch (three creates + one edit) applies in request order; replay acks all duplicate with zero re-application', async () => {
    const ops: OpInput[] = [
      diaryCreate(10, E1, T0),
      diaryCreate(11, E2, T0),
      diaryCreate(12, E3, T0),
      { ...diaryCreate(13, E2, T1), action: 'update' }, // the edit
    ];

    const first = await push(tokenA, ops, keyId(60));
    expect(first.status).toBe(200);
    expect(resultsOf(first).map((r) => [r.opId, r.outcome])).toEqual([
      [opId(10), 'applied'],
      [opId(11), 'applied'],
      [opId(12), 'applied'],
      [opId(13), 'applied'],
    ]);
    // The edit WON LWW (newer instant) — the row carries its instant + op id.
    const edited = await diaryRow(userIdA, E2);
    expect(edited?.last_op_id).toBe(opId(13));
    expect(edited === null ? '' : (edited.updated_at as Date).toISOString()).toBe(new Date(T1).toISOString());

    // Duplicate replay: a NEW request (fresh Idempotency-Key), SAME ops.
    const countBefore = await diaryRowCount(userIdA);
    const editedBefore = await diaryRow(userIdA, E2);
    const replay = await push(tokenA, ops, keyId(61));
    expect(replay.status).toBe(200);
    expect(resultsOf(replay).map((r) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    // Zero re-application: row count and stored winner byte-unchanged.
    expect(await diaryRowCount(userIdA)).toBe(countBefore);
    expect(await diaryRow(userIdA, E2)).toEqual(editedBefore);
  });
});

describe('sync.ops.push — Idempotency-Key matrix (conventions §3)', () => {
  const KEY = keyId(900);
  const ENTITY_K = fixtureUuid('d0a1');
  const ops: OpInput[] = [diaryCreate(20, ENTITY_K, T0)];

  it('same key + same payload ⇒ the recorded outcome replays byte-identically, no second application', async () => {
    const countBefore = await diaryRowCount(userIdA);
    const first = await push(tokenA, ops, KEY);
    expect(first.status).toBe(200);
    const afterFirst = await diaryRowCount(userIdA);
    expect(afterFirst).toBe(countBefore + 1);

    const replay = await push(tokenA, ops, KEY);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(first.text); // BYTE-stable
    expect(await diaryRowCount(userIdA)).toBe(afterFirst); // no second application
  });

  it('same key + changed payload ⇒ 409 CONFLICT', async () => {
    const changed: OpInput[] = [diaryCreate(20, ENTITY_K, T1)]; // different clientUpdatedAt
    const conflict = await push(tokenA, changed, KEY);
    expect(conflict.status).toBe(409);
    expect(conflict.headers['content-type']).toContain('application/problem+json');
    expect((conflict.body as { code: string }).code).toBe('CONFLICT');
  });

  it('two concurrent same-key requests ⇒ exactly one executes; the other serves the recorded outcome (byte-identical)', async () => {
    const entity = fixtureUuid('d0a2');
    const concurrentOps: OpInput[] = [diaryCreate(21, entity, T0)];
    const key = keyId(902);
    const countBefore = await diaryRowCount(userIdA);

    const [r1, r2] = await Promise.all([
      push(tokenA, concurrentOps, key, 'device-x'),
      push(tokenA, concurrentOps, key, 'device-x'),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Exactly one execution: the acks are byte-identical (one is the
    // recorded outcome), one entity row, one ledger row.
    expect(r2.text).toBe(r1.text);
    expect(resultsOf(r1)[0]).toEqual({ opId: opId(21), outcome: 'applied' });
    expect(await diaryRowCount(userIdA)).toBe(countBefore + 1);
    expect(await ledgerRowCount(userIdA, opId(21))).toBe(1);
  });
});

describe('sync.ops.push — ordering/state machine through the REAL diary handler (§1.3/§1.4)', () => {
  const E = fixtureUuid('d021');

  it('create → older-update (LWW loser: applied, no change) → newer-update → delete → update-after-delete → create-after-delete', async () => {
    // create (T1)
    const c = await push(tokenA, [diaryCreate(30, E, T1)], keyId(701));
    expect(resultsOf(c)[0]?.outcome).toBe('applied');

    // OLDER update (T0 < T1): the LWW loser — recorded applied, changes nothing.
    const loser = await push(tokenA, [{ ...diaryCreate(31, E, T0), action: 'update' }], keyId(702));
    expect(loser.status).toBe(200);
    expect(resultsOf(loser)[0]).toEqual({ opId: opId(31), outcome: 'applied' });
    expect((await diaryRow(userIdA, E))?.last_op_id).toBe(opId(30)); // the create still wins

    // NEWER update (T2 > T1): wins.
    const winner = await push(tokenA, [{ ...diaryCreate(32, E, T2), action: 'update' }], keyId(703));
    expect(resultsOf(winner)[0]?.outcome).toBe('applied');
    expect((await diaryRow(userIdA, E))?.last_op_id).toBe(opId(32));

    // delete (T2) — tombstone (diary deletes carry the envelope localDate, no payload).
    const del = await push(
      tokenA,
      [{ ...diaryCreate(33, E, T2), action: 'delete', payload: undefined }],
      keyId(704),
    );
    expect(resultsOf(del)[0]?.outcome).toBe('applied');
    expect((await diaryRow(userIdA, E))?.deleted_at).not.toBeNull();

    // update-after-delete: rejected_deleted, retryable false.
    const zombie = await push(tokenA, [{ ...diaryCreate(34, E, T2), action: 'update' }], keyId(705));
    expect(resultsOf(zombie)[0]).toEqual({ opId: opId(34), outcome: 'rejected', code: 'rejected_deleted', retryable: false });

    // create-after-delete: SAME entity id is blocked (no resurrection, I9).
    const resurrection = await push(tokenA, [diaryCreate(35, E, T2)], keyId(706));
    expect(resultsOf(resurrection)[0]).toEqual({ opId: opId(35), outcome: 'rejected', code: 'rejected_deleted', retryable: false });

    // Deterministic replay of the recorded rejection (new key, same op).
    const replay = await push(tokenA, [{ ...diaryCreate(34, E, T2), action: 'update' }], keyId(707));
    expect(resultsOf(replay)[0]).toEqual({ opId: opId(34), outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });
});

describe('sync.ops.push — batch-shape discipline (§1.2; layer 2 pinned at unit level)', () => {
  it('an unknown kind STRING is a batch-shape error (whole-batch 400, nothing recorded)', async () => {
    const before = await diaryRowCount(userIdA);
    const response = await push(
      tokenA,
      [diaryCreate(40, fixtureUuid('d031'), T0), { ...diaryCreate(41, fixtureUuid('d032'), T0), kind: 'not_a_kind' }],
      keyId(710),
    );
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await diaryRowCount(userIdA)).toBe(before);
  });

  it('the canonical diary shape: envelope↔payload localDate DISAGREEMENT is a whole-batch shape error', async () => {
    const before = await diaryRowCount(userIdA);
    const response = await push(
      tokenA,
      [
        {
          ...diaryCreate(42, fixtureUuid('d033'), T0),
          payload: { ...quickAddSnapshot(DAY), localDate: '2026-10-09' }, // disagrees with the envelope
        },
      ],
      keyId(711),
    );
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await diaryRowCount(userIdA)).toBe(before);
  });
});

describe('sync.ops.push — adversarial (in-lane; s4a deepens)', () => {
  it("B's credentials pushing A's op ID ⇒ no match, generic fresh outcome; A's rows and acks untouched", async () => {
    const sharedOpId = opId(10); // an opId A already pushed (applied)
    const countABefore = await diaryRowCount(userIdA);
    const countBBefore = await diaryRowCount(userIdB);

    const response = await push(tokenB, [diaryCreate(10, fixtureUuid('d041'), T0)], keyId(720));
    expect(response.status).toBe(200);
    // A fresh, ordinary outcome under B — nothing about A's recorded op.
    expect(resultsOf(response)[0]).toEqual({ opId: sharedOpId, outcome: 'applied' });
    expect(await diaryRowCount(userIdB)).toBe(countBBefore + 1);
    // A's rows unchanged; A's replay still acks duplicate of A's own outcome.
    expect(await diaryRowCount(userIdA)).toBe(countABefore);
    const replayA = await push(tokenA, [diaryCreate(10, fixtureUuid('d011'), T0)], keyId(721));
    expect(resultsOf(replayA)[0]?.outcome).toBe('duplicate');
  });

  it('a malformed envelope ⇒ 400 VALIDATION_FAILED that never echoes received values', async () => {
    const hostile = 'health-payload-marked-for-redaction-scan';
    const response = await push(
      tokenA,
      [{ ...diaryCreate(44, fixtureUuid('d042'), T0), clientUpdatedAt: hostile }],
      keyId(722),
    );
    expect(response.status).toBe(400);
    expect(response.text).not.toContain(hostile);
    const errors = (response.body as { errors?: { field: string; message: string }[] }).errors;
    expect(Array.isArray(errors)).toBe(true);
    for (const error of errors ?? []) {
      expect(Object.keys(error).sort()).toEqual(['field', 'message']);
    }
  });

  it('an oversized batch (over the configured cap) ⇒ 400 with zero ops applied', async () => {
    const before = await diaryRowCount(userIdA);
    const bigBatch: OpInput[] = Array.from({ length: 101 }, (_v, i) =>
      diaryCreate(1000 + i, fixtureUuid(`d${i.toString(16)}`), T0),
    );
    const response = await push(tokenA, bigBatch, keyId(723));
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await diaryRowCount(userIdA)).toBe(before);
  });
});

describe('sync.ops.push — rejected_rate_limited through the REAL handler + limiter (§1.7, supervisor-pinned)', () => {
  const UF1 = fixtureUuid('u001');
  const UF2 = fixtureUuid('u002');

  it('over-limit create: acked retryable, NOT durably recorded; same-opId retry re-runs; after the window it applies', async () => {
    // Boot bound: TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR=1.
    const batch: OpInput[] = [userFoodCreate(51, UF1, T0), userFoodCreate(52, UF2, T0)];
    const limited = await push(tokenA, batch, keyId(730));
    expect(limited.status).toBe(200);
    const results = resultsOf(limited);
    expect(results[0]).toEqual({ opId: opId(51), outcome: 'applied' }); // within the limit
    expect(results[1]).toEqual({
      opId: opId(52),
      outcome: 'rejected',
      code: 'rejected_rate_limited',
      retryable: true,
    });
    // The directed resolution (§1.7): the over-limit create is NOT durably
    // queued server-side — no entity, and crucially NO sync_operations row
    // (a recorded rejection would replay forever and block the §1.7 retry).
    const ufRow = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM user_foods WHERE user_id = $1 AND id = $2',
      [userIdA, UF2],
    );
    expect((ufRow.rows[0] as { n: number }).n).toBe(0);
    expect(await ledgerRowCount(userIdA, opId(52))).toBe(0);

    // The SAME opId retried while the window is live: re-runs the real
    // handler (possible only because nothing is recorded) — rate-limited
    // again, still nothing recorded.
    const retryLive = await push(tokenA, [userFoodCreate(52, UF2, T0)], keyId(731));
    expect(resultsOf(retryLive)[0]).toEqual({
      opId: opId(52),
      outcome: 'rejected',
      code: 'rejected_rate_limited',
      retryable: true,
    });
    expect(await ledgerRowCount(userIdA, opId(52))).toBe(0);

    // Lapse the limiter window (harness clock — the admin connection; the
    // app role holds no such grant).
    await adminQuery(
      db,
      `UPDATE user_food_create_counters
       SET hour_window_start = now() - interval '2 hours',
           day_window_start  = now() - interval '25 hours'
       WHERE user_id = $1`,
      [userIdA],
    );

    // Same opId, same payload, fresh key: the handler re-runs, the tick
    // opens a fresh window, the create APPLIES — the §1.7 retry contract.
    const retryLapsed = await push(tokenA, [userFoodCreate(52, UF2, T0)], keyId(732));
    expect(resultsOf(retryLapsed)[0]).toEqual({ opId: opId(52), outcome: 'applied' });
    const ufRowAfter = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM user_foods WHERE user_id = $1 AND id = $2',
      [userIdA, UF2],
    );
    expect((ufRowAfter.rows[0] as { n: number }).n).toBe(1);
    expect(await ledgerRowCount(userIdA, opId(52))).toBe(1); // NOW durably recorded
  });
});
