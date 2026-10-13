/**
 * Kal — wave-4 s4 adversarial: the journal raw-byte denial battery over the
 * real HTTP boundary (criterion 8 + the §3 non-disclosure observables).
 *
 * The W2 method (the w3-adversarial lane precedent): every equivalence pair
 * pins the SAME `X-Request-Id` (echoed into the problem-details `requestId`)
 * and then compares the RAW response text byte-for-byte with zero
 * normalization — key order, spacing, and member set included — plus status
 * and observable headers. Denials must be byte-identical whether or not the
 * target object exists (no existence oracles, I7).
 *
 * The DB-truth half (ledger/counter integrity, collision partial-state
 * proofs, audits, feed walks) lives in the integration sibling
 * (`test/integration/w4-adversarial/abc-journal.itspec.ts`); THIS suite owns
 * the HTTP observables: the 404 quad, the shape-only 400s, the layer-1
 * envelope parity cells for the two journal kinds (whole-batch 400,
 * byte-identical every cause, nothing recorded), and the cross-user ack
 * equivalence. Every journal op flows through the REAL ingestion route.
 */
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { AppModule } from '../../src/app.module.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { applyExerciseCatalogSeed } from '../../prisma/seed-apply.js';
import {
  PINNED_REQUEST_ID,
  advUuid,
  countRows,
  createThreeUserHarness,
  diaryCreateOp,
  expectAckOutcomesIdentical,
  expectRawIdentical,
  pullChanges,
  pushBatch,
  type OpInput,
  type ThreeUserHarness,
} from '../integration/helpers/three-user-harness.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'w4s4adv7rawbyte7fixed7key7material7with7enough7entropy77';

const NS = 'e4d1'; // suite uuid namespace (4 hex)

const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';

/** A health-marker token planted in hostile payloads — must NEVER appear in any response. */
const HEALTH_MARKER = 'w4adv-health-marker-do-not-echo';
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';
const EX_PLANK = '00000000-0000-4000-8000-00000000f21f';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let users: ThreeUserHarness;

/** Captured responses for the I12 payload scan — `owner: 'a'` marks A's OWN successful reads (a user's own data may serve to its owner; I12 forbids CROSS-user health leakage). */
const capturedBodies: { readonly owner: 'a' | 'other'; readonly text: string }[] = [];

function record(response: request.Response, owner: 'a' | 'other' = 'other'): request.Response {
  capturedBodies.push({ owner, text: response.text ?? '' });
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

interface JournalOpLike {
  readonly opId: string;
  readonly kind: 'journal_session' | 'journal_routine';
  readonly entityId: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly clientUpdatedAt: string;
  readonly localDate?: string;
  readonly payload?: Record<string, unknown>;
}

function sessionSnapshot(localDate: string, title: string, withMarker = false): Record<string, unknown> {
  return {
    localDate,
    title: withMarker ? `${title} ${HEALTH_MARKER}` : title,
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 80, reps: 5 }] },
      { exerciseId: EX_PLANK, position: 1, sets: [{ format: 'timed', durationSeconds: 45 }] },
    ],
  };
}

function journalOp(parts: JournalOpLike): JournalOpLike {
  return parts;
}

/** The journal-kind push path — the SAME harness builder with the kind union widened. */
function pushJournal(
  token: string,
  ops: readonly JournalOpLike[],
  idempotencyKey: string,
): request.Test {
  return pushBatch(app, token, ops as unknown as readonly OpInput[], idempotencyKey);
}

function resultsOf(response: request.Response): { opId: string; outcome: string; code?: string; retryable?: boolean }[] {
  return (response.body as { results?: { opId: string; outcome: string; code?: string; retryable?: boolean }[] }).results ?? [];
}

// Fixture ids.
const S1 = advUuid(NS, 'sesa1'); // A's live session
const S2 = advUuid(NS, 'sesa2'); // A's tombstoned session (deleted in beforeAll)
const B_ABSENT = advUuid(NS, 'absn1');
const ROUTINE_A = advUuid(NS, 'roua1');
const A_DIARY = advUuid(NS, 'diara1');

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return advUuid(NS, `k${String(keySeq).padStart(3, '0')}`);
}

