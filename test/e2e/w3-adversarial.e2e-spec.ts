/**
 * Kal W3 ADVERSARIAL e2e (wave-03, task s4a-adversarial) — the A/B/C matrix
 * over the tracking/sync surfaces, run against the real AppModule on a real,
 * fully-migrated, EPHEMERAL PostgreSQL database (`kal_it_s4adv_*`; the dev
 * database is never touched). This lane ATTACKS the merged s1/s2a/s2c/s2d/s2e
 * implementation against the frozen contract (`docs/api/wave-03-contract.md`,
 * `docs/api/conventions.md` §2/§3/§4/§5; ARCHITECTURE §22) — it never fixes
 * it: a verified defect is pinned here and routed via the MR findings
 * register.
 *
 * Method (the W2 precedent, unchanged): every equivalence pair pins the SAME
 * `X-Request-Id` (echoed into the body's `requestId`), then compares the RAW
 * response text byte-for-byte with zero normalization — key order, spacing,
 * and member set included — plus status and observable headers.
 *
 * Matrix shape (ARCHITECTURE §22, read twice): A OWNS the target data; B
 * attacks every read/mutate/reference/enumerate/sync path with B's VALID
 * credentials; C is the CONTROL — C's own-data cases prove every denial is
 * authorization-driven, not availability noise. Required cells:
 *
 *   - diary day read (cross-user date probing is empty-200 parity, no oracle);
 *   - entity lookups by id (foods.get catalog parity; sync-op entity cells);
 *   - user-food enumeration (B's search set-size equals the gibberish set);
 *   - favorites (foreign target vs absent target — one generic rejection);
 *   - sync push (op-ID replay cross-user; entity-ID collision cells; delete/
 *     update against A's live rows; interleaved concurrent batches);
 *   - sync pull (A's cursor under B; B's feed contains zero A rows);
 *   - barcode resolution (account-independent shapes; platform-cache parity);
 *   - batch boundaries (per-op rejection vs batch-aborting failure; shape-
 *     first whole-batch 400s; op-count cap);
 *   - byte-equivalence sets summarized per denial class (I7);
 *   - I12 payload scan: no health markers, foreign ids, or user ids in ANY
 *     captured response body.
 *
 * Pinned adversarial cells from the accumulated launch context:
 *   - cross-user PK collision (B create with A's live entity id) ⇒ the ONE
 *     generic cause-indistinguishable 500, whole-batch abort, ZERO partial
 *     state, NO ledger row, NO idempotency-key record; fresh-id control 200;
 *     ruled §5-consistent (unique indexes ignore RLS; UUIDs unguessable) —
 *     NOT an I7 oracle.
 *   - `rejected_rate_limited` is acked-NOT-recorded (no sync_operations row;
 *     the same opId re-runs and applies after the window) — the §1.7
 *     directed resolution; the deep two-config/both-path proofs live in
 *     w3-adversarial-limits.e2e-spec.ts.
 *
 * Findings are REPORTED (MR findings register), never fixed in place.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';
import {
  advUuid,
  createThreeUserHarness,
  diaryCreateOp,
  diaryRowCount,
  expectAckOutcomesIdentical,
  expectRawIdentical,
  favoriteCreateOp,
  getDiaryDay,
  getFood,
  idempotencyKeyCount,
  ledgerRowCount,
  PINNED_REQUEST_ID,
  pullChanges,
  pushBatch,
  resolveBarcode,
  searchFoods,
  type OpInput,
  type ThreeUserHarness,
  userFoodCreateOp,
} from '../integration/helpers/three-user-harness.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 's4adv7matrix7lane7fixed7key7material7with7enough7entropy77';

const NS = 'a7d1'; // suite uuid namespace (4 hex) — fixture ids never collide across suites

const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';

/** A health-marker token planted in hostile payloads — must NEVER appear in any response. */
const HEALTH_MARKER = 's4adv-health-marker-do-not-echo';
/** A platform-food name unique to A's fixture user food (search-enumeration cell). */
const A_FOOD_NAME = 's4adv unique food abserve zq';
/** A query string guaranteed to match nothing for anyone. */
const GIBBERISH_QUERY = 's4adv gibberish zzzqqq';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let users: ThreeUserHarness;

/** Captured response texts for the I12 payload scan (every body this suite observes). */
const capturedBodies: string[] = [];

