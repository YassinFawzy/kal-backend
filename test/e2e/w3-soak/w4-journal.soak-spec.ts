/**
 * Kal — wave-4 s4 adversarial: JOURNAL soak/replay cells (additive battery
 * under the w3 soak config — same standalone invocation, serialized).
 *
 *   pnpm vitest run --config test/e2e/w3-soak/vitest.w3-soak.config.ts
 *
 * Runs the REAL AppModule on an ephemeral PostgreSQL behind a real HTTP
 * listener; every scenario drives the wire through the FaultProxy (no
 * mocked handlers) with deterministic one-shot keyed faults and a seeded
 * PRNG. The oracle discipline holds: nothing under `src/` is imported for
 * EXPECTATIONS — the in-file oracle transcribes the frozen contract
 * (w3 §1 + w4 §1) independently; `src/app.module.js` is the system under
 * test, exactly as the w3 runner treats it.
 *
 * Battery (task contract s4-adversarial):
 *   1. offline session log → reconnect ⇒ EXACTLY ONCE (client-ID dedupe)
 *      under drop-before + transport duplicate + same-key replays.
 *   2. three-sessions-one-edit under drop+retry+stall.
 *   3. session tombstone propagation + no-resurrection (stale replays).
 *   4. training-day mark stability across replays.
 *   5. sub-ms LWW orientation BOTH ways for session entities (+ opId
 *      tiebreak, the W3 golden pattern extended).
 *   6. F-s2c-1 ADJUDICATION (W3 diary surface — findings-only, no product
 *      edits): engineered same-second sub-second diary rows, limit-1 walk —
 *      proves no loss, convergence-safe, but DUPLICATE re-delivery AND a
 *      NON-TERMINATING walk (cursor regression) on the merged tree.
 *   7. the SAME census for `journal_session` (identical provider shape on
 *      this wave's own surface — findings-only).
 *
 * The F-s2c-1/F-s4 evidence cells pin OBSERVED merged-tree behavior; a
 * supervisor change package that fixes the providers is expected to update
 * these cells in the same package (they are this lane's files).
 */
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../../generated/prisma/client.ts';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { applyExerciseCatalogSeed, applyFoodCatalogSeed } from '../../../prisma/seed-apply.js';
import { createEphemeralKalDb, type EphemeralKalDb } from '../../integration/helpers/ephemeral-db.js';
import { advUuid, quickAddSnapshot } from '../../integration/helpers/three-user-harness.js';
import { FaultProxy } from './harness/faults.js';
import { makeRng } from './harness/support.js';

const SIGNING_KEY = 'w4js7soak7lane7fixed7key7material7with7enough7entropy77';
const RUN_SEED = 0x5bef; // deterministic; the battery is rerunnable

const DAY = '2026-10-08';
const T_BASE_MS = Date.parse('2026-10-08T07:00:00.000Z');
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';
const EX_PLANK = '00000000-0000-4000-8000-00000000f21f';

let db: EphemeralKalDb;
let app: INestApplication<App>;
let appBaseUrl = '';
let dbPool: Pool;

// ---------------------------------------------------------------------------
// Wire client (raw fetch through the proxy; the fault profiles script the
// failures, the client retries blindly on network errors with the SAME
// bytes and key — the offline-device posture).
// ---------------------------------------------------------------------------

interface JournalOpLike {
  readonly opId: string;
  readonly kind: 'journal_session' | 'journal_routine' | 'diary_entry';
  readonly entityId: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly clientUpdatedAt: string;
  readonly localDate?: string;
  readonly payload?: Record<string, unknown>;
}

interface WireResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
  readonly attempts: number;
}