beforeAll(async () => {
  db = await createEphemeralKalDb('w4advraw');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
  try {
    await applyExerciseCatalogSeed(seedClient);
  } finally {
    await seedClient.$disconnect();
  }
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  users = await createThreeUserHarness(app, db, {
    a: { email: 'w4advraw-a@example.com', phone: '+201900000101', username: 'w4advraw_owner_a' },
    b: { email: 'w4advraw-b@example.com', phone: '+201900000102', username: 'w4advraw_attacker_b' },
    c: { email: 'w4advraw-c@example.com', phone: '+201900000103', username: 'w4advraw_control_c' },
  });

  // A's fixtures: one live session (+diary +routine), one genuinely
  // tombstoned session (create then delete — a delete-of-absent would write
  // no tombstone row, and the quad needs the real one).
  const create = await pushJournal(
    users.a.token,
    [
      journalOp({ opId: advUuid(NS, 'opa1'), kind: 'journal_session', entityId: S1, action: 'create', clientUpdatedAt: T0, localDate: DAY, payload: sessionSnapshot(DAY, 'A secret push', true) }),
      journalOp({ opId: advUuid(NS, 'opa2'), kind: 'journal_routine', entityId: ROUTINE_A, action: 'create', clientUpdatedAt: T0, payload: { name: 'A secret template', exercises: [{ exerciseId: EX_PLANK, position: 0, sets: [] }] } }),
      journalOp({ opId: advUuid(NS, 'opa5'), kind: 'journal_session', entityId: S2, action: 'create', clientUpdatedAt: T0, localDate: DAY, payload: sessionSnapshot(DAY, 'A doomed session') }),
    ],
    nextKey(),
  )
  expect(resultsOf(create).map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied']);
  const diary = await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'opa3', 'diara1', T0, DAY)], nextKey());
  expect(resultsOf(diary).map((result) => result.outcome)).toEqual(['applied']);
  const tombstone = await pushJournal(
    users.a.token,
    [journalOp({ opId: advUuid(NS, 'opa4'), kind: 'journal_session', entityId: S2, action: 'delete', clientUpdatedAt: T1, localDate: DAY })],
    nextKey(),
  );
  expect(resultsOf(tombstone).map((result) => result.outcome)).toEqual(['applied']);
  // The tombstone is real: the row exists, deleted.
  expect(await countRows(db, 'journal_sessions', 'id = $1 AND user_id = $2 AND deleted_at IS NOT NULL', [S2, users.a.userId])).toBe(1);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ===========================================================================
// The 404 quad — session detail read, byte-identical every cause
// ===========================================================================