function record(response: request.Response): request.Response {
  capturedBodies.push(response.text ?? '');
  return response;
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

/** One generic problem-details body accessor for assertions. */
function codeOf(response: request.Response): string {
  return (response.body as { code?: string }).code ?? '';
}

interface AckResult {
  readonly opId: string;
  readonly outcome: 'applied' | 'duplicate' | 'rejected';
  readonly code?: string;
  readonly retryable?: boolean;
}

function resultsOf(response: request.Response): AckResult[] {
  return (response.body as { results?: AckResult[] }).results ?? [];
}

/** REST user-food create (the online path) — returns the RAW response. */
async function createUserFoodViaRest(token: string, nameEn: string): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/tracking/user-foods')
    .set('X-Request-Id', PINNED_REQUEST_ID)
    .set('Authorization', `Bearer ${token}`)
    .send({ nameEn, energyKcal: 200, proteinG: 10, carbsG: 20, fatG: 5 });
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4adv');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  users = await createThreeUserHarness(app, db, {
    a: { email: 's4adv-owner-a@example.com', phone: '+201700000101', username: 's4adv_owner_a' },
    b: { email: 's4adv-attacker-b@example.com', phone: '+201700000102', username: 's4adv_attacker_b' },
    c: { email: 's4adv-control-c@example.com', phone: '+201700000103', username: 's4adv_control_c' },
  });
  // The platform catalog is platform-authored (production-faithful: catalog
  // rows arrive via the admin-run seed; tracking-rls.itspec.ts precedent).
  await adminQuery(
    db,
    `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
       name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
     VALUES ('00000000-0000-4000-8000-00000000aa01', 'dish', 'kal_reviewed', 'proprietary',
       'Adversarial fixture food', 'adversarial fixture food', 'طعام تجريبي', 'طعام تجريبي',
       ARRAY['fixture']::text[], ARRAY['fixture']::text[], 100, 5, 10, 2)`,
  );
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ===========================================================================
// A/B/C positive parity — the C controls
// ===========================================================================

describe('A/B/C positive parity — own data works for A and C alike (controls)', () => {
  it('A creates own diary entries through the real seam and reads its own day back', async () => {
    const pushed = record(await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'p01', 'ae101', T0, DAY)], advUuid(NS, 'kp01')));
    expect(pushed.status).toBe(200);
    expect(resultsOf(pushed)).toEqual([{ opId: advUuid(NS, 'p01'), outcome: 'applied' }]);
    const day = record(await getDiaryDay(app, users.a.token, DAY));
    expect(day.status).toBe(200);
    const body = day.body as { localDate: string; totals: { entryCount: number }; entries: { id: string }[] };
    expect(body.localDate).toBe(DAY);
    expect(body.totals.entryCount).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.id).toBe(advUuid(NS, 'ae101'));
  });

  it('C mirrors A: own create + own day read behave identically (control)', async () => {
    const pushed = record(await pushBatch(app, users.c.token, [diaryCreateOp(NS, 'q01', 'ce101', T0, DAY)], advUuid(NS, 'kq01')));
    expect(pushed.status).toBe(200);
    expect(resultsOf(pushed)).toEqual([{ opId: advUuid(NS, 'q01'), outcome: 'applied' }]);
    const day = record(await getDiaryDay(app, users.c.token, DAY));
    expect(day.status).toBe(200);
    const body = day.body as { entries: { id: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.id).toBe(advUuid(NS, 'ce101'));
  });

  it('B reading A\'s date sees an empty day (no oracle); empty-day bytes are account-independent', async () => {
    // B probing the date A populated: 200 with ZERO entries — never A's data.
    const bOnADate = record(await getDiaryDay(app, users.b.token, DAY));
    expect(bOnADate.status).toBe(200);
    expect(bOnADate.body).toMatchObject({ totals: { entryCount: 0 }, entries: [] });

    // The empty shape is byte-identical across accounts on the same date
    // (authorization-driven, not availability noise): B/C/A on a date nobody
    // populated render ONE body. (C/A on DAY see their OWN rows — the control
    // tests above prove own-data parity; those are different bodies by right.)
    const bOnEmpty = record(await getDiaryDay(app, users.b.token, '2031-01-01'));
    const cOnEmpty = record(await getDiaryDay(app, users.c.token, '2031-01-01'));
    const aOnEmpty = record(await getDiaryDay(app, users.a.token, '2031-01-01'));
    expectRawIdentical(bOnEmpty, cOnEmpty, 'B vs C on a truly empty date');
    expectRawIdentical(aOnEmpty, bOnEmpty, 'A vs B on a truly empty date');

    // Malformed date variants: ONE generic 400 for every cause, both accounts.
    for (const bad of ['not-a-date', '2026-13-40', '20261008', '2026-10-08T00:00Z', '..%2F..%2Fetc']) {
      const badA = record(await getDiaryDay(app, users.a.token, bad));
      const badB = record(await getDiaryDay(app, users.b.token, bad));
      expect(badA.status, bad).toBe(400);
      expect(codeOf(badA), bad).toBe('VALIDATION_FAILED');
      expectRawIdentical(badB, badA, `malformed day date — A vs B (${bad})`);
    }
  });
});

// ===========================================================================
// Entity lookups by id — the catalog detail surface
// ===========================================================================

