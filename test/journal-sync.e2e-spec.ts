/**
 * Kal journal sync UNION e2e (wave-04, lane s2c — the registration-union
 * verification) — the real AppModule against a real, fully-migrated,
 * EPHEMERAL PostgreSQL database; the REAL ingestion path end to end:
 * identity → `POST /sync/ops` (frozen envelope, Idempotency-Key) → the
 * registered journal handlers (s2a's `journal_session` + this lane's
 * `journal_routine`, exactly once each) → `GET /sync/changes` → the PR read.
 *
 * This file pins the cases that REQUIRE the union (they cannot exist on
 * either lane's pre-union tree):
 *   - the union boot pin: BOTH journal kinds are registered exactly once in
 *     sync's two production registries, and the duplicate-registration boot
 *     guards still fire;
 *   - the `journal_routine` lifecycle over the real HTTP boundary:
 *     applied → replay ⇒ `duplicate` (zero effects, row-counted) → LWW
 *     update → stale-loser applied-nothing → delete → same-id re-create ⇒
 *     `rejected_deleted` (no resurrection) → idempotent re-delete;
 *   - a `journal_routine` op carrying `localDate` is the WHOLE-BATCH 400
 *     class at envelope layer-1 (the localDate-FORBIDDEN class — a template
 *     has no day), nothing recorded;
 *   - Ruling 4 over HTTP: the routine feed upserts carry the STORED-entity
 *     projection (frozen name snapshots + server child ids), never the bare
 *     op shape;
 *   - PR idempotence under duplicate session replay (the dedicated
 *     task-contract case): pushing the same `journal_session` op twice
 *     (duplicate ack) never inflates or moves the PR; the equal-estimate
 *     tie pair (100×8 ≡ 95×10) keeps the FIRST achievement through the real
 *     path; tombstoning the winning session moves the PR source (value
 *     equal, locator moved — the derived-never-stored posture);
 *   - cross-user op-id replay NEVER matches (the dedupe key binds the user,
 *     §3): B pushing A's opId with B's own entity applies as B's OWN op;
 *     A's PR is B-proof.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { applyExerciseCatalogSeed } from '../prisma/seed-apply.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { OpHandlerRegistry } from '../src/sync/ingestion/op-handler-registry.js';
import { SyncDeltaRegistry } from '../src/sync/pull/delta-registry.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4journal4union4lane4fixed4key4material4with4enough4entropy01';
const PASSWORD = 'union-e2e-password-01';
const DEVICE = 'union-e2e-device';

/** Real catalog rows (the seeded manifest — names asserted through the feed). */
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';

const USER_A = { email: 'union-a@example.com', phone: '+201300000001', username: 'union_e2e_a' };
const USER_B = { email: 'union-b@example.com', phone: '+201300000002', username: 'union_e2e_b' };

let app: INestApplication<App>;
let db: EphemeralKalDb;
let tokenA = '';
let tokenB = '';