describe('journal.sessions.get — the 404 quad (no existence oracle)', () => {
  const get = (token: string, id: string): request.Test =>
    request(app.getHttpServer()).get(`/journal/sessions/${id}`).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);

  it('foreign ≡ absent ≡ malformed ≡ tombstoned (raw bytes, status, content-type)', async () => {
    const foreign = record(await get(users.b.token, S1));
    const absent = record(await get(users.b.token, B_ABSENT));
    const malformed = record(await get(users.b.token, 'w4adv-not-a-uuid'));
    const tombstoned = record(await get(users.b.token, S2));
    for (const response of [foreign, absent, malformed, tombstoned]) {
      expect(response.status).toBe(404);
    }
    expectRawIdentical(foreign, absent, 'foreign ≡ absent');
    expectRawIdentical(foreign, malformed, 'foreign ≡ malformed');
    expectRawIdentical(foreign, tombstoned, 'foreign ≡ tombstoned');
    expect((foreign.body as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('C attacking A produces the identical denial — and A reading A is a 200 (authorization-driven)', async () => {
    const bForeign = record(await get(users.b.token, S1));
    const cForeign = record(await get(users.c.token, S1));
    const aOwn = record(await get(users.a.token, S1), 'a');
    expectRawIdentical(bForeign, cForeign, 'B ≡ C foreign denial');
    expect(aOwn.status).toBe(200);
    expect((aOwn.body as { session?: { id?: string } }).session?.id).toBe(S1);
  });

  it('the denial bodies carry no A-owned content (ids, titles, snapshots)', async () => {
    const foreign = await get(users.b.token, S1);
    expect(foreign.text).not.toContain(S1);
    expect(foreign.text).not.toContain('A secret push');
    expect(foreign.text).not.toContain(users.a.userId);
    expect(foreign.text).not.toContain(HEALTH_MARKER);
  });
});

// ===========================================================================
// Day read — shape-only 400 parity + empty-day 200 posture
// ===========================================================================

describe('journal.sessions.day.get — shape-only gate', () => {
  const get = (token: string, day: string): request.Test =>
    request(app.getHttpServer()).get(`/journal/sessions/days/${day}`).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);

  it('malformed localDate ⇒ one byte-identical 400 for A, B, and C alike (value-free)', async () => {
    const aBad = record(await get(users.a.token, '2026-02-30'));
    const bBad = record(await get(users.b.token, 'not-a-date'));
    const cBad = record(await get(users.c.token, '20261008'));
    for (const response of [aBad, bBad, cBad]) {
      expect(response.status).toBe(400);
    }
    expectRawIdentical(aBad, bBad, 'A ≡ B malformed-day 400');
    expectRawIdentical(aBad, cBad, 'A ≡ C malformed-day 400');
  });

  it("A's training day reads as an EMPTY 200 for B and C — no existence oracle by day either", async () => {
    const bEmpty = record(await get(users.b.token, DAY));
    const cEmpty = record(await get(users.c.token, DAY));
    expect(bEmpty.status).toBe(200);
    expectRawIdentical(bEmpty, cEmpty, 'B ≡ C empty-day 200');
    expect((bEmpty.body as { sessions: unknown[] }).sessions).toEqual([]);
    expect(bEmpty.text).not.toContain(S1);
  });
});

// ===========================================================================
// Layer-1 envelope parity — the journal kinds ride the whole-batch 400 class
// ===========================================================================

describe('layer-1 envelope parity (journal kinds) — whole-batch 400, byte-identical, nothing recorded', () => {
  const reference = async (): Promise<request.Response> => {
    // The known W3-class whole-batch 400: a user_food op carrying localDate.
    return record(
      await pushBatch(
        app,
        users.b.token,
        [
          {
            opId: advUuid(NS, 'ref1'),
            kind: 'user_food',
            entityId: advUuid(NS, 'refe1'),
            action: 'create',
            clientUpdatedAt: T0,
            localDate: DAY,
            payload: { nameEn: 'x', energyKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 },
          } as unknown as OpInput,
        ],
        nextKey(),
      ),
    );
  };

  it('journal_session without localDate ≡ with calendar-invalid localDate ≡ routine WITH localDate ≡ envelope/payload disagreement — all the SAME bytes', async () => {
    const referenceResponse = await reference();
    expect(referenceResponse.status).toBe(400);

    const missingDate = record(
      await pushJournal(users.b.token, [
        journalOp({ opId: advUuid(NS, 'e1'), kind: 'journal_session', entityId: advUuid(NS, 'e1e'), action: 'create', clientUpdatedAt: T0, payload: sessionSnapshot(DAY, 'x') }),
      ], nextKey()),
    );
    const invalidDate = record(
      await pushJournal(users.b.token, [
        journalOp({ opId: advUuid(NS, 'e2'), kind: 'journal_session', entityId: advUuid(NS, 'e2e'), action: 'create', clientUpdatedAt: T0, localDate: '2026-02-30', payload: sessionSnapshot('2026-02-30', 'x') }),
      ], nextKey()),
    );
    const routineCarrying = record(
      await pushJournal(users.b.token, [
        journalOp({ opId: advUuid(NS, 'e3'), kind: 'journal_routine', entityId: advUuid(NS, 'e3e'), action: 'create', clientUpdatedAt: T0, localDate: DAY, payload: { name: 'x', exercises: [{ exerciseId: EX_PLANK, position: 0, sets: [] }] } }),
      ], nextKey()),
    );
    const disagreement = record(
      await pushJournal(users.b.token, [
        journalOp({ opId: advUuid(NS, 'e4'), kind: 'journal_session', entityId: advUuid(NS, 'e4e'), action: 'create', clientUpdatedAt: T0, localDate: DAY, payload: sessionSnapshot('2026-10-09', 'x') }),
      ], nextKey()),
    );

    for (const response of [missingDate, invalidDate, routineCarrying, disagreement]) {
      expect(response.status, response.text).toBe(400);
      expectRawIdentical(referenceResponse, response, 'whole-batch 400 byte parity');
    }

    // Nothing recorded for any cause (whole-batch refusal, zero effects).
    for (const suffix of ['e1e', 'e2e', 'e3e', 'e4e']) {
      expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.b.userId, advUuid(NS, suffix)])).toBe(0);
    }
    expect(await countRows(db, 'journal_sessions', 'user_id = $1', [users.b.userId])).toBe(0);
    expect(await countRows(db, 'journal_routines', 'user_id = $1', [users.b.userId])).toBe(0);
  });

  it('a foreign (A-owned) entity id in a journal_session DELETE rides per-op resolution, not the batch 400 — and A is untouched', async () => {
    const before = await adminQuery(db, `SELECT updated_at::text AS u, deleted_at::text AS d FROM journal_sessions WHERE id = $1 AND user_id = $2`, [S1, users.a.userId]);
    const response = record(
      await pushJournal(
        users.b.token,
        [journalOp({ opId: advUuid(NS, 'e5'), kind: 'journal_session', entityId: S1, action: 'delete', clientUpdatedAt: T0, localDate: DAY })],
        nextKey(),
      ),
    );
    expect(response.status).toBe(200); // per-op ack path
    expect(resultsOf(response).map((result) => result.outcome)).toEqual(['applied']);
    const after = await adminQuery(db, `SELECT updated_at::text AS u, deleted_at::text AS d FROM journal_sessions WHERE id = $1 AND user_id = $2`, [S1, users.a.userId]);
    expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
  });
});