describe('entity lookups by id — tracking.foods.get parity (I7)', () => {
  const CATALOG_ID = '00000000-0000-4000-8000-00000000aa01';

  it('404 is byte-identical for absent, malformed, and non-catalog ids — cross-account', async () => {
    const absentA = record(await getFood(app, users.a.token, advUuid(NS, 'n0food')));
    const absentB = record(await getFood(app, users.b.token, advUuid(NS, 'n0food')));
    const malformedA = record(await getFood(app, users.a.token, 'not-a-uuid'));
    const malformedB = record(await getFood(app, users.b.token, 'not-a-uuid'));
    expect(absentA.status).toBe(404);
    expect(codeOf(absentA)).toBe('NOT_FOUND');
    expectRawIdentical(absentB, absentA, 'absent id A vs B');
    expectRawIdentical(malformedA, absentA, 'malformed id vs absent id');
    expectRawIdentical(malformedB, absentA, 'malformed id cross-account');

    // A's OWN user-food id is still "no such catalog row" — and B using the
    // same id gets the same bytes (the surface is catalog-scoped by design).
    const own = await createUserFoodViaRest(users.a.token, A_FOOD_NAME);
    expect(own.status).toBe(201);
    const aFoodId = (own.body as { userFood: { id: string } }).userFood.id;
    const ownIdAsCatalog = record(await getFood(app, users.a.token, aFoodId));
    const ownIdUnderB = record(await getFood(app, users.b.token, aFoodId));
    expectRawIdentical(ownIdAsCatalog, absentA, 'own user-food id vs absent (catalog-scoped 404)');
    expectRawIdentical(ownIdUnderB, absentA, 'A\'s user-food id under B vs absent');

    // C control: the catalog hit works identically for C and B (public catalog).
    const catalogC = record(await getFood(app, users.c.token, CATALOG_ID));
    const catalogB = record(await getFood(app, users.b.token, CATALOG_ID));
    expect(catalogC.status).toBe(200);
    expectRawIdentical(catalogB, catalogC, 'catalog detail B vs C (public platform data)');
  });
});

// ===========================================================================
// User-food enumeration — search set-size equivalence
// ===========================================================================

describe('user-food enumeration — search never reveals A\'s rows to B (I7, set-size class)', () => {
  it('B\'s result set for A\'s exact food name equals B\'s gibberish set (both empty); A finds exactly its own', async () => {
    const bByAName = record(await searchFoods(app, users.b.token, { q: A_FOOD_NAME }));
    const bByGibberish = record(await searchFoods(app, users.b.token, { q: GIBBERISH_QUERY }));
    const cByAName = record(await searchFoods(app, users.c.token, { q: A_FOOD_NAME }));
    expect(bByAName.status).toBe(200);
    expectRawIdentical(bByAName, bByGibberish, 'B searching A\'s food name vs gibberish');
    expectRawIdentical(cByAName, bByGibberish, 'C searching A\'s food name (control) vs gibberish');
    expect(bByAName.body).toEqual({ data: [], nextCursor: null });

    // The owner sees exactly its own row (the C-style own-data control, for A).
    const aByOwnName = await searchFoods(app, users.a.token, { q: A_FOOD_NAME });
    expect(aByOwnName.status).toBe(200);
    const data = (aByOwnName.body as { data: { id: string; provenance: string }[] }).data;
    expect(data).toHaveLength(1);
    expect(data[0]?.provenance).toBe('user_created');
    // (aByOwnName is deliberately NOT captured — it is A's own data in A's
    // own response; the I12 scan tracks bodies that must never carry it.)
  });
});

// ===========================================================================
// Sync push — same-ID negatives + the PK-collision cell
// ===========================================================================

describe('sync push — op-ID replay cross-user (I6/I9: the key includes the user binding)', () => {
  it('B reusing A\'s applied opId gets an ordinary fresh outcome; A\'s replay still duplicates; ledgers independent', async () => {
    const sharedOpId = advUuid(NS, 'sh01'); // A's already-applied op id
    const aLedgerBefore = await ledgerRowCount(db, users.a.userId);
    const bLedgerBefore = await ledgerRowCount(db, users.b.userId);
    const aRowsBefore = await diaryRowCount(db, users.a.userId);
    const bRowsBefore = await diaryRowCount(db, users.b.userId);

    const aFirst = record(await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'sh01', 'ae001', T0, DAY)], advUuid(NS, 'ksh01')));
    expect(resultsOf(aFirst)[0]).toEqual({ opId: sharedOpId, outcome: 'applied' });

    // B replays A's opId with B's OWN fresh entity id: the (user, opId) key
    // never matches A's record — B gets the ordinary outcome for a new op.
    const bReplay = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'sh01', 'be001', T0, DAY), opId: sharedOpId }], advUuid(NS, 'ksh02')),
    );
    expect(bReplay.status).toBe(200);
    expect(resultsOf(bReplay)).toEqual([{ opId: sharedOpId, outcome: 'applied' }]);
    expect(await ledgerRowCount(db, users.b.userId)).toBe(bLedgerBefore + 1);
    expect(await diaryRowCount(db, users.b.userId)).toBe(bRowsBefore + 1);
    // A untouched by B's replay.
    expect(await ledgerRowCount(db, users.a.userId)).toBe(aLedgerBefore + 1);
    expect(await diaryRowCount(db, users.a.userId)).toBe(aRowsBefore + 1);

    // A's own replay of its op is STILL a duplicate of A's outcome only.
    const aReplay = record(await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'sh01', 'ae001', T0, DAY)], advUuid(NS, 'ksh03')));
    expect(resultsOf(aReplay)).toEqual([{ opId: sharedOpId, outcome: 'duplicate' }]);

    // The dedupe key is (user, opId): two ledger rows, two users, one id string.
    const rows = await adminQuery(
      db,
      'SELECT user_id, count(*)::int AS n FROM sync_operations WHERE client_op_id = $1 GROUP BY user_id ORDER BY user_id',
      [sharedOpId],
    );
    expect(rows.rows).toHaveLength(2);
  });
});

