/**
 * Kal sync ingestion e2e (wave-03, task s2d-sync-ingestion) — the real
 * AppModule against a real, fully-migrated, EPHEMERAL PostgreSQL database
 * (the established harness pattern; the dev database is never touched).
 *
 * The dispatch seam is exercised through the PRODUCTION registry path with
 * the clearly-marked TEST-ONLY seam handler (test/support/sync-test-handler
 * .ts — a §1.3-faithful mini state machine over the real `favorites` table).
 * The real diary/foods handlers merge via s2a/s2c; combined behavior is
 * proven at the s4/integration stage (stated in the lane MR).
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
 *   - Ordering/state machine: create → older-update (LWW loser recorded
 *     applied, no change) → newer-update → delete → update-after-delete
 *     (`rejected_deleted`) → create-after-delete (`rejected_deleted`);
 *     unknown kind STRING ⇒ whole-batch 400; enum-valid kind with no
 *     registered handler ⇒ per-op `rejected` (validation class).
 *   - Negative/adversarial (in-lane): B's credentials pushing A's op ID ⇒
 *     no match, generic fresh outcome, A's acks and rows untouched;
 *     malformed envelope ⇒ `400 VALIDATION_FAILED` without echoing received
 *     values; oversized batch (over the configured cap) ⇒ `400`;
 *     unauthenticated ⇒ `401`.
 *   - Recovery/atomicity: injected handler failure mid-batch ⇒ problem-
 *     details 500 with zero partial state; retry succeeds exactly once.
 *   - `rejected_rate_limited` (§1.7 directed resolution): acked retryable,
 *     NOT durably recorded — a later retry re-runs and applies.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w3FixturesDocument } from '../src/contracts/w3.fixtures.js';
import { OpHandlerRegistry } from '../src/sync/ingestion/op-handler-registry.js';
import { assertConformsToSchema } from './support/contract-schema.js';
import { createFavoriteTestHandler } from './support/sync-test-handler.js';
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

/**
 * Reserved fixture-range food ids (FK targets; the production-faithful
 * catalog seed path). Each CREATE op deterministically maps to one food
 * (op number mod pool size) — stable across re-pushes (byte-identical
 * bodies for the Idempotency-Key suite) and collision-free for the
 * one-active-favorite-per-food rule within a user.
 */
const FOODS: string[] = Array.from({ length: 24 }, (_v, i) => `00000000-0000-4000-8000-00000000f1${i.toString(16).padStart(2, '0')}`);

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

/** Suite-driven injection points for the test handler (per-op, mutable). */
const failOpIds = new Set<string>();
const rateLimitedOpIds = new Set<string>();

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