class SoakDevice {
  readonly deliveries = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    readonly token: string,
    private readonly deviceId: string,
    private readonly scenario: string,
  ) {}

  private marker(): Record<string, string> {
    return { 'x-kal-soak-device': `${this.scenario}-${this.deviceId}` };
  }

  /** POST /sync/ops with blind same-bytes retry on network errors. */
  async push(proxy: FaultProxy | null, ops: readonly JournalOpLike[], key: string, attempts = 6): Promise<WireResult> {
    const base = proxy === null ? this.baseUrl : proxy.baseUrl;
    const body = JSON.stringify({ deviceId: this.deviceId, ops });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${base}/sync/ops`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, Authorization: `Bearer ${this.token}`, ...this.marker() },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const raw = await response.text();
        return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw, attempts: attempt };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`push did not succeed within ${attempts} attempts: ${String(lastError)}`);
  }

  async pull(proxy: FaultProxy | null, query: Record<string, string>): Promise<{ status: number; body: PullBody }> {
    const base = proxy === null ? this.baseUrl : proxy.baseUrl;
    const search = new URLSearchParams(query).toString();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await fetch(`${base}/sync/changes?${search}`, {
          headers: { Authorization: `Bearer ${this.token}`, ...this.marker() },
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await response.json()) as PullBody;
        return { status: response.status, body };
      } catch (error) {
        if (attempt === 6) {
          throw new Error(`pull did not succeed within 6 attempts: ${String(error)}`);
        }
      }
    }
    throw new Error('unreachable');
  }

}

interface PullBody {
  readonly changes: readonly { kind: string; entityId: string; change: 'upsert' | 'delete'; updatedAt: string; payload?: Record<string, unknown> }[];
  readonly nextCursor: string | null;
}

interface WalkCensus {
  /** Delivered change records in arrival order. */
  readonly changes: PullBody['changes'];
  /** entityId → delivery count. */
  readonly counts: Map<string, number>;
  /** nextCursor token → occurrence count (a repeat = the walk regressed). */
  readonly cursorRepeats: Map<string, number>;
  readonly pages: number;
  readonly drained: boolean;
}

/**
 * Walks the feed with the given page size. `pageCap` bounds the walk: the
 * F-s2c-1 census cells EXPECT a non-draining walk and assert on the census,
 * so a capped walk is a measurement, not a failure.
 */
async function walk(device: SoakDevice, proxy: FaultProxy | null, limit: string, pageCap: number): Promise<WalkCensus> {
  const changes: PullBody['changes'] = [];
  const counts = new Map<string, number>();
  const cursorRepeats = new Map<string, number>();
  let cursor: string | null = null;
  let drained = false;
  for (let page = 0; page < pageCap; page += 1) {
    const query: Record<string, string> = { limit };
    if (cursor !== null) {
      query.cursor = cursor;
    }
    const result = await device.pull(proxy, query);
    expect(result.status).toBe(200);
    for (const change of result.body.changes) {
      changes.push(change);
      counts.set(change.entityId, (counts.get(change.entityId) ?? 0) + 1);
    }
    if (result.body.nextCursor === null) {
      drained = true;
      break;
    }
    cursor = result.body.nextCursor;
    cursorRepeats.set(cursor, (cursorRepeats.get(cursor) ?? 0) + 1);
  }
  return { changes, counts, cursorRepeats, pages: pageCap, drained };
}

/** Applies delivered changes arrival-order to a merged view (the contract oracle). */
function applyToMergedView(changes: PullBody['changes']): Map<string, 'live' | 'gone'> {
  const view = new Map<string, 'live' | 'gone'>();
  for (const change of changes) {
    view.set(change.entityId, change.change === 'upsert' ? 'live' : 'gone');
  }
  return view;
}

// ---------------------------------------------------------------------------
// Op builders
// ---------------------------------------------------------------------------

function instantAt(msOffset: number): string {
  return new Date(T_BASE_MS + msOffset).toISOString();
}

function sessionPayload(localDate: string, title: string): Record<string, unknown> {
  return {
    localDate,
    title,
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 80, reps: 5 }] },
      { exerciseId: EX_PLANK, position: 1, sets: [{ format: 'timed', durationSeconds: 45 }] },
    ],
  };
}

function sessionCreate(tag: string, at: string, title: string): JournalOpLike {
  return { opId: advUuid('4a6c', tag), kind: 'journal_session', entityId: advUuid('4a6c', `${tag}e`), action: 'create', clientUpdatedAt: at, localDate: DAY, payload: sessionPayload(DAY, title) };
}

function sessionUpdate(tag: string, entityId: string, at: string, title: string): JournalOpLike {
  return { opId: advUuid('4a6c', tag), kind: 'journal_session', entityId, action: 'update', clientUpdatedAt: at, localDate: DAY, payload: sessionPayload(DAY, title) };
}

function diaryCreate(tag: string, entityId: string, at: string): JournalOpLike {
  return { opId: advUuid('4a6c', tag), kind: 'diary_entry', entityId, action: 'create', clientUpdatedAt: at, localDate: DAY, payload: quickAddSnapshot(DAY) };
}

// ---------------------------------------------------------------------------
// Identity + boot
// ---------------------------------------------------------------------------

let userSeq = 0;
async function provisionUser(tag: string): Promise<{ userId: string; token: string }> {
  userSeq += 1;
  const suffix = `${userSeq}${Math.floor(makeRng(RUN_SEED + userSeq)() * 1e6)}`.slice(0, 9).padStart(9, '0');
  const credentials = { email: `${tag}@w4jsoak.invalid`, phone: `+2017${suffix}`, username: `w4jsoak_${tag}`.slice(0, 30), password: 'w4jsoak-password-01' };
  const signup = await fetch(`${appBaseUrl}/identity/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(10_000) });
  expect(signup.status).toBe(200);
  const signin = await fetch(`${appBaseUrl}/identity/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': `w4jsoak-${tag}` },
    body: JSON.stringify({ identifier: credentials.username, password: credentials.password }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(signin.status).toBe(200);
  const token = ((await signin.json()) as { accessToken?: string }).accessToken ?? '';
  const me = await fetch(`${appBaseUrl}/identity/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const userId = ((await me.json()) as { user?: { id?: string } }).user?.id ?? '';
  expect(userId).toMatch(/^[0-9a-f-]{36}$/u);
  return { userId, token };
}