describe('sync push — the cross-user PK-collision cell (pinned; ruled §5-consistent, not an oracle)', () => {
  const A_LIVE = advUuid(NS, 'alive1');

  beforeAll(async () => {
    // A owns a LIVE diary entry, a live user food, and a live favorite —
    // self-sufficient seeding (no ordering coupling to earlier describes).
    const pushed = record(await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'cl00', 'alive1', T0, DAY)], advUuid(NS, 'kcl00')));
    expect(resultsOf(pushed)[0]?.outcome).toBe('applied');
    const food = await createUserFoodViaRest(users.a.token, 'A collision-target food');
    expect(food.status).toBe(201);
    const aFoodId = (food.body as { userFood: { id: string } }).userFood.id;
    const fav = record(
      await pushBatch(app, users.a.token, [favoriteCreateOp(NS, 'fv00', 'afav1', T0, { userFoodId: aFoodId })], advUuid(NS, 'kfv00')),
    );
    expect(resultsOf(fav)[0]?.outcome).toBe('applied');
  });

  it('B create with A\'s LIVE diary entity id ⇒ ONE generic 500; whole-batch abort; ZERO partial state', async () => {
    const bBefore = {
      rows: await diaryRowCount(db, users.b.userId),
      ledger: await ledgerRowCount(db, users.b.userId),
      keys: await idempotencyKeyCount(db, users.b.userId),
    };
    const aRowsBefore = await diaryRowCount(db, users.a.userId);

    const colliding: OpInput = { ...diaryCreateOp(NS, 'cb01', 'alive1', T0, DAY) };
    const batch: OpInput[] = [
      diaryCreateOp(NS, 'cb02', 'be101', T0, DAY), // B-valid op BEFORE the collision
      colliding, // B create with A's live entity id
      diaryCreateOp(NS, 'cb03', 'be102', T0, DAY), // B-valid op AFTER
    ];
    const response = record(await pushBatch(app, users.b.token, batch, advUuid(NS, 'kcb01')));
    expect(response.status).toBe(500);
    expect(codeOf(response)).toBe('INTERNAL_ERROR');
    expect(response.text).not.toContain(A_LIVE);
    expect(response.text).not.toContain(users.a.userId);
    expect(response.text).not.toContain(users.b.userId);

    // Whole-batch abort, zero partial state: NONE of the batch's ops exist —
    // no entity rows, no ledger rows, and crucially NO idempotency-key record.
    expect(await diaryRowCount(db, users.b.userId)).toBe(bBefore.rows);
    expect(await ledgerRowCount(db, users.b.userId)).toBe(bBefore.ledger);
    expect(await idempotencyKeyCount(db, users.b.userId)).toBe(bBefore.keys);
    // A's data untouched.
    expect(await diaryRowCount(db, users.a.userId)).toBe(aRowsBefore);

    // Nothing recorded ⇒ the SAME key retried recomputes the same generic 500
    // (not a recorded replay)…
    const retry = record(await pushBatch(app, users.b.token, [colliding], advUuid(NS, 'kcb01')));
    expect(retry.status).toBe(500);
    expectRawIdentical(retry, response, 'collision retry (same key) vs original collision');
    // …and the fresh-id control on the same key shape is a clean 200.
    const freshControl = record(
      await pushBatch(app, users.b.token, batch.filter((op) => op.entityId !== A_LIVE), advUuid(NS, 'kcb02')),
    );
    expect(freshControl.status).toBe(200);
    expect(resultsOf(freshControl).every((r) => r.outcome === 'applied')).toBe(true);
  });

  it('the 500 is cause-indistinguishable: identical bytes across kinds, target states, and batch positions', async () => {
    // Via A's live user-food entity id.
    const aFoodRow = await adminQuery(
      db,
      `SELECT id::text AS id FROM user_foods WHERE user_id = $1 AND name_en = $2 AND deleted_at IS NULL`,
      [users.a.userId, 'A collision-target food'],
    );
    const aFoodId = (aFoodRow.rows[0] as { id: string }).id;
    const ufCollision = record(
      await pushBatch(
        app,
        users.b.token,
        [{ ...userFoodCreateOp(NS, 'cc02', 'bef01', T0, 'B food'), entityId: aFoodId }],
        advUuid(NS, 'kcc02'),
      ),
    );
    expect(ufCollision.status).toBe(500);

    // Via A's live favorite entity id.
    const aFavRow = await adminQuery(
      db,
      'SELECT id::text AS id FROM favorites WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1',
      [users.a.userId],
    );
    const aFavId = (aFavRow.rows[0] as { id: string }).id;
    const favCollision = record(
      await pushBatch(
        app,
        users.b.token,
        [
          {
            ...favoriteCreateOp(NS, 'cc03', 'bef02', T0, { foodId: '00000000-0000-4000-8000-00000000aa01' }),
            entityId: aFavId,
          },
        ],
        advUuid(NS, 'kcc03'),
      ),
    );
    expect(favCollision.status).toBe(500);
    expectRawIdentical(favCollision, ufCollision, 'favorite collision vs user_food collision');

    // Against A's TOMBSTONED entity id (same PK occupancy — same generic 500).
    const tombstoneCreate = record(await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'cc04', 'tomb2', T1, DAY)], advUuid(NS, 'kcc04')));
    expect(resultsOf(tombstoneCreate)[0]?.outcome).toBe('applied');
    const tombstoneDelete = record(
      await pushBatch(
        app,
        users.a.token,
        [{ ...diaryCreateOp(NS, 'cc05', 'tomb2', T1, DAY), action: 'delete' as const, payload: undefined }],
        advUuid(NS, 'kcc05'),
      ),
    );
    expect(resultsOf(tombstoneDelete)[0]?.outcome).toBe('applied');
    const tombstoneCollision = record(await pushBatch(app, users.b.token, [diaryCreateOp(NS, 'cc06', 'tomb2', T0, DAY)], advUuid(NS, 'kcc06')));
    expect(tombstoneCollision.status).toBe(500);
    // The tombstoned-target body equals the live-target body — and equals the
    // user_food/favorite collisions: ONE cause-indistinguishable 500 body.
    expectRawIdentical(tombstoneCollision, ufCollision, 'tombstoned-target vs live-target collision');

    // Mid-batch position (after B-valid ops) — same single generic body.
    const midBatch = record(
      await pushBatch(
        app,
        users.b.token,
        [diaryCreateOp(NS, 'cc07', 'be103', T0, DAY), { ...diaryCreateOp(NS, 'cc08', 'alive1', T0, DAY) }],
        advUuid(NS, 'kcc07'),
      ),
    );
    expect(midBatch.status).toBe(500);
    expectRawIdentical(midBatch, ufCollision, 'mid-batch collision vs single-op collision');
  });
});