// ===========================================================================
// Cross-user ack equivalence — same attack, same outcome triples
// ===========================================================================

describe('cross-user ack equivalence (the per-op denial classes)', () => {
  it("B's and C's identical attacks on A produce identical ack outcome triples", async () => {
    const attack = (token: string, tag: string): request.Test =>
      pushJournal(
        token,
        [
          journalOp({ opId: advUuid(NS, `${tag}1`), kind: 'journal_session', entityId: S1, action: 'update', clientUpdatedAt: T0, localDate: DAY, payload: sessionSnapshot(DAY, 'attack') }),
          journalOp({ opId: advUuid(NS, `${tag}2`), kind: 'journal_routine', entityId: ROUTINE_A, action: 'update', clientUpdatedAt: T0, payload: { name: 'attack', exercises: [] } }),
          journalOp({ opId: advUuid(NS, `${tag}3`), kind: 'journal_session', entityId: B_ABSENT, action: 'delete', clientUpdatedAt: T0, localDate: DAY }),
        ],
        nextKey(),
      );
    const bAttack = record(await attack(users.b.token, 'b'));
    const cAttack = record(await attack(users.c.token, 'c'));
    expectAckOutcomesIdentical(bAttack, cAttack, 'B ≡ C attack acks');
    expect(resultsOf(bAttack).map((result) => result.outcome)).toEqual(['rejected', 'rejected', 'applied']);
  });
});

// ===========================================================================
// Pull scoping over the wire + catalog parity
// ===========================================================================

describe('pull + search scoping over the wire', () => {
  it("B's full feed walk never carries A's journal entities, op ids, or content", async () => {
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const query: Record<string, string> = { limit: '50' };
      if (cursor !== null) {
        query.cursor = cursor;
      }
      const page = record(await pullChanges(app, users.b.token, query));
      expect(page.status).toBe(200);
      pages += 1;
      const body = page.body as { changes: { entityId: string }[]; nextCursor: string | null };
      for (const foreign of [S1, S2, ROUTINE_A, A_DIARY]) {
        expect(page.text).not.toContain(foreign);
      }
      expect(page.text).not.toContain('A secret push');
      expect(page.text).not.toContain('A secret template');
      if (body.nextCursor === null || pages > 20) {
        break;
      }
      cursor = body.nextCursor;
    }
    expect(pages).toBeGreaterThan(0);
  });

  it('the exercise catalog is platform-public: A, B, C receive identical result DATA (cursors are user-bound by design)', async () => {
    const search = (token: string): request.Test =>
      request(app.getHttpServer()).get('/journal/exercises').query({ q: 'squat' }).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);
    const aSearch = record(await search(users.a.token));
    const bSearch = record(await search(users.b.token));
    const cSearch = record(await search(users.c.token));
    expect(aSearch.status).toBe(200);
    // The result arrays are byte-identical; the nextCursor is the caller's
    // own user-bound token (its payload carries `u`) — parity is asserted on
    // the data, the status, and the absence of any cross-user content.
    expect(JSON.stringify((aSearch.body as { data: unknown }).data)).toBe(JSON.stringify((bSearch.body as { data: unknown }).data));
    expect(JSON.stringify((aSearch.body as { data: unknown }).data)).toBe(JSON.stringify((cSearch.body as { data: unknown }).data));
    for (const response of [aSearch, bSearch, cSearch]) {
      expect(response.text).not.toContain(users.a.userId);
      expect(response.text).not.toContain('A secret push');
    }
  });
});

// ===========================================================================
// I12 — the captured-body scan
// ===========================================================================

describe('privacy posture of every body this battery observed', () => {
  it('no body served to B or C ever carried the planted health marker, A titles, or A ids', async () => {
    expect(capturedBodies.length).toBeGreaterThan(15); // the battery is real
    for (const captured of capturedBodies) {
      if (captured.owner === 'a') {
        continue; // A's own read may carry A's own stored data
      }
      expect(captured.text).not.toContain(HEALTH_MARKER);
      expect(captured.text).not.toContain('A secret push');
      expect(captured.text).not.toContain('A secret template');
      expect(captured.text).not.toContain(S1);
      expect(captured.text).not.toContain(users.a.userId);
    }
  });
});
