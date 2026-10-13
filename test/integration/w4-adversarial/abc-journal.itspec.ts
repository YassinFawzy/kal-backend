/**
 * Kal — wave-4 s4 adversarial: the journal A/B/C matrix (criterion 8),
 * integration lane.
 *
 * A owns journal data (sessions, a routine, a PR-eligible history); B
 * attacks every read, mutate, reference, enumerate, and sync-cursor path
 * with VALID credentials; C supplies the authorization-driven controls.
 * Architecture §22 + task contract s4-adversarial. The raw-byte 404/400
 * parity batteries live in the e2e sibling (`test/e2e/w4-adversarial.e2e-spec.ts`);
 * THIS suite owns the DB-truth half: ledger/counter/row integrity after
 * every attack, cross-user op-replay resolution, the journal-equivalent
 * PK-collision pin (the W3 cross-user PK-collision ruling), cursor
 * foreign-binding audits, and the feed-enumeration scoping walks.
 *
 * Harness discipline: the shared `createThreeUserHarness` machinery
 * (accounts, verified bindings, pinned request ids, ack-triple assertions,
 * row counters) is REUSED — the journal kinds ride the same push path
 * through a documented type-widening wrapper (the harness predates w4;
 * `helpers/**` is additive-only via supervisor).
 */
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../../generated/prisma/client.ts';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { applyExerciseCatalogSeed } from '../../../prisma/seed-apply.js';
import {
  PINNED_REQUEST_ID,
  advUuid,
  countRows,
  createThreeUserHarness,
  diaryCreateOp,
  expectAckOutcomesIdentical,
  pullChanges,
  pushBatch,
  type OpInput,
  type ThreeUserHarness,
} from '../helpers/three-user-harness.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';

const SIGNING_KEY = 'w4s4abc7journal7fixed7key7material7with7enough7entropy7';

const NS = 'b4c1'; // suite uuid namespace (4 hex)

const DAY_1 = '2026-10-08';
const DAY_2 = '2026-10-09';
const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';
const T2 = '2026-10-09T09:30:00Z';

/** Catalog ids from the frozen seed manifest (…f2nn reserved range). */
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';
const EX_PLANK = '00000000-0000-4000-8000-00000000f21f';

/** A health-marker token planted in hostile payloads — must NEVER appear in any response. */
const HEALTH_MARKER = 'w4abc-health-marker-do-not-echo';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let users: ThreeUserHarness;

// ---------------------------------------------------------------------------
// Journal op builders (the w4 kinds — the harness trio has no journal kinds)
// ---------------------------------------------------------------------------

/** Journal-wide op input: the harness OpInput with the kind union widened. */
interface JournalOpInput extends Omit<OpInput, 'kind'> {
  readonly kind: 'journal_session' | 'journal_routine';
}

function weightedSet(weightKg: number, reps: number): Record<string, unknown> {
  return { format: 'weighted', weightKg, reps };
}

/** Full session snapshot (w4 contract §1.1 — payload localDate mirrors the envelope). */
function sessionSnapshot(localDate: string, title: string | undefined, withMarker = false): Record<string, unknown> {
  return {
    localDate,
    ...(title === undefined ? {} : { title: withMarker ? `${title} ${HEALTH_MARKER}` : title }),
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [weightedSet(80, 5), weightedSet(90, 3)] },
      { exerciseId: EX_PLANK, position: 1, sets: [{ format: 'timed', durationSeconds: 60 }] },
    ],
  };
}

/** Full routine snapshot (w4 contract §1.1 — no localDate anywhere). */
function routineSnapshot(name: string): Record<string, unknown> {
  return {
    name,
    exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [weightedSet(60, 10)] }],
  };
}

function sessionOp(parts: {
  opId: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  clientUpdatedAt: string;
  localDate?: string;
  payload?: Record<string, unknown>;
}): JournalOpInput {
  return {
    opId: parts.opId,
    kind: 'journal_session',
    entityId: parts.entityId,
    action: parts.action,
    clientUpdatedAt: parts.clientUpdatedAt,
    ...(parts.localDate === undefined ? {} : { localDate: parts.localDate }),
    ...(parts.payload === undefined ? {} : { payload: parts.payload }),
  };
}

function routineOp(parts: {
  opId: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  clientUpdatedAt: string;
  payload?: Record<string, unknown>;
}): JournalOpInput {
  return {
    opId: parts.opId,
    kind: 'journal_routine',
    entityId: parts.entityId,
    action: parts.action,
    clientUpdatedAt: parts.clientUpdatedAt,
    ...(parts.payload === undefined ? {} : { payload: parts.payload }),
  };
}