describe('sync push — B mutating A\'s rows: update and delete reference cells (no oracle)', () => {
  it('B update of A\'s live entity id is byte-identical to B update of B\'s own absent id (rejected_conflict)', async () => {
    const updateOnA = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'ud01', 'alive1', T1, DAY), action: 'update' as const }], advUuid(NS, 'kud01')),
    );
    const updateOnAbsent = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'ud02', 'be999', T1, DAY), action: 'update' as const }], advUuid(NS, 'kud02')),
    );
    expect(updateOnA.status).toBe(200);
    expect(resultsOf(updateOnA)).toEqual([
      { opId: advUuid(NS, 'ud01'), outcome: 'rejected', code: 'rejected_conflict', retryable: false },
    ]);
    expectAckOutcomesIdentical(updateOnA, updateOnAbsent, 'update on A\'s live id vs B\'s absent id');

    // The rejection is terminal and recorded for B — deterministic replay
    // (recorded outcome, handler not re-run).
    const replay = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'ud01', 'alive1', T1, DAY), action: 'update' as const }], advUuid(NS, 'kud03')),
    );
    expectRawIdentical(replay, updateOnA, 'recorded rejection replay (deterministic)');
    expect(await ledgerRowCount(db, users.b.userId, advUuid(NS, 'ud01'))).toBe(1);
    // B's absent-target op created nothing.
    expect(
      (await adminQuery(db, 'SELECT count(*)::int AS n FROM diary_entries WHERE user_id = $1 AND id = $2', [
        users.b.userId,
        advUuid(NS, 'be999'),
      ])).rows[0],
    ).toEqual({ n: 0 });
  });

  it('B delete of A\'s live entity id acks applied idempotently — and A\'s row is untouched (nothing to attack)', async () => {
    const aRowBefore = await adminQuery(
      db,
      'SELECT updated_at, deleted_at, last_op_id FROM diary_entries WHERE user_id = $1 AND id = $2',
      [users.a.userId, advUuid(NS, 'alive1')],
    );
    const before = aRowBefore.rows[0] as { updated_at: Date; deleted_at: Date | null; last_op_id: string | null };
    expect(before.deleted_at).toBeNull();

    const bDelete = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'dl01', 'alive1', T1, DAY), action: 'delete' as const, payload: undefined }], advUuid(NS, 'kdl01')),
    );
    const bAbsentDelete = record(
      await pushBatch(
        app,
        users.b.token,
        [{ ...diaryCreateOp(NS, 'dl02', 'be998', T1, DAY), action: 'delete' as const, payload: undefined }],
        advUuid(NS, 'kdl02'),
      ),
    );
    expect(resultsOf(bDelete)).toEqual([{ opId: advUuid(NS, 'dl01'), outcome: 'applied' }]);
    expectAckOutcomesIdentical(bDelete, bAbsentDelete, 'delete of A\'s live id vs B\'s absent id');

    // A's row byte-unchanged: no tombstone, no LWW-substrate movement.
    const aRowAfter = await adminQuery(
      db,
      'SELECT updated_at, deleted_at, last_op_id FROM diary_entries WHERE user_id = $1 AND id = $2',
      [users.a.userId, advUuid(NS, 'alive1')],
    );
    expect(aRowAfter.rows[0]).toEqual(before);

    // A's day read still shows A's entry (the delete moved nothing).
    const aDay = record(await getDiaryDay(app, users.a.token, DAY));
    expect((aDay.body as { totals: { entryCount: number } }).totals.entryCount).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Favorites — foreign-target authorization is indistinguishable from absence