function fixtureUuid(n: number): string {
  return `6cf10000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
function opId(n: number): string {
  return `8d0f0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
function keyId(n: number): string {
  return `8cef0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function push(token: string, ops: unknown[], key: string) {
  return request(app.getHttpServer())
    .post('/sync/ops')
    .set(bearer(token))
    .set('Idempotency-Key', key)
    .send({ deviceId: DEVICE, ops });
}

function routinePayload(name: string): Record<string, unknown> {
  return {
    name,
    exercises: [
      {
        exerciseId: EX_SQUAT,
        position: 0,
        sets: [
          { format: 'weighted', weightKg: 60, reps: 8 },
          { format: 'timed', durationSeconds: 45 },
        ],
      },
    ],
  };
}

function sessionPayload(localDate: string, weightKg: number, reps: number): Record<string, unknown> {
  return {
    localDate,
    title: 'Union e2e squat day',
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg, reps }] },
    ],
  };
}

async function routineRowCount(userId: string, entityId: string): Promise<number> {
  const result = await adminQuery(db, 'SELECT COUNT(*)::int AS count FROM journal_routines WHERE user_id = $1 AND id = $2', [userId, entityId]);
  return Number((result.rows[0] as { count: number }).count);
}

async function pullChanges(token: string): Promise<{ changes: { kind: string; entityId: string; change: string; payload?: { name?: string; exercises?: { nameSnapshotEn?: string; id?: string }[] }[] }[]; nextCursor: string | null }> {
  const response = await request(app.getHttpServer()).get('/sync/changes').set(bearer(token)).expect(200);
  return response.body as { changes: { kind: string; entityId: string; change: string; payload?: { name?: string; exercises?: { nameSnapshotEn?: string; id?: string }[] }[] }[]; nextCursor: string | null };
}

async function prBody(token: string, exerciseId: string): Promise<Record<string, unknown>> {
  const response = await request(app.getHttpServer()).get(`/journal/exercises/${exerciseId}/pr`).set(bearer(token)).expect(200);
  return response.body as Record<string, unknown>;
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('s2c-union-e2e');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      await applyExerciseCatalogSeed(seedClient);
    } finally {
      await seedClient.$disconnect();
    }
    const previous: Record<string, string | undefined> = {
      DATABASE_URL: process.env['DATABASE_URL'],
      IDENTITY_JWT_SIGNING_KEY: process.env['IDENTITY_JWT_SIGNING_KEY'],
    };
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
    for (const [index, user] of [USER_A, USER_B].entries()) {
      await request(app.getHttpServer()).post('/identity/signup').send({ ...user, password: PASSWORD }).expect(200);
      const signin = await request(app.getHttpServer())
        .post('/identity/signin')
        .set('X-Device-Id', `${DEVICE}-${index}`)
        .send({ identifier: user.username, password: PASSWORD })
        .expect(200);
      if (index === 0) {
        tokenA = (signin.body as { accessToken: string }).accessToken;
      } else {
        tokenB = (signin.body as { accessToken: string }).accessToken;
      }
    }
  })();
}, 240_000);

afterAll(() => {
  return (async () => {
    await app?.close();
    await db?.drop();
  })();
}, 60_000);

// ---------------------------------------------------------------------------

describe('the registration union — boot pin', () => {
  it('both production registries carry all five kinds — both journal kinds exactly once each', () => {
    const handlers = app.get(OpHandlerRegistry).registeredKinds();
    const providers = app.get(SyncDeltaRegistry).registeredKinds();
    expect([...handlers].sort()).toEqual(['diary_entry', 'favorite', 'journal_routine', 'journal_session', 'user_food']);
    expect([...providers].sort()).toEqual(['diary_entry', 'favorite', 'journal_routine', 'journal_session', 'user_food']);
    // Exactly once each (a Set of the same length proves no duplicates).
    expect(new Set(handlers).size).toBe(handlers.length);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it('the duplicate-registration boot guards still fire (registry integrity, fail fast)', () => {
    const handlerRegistry = new OpHandlerRegistry();
    const probe = { kind: 'journal_routine' as const, apply: async () => ({ outcome: 'applied' as const }) };
    handlerRegistry.registerOpHandler(probe);
    expect(() => handlerRegistry.registerOpHandler(probe)).toThrow(/already registered/u);
    const deltaRegistry = new SyncDeltaRegistry();
    const provider = { kind: 'journal_routine' as const, changesSince: async () => ({ changes: [], exhausted: true }) };
    deltaRegistry.registerDeltaProvider('journal_routine', provider);
    expect(() => deltaRegistry.registerDeltaProvider('journal_routine', provider)).toThrow(/already registered/u);
    expect(() => deltaRegistry.registerDeltaProvider('journal_session', { ...provider, kind: 'journal_routine' } as never)).toThrow(/reports kind/u);
  });
});

describe('journal_routine over the real ingestion path (§1) — the union surface', () => {
  const routineEntity = fixtureUuid(1);

  it('create applies; the SAME op replayed acks duplicate with ZERO effects (row-counted)', async () => {
    const op = {
      opId: opId(1),
      kind: 'journal_routine',
      entityId: routineEntity,
      action: 'create',
      clientUpdatedAt: '2026-10-12T10:00:00.000Z',
      payload: routinePayload('Union push day'),
    };
    const first = await push(tokenA, [op], keyId(1));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ results: [{ opId: opId(1), outcome: 'applied' }] });
    // Replay: same op, NEW Idempotency-Key — per-op dedupe on (user, opId).
    const replay = await push(tokenA, [op], keyId(2));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ results: [{ opId: opId(1), outcome: 'duplicate' }] });
    expect(await routineRowCount(await resolveUserId(USER_A.username), routineEntity)).toBe(1);
    // Idempotency-Key replay (same key + same body) is the byte-stable recorded response.
    const keyed = await push(tokenA, [op], keyId(1));
    expect(keyed.body).toMatchObject({ results: [{ opId: opId(1), outcome: 'applied' }] });
  });

  it('the feed upsert carries the STORED-entity projection — frozen name snapshot + server child ids (Ruling 4)', async () => {
    const feed = await pullChanges(tokenA);
    const routineUpserts = feed.changes.filter((change) => change.kind === 'journal_routine' && change.change === 'upsert');
    expect(routineUpserts).toHaveLength(1);
    const payload = routineUpserts[0]?.payload;
    expect(payload?.name).toBe('Union push day');
    const entry = payload?.exercises?.[0];
    expect(entry?.nameSnapshotEn).toBe('Barbell back squat'); // frozen at apply — Ruling 4 shape
    expect(typeof entry?.id).toBe('string'); // the server child id rides the projection
  });

  it('LWW: a winning update applies; a stale loser acks applied and changes nothing', async () => {
    const winner = {
      opId: opId(2),
      kind: 'journal_routine',
      entityId: routineEntity,
      action: 'update',
      clientUpdatedAt: '2026-10-12T11:00:00.000Z',
      payload: routinePayload('Union push day — renamed'),
    };
    await push(tokenA, [winner], keyId(3)).then((response) => {
      expect(response.body).toMatchObject({ results: [{ outcome: 'applied' }] });
    });
    const loser = {
      opId: opId(3),
      kind: 'journal_routine',
      entityId: routineEntity,
      action: 'update',
      clientUpdatedAt: '2026-10-12T10:30:00.000Z', // earlier than the stored substrate — loses (§1.4)
      payload: routinePayload('Stale loser name'),
    };
    await push(tokenA, [loser], keyId(4)).then((response) => {
      expect(response.body).toMatchObject({ results: [{ opId: opId(3), outcome: 'applied' }] });
    });
    // The loser changed nothing; the winning rename stands.
    const feed = await pullChanges(tokenA);
    const names = feed.changes.filter((change) => change.kind === 'journal_routine' && change.change === 'upsert').map((change) => change.payload?.name);
    expect(names).toContain('Union push day — renamed');
    expect(names).not.toContain('Stale loser name');
  });

  it('a journal_routine op carrying localDate is the WHOLE-BATCH 400 class — nothing recorded', async () => {
    const response = await push(tokenA, [
      {
        opId: opId(4),
        kind: 'journal_routine',
        entityId: fixtureUuid(9),
        action: 'create',
        clientUpdatedAt: '2026-10-12T12:00:00.000Z',
        localDate: '2026-10-12', // FORBIDDEN on routines — a template has no day
        payload: routinePayload('Should never land'),
      },
    ], keyId(5));
    expect(response.status).toBe(400);
    expect((response.body as { code?: string }).code).toBe('VALIDATION_FAILED');
    const count = await adminQuery(db, 'SELECT COUNT(*)::int AS count FROM journal_routines WHERE name = $1', ['Should never land']);
    expect(Number((count.rows[0] as { count: number }).count)).toBe(0);
  });

  it('delete tombstones; same-id re-create is rejected_deleted (no resurrection); re-delete is idempotent', async () => {
    const del = {
      opId: opId(5),
      kind: 'journal_routine',
      entityId: routineEntity,
      action: 'delete',
      clientUpdatedAt: '2026-10-12T12:30:00.000Z',
    };
    const response = await push(tokenA, [del], keyId(6));
    expect(response.body).toMatchObject({ results: [{ opId: opId(5), outcome: 'applied' }] });
    // Resurrection block: create on the tombstoned id ⇒ terminal rejection.
    const resurrect = {
      opId: opId(6),
      kind: 'journal_routine',
      entityId: routineEntity,
      action: 'create',
      clientUpdatedAt: '2026-10-12T13:00:00.000Z',
      payload: routinePayload('Resurrection attempt'),
    };
    const blocked = await push(tokenA, [resurrect], keyId(7));
    expect(blocked.body).toMatchObject({ results: [{ opId: opId(6), outcome: 'rejected', code: 'rejected_deleted', retryable: false }] });
    // Idempotent re-delete.
    const again = { ...del, opId: opId(7), clientUpdatedAt: '2026-10-12T13:30:00.000Z' };
    const second = await push(tokenA, [again], keyId(8));
    expect(second.body).toMatchObject({ results: [{ opId: opId(7), outcome: 'applied' }] });
    // The feed surfaced the payload-free tombstone delete for the routine.
    const feed = await pullChanges(tokenA);
    const tombstones = feed.changes.filter((change) => change.kind === 'journal_routine' && change.change === 'delete');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.entityId).toBe(routineEntity);
    expect(tombstones[0]?.payload).toBeUndefined();
  });
});

describe('PR idempotence under duplicate session replay (the dedicated union case)', () => {
  const sessionA = fixtureUuid(2); // 2026-03-01 — 100 kg × 8 (126.67; the FIRST achievement)
  const sessionB = fixtureUuid(3); // 2026-03-05 — 95 kg × 10 (ties 126.67 exactly)
  let userAId = '';
  let userBId = '';

  beforeAll(() => {
    return (async () => {
      const a = await adminQuery(db, 'SELECT id FROM users WHERE username = $1', [USER_A.username]);
      const b = await adminQuery(db, 'SELECT id FROM users WHERE username = $1', [USER_B.username]);
      userAId = (a.rows[0] as { id: string }).id;
      userBId = (b.rows[0] as { id: string }).id;
    })();
  });

  it('the session create applies; the PR derives 126.67 (Epley) from it', async () => {
    const op = {
      opId: opId(11),
      kind: 'journal_session',
      entityId: sessionA,
      action: 'create',
      clientUpdatedAt: '2026-10-12T14:00:00.000Z',
      localDate: '2026-03-01',
      payload: sessionPayload('2026-03-01', 100, 8),
    };
    const response = await push(tokenA, [op], keyId(11));
    expect(response.body).toMatchObject({ results: [{ opId: opId(11), outcome: 'applied' }] });
    expect(await prBody(tokenA, EX_SQUAT)).toEqual({
      result: 'pr',
      pr: {
        exerciseId: EX_SQUAT,
        estimatedOneRepMaxKg: 126.67,
        sourceSet: { sessionId: sessionA, setId: expect.any(String), weightKg: 100, reps: 8, sessionLocalDate: '2026-03-01' },
        achievedOn: '2026-03-01',
      },
    });
  });

  it('replaying the SAME session op acks duplicate and the PR is UNCHANGED (no inflation, no movement)', async () => {
    const op = {
      opId: opId(11),
      kind: 'journal_session',
      entityId: sessionA,
      action: 'create',
      clientUpdatedAt: '2026-10-12T14:00:00.000Z',
      localDate: '2026-03-01',
      payload: sessionPayload('2026-03-01', 100, 8),
    };
    const replay = await push(tokenA, [op], keyId(12));
    expect(replay.body).toMatchObject({ results: [{ opId: opId(11), outcome: 'duplicate' }] });
    const setCount = await adminQuery(db, 'SELECT COUNT(*)::int AS count FROM journal_exercise_sets WHERE user_id = $1', [userAId]);
    expect(Number((setCount.rows[0] as { count: number }).count)).toBe(1); // the replay inserted nothing
    const after = await prBody(tokenA, EX_SQUAT);
    expect((after.pr as { sourceSet: { sessionId: string } }).sourceSet.sessionId).toBe(sessionA);
    expect(after).toEqual(await prBody(tokenA, EX_SQUAT)); // re-derivation is bit-identical
  });

  it('the equal-estimate LATER session (95×10) cannot steal the PR — first achievement wins through the real path', async () => {
    const op = {
      opId: opId(12),
      kind: 'journal_session',
      entityId: sessionB,
      action: 'create',
      clientUpdatedAt: '2026-10-12T14:30:00.000Z',
      localDate: '2026-03-05',
      payload: sessionPayload('2026-03-05', 95, 10),
    };
    const response = await push(tokenA, [op], keyId(13));
    expect(response.body).toMatchObject({ results: [{ opId: opId(12), outcome: 'applied' }] });
    const body = await prBody(tokenA, EX_SQUAT);
    // 100×8 and 95×10 derive the SAME 126.67 — the tie keeps the EARLIER session.
    expect((body.pr as { estimatedOneRepMaxKg: number }).estimatedOneRepMaxKg).toBe(126.67);
    expect((body.pr as { sourceSet: { sessionId: string } }).sourceSet.sessionId).toBe(sessionA);
  });

  it('tombstoning the winning session via a real delete op MOVES the PR source (value equal, locator moved)', async () => {
    const del = {
      opId: opId(13),
      kind: 'journal_session',
      entityId: sessionA,
      action: 'delete',
      clientUpdatedAt: '2026-10-12T15:00:00.000Z',
      localDate: '2026-03-01',
    };
    const response = await push(tokenA, [del], keyId(14));
    expect(response.body).toMatchObject({ results: [{ opId: opId(13), outcome: 'applied' }] });
    const body = await prBody(tokenA, EX_SQUAT);
    expect((body.pr as { estimatedOneRepMaxKg: number }).estimatedOneRepMaxKg).toBe(126.67);
    expect((body.pr as { sourceSet: { sessionId: string } }).sourceSet.sessionId).toBe(sessionB); // derived-never-stored: the read recomputed
  });

  it('cross-user op-id replay NEVER matches (the dedupe key binds the user, §3) — and A’s PR is B-proof', async () => {
    // B pushes A's SESSION opId with B's OWN entity id: the user-bound dedupe
    // misses, so it applies as B's OWN session — never as a duplicate of A's.
    const op = {
      opId: opId(11), // A's op id
      kind: 'journal_session',
      entityId: fixtureUuid(4), // B's own entity
      action: 'create',
      clientUpdatedAt: '2026-10-12T14:10:00.000Z',
      localDate: '2026-03-02',
      payload: sessionPayload('2026-03-02', 40, 12),
    };
    const response = await push(tokenB, [op], keyId(15));
    expect(response.body).toMatchObject({ results: [{ opId: opId(11), outcome: 'applied' }] }); // NOT duplicate — the key is (user, opId)
    // B's PR is B's own (40×12 → 56), never A's 126.67.
    const bs = await prBody(tokenB, EX_SQUAT);
    expect((bs.pr as { estimatedOneRepMaxKg: number }).estimatedOneRepMaxKg).toBe(56);
    expect((bs.pr as { sourceSet: { sessionId: string } }).sourceSet.sessionId).toBe(fixtureUuid(4));
    // A's PR is untouched by B's session.
    const as_ = await prBody(tokenA, EX_SQUAT);
    expect((as_.pr as { sourceSet: { sessionId: string } }).sourceSet.sessionId).toBe(sessionB);
    // Same cross-user cell for a routine op id: B replaying A's ROUTINE op id
    // applies as B's own op, not a duplicate of A's.
    const routineOp = {
      opId: opId(1), // A's routine op id from the lifecycle describe
      kind: 'journal_routine',
      entityId: fixtureUuid(5), // B's own entity
      action: 'create',
      clientUpdatedAt: '2026-10-12T10:05:00.000Z',
      payload: routinePayload('B own template'),
    };
    const routineResponse = await push(tokenB, [routineOp], keyId(16));
    expect(routineResponse.body).toMatchObject({ results: [{ opId: opId(1), outcome: 'applied' }] });
    expect(await routineRowCount(userBId, fixtureUuid(5))).toBe(1);
    expect(await routineRowCount(userAId, routineOp.entityId as string)).toBe(0);
  });
});

/** Resolves the verified database binding for a username (server truth, I6). */
async function resolveUserId(username: string): Promise<string> {
  const rows = await adminQuery(db, 'SELECT id FROM users WHERE username = $1', [username]);
  return (rows.rows[0] as { id: string }).id;
}