/**
 * The journal-kind push path: the SAME harness builder (same pinned
 * X-Request-Id, same Idempotency-Key header, same `{deviceId, ops}` body)
 * with the kind union widened — the additive extension point; the shared
 * harness file is untouched.
 */
function pushJournalBatch(
  appRef: INestApplication<App>,
  token: string,
  ops: readonly JournalOpInput[],
  idempotencyKey: string,
): request.Test {
  return pushBatch(appRef, token, ops as unknown as readonly OpInput[], idempotencyKey);
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

function codeOf(response: request.Response): string {
  return (response.body as { code?: string }).code ?? '';
}

interface PullPage {
  readonly changes: readonly { kind: string; entityId: string; change: 'upsert' | 'delete'; updatedAt: string }[];
  readonly nextCursor: string | null;
}

/** Walks one user's full delta feed (bounded — a drained feed returns null). */
async function walkFeed(token: string, limit = '100'): Promise<PullPage['changes']> {
  const collected: PullPage['changes'][number][] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const query: Record<string, string> = { limit };
    if (cursor !== null) {
      query.cursor = cursor;
    }
    const response = await pullChanges(app, token, query);
    expect(response.status).toBe(200);
    const body = response.body as PullPage;
    collected.push(...body.changes);
    if (body.nextCursor === null) {
      return collected;
    }
    cursor = body.nextCursor;
  }
  throw new Error('feed walk did not drain within 50 pages');
}