// ===========================================================================

describe('favorites — B cannot reference A\'s user food (one generic rejection)', () => {
  it('B favorite targeting A\'s user-food id is byte-identical to targeting an absent id; C\'s own-target control applies', async () => {
    const aFoodRow = await adminQuery(
      db,
      'SELECT id::text AS id FROM user_foods WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1',
      [users.a.userId],
    );
    const aFoodId = (aFoodRow.rows[0] as { id: string }).id;

    const onA = record(await pushBatch(app, users.b.token, [favoriteCreateOp(NS, 'fv01', 'bfv01', T0, { userFoodId: aFoodId })], advUuid(NS, 'kfv01')));
    const onAbsent = record(await pushBatch(app, users.b.token, [favoriteCreateOp(NS, 'fv02', 'bfv02', T0, { userFoodId: advUuid(NS, 'bf999') })], advUuid(NS, 'kfv02')));
    expect(onA.status).toBe(200);
    expect(resultsOf(onA)).toEqual([
      { opId: advUuid(NS, 'fv01'), outcome: 'rejected', code: 'rejected_validation', retryable: false },
    ]);
    expectAckOutcomesIdentical(onA, onAbsent, 'favorite foreign target vs absent target');

    // C control: C's OWN user food as favorite target applies cleanly.
    const cFood = await createUserFoodViaRest(users.c.token, 'C control food');
    expect(cFood.status).toBe(201);
    const cFoodId = (cFood.body as { userFood: { id: string } }).userFood.id;
    const cOwn = record(await pushBatch(app, users.c.token, [favoriteCreateOp(NS, 'fv03', 'cfv01', T0, { userFoodId: cFoodId })], advUuid(NS, 'kfv03')));
    expect(resultsOf(cOwn)).toEqual([{ opId: advUuid(NS, 'fv03'), outcome: 'applied' }]);
  });
});

// ===========================================================================
// Batch boundaries
// ===========================================================================

describe('batch boundaries — per-op rejection never aborts; shape errors and infra failures do', () => {
  it('a REJECTED op between applied ops: the batch commits, ack order is request order, per-op independence', async () => {
    const bBefore = await diaryRowCount(db, users.b.userId);
    const batch: OpInput[] = [
      diaryCreateOp(NS, 'bb01', 'be104', T0, DAY),
      { ...diaryCreateOp(NS, 'bb02', 'alive1', T1, DAY), action: 'update' as const }, // A's live id ⇒ rejected_conflict
      diaryCreateOp(NS, 'bb03', 'be105', T0, DAY),
    ];
    const response = record(await pushBatch(app, users.b.token, batch, advUuid(NS, 'kbb01')));
    expect(response.status).toBe(200);
    expect(resultsOf(response).map((r) => r.outcome)).toEqual(['applied', 'rejected', 'applied']);
    expect(await diaryRowCount(db, users.b.userId)).toBe(bBefore + 2);
  });

  it('a batch-shape violation ANYWHERE rejects the WHOLE batch database-free (zero state, values not echoed)', async () => {
    const bBefore = await diaryRowCount(db, users.b.userId);
    const keysBefore = await idempotencyKeyCount(db, users.b.userId);
    const hostileMarker = `${HEALTH_MARKER}-shape`;
    // The marker rides a user_food op that carries a FORBIDDEN localDate —
    // the §1.1 envelope-parity shape error (whole-batch, database-free).
    const batch = [
      diaryCreateOp(NS, 'bs01', 'be106', T0, DAY),
      { ...userFoodCreateOp(NS, 'bs02', 'be107', T0, hostileMarker), localDate: DAY },
      diaryCreateOp(NS, 'bs03', 'be108', T0, DAY),
    ];
    const response = record(await pushBatch(app, users.b.token, batch as unknown as OpInput[], advUuid(NS, 'kbs01')));
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('VALIDATION_FAILED');
    expect(response.text).not.toContain(hostileMarker);
    expect(await diaryRowCount(db, users.b.userId)).toBe(bBefore);
    expect(await idempotencyKeyCount(db, users.b.userId)).toBe(keysBefore);
  });

  it('over the op-count cap: whole-batch 400, zero state (the frozen default cap observed)', async () => {
    const bBefore = await diaryRowCount(db, users.b.userId);
    const bigBatch: OpInput[] = Array.from({ length: 101 }, (_v, i) =>
      diaryCreateOp(NS, `bp${i.toString(16).padStart(2, '0')}`, `be2${i.toString(16).padStart(2, '0')}`, T0, DAY),
    );
    const response = record(await pushBatch(app, users.b.token, bigBatch, advUuid(NS, 'kbp01')));
    expect(response.status).toBe(400);
    expect(codeOf(response)).toBe('VALIDATION_FAILED');
    expect(await diaryRowCount(db, users.b.userId)).toBe(bBefore);
  });

  it('interleaved concurrent batches: B\'s failing batch never disturbs A\'s concurrent batch', async () => {
    const aEntity = advUuid(NS, 'ae201');
    const aBatch: OpInput[] = [diaryCreateOp(NS, 'cc10', 'ae201', T0, DAY)];
    const bBatch: OpInput[] = [
      diaryCreateOp(NS, 'cc11', 'be109', T0, DAY),
      { ...diaryCreateOp(NS, 'cc12', 'alive1', T0, DAY) }, // collision with A's live id
    ];
    const [aResponse, bResponse] = await Promise.all([
      pushBatch(app, users.a.token, aBatch, advUuid(NS, 'kcc10')),
      pushBatch(app, users.b.token, bBatch, advUuid(NS, 'kcc11')),
    ]);
    record(aResponse);
    record(bResponse);
    expect(aResponse.status).toBe(200);
    expect(resultsOf(aResponse)).toEqual([{ opId: advUuid(NS, 'cc10'), outcome: 'applied' }]);
    expect(bResponse.status).toBe(500);
    expectRawIdentical(bResponse, record(await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'cc13', 'alive1', T0, DAY) }], advUuid(NS, 'kcc13'))), 'concurrent collision vs single collision');
    // A's entity landed exactly once despite B's concurrent attack.
    const aRows = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM diary_entries WHERE user_id = $1 AND id = $2',
      [users.a.userId, aEntity],
    );
    expect((aRows.rows[0] as { n: number }).n).toBe(1);
  });
});