async function sessionCount(userId: string, where = ''): Promise<number> {
  const result = await dbPool.query(`SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = $1 ${where}`, [userId]);
  return (result.rows[0] as { n: number }).n;
}

async function markCount(userId: string, day: string): Promise<number> {
  const result = await dbPool.query(`SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = $1 AND local_date = $2`, [userId, day]);
  return (result.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('w4jsoak');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const databaseUrl = url.toString();
  const seedPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const seedClient = new PrismaClient({ adapter: new PrismaPg(seedPool, { disposeExternalPool: true }) });
  try {
    expect((await applyFoodCatalogSeed(seedClient)).foods).toBe(48);
    expect((await applyExerciseCatalogSeed(seedClient)).exercises).toBe(50);
  } finally {
    await seedClient.$disconnect();
  }
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
    // The soak exercises idempotency/replay, not the limit surfaces (the
    // dedicated limits battery owns those) — bounds-legal raises.
    TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '1000',
    TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '10000',
    JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '100',
    JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000',
  };
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
  const address = (app.getHttpServer() as import('node:http').Server).address();
  if (address === null || typeof address === 'string') {
    throw new Error('soak app did not bind a tcp listener');
  }
  appBaseUrl = `http://127.0.0.1:${address.port}`;
  dbPool = db.pool;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ===========================================================================
// 1. Offline session log → reconnect ⇒ exactly once
// ===========================================================================

describe('replay/soak: offline session log syncs exactly once on reconnect', () => {
  it('5 offline sessions survive drop-before + same-key replays + a transport duplicate with ZERO duplicates', async () => {
    const proxy = new FaultProxy({ targetPort: Number(new URL(appBaseUrl).port), targetHost: '127.0.0.1' });
    await proxy.start();
    try {
      const { userId, token } = await provisionUser('onceonly');
      const device = new SoakDevice(appBaseUrl, token, 'dev-a', 'onceonly');
      // Offline: five sessions logged locally, never pushed.
      const ops: JournalOpLike[] = [
        sessionCreate('oc1', instantAt(0), 'push day'),
        sessionCreate('oc2', instantAt(60_000), 'pull day'),
        sessionCreate('oc3', instantAt(120_000), 'legs'),
        sessionCreate('oc4', instantAt(180_000), 'intervals'),
        sessionCreate('oc5', instantAt(240_000), 'mobility'),
      ];
      const key = advUuid('4a6c', 'onceonly-key');
      // Reconnect: the first flight DIES in transit (drop-before), the retry
      // is forwarded TWICE (transport duplicate) — dedupe must hold.
      proxy.injectOnce(
        (request) => request.path === '/sync/ops' && request.headers['x-kal-soak-device'] === 'onceonly-dev-a',
        { type: 'drop-before' },
      );
      proxy.injectOnce(
        (request) => request.path === '/sync/ops' && request.headers['idempotency-key'] === key,
        { type: 'duplicate' },
      );
      const first = await device.push(proxy, ops, key);
      expect(first.status).toBe(200);
      const results = (first.body as { results: { outcome: string }[] }).results;
      expect(results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);

      // The device replays the SAME batch (same key) twice — the stored
      // response replays byte-identically, nothing re-applies.
      const replay1 = await device.push(proxy, ops, key);
      expect(replay1.raw).toBe(first.raw);
      const replay2 = await device.push(proxy, ops, key);
      expect(replay2.raw).toBe(first.raw);

      // A different device with a FRESH key carrying the SAME op ids —
      // the per-op dedupe: every outcome is `duplicate`, zero new rows.
      const freshKey = await device.push(proxy, ops, advUuid('4a6c', 'onceonly-key2'));
      expect((freshKey.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual([
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
      ]);

      // Server truth: exactly five session rows, ten exercise children, ten sets
      // (the payload carries two exercises of one set each per session).
      expect(await sessionCount(userId)).toBe(5);
      const children = await dbPool.query(
        `SELECT (SELECT count(*)::int FROM journal_session_exercises WHERE user_id = $1) AS ex, (SELECT count(*)::int FROM journal_exercise_sets WHERE user_id = $1) AS st`,
        [userId],
      );
      expect(children.rows[0]).toEqual({ ex: 10, st: 10 });

      // The feed: each session delivered exactly once (current-state feed).
      const census = await walk(device, proxy, '50', 20);
      expect(census.drained).toBe(true);
      expect(census.changes).toHaveLength(5);
      for (const op of ops) {
        expect(census.counts.get(op.entityId)).toBe(1);
      }
      expect(proxy.findings).toEqual([]);
    } finally {
      await proxy.stop();
    }
  }, 120_000);
});

// ===========================================================================
// 2. Three sessions, one edit, under drop+retry+stall
// ===========================================================================

describe('replay/soak: three-sessions-one-edit under drop+retry', () => {
  it('the edit lands on exactly the edited session; faults never duplicate or lose an apply', async () => {
    const proxy = new FaultProxy({ targetPort: Number(new URL(appBaseUrl).port), targetHost: '127.0.0.1' });
    await proxy.start();
    try {
      const { userId, token } = await provisionUser('threeedit');
      const device = new SoakDevice(appBaseUrl, token, 'dev-a', 'threeedit');
      const creates = [sessionCreate('te1', instantAt(0), 'day one'), sessionCreate('te2', instantAt(60_000), 'day two'), sessionCreate('te3', instantAt(120_000), 'day three')];
      const batchKey = advUuid('4a6c', 'threeedit-key');
      proxy.injectOnce((request) => request.path === '/sync/ops' && request.headers['x-kal-soak-device'] === 'threeedit-dev-a', { type: 'drop-before' });
      proxy.injectOnce((request) => request.path === '/sync/ops' && request.headers['idempotency-key'] === batchKey, { type: 'stall', holdMs: 60 });
      const first = await device.push(proxy, creates, batchKey);
      expect(first.status).toBe(200);
      expect((first.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied']);

      // The offline edit of session #2 (entity id derived like the builder's).
      const e2 = advUuid('4a6c', 'te2e');
      const edit = sessionUpdate('te2u', e2, instantAt(600_000), 'day two — EDITED');
      const editKey = advUuid('4a6c', 'threeedit-edit-key');
      proxy.injectOnce((request) => request.path === '/sync/ops' && request.headers['idempotency-key'] === editKey, { type: 'drop-after' });
      const editResult = await device.push(proxy, [edit], editKey);
      expect(editResult.status).toBe(200); // the retry hit the key-replay path
      const editReplay = await device.push(proxy, [edit], editKey);
      expect(editReplay.raw).toBe(editResult.raw);

      // Server truth: three rows, only #2 carries the edit.
      expect(await sessionCount(userId)).toBe(3);
      const titles = await dbPool.query(`SELECT id, title FROM journal_sessions WHERE user_id = $1 ORDER BY title`, [userId]);
      const byTitle = new Map((titles.rows as { id: string; title: string }[]).map((row) => [row.id, row.title]));
      expect(byTitle.get(e2)).toBe('day two — EDITED');
      expect([...byTitle.values()].filter((title) => title === 'day two — EDITED')).toHaveLength(1);

      const census = await walk(device, proxy, '50', 20);
      expect(census.drained).toBe(true);
      expect(census.counts.get(e2)).toBe(1);
      const e2Change = census.changes.find((change) => change.entityId === e2);
      expect((e2Change?.payload as { title?: string } | undefined)?.title).toBe('day two — EDITED');
      expect(proxy.findings).toEqual([]);
    } finally {
      await proxy.stop();
    }
  }, 120_000);
});

// ===========================================================================
// 3. Tombstone propagation + no-resurrection
// ===========================================================================

describe('replay/soak: session tombstone propagation + no-resurrection', () => {
  it('a synced session deletes cleanly; stale replays of the CREATE never resurrect it', async () => {
    const proxy = new FaultProxy({ targetPort: Number(new URL(appBaseUrl).port), targetHost: '127.0.0.1' });
    await proxy.start();
    try {
      const { userId, token } = await provisionUser('tombstone');
      const deviceA = new SoakDevice(appBaseUrl, token, 'dev-a', 'tombstone');
      const deviceB = new SoakDevice(appBaseUrl, token, 'dev-b', 'tombstone');
      const create = sessionCreate('tb1', instantAt(0), 'doomed session');
      const createKey = advUuid('4a6c', 'tombstone-create-key');
      const applied = await deviceA.push(proxy, [create], createKey);
      expect((applied.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied']);

      // Device B bootstraps: sees the session.
      const bBefore = await walk(deviceB, proxy, '50', 20);
      expect(bBefore.counts.get(create.entityId)).toBe(1);

      // The delete syncs; both devices see the tombstone exactly once.
      const del = { ...create, opId: advUuid('4a6c', 'tb1d'), action: 'delete' as const, clientUpdatedAt: instantAt(600_000) };
      delete (del as { payload?: unknown }).payload;
      const deleted = await deviceA.push(proxy, [del], advUuid('4a6c', 'tombstone-delete-key'));
      expect((deleted.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied']);
      const aAfter = await walk(deviceA, proxy, '50', 20);
      const aTombstone = aAfter.changes.filter((change) => change.entityId === create.entityId);
      expect(aTombstone).toHaveLength(1);
      expect(aTombstone[0]?.change).toBe('delete');
      expect(aTombstone[0]).not.toHaveProperty('payload');
      const bAfter = await walk(deviceB, proxy, '50', 20);
      expect(bAfter.changes.filter((change) => change.entityId === create.entityId)).toHaveLength(1);
      expect(bAfter.changes.find((change) => change.entityId === create.entityId)?.change).toBe('delete');

      // Stale replay: the ORIGINAL create op (fresh key) — duplicate ack, no resurrection.
      const staleCreate = await deviceA.push(proxy, [create], advUuid('4a6c', 'tombstone-stale1'));
      expect((staleCreate.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['duplicate']);
      expect(await dbPool.query(`SELECT count(*)::int AS n FROM journal_sessions WHERE id = $1 AND deleted_at IS NOT NULL`, [create.entityId])).toMatchObject({ rows: [{ n: 1 }] });
      // The post-tombstone feed never re-emits an upsert.
      const bResurrect = await walk(deviceB, proxy, '50', 20);
      for (const change of bResurrect.changes.filter((entry) => entry.entityId === create.entityId)) {
        expect(change.change).toBe('delete');
      }
      // Replaying the SAME delete op id (fresh key) is a per-op dedupe — the
      // recorded applied outcome replays as `duplicate` — and nothing changes.
      const delAgain = await deviceA.push(proxy, [del], advUuid('4a6c', 'tombstone-stale2'));
      expect((delAgain.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['duplicate']);
      expect(await sessionCount(userId, 'AND deleted_at IS NULL')).toBe(0);
      expect(await sessionCount(userId)).toBe(1); // the tombstone row remains
      expect(proxy.findings).toEqual([]);
    } finally {
      await proxy.stop();
    }
  }, 120_000);
});

// ===========================================================================
// 4. Training-day mark stability across replays
// ===========================================================================

describe('replay/soak: training-day mark stability across replays', () => {
  it('the mark tracks ∃ active session for the day under full replay storms, both directions', async () => {
    const proxy: FaultProxy | null = null; // direct wire — replay is the fault here
    const { userId, token } = await provisionUser('marks');
    const device = new SoakDevice(appBaseUrl, token, 'dev-a', 'marks');
    const c1 = sessionCreate('mk1', instantAt(0), 'marks one');
    const c2 = sessionCreate('mk2', instantAt(60_000), 'marks two');

    // Two creates, each replayed with fresh keys (duplicate storms).
    for (let round = 0; round < 3; round += 1) {
      const result = await device.push(proxy, round === 0 ? [c1, c2] : [c1, c2], advUuid('4a6c', `marks-key-${round}`));
      const outcomes = (result.body as { results: { outcome: string }[] }).results.map((entry) => entry.outcome);
      expect(outcomes).toEqual(round === 0 ? ['applied', 'applied'] : ['duplicate', 'duplicate']);
    }
    expect(await markCount(userId, DAY)).toBe(1);
    expect(await sessionCount(userId, 'AND deleted_at IS NULL')).toBe(2);

    // Delete one: the mark STAYS (∃ one active session).
    const d1: JournalOpLike = { ...c1, opId: advUuid('4a6c', 'mk1d'), action: 'delete', clientUpdatedAt: instantAt(600_000) };
    delete (d1 as { payload?: unknown }).payload;
    await device.push(proxy, [d1], advUuid('4a6c', 'marks-del1'));
    await device.push(proxy, [d1], advUuid('4a6c', 'marks-del1-replay')); // idempotent delete replay
    expect(await markCount(userId, DAY)).toBe(1);
    expect(await sessionCount(userId, 'AND deleted_at IS NULL')).toBe(1);

    // Delete the last: the mark is REMOVED.
    const d2: JournalOpLike = { ...c2, opId: advUuid('4a6c', 'mk2d'), action: 'delete', clientUpdatedAt: instantAt(660_000) };
    delete (d2 as { payload?: unknown }).payload;
    await device.push(proxy, [d2], advUuid('4a6c', 'marks-del2'));
    expect(await markCount(userId, DAY)).toBe(0);

    // Full history replay: nothing resurrects; the mark stays gone.
    for (const ops of [[c1], [c2], [d1], [d2]]) {
      await device.push(proxy, ops, advUuid('4a6c', `marks-replay-${ops[0]?.opId.slice(0, 8)}`));
    }
    expect(await markCount(userId, DAY)).toBe(0);
    expect(await sessionCount(userId, 'AND deleted_at IS NULL')).toBe(0);

    // Re-create: the mark returns (derived, never stale).
    const c3 = sessionCreate('mk3', instantAt(1_200_000), 'marks three');
    await device.push(proxy, [c3], advUuid('4a6c', 'marks-key-new'));
    expect(await markCount(userId, DAY)).toBe(1);
  }, 120_000);
});

// ===========================================================================
// 5. Sub-ms LWW orientation — both ways (+ the opId tiebreak)
// ===========================================================================

describe('replay/soak: sub-ms LWW orientation both ways for session entities', () => {
  it('a 1-ms-later update wins regardless of arrival order; equal instants break by higher opId, both ways', async () => {
    const proxy: FaultProxy | null = null;
    const titles = async (userId: string, entityId: string): Promise<string | null> => {
      const result = await dbPool.query(`SELECT title FROM journal_sessions WHERE id = $1 AND user_id = $2`, [entityId, userId]);
      return (result.rows[0] as { title: string } | undefined)?.title ?? null;
    };

    // Order A: the LATER update arrives SECOND (classic LWW).
    const userA = await provisionUser('lwwa');
    const deviceA = new SoakDevice(appBaseUrl, userA.token, 'dev-a', 'lwwa');
    const baseA = sessionCreate('lwA', instantAt(0), 'start');
    await deviceA.push(proxy, [baseA], advUuid('4a6c', 'lwwa-create'));
    const hiA = sessionUpdate('lwAh', baseA.entityId, instantAt(2), 'later-wins');
    const loA = sessionUpdate('lwAl', baseA.entityId, instantAt(1), 'earlier-loses');
    await deviceA.push(proxy, [hiA], advUuid('4a6c', 'lwwa-hi'));
    await deviceA.push(proxy, [loA], advUuid('4a6c', 'lwwa-lo'));
    expect(await titles(userA.userId, baseA.entityId)).toBe('later-wins');

    // Order B: the LATER update arrives FIRST — same winner.
    const userB = await provisionUser('lwwb');
    const deviceB = new SoakDevice(appBaseUrl, userB.token, 'dev-a', 'lwwb');
    const baseB = sessionCreate('lwB', instantAt(0), 'start');
    await deviceB.push(proxy, [baseB], advUuid('4a6c', 'lwwb-create'));
    const hiB = sessionUpdate('lwBh', baseB.entityId, instantAt(2), 'later-wins');
    const loB = sessionUpdate('lwBl', baseB.entityId, instantAt(1), 'earlier-loses');
    await deviceB.push(proxy, [loB], advUuid('4a6c', 'lwwb-lo'));
    await deviceB.push(proxy, [hiB], advUuid('4a6c', 'lwwb-hi'));
    expect(await titles(userB.userId, baseB.entityId)).toBe('later-wins');

    // Tie: equal clientUpdatedAt ⇒ the HIGHER opId wins, both arrival orders.
    const tieLo = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
    const tieHi = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    const tieAt = instantAt(5_000);
    const userC = await provisionUser('lwwc');
    const deviceC = new SoakDevice(appBaseUrl, userC.token, 'dev-a', 'lwwc');
    const baseC = sessionCreate('lwC', instantAt(0), 'start');
    await deviceC.push(proxy, [baseC], advUuid('4a6c', 'lwwc-create'));
    const updLo: JournalOpLike = { ...sessionUpdate('lwClo', baseC.entityId, tieAt, 'lo-opid-loses'), opId: tieLo };
    const updHi: JournalOpLike = { ...sessionUpdate('lwChi', baseC.entityId, tieAt, 'hi-opid-wins'), opId: tieHi };
    await deviceC.push(proxy, [updLo], advUuid('4a6c', 'lwwc-lo'));
    await deviceC.push(proxy, [updHi], advUuid('4a6c', 'lwwc-hi'));
    expect(await titles(userC.userId, baseC.entityId)).toBe('hi-opid-wins');

    const userD = await provisionUser('lwwd');
    const deviceD = new SoakDevice(appBaseUrl, userD.token, 'dev-a', 'lwwd');
    const baseD = sessionCreate('lwD', instantAt(0), 'start');
    await deviceD.push(proxy, [baseD], advUuid('4a6c', 'lwwd-create'));
    const updLo2: JournalOpLike = { ...sessionUpdate('lwDlo', baseD.entityId, tieAt, 'lo-opid-loses'), opId: tieLo };
    const updHi2: JournalOpLike = { ...sessionUpdate('lwDhi', baseD.entityId, tieAt, 'hi-opid-wins'), opId: tieHi };
    await deviceD.push(proxy, [updHi2], advUuid('4a6c', 'lwwd-hi'));
    await deviceD.push(proxy, [updLo2], advUuid('4a6c', 'lwwd-lo'));
    expect(await titles(userD.userId, baseD.entityId)).toBe('hi-opid-wins');
  }, 120_000);
});

// ===========================================================================
// 6. F-s2c-1 ADJUDICATION — the W3 diary delta provider (findings-only)
// ===========================================================================

describe('F-s2c-1 adjudication: W3 diary paging under engineered same-second rows (findings evidence — no product edits)', () => {
  // Engineered stratum (all inside one whole second, µs-legal envelope
  // instants; ids are ordered literals so the keyset order is deterministic):
  //   (ms-trunc .000, id …0001)  served exact
  //   (ms-trunc .000, id …0003)  served exact
  //   (ms-trunc .300, id …0002)  SERVED SECOND-TRUNCATED (the msIso defect)
  // Serving …0002 regresses the cursor to (.000, …0002) — strictly before
  // (.000, …0003) — so the walk cycles …0003/…0002 and never drains.
  const ID_1 = '6a4c0000-0000-4000-8000-000000000001';
  const ID_2 = '6a4c0000-0000-4000-8000-000000000002';
  const ID_3 = '6a4c0000-0000-4000-8000-000000000003';
  const T_EXACT = '2026-10-08T07:00:00.000000Z';
  const T_SUB = '2026-10-08T07:00:00.300000Z';

  it('census: NO loss, tombstone-safe, convergent — but duplicate re-delivery AND a non-draining walk', async () => {
    const proxy: FaultProxy | null = null;
    const { userId, token } = await provisionUser('fs2c1');
    const device = new SoakDevice(appBaseUrl, token, 'dev-a', 'fs2c1');
    const rows: JournalOpLike[] = [
      diaryCreate('f1', ID_1, T_EXACT),
      diaryCreate('f2', ID_2, T_SUB),
      diaryCreate('f3', ID_3, T_EXACT),
    ];
    const pushed = await device.push(proxy, rows, advUuid('4a6c', 'fs2c1-key'));
    expect((pushed.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied']);

    const census = await walk(device, proxy, '1', 50);
    // (a) NO LOSS — every row's final state was delivered at least once.
    for (const row of rows) {
      expect(census.counts.get(row.entityId) ?? 0, `loss check ${row.entityId}`).toBeGreaterThanOrEqual(1);
    }
    // (b) DUPLICATE re-delivery + NON-TERMINATING walk (the defect, pinned):
    //     limit-1 pages never drain; a nextCursor token recurs while the
    //     walk is un-drained. (If a supervisor fix lands, this cell is
    //     updated in the same package — it pins observed merged-tree behavior.)
    expect(census.drained, 'the limit-1 walk must DRAIN on a fixed provider').toBe(false);
    expect(census.pages).toBe(50);
    // The cycle is DETERMINISTIC — exact pinned census (the defect measured,
    // not approximated): pages 1–2 serve …0001 and …0003 once each; from
    // page 3 the walk cycles …0002 (served at its true .300 position, cursor
    // regressing to .000) and …0003 (re-served) — 24 pages each over pages
    // 3–50. 50 deliveries for 3 rows.
    expect(census.counts.get(ID_1)).toBe(1);
    expect(census.counts.get(ID_2)).toBe(24);
    expect(census.counts.get(ID_3)).toBe(25);
    const totalDeliveries = [...census.counts.values()].reduce((sum, count) => sum + count, 0);
    expect(totalDeliveries, 'duplicate re-delivery demonstrated (3 rows walked 50 times)').toBe(50);
    const maxCursorRecurrence = Math.max(...census.cursorRepeats.values());
    expect(maxCursorRecurrence, 'cursor regression: a nextCursor token recurs mid-walk').toBeGreaterThanOrEqual(20);
    // (c) CONVERGENCE-SAFE — arrival-order application over ALL delivered
    //     changes equals the true final state (three live rows, exact payloads).
    const view = applyToMergedView(census.changes);
    expect(view.get(ID_1)).toBe('live');
    expect(view.get(ID_2)).toBe('live');
    expect(view.get(ID_3)).toBe('live');
    const deliveredById = new Map(census.changes.map((change) => [change.entityId, change]));
    for (const row of rows) {
      expect(deliveredById.get(row.entityId)?.payload).toEqual(row.payload);
    }
    // (d) No resurrection class: the defect re-delivers, it never flips a
    //     delete into an upsert (verified with a tombstoned row below).
    const delRow: JournalOpLike = { ...diaryCreate('f4', ID_2, T_SUB), opId: advUuid('4a6c', 'f4d'), action: 'delete', clientUpdatedAt: '2026-10-08T07:05:00.000000Z' };
    delete (delRow as { payload?: unknown }).payload;
    const delPush = await device.push(proxy, [delRow], advUuid('4a6c', 'fs2c1-del'));
    expect((delPush.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied']);
    const afterDelete = await walk(device, proxy, '1', 50);
    const viewsAfter = applyToMergedView(afterDelete.changes);
    expect(viewsAfter.get(ID_2)).toBe('gone');
    for (const change of afterDelete.changes.filter((entry) => entry.entityId === ID_2)) {
      expect(change.change).toBe('delete'); // never an upsert after the tombstone
    }

    // Findings-register line (pinned in the assertions above): diary
    // limit-1 walk over 3 same-second rows = 50 deliveries, never drains;
    // no loss; convergent; no resurrection.
    void userId;
  }, 180_000);
});

// ===========================================================================
// 7. The same defect class on this wave's own surface — journal_session
// ===========================================================================

describe('F-s4 census: journal_session paging under engineered same-second rows (findings evidence — no product edits)', () => {
  const ID_1 = '6a4c0000-0000-4000-8000-000000000011';
  const ID_2 = '6a4c0000-0000-4000-8000-000000000012';
  const ID_3 = '6a4c0000-0000-4000-8000-000000000013';
  const T_EXACT = '2026-10-08T07:00:00.000000Z';
  const T_SUB = '2026-10-08T07:00:00.300000Z';

  it('census: the session provider serves second-truncated instants over a millisecond keyset — same re-delivery, same regression', async () => {
    const proxy: FaultProxy | null = null;
    const { userId, token } = await provisionUser('jscensus');
    const device = new SoakDevice(appBaseUrl, token, 'dev-a', 'jscensus');
    const rows: JournalOpLike[] = [
      sessionCreate('j1', T_EXACT, 'exact one'),
      sessionCreate('j2', T_SUB, 'sub-second'),
      sessionCreate('j3', T_EXACT, 'exact three'),
    ];
    // The builder derives entity ids from tags — rebind the engineered ids.
    const engineered: JournalOpLike[] = rows.map((row, index) => ({ ...row, entityId: [ID_1, ID_2, ID_3][index] as string }));
    const pushed = await device.push(proxy, engineered, advUuid('4a6c', 'jscensus-key'));
    expect((pushed.body as { results: { outcome: string }[] }).results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'applied']);

    const census = await walk(device, proxy, '1', 50);
    for (const row of engineered) {
      expect(census.counts.get(row.entityId) ?? 0, `loss check ${row.entityId}`).toBeGreaterThanOrEqual(1);
    }
    expect(census.drained, 'the limit-1 walk must DRAIN on a fixed provider').toBe(false);
    // Identical deterministic census on this wave's own provider: …011 ×1,
    // …012 ×24 (regressed), …013 ×25 — 50 deliveries for 3 rows.
    expect(census.counts.get(ID_1)).toBe(1);
    expect(census.counts.get(ID_2)).toBe(24);
    expect(census.counts.get(ID_3)).toBe(25);
    const totalDeliveries = [...census.counts.values()].reduce((sum, count) => sum + count, 0);
    expect(totalDeliveries, 'duplicate re-delivery demonstrated on journal_session').toBe(50);
    const view = applyToMergedView(census.changes);
    for (const row of engineered) {
      expect(view.get(row.entityId)).toBe('live');
    }
    void userId;
  }, 180_000);
});