/** A's journal_sessions row integrity snapshot (byte-untouched verification). */
async function sessionRowSnapshot(userId: string, sessionId: string): Promise<string> {
  const result = await adminQuery(
    db,
    `SELECT updated_at::text AS u, deleted_at::text AS d, last_op_id::text AS l, local_date::text AS day, title
       FROM journal_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  return JSON.stringify(result.rows);
}

async function pollAuditRows(action: string, min: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await adminQuery(db, `SELECT count(*)::int AS n FROM audit_events WHERE action = $1`, [action]);
    if ((result.rows[0]?.n ?? 0) >= min) {
      return result.rows[0].n;
    }
    if (Date.now() > deadline) {
      return result.rows[0]?.n ?? 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

/** Deterministic per-suite Idempotency-Key counter (no wall clock, no RNG). */
let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return advUuid(NS, `key${String(keySeq).padStart(3, '0')}`);
}

// ---------------------------------------------------------------------------
// Fixture ids
// ---------------------------------------------------------------------------

const S1 = advUuid(NS, 'sessa1'); // A's live session, day 1
const S2 = advUuid(NS, 'sessa2'); // A's second session, day 2 (tombstoned mid-suite)
const R1 = advUuid(NS, 'roufa1'); // A's routine
const B1 = advUuid(NS, 'sesb1'); // B's own session (availability control)
const C1 = advUuid(NS, 'sesc1'); // C's own session (control parity)
const A_DIARY = advUuid(NS, 'diara1'); // A's diary entry (cross-kind collision source)
const ABSENT_SESSION = advUuid(NS, 'absnt1');
const MALFORMED_ID = 'w4abc-not-a-uuid-at-all';

const key = (tag: string): string => advUuid(NS, tag);

beforeAll(async () => {
  db = await createEphemeralKalDb('w4abc');
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
    a: { email: 'w4abc-owner-a@example.com', phone: '+201800000101', username: 'w4abc_owner_a' },
    b: { email: 'w4abc-attacker-b@example.com', phone: '+201800000102', username: 'w4abc_attacker_b' },
    c: { email: 'w4abc-control-c@example.com', phone: '+201800000103', username: 'w4abc_control_c' },
  });

  // A's journal: two sessions (one PR-eligible weighted history + one to be
  // tombstoned), one routine, one diary entry (cross-kind collision source).
  const aCreates: JournalOpInput[] = [
    sessionOp({ opId: advUuid(NS, 'opa01'), entityId: S1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'A push day') }),
    sessionOp({ opId: advUuid(NS, 'opa02'), entityId: S2, action: 'create', clientUpdatedAt: T1, localDate: DAY_2, payload: sessionSnapshot(DAY_2, 'A pull day') }),
    routineOp({ opId: advUuid(NS, 'opa03'), entityId: R1, action: 'create', clientUpdatedAt: T0, payload: routineSnapshot('A starter template') }),
  ];
  const aDiary = diaryCreateOp(NS, 'opa04', 'diara1', T0, DAY_1);
  const pushedA = await pushJournalBatch(app, users.a.token, aCreates, key('ka01'));
  expect(pushedA.status).toBe(200);
  expect(resultsOf(pushedA).map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied']);
  const pushedDiary = await pushBatch(app, users.a.token, [aDiary], key('ka02'));
  expect(pushedDiary.status).toBe(200);
  expect(resultsOf(pushedDiary).map((result) => result.outcome)).toEqual(['applied']);

  // B and C each own one live session — the availability controls.
  const bCreate = await pushJournalBatch(
    app,
    users.b.token,
    [sessionOp({ opId: advUuid(NS, 'opb01'), entityId: B1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B leg day') })],
    key('kb01'),
  );
  expect(resultsOf(bCreate).map((result) => result.outcome)).toEqual(['applied']);
  const cCreate = await pushJournalBatch(
    app,
    users.c.token,
    [sessionOp({ opId: advUuid(NS, 'opc01'), entityId: C1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'C control day') })],
    key('kc01'),
  );
  expect(resultsOf(cCreate).map((result) => result.outcome)).toEqual(['applied']);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ===========================================================================
// Controls — own data works; denials are authorization-driven
// ===========================================================================

describe('A/B/C positive parity (controls)', () => {
  it('A reads its own session, day, and PR — the reads this suite attacks are real', async () => {
    const own = await request(app.getHttpServer())
      .get(`/journal/sessions/${S1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect(own.status).toBe(200);
    const session = (own.body as { session: { id: string; localDate: string; exercises: { nameSnapshotEn: string }[] } }).session;
    expect(session.id).toBe(S1);
    expect(session.localDate).toBe(DAY_1);
    expect(session.exercises[0]?.nameSnapshotEn).toBe('Barbell back squat');

    const day = await request(app.getHttpServer())
      .get(`/journal/sessions/days/${DAY_1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect(day.status).toBe(200);
    const ids = (day.body as { sessions: { id: string }[] }).sessions.map((row) => row.id);
    expect(ids).toContain(S1);

    const pr = await request(app.getHttpServer())
      .get(`/journal/exercises/${EX_SQUAT}/pr`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect(pr.status).toBe(200);
    const prBody = pr.body as { result: string; pr?: { sourceSet: { sessionId: string } } };
    expect(prBody.result).toBe('pr');
    expect(prBody.pr?.sourceSet.sessionId).toBe(S1);
  });

  it('C creates, reads, and attacks exactly like B — and its own data behaves identically', async () => {
    const own = await request(app.getHttpServer())
      .get(`/journal/sessions/${C1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.c.token}`);
    expect(own.status).toBe(200);

    // C runs the same by-ID attack battery against A — same denials as B's.
    const cForeign = await request(app.getHttpServer())
      .get(`/journal/sessions/${S1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.c.token}`);
    const bForeign = await request(app.getHttpServer())
      .get(`/journal/sessions/${S1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.b.token}`);
    expect(cForeign.status).toBe(404);
    expect(cForeign.text).toBe(bForeign.text);
  });
});

// ===========================================================================
// By-ID denials with DB-truth — the 404 quad and its non-effects
// ===========================================================================

describe('by-ID attack matrix (session detail read)', () => {
  it('B reads A session ≡ absent ≡ malformed (raw byte parity, pinned request id)', async () => {
    const get = (token: string, id: string): request.Test =>
      request(app.getHttpServer()).get(`/journal/sessions/${id}`).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);
    const foreign = await get(users.b.token, S1);
    const absent = await get(users.b.token, ABSENT_SESSION);
    const malformed = await get(users.b.token, MALFORMED_ID);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(foreign.text).toBe(absent.text);
    expect(foreign.text).toBe(malformed.text);
    expect((foreign.body as { code?: string }).code).toBe('NOT_FOUND');
  });

  it('B update on A entity id ⇒ rejected_conflict; A row byte-untouched; ack triple ≡ nonexistent-id probe', async () => {
    const before = await sessionRowSnapshot(users.a.userId, S1);
    const attack = await pushJournalBatch(
      app,
      users.b.token,
      [sessionOp({ opId: advUuid(NS, 'opb02'), entityId: S1, action: 'update', clientUpdatedAt: T1, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B tampered title') })],
      key('kb02'),
    );
    expect(attack.status).toBe(200);
    const attackResults = resultsOf(attack);
    expect(attackResults).toHaveLength(1);
    expect(attackResults[0]).toMatchObject({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });

    // Cause-indistinguishable: the SAME attack against a nonexistent id.
    const probe = await pushJournalBatch(
      app,
      users.b.token,
      [sessionOp({ opId: advUuid(NS, 'opb03'), entityId: ABSENT_SESSION, action: 'update', clientUpdatedAt: T1, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B probe title') })],
      key('kb03'),
    );
    expectAckOutcomesIdentical(attack, probe, 'update-on-foreign ≡ update-on-absent');

    // A's row is byte-untouched (updated_at, deleted_at, last_op_id, day, title).
    const after = await sessionRowSnapshot(users.a.userId, S1);
    expect(after).toBe(before);
  });

  it("B delete on A entity id ⇒ acked applied, ZERO effect on A — A's row stays active and readable", async () => {
    const before = await sessionRowSnapshot(users.a.userId, S1);
    const attack = await pushJournalBatch(
      app,
      users.b.token,
      [sessionOp({ opId: advUuid(NS, 'opb04'), entityId: S1, action: 'delete', clientUpdatedAt: T2, localDate: DAY_1 })],
      key('kb04'),
    );
    expect(attack.status).toBe(200);
    expect(resultsOf(attack)).toHaveLength(1);
    expect(resultsOf(attack)[0]).toMatchObject({ outcome: 'applied' });

    // A's row: no tombstone, no LWW substrate movement.
    expect(await sessionRowSnapshot(users.a.userId, S1)).toBe(before);
    const own = await request(app.getHttpServer())
      .get(`/journal/sessions/${S1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect(own.status).toBe(200);

    // The recorded rejection/ack posture: B's ledger holds the op (delete of
    // an invisible row is idempotent-applied for B), and a replay is a
    // duplicate with no new effects.
    expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.b.userId, advUuid(NS, 'opb04')])).toBe(1);
  });

  it('A tombstones S2 ⇒ B and C see the SAME 404 bytes as before the delete (tombstone ≡ foreign ≡ absent)', async () => {
    const del = await pushJournalBatch(
      app,
      users.a.token,
      [sessionOp({ opId: advUuid(NS, 'opa05'), entityId: S2, action: 'delete', clientUpdatedAt: T2, localDate: DAY_2 })],
      key('ka05'),
    );
    expect(resultsOf(del).map((result) => result.outcome)).toEqual(['applied']);
    const get = (token: string, id: string): request.Test =>
      request(app.getHttpServer()).get(`/journal/sessions/${id}`).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);
    const tombstoned = await get(users.b.token, S2);
    const absent = await get(users.b.token, ABSENT_SESSION);
    const foreign = await get(users.c.token, S1);
    expect(tombstoned.status).toBe(404);
    expect(tombstoned.text).toBe(absent.text);
    expect(tombstoned.text).toBe(foreign.text);
  });
});