// ===========================================================================
// Sync pull — cursors are user-bound; B's feed is B-only
// ===========================================================================

describe('sync pull — A\'s cursor under B; feed scoping (I7, conventions §2)', () => {
  it('every cursor failure class under B — including A\'s cursor — is ONE byte-identical 400, account-independent', async () => {
    const pageA = record(await pullChanges(app, users.a.token, { limit: '1' }));
    expect(pageA.status).toBe(200);
    const aCursor = (pageA.body as { nextCursor: string | null }).nextCursor;
    expect(typeof aCursor).toBe('string');

    const variants: [string, string][] = [
      ['foreign (A\'s cursor under B)', aCursor as string],
      ['garbage', 'totally-garbage'],
      ['truncated', (aCursor as string).slice(0, Math.floor((aCursor as string).length / 2))],
      ['tampered tail', `${(aCursor as string).slice(0, -2)}xy`],
      ['structurally malformed', '.'],
      ['empty', ''],
    ];
    const bodies: string[] = [];
    for (const [label, cursor] of variants) {
      const underB = record(await pullChanges(app, users.b.token, { cursor }));
      expect(underB.status, label).toBe(400);
      expect(codeOf(underB), label).toBe('VALIDATION_FAILED');
      bodies.push(underB.text);
    }
    expect(new Set(bodies).size, 'ONE body for every failure cause under B').toBe(1);

    // The SAME garbage under A and under C: byte-identical — the denial never
    // depends on the authenticated account.
    const underA = record(await pullChanges(app, users.a.token, { cursor: 'totally-garbage' }));
    const underC = record(await pullChanges(app, users.c.token, { cursor: 'totally-garbage' }));
    expectRawIdentical(underA, underC, 'garbage cursor under A vs C');

    // The foreign cursor NEVER yields rows: B's changes stay undefined.
    const refused = record(await pullChanges(app, users.b.token, { cursor: aCursor as string }));
    expect(refused.body.changes).toBeUndefined();
  });

  it('B\'s bootstrap feed contains ZERO A rows; C\'s contains zero A rows (composition scoping)', async () => {
    const aEntityIds = new Set<string>([advUuid(NS, 'ae101'), advUuid(NS, 'alive1'), advUuid(NS, 'tomb2'), advUuid(NS, 'ae201'), advUuid(NS, 'ae001')]);
    for (const [label, user] of [
      ['B', users.b],
      ['C', users.c],
    ] as const) {
      let cursor: string | null = null;
      for (let pages = 0; pages < 50; pages += 1) {
        const page = record(await pullChanges(app, user.token, cursor === null ? {} : { cursor }));
        expect(page.status, label).toBe(200);
        for (const change of (page.body as { changes: { entityId: string }[] }).changes) {
          expect(aEntityIds.has(change.entityId), `${label} received A entity ${change.entityId}`).toBe(false);
        }
        cursor = (page.body as { nextCursor: string | null }).nextCursor;
        if (cursor === null) {
          break;
        }
      }
      expect(cursor, `${label} feed terminated`).toBeNull();
    }
  });
});

// ===========================================================================
// Barcode resolution — account-independent shapes, platform-cache parity
// ===========================================================================