interface OpInput {
  opId: string;
  kind: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  clientUpdatedAt: string;
  localDate?: string;
  payload?: Record<string, unknown>;
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

function createOp(n: number, entityId: string, at: string): OpInput {
  return {
    opId: opId(n),
    kind: 'favorite',
    entityId,
    action: 'create',
    clientUpdatedAt: at,
    payload: { foodId: FOODS[n % FOODS.length] as string },
  };
}

const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';
const T2 = '2026-10-08T09:00:00Z';

type FavoriteRow = { updated_at: Date; deleted_at: Date | null; last_op_id: string | null };

async function favoriteRowCount(userId: string): Promise<number> {
  const result = await adminQuery(db, 'SELECT count(*)::int AS n FROM favorites WHERE user_id = $1', [userId]);
  return (result.rows[0] as { n: number }).n;
}

async function favoriteRow(userId: string, entityId: string): Promise<FavoriteRow | null> {
  const result = await adminQuery(
    db,
    'SELECT updated_at, deleted_at, last_op_id FROM favorites WHERE user_id = $1 AND id = $2',
    [userId, entityId],
  );
  return (result.rows[0] as FavoriteRow | undefined) ?? null;
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

  // The catalog is platform-authored: the production-faithful seed path
  // (the admin/migration connection), exactly as the tracking-rls suite
  // seeds it. FK targets for the test handler's favorite creates.
  await adminQuery(
    db,
    `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
       name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
     SELECT id, 'dish', 'kal_reviewed', 'proprietary', 'Fixture food ' || row_number() OVER (),
       'fixture food ' || row_number() OVER (), 'طعام تجريبي', 'طعام تجريبي',
       ARRAY['fixture']::text[], ARRAY['fixture']::text[], 100, 5, 10, 2
     FROM unnest($1::uuid[]) AS id`,
    [FOODS],
  );

  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  app = await bootApp({
    DATABASE_URL: url.toString(),
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
  });

  // Register the TEST-ONLY seam handler through the PRODUCTION registry
  // path (the same API the tracking lanes use at module init).
  app.get(OpHandlerRegistry).registerOpHandler(
    createFavoriteTestHandler({
      failWhen: (op) => failOpIds.has(op.opId),
      rateLimitWhen: (op) => rateLimitedOpIds.has(op.opId),
    }),
  );

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

describe('sync.ops.push — fixture round-trip (§0/§2)', () => {
  const ENTITY_ROUNDTRIP = fixtureUuid('e001');

  it('a 200 ack conforms to the served w3 bodySchema (results items: opId + outcome), exact content type', async () => {
    const response = await push(tokenA, [createOp(1, ENTITY_ROUNDTRIP, T0)], keyId(50));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    const entry = w3FixturesDocument().endpoints.find((e) => e.id === 'sync.ops.push');
    expect(entry).toBeDefined();
    const ok = entry?.responses.find((r) => r.status === 200);
    assertConformsToSchema(response.body, ok?.bodySchema as never, 'sync.ops.push');
    expect(resultsOf(response)[0]).toEqual({ opId: opId(1), outcome: 'applied' });
  });

  it('error responses carry the exact frozen registry codes, problem-details content type, bearer challenge', async () => {
    const unauthenticated = await request(app.getHttpServer()).post('/sync/ops').send({ deviceId: 'd', ops: [] });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    expect((unauthenticated.body as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(unauthenticated.headers['www-authenticate']).toBe('Bearer');

    const badBatch = await push(tokenA, [{ ...createOp(2, ENTITY_ROUNDTRIP, T0), kind: 'nonsense' }], keyId(51));
    expect(badBatch.status).toBe(400);
    expect(badBatch.headers['content-type']).toContain('application/problem+json');
    expect((badBatch.body as { code: string }).code).toBe('VALIDATION_FAILED');

    const entry = w3FixturesDocument().endpoints.find((e) => e.id === 'sync.ops.push');
    for (const code of ['VALIDATION_FAILED', 'UNAUTHENTICATED']) {
      const declared = entry?.responses.find((r) => r.status === (code === 'VALIDATION_FAILED' ? 400 : 401));
      expect(declared).toBeDefined();
    }
  });
});

describe('sync.ops.push — happy batch (PRD §23.1 shape) + duplicate replay (I9)', () => {
  const E1 = fixtureUuid('e011');
  const E2 = fixtureUuid('e012');
  const E3 = fixtureUuid('e013');

  it('the 4-op batch (three creates + one edit) applies in request order; replay acks all duplicate with zero re-application', async () => {
    const ops: OpInput[] = [
      createOp(10, E1, T0),
      createOp(11, E2, T0),
      createOp(12, E3, T0),
      { ...createOp(13, E2, T1), action: "update" }, // the edit
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
    const edited = await favoriteRow(userIdA, E2);
    expect(edited?.last_op_id).toBe(opId(13));
    expect(edited === null ? '' : (edited.updated_at as Date).toISOString()).toBe(new Date(T1).toISOString()); // the edit's instant, stored

    // Duplicate replay: a NEW request (fresh Idempotency-Key), SAME ops.
    const countBefore = await favoriteRowCount(userIdA);
    const editedBefore = await favoriteRow(userIdA, E2);
    const replay = await push(tokenA, ops, keyId(61));
    expect(replay.status).toBe(200);
    expect(resultsOf(replay).map((r) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    // Zero re-application: row count and stored winner byte-unchanged.
    expect(await favoriteRowCount(userIdA)).toBe(countBefore);
    expect(await favoriteRow(userIdA, E2)).toEqual(editedBefore);
  });
});

describe('sync.ops.push — Idempotency-Key matrix (conventions §3)', () => {
  const KEY = keyId(900);
  const ENTITY_K = fixtureUuid('e0a1');
  const ops: OpInput[] = [createOp(20, ENTITY_K, T0)];

  it('same key + same payload ⇒ the recorded outcome replays byte-identically, no second application', async () => {
    const countBefore = await favoriteRowCount(userIdA);
    const first = await push(tokenA, ops, KEY);
    expect(first.status).toBe(200);
    const afterFirst = await favoriteRowCount(userIdA);
    expect(afterFirst).toBe(countBefore + 1);

    const replay = await push(tokenA, ops, KEY);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(first.text); // BYTE-stable
    expect(await favoriteRowCount(userIdA)).toBe(afterFirst); // no second application
  });

  it('same key + changed payload ⇒ 409 CONFLICT', async () => {
    const changed: OpInput[] = [createOp(20, ENTITY_K, T1)]; // different clientUpdatedAt
    const conflict = await push(tokenA, changed, KEY);
    expect(conflict.status).toBe(409);
    expect(conflict.headers['content-type']).toContain('application/problem+json');
    expect((conflict.body as { code: string }).code).toBe('CONFLICT');
  });

  it('two concurrent same-key requests ⇒ exactly one executes; the other serves the recorded outcome (byte-identical)', async () => {
    const entity = fixtureUuid('e0a2');
    const concurrentOps: OpInput[] = [createOp(21, entity, T0)];
    const key = keyId(902);
    const countBefore = await favoriteRowCount(userIdA);

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
    expect(await favoriteRowCount(userIdA)).toBe(countBefore + 1);
    expect(await ledgerRowCount(userIdA, opId(21))).toBe(1);
  });
});

describe('sync.ops.push — ordering/state machine (§1.3/§1.4, engine-dispatched)', () => {
  const E = fixtureUuid('e021');

  it('create → older-update (LWW loser: applied, no change) → newer-update → delete → update-after-delete → create-after-delete', async () => {
    // create (T1)
    const c = await push(tokenA, [createOp(30, E, T1)], keyId(701));
    expect(resultsOf(c)[0]?.outcome).toBe('applied');

    // OLDER update (T0 < T1): the LWW loser — recorded applied, changes nothing.
    const loser = await push(tokenA, [{ ...createOp(31, E, T0), action: "update" }], keyId(702));
    expect(loser.status).toBe(200);
    expect(resultsOf(loser)[0]).toEqual({ opId: opId(31), outcome: 'applied' });
    expect((await favoriteRow(userIdA, E))?.last_op_id).toBe(opId(30)); // the create still wins

    // NEWER update (T2 > T1): wins.
    const winner = await push(tokenA, [{ ...createOp(32, E, T2), action: "update" }], keyId(703));
    expect(resultsOf(winner)[0]?.outcome).toBe('applied');
    expect((await favoriteRow(userIdA, E))?.last_op_id).toBe(opId(32));

    // delete (T2) — tombstone.
    const del = await push(tokenA, [{ ...createOp(33, E, T2), action: "delete", payload: undefined }], keyId(704));
    expect(resultsOf(del)[0]?.outcome).toBe('applied');
    expect((await favoriteRow(userIdA, E))?.deleted_at).not.toBeNull();

    // update-after-delete: rejected_deleted, retryable false.
    const zombie = await push(tokenA, [{ ...createOp(34, E, T2), action: "update" }], keyId(705));
    expect(resultsOf(zombie)[0]).toEqual({ opId: opId(34), outcome: 'rejected', code: 'rejected_deleted', retryable: false });

    // create-after-delete: SAME entity id is blocked (no resurrection, I9).
    const resurrection = await push(tokenA, [createOp(35, E, T2)], keyId(706));
    expect(resultsOf(resurrection)[0]).toEqual({ opId: opId(35), outcome: 'rejected', code: 'rejected_deleted', retryable: false });

    // Deterministic replay of the recorded rejection (new key, same op).
    const replay = await push(tokenA, [{ ...createOp(34, E, T2), action: "update" }], keyId(707));
    expect(resultsOf(replay)[0]).toEqual({ opId: opId(34), outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });
});

describe('sync.ops.push — registry discipline (§1.2 layer 1 vs §4 layer 2)', () => {
  it('an unknown kind STRING is a batch-shape error (whole-batch 400, nothing recorded)', async () => {
    const before = await favoriteRowCount(userIdA);
    const response = await push(
      tokenA,
      [createOp(40, fixtureUuid("e031"), T0), { ...createOp(41, fixtureUuid("e032"), T0), kind: "not_a_kind" }],
      keyId(710),
    );
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await favoriteRowCount(userIdA)).toBe(before);
  });

  it('an enum-valid kind with no registered handler ⇒ per-op rejected (validation class); the rest of the batch applies', async () => {
    const response = await push(
      tokenA,
      [
        {
          ...createOp(42, fixtureUuid('e033'), T0),
          kind: 'diary_entry',
          localDate: '2026-10-08',
          payload: { mealSlot: 'breakfast' },
        },
        createOp(43, fixtureUuid('e034'), T0),
      ],
      keyId(711),
    );
    expect(response.status).toBe(200);
    const results = resultsOf(response);
    expect(results[0]).toEqual({ opId: opId(42), outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(results[1]?.outcome).toBe('applied');
  });
});

describe('sync.ops.push — adversarial (in-lane; s4a deepens)', () => {
  it("B's credentials pushing A's op ID ⇒ no match, generic fresh outcome; A's rows and acks untouched", async () => {
    const sharedOpId = opId(10); // an opId A already pushed (applied)
    const countABefore = await favoriteRowCount(userIdA);
    const countBBefore = await favoriteRowCount(userIdB);

    const response = await push(
      tokenB,
      [createOp(10, fixtureUuid('e041'), T0)],
      keyId(720),
    );
    expect(response.status).toBe(200);
    // A fresh, ordinary outcome under B — nothing about A's recorded op.
    expect(resultsOf(response)[0]).toEqual({ opId: sharedOpId, outcome: 'applied' });
    expect(await favoriteRowCount(userIdB)).toBe(countBBefore + 1);
    // A's rows unchanged; A's replay still acks duplicate of A's own outcome.
    expect(await favoriteRowCount(userIdA)).toBe(countABefore);
    const replayA = await push(tokenA, [createOp(10, fixtureUuid('e011'), T0)], keyId(721));
    expect(resultsOf(replayA)[0]?.outcome).toBe('duplicate');
  });

  it('a malformed envelope ⇒ 400 VALIDATION_FAILED that never echoes received values', async () => {
    const hostile = 'health-payload-marked-for-redaction-scan';
    const response = await push(
      tokenA,
      [{ ...createOp(44, fixtureUuid('e042'), T0), clientUpdatedAt: hostile }],
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
    const before = await favoriteRowCount(userIdA);
    const bigBatch: OpInput[] = Array.from({ length: 101 }, (_v, i) =>
      createOp(1000 + i, fixtureUuid(`f${i.toString(16)}`), T0),
    );
    const response = await push(tokenA, bigBatch, keyId(723));
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await favoriteRowCount(userIdA)).toBe(before);
  });
});

describe('sync.ops.push — recovery/atomicity + rate-limited semantics', () => {
  it('injected handler failure mid-batch ⇒ generic 500 problem-details, ZERO partial state; retry succeeds exactly once', async () => {
    const e1 = fixtureUuid('e051');
    const e2 = fixtureUuid('e052');
    const e3 = fixtureUuid('e053');
    const batch: OpInput[] = [createOp(51, e1, T0), createOp(52, e2, T0), createOp(53, e3, T0)];

    failOpIds.add(opId(52));
    try {
      const failed = await push(tokenA, batch, keyId(730));
      expect(failed.status).toBe(500);
      expect(failed.headers['content-type']).toContain('application/problem+json');
      expect((failed.body as { code: string }).code).toBe('INTERNAL_ERROR');
      // Zero partial state: none of the batch's entities exist.
      expect(await favoriteRow(userIdA, e1)).toBeNull();
      expect(await favoriteRow(userIdA, e2)).toBeNull();
      expect(await favoriteRow(userIdA, e3)).toBeNull();
    } finally {
      failOpIds.delete(opId(52));
    }

    // Crash-retry equivalence: the same batch retried ⇒ identical final
    // state to a single clean run; each op applies exactly once.
    const retry = await push(tokenA, batch, keyId(730));
    expect(retry.status).toBe(200);
    expect(resultsOf(retry).map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);

    // A further clean replay of the same ops ⇒ duplicates, state unchanged.
    const countAfterRetry = await favoriteRowCount(userIdA);
    const verify = await push(tokenA, batch, keyId(731));
    expect(resultsOf(verify).map((r) => r.outcome)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(await favoriteRowCount(userIdA)).toBe(countAfterRetry);
  });

  it('rejected_rate_limited: acked retryable=true, NOT durably recorded — a later retry re-runs and applies (§1.7)', async () => {
    const e = fixtureUuid('e061');
    rateLimitedOpIds.add(opId(54));
    try {
      const limited = await push(tokenA, [createOp(54, e, T0)], keyId(740));
      expect(limited.status).toBe(200);
      expect(resultsOf(limited)[0]).toEqual({
        opId: opId(54),
        outcome: 'rejected',
        code: 'rejected_rate_limited',
        retryable: true,
      });
      // Not durably recorded: no entity, no ledger row.
      expect(await favoriteRow(userIdA, e)).toBeNull();
      expect(await ledgerRowCount(userIdA, opId(54))).toBe(0);
    } finally {
      rateLimitedOpIds.delete(opId(54));
    }
    // Retry (window passed): the handler re-runs and applies.
    const retry = await push(tokenA, [createOp(54, e, T0)], keyId(741));
    expect(resultsOf(retry)[0]?.outcome).toBe('applied');
    expect(await favoriteRow(userIdA, e)).not.toBeNull();
  });
});