// ===========================================================================
// PR scoping — the derived read model is caller-scoped
// ===========================================================================

describe('PR read scoping (derived, owning-user-only)', () => {
  it("B's PR read for A's best exercise carries NONE of A's sessions — only B's own derivation", async () => {
    const pr = await request(app.getHttpServer())
      .get(`/journal/exercises/${EX_SQUAT}/pr`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.b.token}`);
    expect(pr.status).toBe(200);
    const body = pr.text;
    expect(body).not.toContain(S1);
    expect(body).not.toContain(S2);
    expect(body).not.toContain(users.a.userId);
    // B's own weighted history derives B's OWN pr — the read is real, the
    // scoping is authorization (B1 uses the same squat with lighter sets).
    const prBody = pr.body as { result: string; pr?: { sourceSet: { sessionId: string; weightKg: number } } };
    expect(prBody.result).toBe('pr');
    expect(prBody.pr?.sourceSet.sessionId).toBe(B1);
  });

  it('PR 404 parity: unknown catalog id ≡ malformed id (byte-identical generic denial)', async () => {
    const get = (token: string, id: string): request.Test =>
      request(app.getHttpServer()).get(`/journal/exercises/${id}/pr`).set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);
    const absent = await get(users.b.token, '00000000-0000-4900-8000-00000000f999');
    const malformed = await get(users.b.token, MALFORMED_ID);
    expect(absent.status).toBe(404);
    expect(absent.text).toBe(malformed.text);
  });
});

// ===========================================================================
// Day-read scoping + shape-only 400 parity
// ===========================================================================

describe('day-read scoping', () => {
  it("A's training day is empty for B — B's same-date read carries only B's own rows", async () => {
    const day = (token: string): Promise<request.Response> =>
      request(app.getHttpServer())
        .get(`/journal/sessions/days/${DAY_1}`)
        .set('X-Request-Id', PINNED_REQUEST_ID)
        .set('Authorization', `Bearer ${token}`);
    const bDay = await day(users.b.token);
    const aDay = await day(users.a.token);
    expect(bDay.status).toBe(200);
    expect(aDay.status).toBe(200);
    const bIds = (bDay.body as { sessions: { id: string }[] }).sessions.map((row) => row.id);
    const aIds = (aDay.body as { sessions: { id: string }[] }).sessions.map((row) => row.id);
    expect(bIds).toEqual([B1]);
    expect(aIds).toContain(S1);
    expect(aIds).not.toContain(B1);
    expect(bDay.text).not.toContain(S1);
    expect(aDay.text).not.toContain(B1);
  });

  it('malformed localDate ⇒ 400 byte-identical for A and B alike (value-free denial)', async () => {
    const get = (token: string): request.Test =>
      request(app.getHttpServer()).get('/journal/sessions/days/not-a-date').set('X-Request-Id', PINNED_REQUEST_ID).set('Authorization', `Bearer ${token}`);
    const aMalformed = await get(users.a.token);
    const bMalformed = await get(users.b.token);
    expect(aMalformed.status).toBe(400);
    expect(aMalformed.text).toBe(bMalformed.text);
  });
});

// ===========================================================================
// Enumeration — the delta feed never carries another user's journal rows
// ===========================================================================

describe('feed enumeration scoping', () => {
  it("B's full feed walk contains zero A entities (sessions, routine, diary) and zero A op ids", async () => {
    const feed = await walkFeed(users.b.token);
    const entityIds = feed.map((change) => change.entityId);
    expect(entityIds).toContain(B1); // the walk is real — B sees its own row
    expect(entityIds).not.toContain(S1);
    expect(entityIds).not.toContain(S2);
    expect(entityIds).not.toContain(R1);
    expect(entityIds).not.toContain(A_DIARY);
    const kinds = new Set(feed.map((change) => change.kind));
    expect(kinds.has('journal_session')).toBe(true);
    // C's control walk likewise carries only C's own entity.
    const cFeed = await walkFeed(users.c.token);
    expect(cFeed.map((change) => change.entityId)).toEqual([C1]);
  });

  it("A's feed carries the S2 tombstone as a payload-free delete, exactly once; B's feed never sees it", async () => {
    const aFeed = await walkFeed(users.a.token);
    const s2Changes = aFeed.filter((change) => change.entityId === S2);
    expect(s2Changes).toHaveLength(1);
    expect(s2Changes[0]?.change).toBe('delete');
    expect(s2Changes[0]).not.toHaveProperty('payload');
    // And the routine rides the same feed for its owner only.
    expect(aFeed.filter((change) => change.entityId === R1)).toHaveLength(1);
    const bFeed = await walkFeed(users.b.token);
    expect(bFeed.filter((change) => change.entityId === S2)).toHaveLength(0);
  });

  it('A paged feed (limit 1) never leaks into B paging — the walk is a total scoping, not a page accident', async () => {
    const feed = await walkFeed(users.b.token, '1');
    const entityIds = feed.map((change) => change.entityId);
    expect(entityIds).toContain(B1); // the paged walk is real
    for (const foreign of [S1, S2, R1, A_DIARY]) {
      expect(entityIds).not.toContain(foreign);
    }
  });
});

// ===========================================================================
// Cursor hand-offs — user-bound tokens, byte-identical generic 400s, audits
// ===========================================================================

describe('sync delta cursor hand-offs', () => {
  it("A's valid cursor presented by B ⇒ generic 400, byte-identical to every malformed cause", async () => {
    const first = await pullChanges(app, users.a.token, { limit: '1' });
    expect(first.status).toBe(200);
    const cursorA = (first.body as { nextCursor: string | null }).nextCursor;
    expect(cursorA).not.toBeNull();
    const payload = (cursorA as string).split('.')[0] ?? '';
    const tag = (cursorA as string).split('.')[1] ?? '';
    const tampered = `${payload.slice(0, -2)}xx.${tag}`;
    const truncated = payload;

    const present = (token: string, cursor: string): request.Test => pullChanges(app, token, { cursor, limit: '10' });
    const foreign = await present(users.b.token, cursorA as string);
    const garbage = await present(users.b.token, 'w4abc garbage cursor token');
    const tamperedResponse = await present(users.b.token, tampered);
    const truncatedResponse = await present(users.b.token, truncated);
    expect(foreign.status).toBe(400);
    expect(foreign.text).toBe(garbage.text);
    expect(foreign.text).toBe(tamperedResponse.text);
    expect(foreign.text).toBe(truncatedResponse.text);
    expect(codeOf(foreign)).toBe('VALIDATION_FAILED');
    // And B's own cursor still works for B (availability control).
    const ownFirst = await pullChanges(app, users.b.token, { limit: '1' });
    expect(ownFirst.status).toBe(200);
    const ownCursor = (ownFirst.body as { nextCursor: string | null }).nextCursor;
    if (ownCursor !== null) {
      expect((await present(users.b.token, ownCursor)).status).toBe(200);
    }
  });

  it('the foreign delta-cursor presentation lands exactly one digest-only audit row', async () => {
    const first = await pullChanges(app, users.a.token, { limit: '1' });
    const cursorA = (first.body as { nextCursor: string | null }).nextCursor;
    if (cursorA !== null) {
      await pullChanges(app, users.b.token, { cursor: cursorA, limit: '10' });
    }
    const rows = await pollAuditRows('sync.cursor.foreign_binding', 1);
    expect(rows).toBeGreaterThanOrEqual(1);
    const detail = await adminQuery(
      db,
      `SELECT actor, action, target, justification FROM audit_events WHERE action = 'sync.cursor.foreign_binding' ORDER BY occurred_at DESC LIMIT 1`,
    );
    const row = detail.rows[0] as { actor: string; target: string; justification: string };
    const flat = JSON.stringify(row);
    // Digest-only posture: no raw user id, no raw cursor material.
    expect(flat).not.toContain(users.a.userId);
    expect(flat).not.toContain(users.b.userId);
    expect(flat).not.toContain(cursorA ?? '~~unreachable~~');
  });
});

describe('exercise search cursor hand-offs', () => {
  it("A's paged search cursor presented by B ⇒ the ONE bare 400, byte-identical to a garbage cursor", async () => {
    const page1 = await request(app.getHttpServer())
      .get('/journal/exercises')
      .query({ q: 'a', limit: '5' })
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect(page1.status).toBe(200);
    const cursorASearch = (page1.body as { nextCursor: string | null }).nextCursor;
    expect(cursorASearch).not.toBeNull();

    const present = (token: string, cursor: string): request.Test =>
      request(app.getHttpServer())
        .get('/journal/exercises')
        .query({ q: 'a', cursor })
        .set('X-Request-Id', PINNED_REQUEST_ID)
        .set('Authorization', `Bearer ${token}`);
    const foreign = await present(users.b.token, cursorASearch as string);
    const garbage = await present(users.b.token, 'w4abc garbage search cursor');
    expect(foreign.status).toBe(400);
    expect(foreign.text).toBe(garbage.text);
    // Bare envelope: no per-field errors array on the cursor denial class.
    expect((foreign.body as { errors?: unknown }).errors).toBeUndefined();
    // A's own cursor works for A.
    expect((await present(users.a.token, cursorASearch as string)).status).toBe(200);
  });

  it('the foreign search-cursor presentation lands a digest-only journal.search_cursor.foreign_binding audit row', async () => {
    const page1 = await request(app.getHttpServer())
      .get('/journal/exercises')
      .query({ q: 'e', limit: '5' })
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    const cursorASearch = (page1.body as { nextCursor: string | null }).nextCursor;
    if (cursorASearch !== null) {
      await request(app.getHttpServer())
        .get('/journal/exercises')
        .query({ q: 'e', cursor: cursorASearch })
        .set('X-Request-Id', PINNED_REQUEST_ID)
        .set('Authorization', `Bearer ${users.b.token}`);
    }
    const rows = await pollAuditRows('journal.search_cursor.foreign_binding', 1);
    expect(rows).toBeGreaterThanOrEqual(1);
    const detail = await adminQuery(
      db,
      `SELECT actor, target, justification FROM audit_events WHERE action = 'journal.search_cursor.foreign_binding' ORDER BY occurred_at DESC LIMIT 1`,
    );
    const flat = JSON.stringify(detail.rows[0]);
    expect(flat).not.toContain(users.a.userId);
    expect(flat).not.toContain(users.b.userId);
    expect(flat).not.toContain(cursorASearch ?? '~~unreachable~~');
  });
});

// ===========================================================================
// Op replay — dedupe is user-bound; foreign ids never match
// ===========================================================================

describe('cross-user op replay + per-op resolution', () => {
  it("B submitting an op carrying A's OP id (own entity) applies as B's OWN new op — never a duplicate match", async () => {
    // A's recorded op id from the fixture batch:
    const aOpId = advUuid(NS, 'opa01');
    const rows = await adminQuery(db, `SELECT outcome FROM sync_operations WHERE user_id = $1 AND client_op_id = $2`, [users.a.userId, aOpId]);
    expect(rows.rows).toHaveLength(1);

    const bReplay = await pushJournalBatch(
      app,
      users.b.token,
      [sessionOp({ opId: aOpId, entityId: B1, action: 'update', clientUpdatedAt: T1, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B retitled leg day') })],
      key('kb05'),
    );
    expect(bReplay.status).toBe(200);
    const results = resultsOf(bReplay);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ opId: aOpId, outcome: 'applied' }); // NOT duplicate
    // B's own row legitimately updated; A's row untouched.
    const bOwn = await request(app.getHttpServer())
      .get(`/journal/sessions/${B1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.b.token}`);
    expect((bOwn.body as { session: { title?: string } }).session.title).toBe('B retitled leg day');
    expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.a.userId, aOpId])).toBe(1);
  });

  it('mixed batch with a foreign-id op resolves cleanly per-op — the batch continues, no cross-contamination', async () => {
    const beforeBatch = await sessionRowSnapshot(users.a.userId, S1);
    const batch = await pushJournalBatch(
      app,
      users.b.token,
      [
        sessionOp({ opId: advUuid(NS, 'opb06'), entityId: advUuid(NS, 'sesb2'), action: 'create', clientUpdatedAt: T0, localDate: DAY_2, payload: sessionSnapshot(DAY_2, 'B second day') }),
        sessionOp({ opId: advUuid(NS, 'opb07'), entityId: S1, action: 'update', clientUpdatedAt: T2, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B attack title') }),
        routineOp({ opId: advUuid(NS, 'opb08'), entityId: advUuid(NS, 'roub1'), action: 'create', clientUpdatedAt: T0, payload: routineSnapshot('B template') }),
      ],
      key('kb06'),
    );
    expect(batch.status).toBe(200);
    const results = resultsOf(batch);
    expect(results.map((result) => result.outcome)).toEqual(['applied', 'rejected', 'applied']);
    expect(results[1]).toMatchObject({ code: 'rejected_conflict' });
    expect(await sessionRowSnapshot(users.a.userId, S1)).toBe(beforeBatch);
    const aOwn = await request(app.getHttpServer())
      .get(`/journal/sessions/${S1}`)
      .set('X-Request-Id', PINNED_REQUEST_ID)
      .set('Authorization', `Bearer ${users.a.token}`);
    expect((aOwn.body as { session: { title?: string } }).session.title).toBe('A push day');
  });

  it('duplicate replay of an applied journal batch ⇒ byte-identical replay ack, zero new rows', async () => {
    const opId = advUuid(NS, 'opb09');
    const entity = advUuid(NS, 'sesb3');
    const batchKey = key('kb07');
    const ops: JournalOpInput[] = [
      sessionOp({ opId, entityId: entity, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B dedupe day') }),
    ];
    const first = await pushJournalBatch(app, users.b.token, ops, batchKey);
    expect(resultsOf(first).map((result) => result.outcome)).toEqual(['applied']);
    const replay = await pushJournalBatch(app, users.b.token, ops, batchKey);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(first.text); // the Idempotency-Key replay path
    const freshKey = await pushJournalBatch(app, users.b.token, ops, key('kb08'));
    expect(resultsOf(freshKey).map((result) => result.outcome)).toEqual(['duplicate']);
    expect(await countRows(db, 'journal_sessions', 'id = $1 AND user_id = $2', [entity, users.b.userId])).toBe(1);
    expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.b.userId, opId])).toBe(1);
  });
});

// ===========================================================================
// The journal-equivalent PK-collision pin (the W3 cross-user ruling)
// ===========================================================================

describe('cross-user entity-id create ⇒ the generic 500, cause-indistinguishable (journal pin)', () => {
  it('B create with A session id ⇒ one generic 500; whole batch aborted; zero partial state', async () => {
    const collision = await pushJournalBatch(
      app,
      users.b.token,
      [
        sessionOp({ opId: advUuid(NS, 'opb10'), entityId: S1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B collision attempt') }),
      ],
      key('kb09'),
    );
    expect(collision.status).toBe(500);
    expect(codeOf(collision)).toBe('INTERNAL_ERROR');
    expect(collision.text).not.toContain(users.a.userId);
    expect(collision.text).not.toContain(S1);
    // Zero partial state: no ledger row, no session row, no idempotency-key record.
    expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.b.userId, advUuid(NS, 'opb10')])).toBe(0);
    expect(await countRows(db, 'journal_sessions', 'id = $1 AND user_id = $2', [S1, users.b.userId])).toBe(0);
  });

  it('the 500 is cause-indistinguishable: journal_session ≡ journal_routine ≡ diary_entry ≡ batch position (raw bytes)', async () => {
    const pinned = 'w4abc pinned collision request id 00';
    const post = (token: string, ops: readonly JournalOpInput[]): Promise<request.Response> =>
      request(app.getHttpServer())
        .post('/sync/ops')
        .set('X-Request-Id', pinned)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', nextKey())
        .send({ deviceId: 'w4abc-collision-device', ops });

    const sessionCollision = await post(users.b.token, [
      sessionOp({ opId: advUuid(NS, 'opb11'), entityId: S1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'x') }),
    ]);
    const routineCollision = await post(users.b.token, [
      routineOp({ opId: advUuid(NS, 'opb12'), entityId: R1, action: 'create', clientUpdatedAt: T0, payload: routineSnapshot('x') }),
    ]);
    const diaryCollision = await post(users.b.token, [diaryCreateOp(NS, 'opb13', 'diara1', T0, DAY_1) as unknown as JournalOpInput]);
    const positioned = await post(users.b.token, [
      sessionOp({ opId: advUuid(NS, 'opb14'), entityId: advUuid(NS, 'sesb4'), action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'valid lead op') }),
      sessionOp({ opId: advUuid(NS, 'opb15'), entityId: S1, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'x') }),
    ]);

    expect(sessionCollision.status).toBe(500);
    expect(routineCollision.status).toBe(500);
    expect(diaryCollision.status).toBe(500);
    expect(positioned.status).toBe(500);
    expect(sessionCollision.text).toBe(routineCollision.text);
    expect(sessionCollision.text).toBe(diaryCollision.text);
    expect(sessionCollision.text).toBe(positioned.text);

    // The positioned batch aborted WHOLE: its valid lead op left nothing.
    expect(await countRows(db, 'journal_sessions', 'id = $1 AND user_id = $2', [advUuid(NS, 'sesb4'), users.b.userId])).toBe(0);
    for (const op of ['opb11', 'opb12', 'opb13', 'opb14', 'opb15']) {
      expect(await countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [users.b.userId, advUuid(NS, op)])).toBe(0);
    }

    // The collision emit point fired, digest-only.
    const rows = await pollAuditRows('sync.ingest.entity_collision', 3);
    expect(rows).toBeGreaterThanOrEqual(3);
    const detail = await adminQuery(db, `SELECT actor, target, justification FROM audit_events WHERE action = 'sync.ingest.entity_collision' ORDER BY occurred_at DESC LIMIT 1`);
    const flat = JSON.stringify(detail.rows[0]);
    expect(flat).not.toContain(S1);
    expect(flat).not.toContain(R1);
    expect(flat).not.toContain(users.a.userId);
  });

  it('after an aborted collision batch the caller can proceed normally (no poisoning)', async () => {
    const entity = advUuid(NS, 'sesb5');
    const clean = await pushJournalBatch(
      app,
      users.b.token,
      [sessionOp({ opId: advUuid(NS, 'opb16'), entityId: entity, action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'B post-collision day') })],
      key('kb10'),
    );
    expect(resultsOf(clean).map((result) => result.outcome)).toEqual(['applied']);
    expect(await countRows(db, 'journal_sessions', 'id = $1 AND user_id = $2', [entity, users.b.userId])).toBe(1);
  });
});

// ===========================================================================
// Ack envelope privacy (I12)
// ===========================================================================

describe('ack envelope + response privacy', () => {
  it('ack bodies carry only the frozen envelope members — never payloads, titles, snapshots, or user ids', async () => {
    const ops: JournalOpInput[] = [
      sessionOp({ opId: advUuid(NS, 'opb17'), entityId: advUuid(NS, 'sesb6'), action: 'create', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, `secret title ${HEALTH_MARKER}`) }),
      sessionOp({ opId: advUuid(NS, 'opb18'), entityId: S1, action: 'update', clientUpdatedAt: T0, localDate: DAY_1, payload: sessionSnapshot(DAY_1, 'x') }),
    ];
    const response = await pushJournalBatch(app, users.b.token, ops, key('kb11'));
    expect(response.status).toBe(200);
    const body = response.body as { results: Record<string, unknown>[] };
    const allowed = ['code', 'opId', 'outcome', 'retryable'];
    for (const result of body.results) {
      for (const member of Object.keys(result)) {
        expect(allowed, `unexpected ack member: ${member}`).toContain(member);
      }
    }
    expect(response.text).not.toContain(HEALTH_MARKER);
    expect(response.text).not.toContain('secret title');
    expect(response.text).not.toContain('Barbell back squat');
    expect(response.text).not.toContain(users.a.userId);
  });
});