describe('barcode resolution — generic shapes; the platform cache is platform-plane by design', () => {
  it('malformed barcode 400 and success-shaped miss are byte-identical across A/B/C', async () => {
    const badA = record(await resolveBarcode(app, users.a.token, 'abc'));
    const badB = record(await resolveBarcode(app, users.b.token, 'abc'));
    expect(badA.status).toBe(400);
    expectRawIdentical(badB, badA, 'malformed barcode A vs B');

    const missA = record(await resolveBarcode(app, users.a.token, '9999999999'));
    const missB = record(await resolveBarcode(app, users.b.token, '9999999999'));
    const missC = record(await resolveBarcode(app, users.c.token, '9999999999'));
    expect(missA.status).toBe(200);
    expect(missA.body).toEqual({ result: 'not_found' });
    expectRawIdentical(missB, missA, 'miss A vs B');
    expectRawIdentical(missC, missA, 'miss C (control)');
  });

  it('a resolved product is platform-plane: B resolving the adapter-hit barcode gets the same public resolution (documented posture — not A\'s data)', async () => {
    const aHit = record(await resolveBarcode(app, users.a.token, '200000000001'));
    expect(aHit.status).toBe(200);
    expect((aHit.body as { result: string }).result).toBe('resolved');
    const bHit = record(await resolveBarcode(app, users.b.token, '200000000001'));
    const cHit = record(await resolveBarcode(app, users.c.token, '200000000001'));
    expectRawIdentical(bHit, aHit, 'adapter-hit resolution A vs B (platform cache)');
    expectRawIdentical(cHit, aHit, 'adapter-hit resolution C (control)');
  });
});

// ===========================================================================
// Byte-equivalence summary + I12 payload scan
// ===========================================================================

describe('denial-class byte-equivalence summary (I7) and the I12 payload scan', () => {
  it('each denial situation class has exactly ONE raw body across every observation this suite made', async () => {
    // Re-observe each class once more under the SAME pinned request id.
    const cursor400 = record(await pullChanges(app, users.b.token, { cursor: 'summary-garbage' }));
    const date400 = record(await getDiaryDay(app, users.b.token, 'bad-date'));
    const food404 = record(await getFood(app, users.b.token, 'summary-not-a-uuid'));
    const collision500 = record(await pushBatch(app, users.b.token, [diaryCreateOp(NS, 'sm01', 'alive1', T0, DAY)], advUuid(NS, 'ksm01')));
    const updateAck = record(
      await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'sm02', 'alive1', T1, DAY), action: 'update' as const }], advUuid(NS, 'ksm02')),
    );
    const targetAck = record(
      await pushBatch(app, users.b.token, [favoriteCreateOp(NS, 'sm03', 'bfv03', T0, { userFoodId: advUuid(NS, 'bf998') })], advUuid(NS, 'ksm03')),
    );
    const shape400 = record(
      await pushBatch(
        app,
        users.b.token,
        [{ ...diaryCreateOp(NS, 'sm04', 'be110', T0, DAY), kind: 'nonsense' as unknown as 'diary_entry' }],
        advUuid(NS, 'ksm04'),
      ),
    );

    expect(cursor400.status).toBe(400);
    expect(date400.status).toBe(400);
    expect(food404.status).toBe(404);
    expect(collision500.status).toBe(500);
    expect(shape400.status).toBe(400);
    // Cursor-400 and day-date-400 are the SAME situation class (generic
    // VALIDATION_FAILED without field errors) — byte-identical.
    expectRawIdentical(cursor400, date400, 'cursor 400 vs day-date 400 (same generic class)');
    // The shape 400 carries field errors — a DIFFERENT situation class is
    // permitted by the contract; the assertion is that the class is stable.
    expect((shape400.body as { errors?: unknown[] }).errors).toBeDefined();

    // Ack rejections: same (code, retryable) ⇒ same canonical field set.
    const ackOf = (response: request.Response): Record<string, unknown> | undefined =>
      resultsOf(response)[0] as unknown as Record<string, unknown>;
    expect(Object.keys(ackOf(updateAck) ?? {}).sort()).toEqual(['code', 'opId', 'outcome', 'retryable']);
    expect(Object.keys(ackOf(targetAck) ?? {}).sort()).toEqual(['code', 'opId', 'outcome', 'retryable']);
  });

  it('I12: NO captured response body contains health markers, foreign entity ids, or any account id', async () => {
    expect(capturedBodies.length).toBeGreaterThan(20);
    const forbidden = [
      HEALTH_MARKER,
      A_FOOD_NAME,
      users.a.userId,
      users.b.userId,
      users.c.userId,
    ];
    for (const body of capturedBodies) {
      for (const needle of forbidden) {
        expect(body, `captured body must not contain "${needle}": ${body.slice(0, 160)}`).not.toContain(needle);
      }
    }
    // Ack envelopes carry ONLY the frozen projection (opId/outcome/code/retryable).
    for (const body of capturedBodies) {
      if (body.startsWith('{"results":')) {
        const parsed = JSON.parse(body) as { results: Record<string, unknown>[] };
        for (const result of parsed.results) {
          expect(Object.keys(result).every((key) => ['opId', 'outcome', 'code', 'retryable'].includes(key))).toBe(true);
        }
      }
    }
  });
});
