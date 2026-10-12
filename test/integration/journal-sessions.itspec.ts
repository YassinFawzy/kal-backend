/**
 * Kal journal sessions — integration / isolation suite (wave-04, task
 * s2a-sessions).
 *
 * DB-backed: ephemeral `kal_it_*` database, full migration history via the
 * real Prisma runner, the REAL journal stack (repository, catalog
 * name-resolution port, session-create limiter, training-day marks, the
 * `journal_session` op handler and delta provider, the §2 read service) and
 * — for the ingestion-path cases — the REAL `SyncIngestionService` with the
 * journal handler registered through the production registry path. The
 * exercise catalog is the production seed (the single authority manifest,
 * applied idempotently).
 *
 * Required cases (task contract — assertions by name):
 *   - happy path: a mixed-format session (weighted + timed + free-text WOD
 *     notes) applies through the real ingestion path; name snapshots freeze
 *     from the catalog at apply; the delta feed upserts the §2 PROJECTION
 *     (Ruling 4 — frozen name snapshots ride the feed); the read endpoints
 *     project the same aggregate.
 *   - validation/boundary: an invalid op in a batch ⇒ per-op
 *     `rejected_validation`, the batch continues, other ops apply; unknown
 *     exercise reference ⇒ rejected_validation; day-boundary carry — a
 *     session finished 23:59 and synced 00:01 keeps its carried local date.
 *   - sync/idempotency: replay ⇒ `duplicate`, zero side effects (including
 *     no limiter re-tick); tombstone ⇒ delta surfaces a payload-free
 *     delete; same-entity-ID create after delete blocked; LWW ordering
 *     incl. the equal-timestamp tiebreak.
 *   - rate guard: two-config trip points (limits move ⇒ behavior moves);
 *     over-limit ⇒ per-op `rejected_rate_limited` retryable with NO ledger
 *     row (the w3 acked-not-recorded ruling); the same opId retried after
 *     the window rolls off applies cleanly; the DAY window trips
 *     independently of the HOUR window.
 *   - isolation seeds (the deep A/B/C battery is s4's — these are the
 *     same-ID negatives it builds on): B's ops against A's entity ids are
 *     denials byte-identical whether or not A's row exists; B's reads see
 *     none of A's rows; C's own-data parity.
 *   - history honesty: a post-apply catalog-name edit does NOT change the
 *     applied session's frozen snapshot (reads keep serving the freeze).
 *   - training-day marks: derived idempotently inside the apply UoW;
 *     tombstoning the last session of a day un-marks it; a day move
 *     recomputes both days; marks are invisible to the delta feed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { ConfigService } from '../../src/config/config.service.js';
import { JournalConfigService } from '../../src/config/journal.config.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { applyExerciseCatalogSeed } from '../../prisma/seed-apply.js';
import { ExerciseCatalogNameResolver } from '../../src/journal/sessions/exercise-catalog.port.js';
import { SessionOpHandler } from '../../src/journal/sessions/session-apply.service.js';
import { SessionDeltaProvider } from '../../src/journal/sessions/session-delta.service.js';
import { SessionCreateRateLimiter } from '../../src/journal/sessions/session-rate-limiter.js';
import { SessionReadService } from '../../src/journal/sessions/session-read.service.js';
import { SessionRepository } from '../../src/journal/sessions/session-repository.js';
import { JournalTrainingDayReader, TrainingDayMarksService } from '../../src/journal/sessions/training-day-marks.service.js';
import { IdempotencyKeyStore } from '../../src/sync/ingestion/idempotency-key.store.js';
import { OpHandlerRegistry } from '../../src/sync/ingestion/op-handler-registry.js';
import { OpLedgerStore } from '../../src/sync/ingestion/op-ledger.store.js';
import { SyncConfigService } from '../../src/sync/ingestion/sync.config.js';
import { SyncIngestionService } from '../../src/sync/ingestion/ingestion.service.js';
import type { SyncOpEnvelope } from '../../src/tracking/sync-seams.js';
import { asUserlessApp, USER_A, USER_B, USER_C } from './helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { inUserScopeTx } from '../../src/journal/journal-tx.js';

/** Catalog ids from the frozen seed manifest (reserved fixture range …f2nn). */
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201'; // Barbell back squat / سكوات بالبار
const EX_PLANK = '00000000-0000-4000-8000-00000000f21f'; // Plank / بلانك
const EX_BURPEE = '00000000-0000-4000-8000-00000000f223'; // Burpee / بربي
const SQUAT_NAME_EN = 'Barbell back squat';
const SQUAT_NAME_AR = 'سكوات بالبار';

/** Synthetic limiter-proof users (fresh counters — the windows are rolling). */
const USER_D = '55555555-5555-4555-8555-555555555555';
const USER_E = '66666666-6666-4666-8666-666666666666';

const CTX_A = { userId: USER_A, deviceId: 'device-A' };

const T_2359 = '2026-10-12T20:59:00.000Z'; // 23:59 Cairo wall time (UTC+3) — the session's finish instant
const T0 = '2026-10-12T10:00:00.000Z';
const T1 = '2026-10-12T11:00:00.000Z';

let db: EphemeralKalDb;
let prisma: PrismaService;
let config: JournalConfigService;
let repository: SessionRepository;
let marks: TrainingDayMarksService;
let handler: SessionOpHandler;
let delta: SessionDeltaProvider;
let reads: SessionReadService;
let reader: JournalTrainingDayReader;
let ingestion: SyncIngestionService;

function configFor(overrides: Record<string, string>): JournalConfigService {
  const keys = Object.keys(overrides);
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return new JournalConfigService('test');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function hexTail(n: number): string {
  return n.toString(16).padStart(12, '0');
}
function opId(n: number): string {
  return `7d0f0000-0000-4000-8000-${hexTail(n)}`;
}
function entityId(n: number): string {
  return `7e100000-0000-4000-8000-${hexTail(n)}`;
}
function batchKey(n: number): string {
  return `7cef0000-0000-4000-8000-${hexTail(n)}`;
}

function weightedSet(weightKg = 60, reps = 8): Record<string, unknown> {
  return { format: 'weighted', weightKg, reps };
}

/** A mixed-format session snapshot: weighted + timed hold + WOD free text. */
function mixedSnapshot(localDate: string, title?: string): Record<string, unknown> {
  return {
    localDate,
    ...(title === undefined ? {} : { title }),
    exercises: [
      { exerciseId: EX_SQUAT, position: 0, sets: [weightedSet(80, 5), weightedSet(85, 5), weightedSet(90, 3)] },
      { exerciseId: EX_PLANK, position: 1, sets: [{ format: 'timed', durationSeconds: 60 }, { format: 'timed', durationSeconds: 45 }] },
      { exerciseId: EX_BURPEE, position: 2, sets: [{ format: 'notes', text: 'WOD 21-15-9 — cash-out unbroken' }] },
    ],
  };
}

function sessionOp(n: number, overrides: Partial<SyncOpEnvelope> & { payload?: unknown } = {}): SyncOpEnvelope {
  return {
    opId: opId(n),
    kind: 'journal_session',
    entityId: entityId(n),
    action: 'create',
    clientUpdatedAt: T0,
    localDate: '2026-10-12',
    payload: mixedSnapshot('2026-10-12'),
    ...overrides,
  } as SyncOpEnvelope;
}

async function seedUser(userId: string, email: string, username: string): Promise<void> {
  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [userId, email, username]);
  }, { commit: true });
}

async function applyHandlerStack(cfg: JournalConfigService, userId: string, op: SyncOpEnvelope) {
  const stackHandler = new SessionOpHandler(
    repository,
    new SessionCreateRateLimiter(cfg),
    marks,
    new ExerciseCatalogNameResolver(),
  );
  return inUserScopeTx(prisma, { userId }, (tx) => stackHandler.apply(op, { userId, deviceId: 'device-x' }, tx));
}

/** Pushes ops through the REAL ingestion service (registry path, per-op ledger, ack envelope). */
async function ingest(userId: string, keyId: number, ops: SyncOpEnvelope[]): Promise<{ status: number; body: unknown; raw: string }> {
  const result = await ingestion.ingest(
    { kind: 'consumer', userId },
    { deviceId: `device-${userId.slice(0, 8)}`, ops },
    batchKey(keyId),
  );
  return { status: result.status, body: JSON.parse(result.body) as unknown, raw: result.body };
}

interface AckBody {
  results?: { opId: string; outcome: string; code?: string; retryable?: boolean }[];
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('jrn-sessions-it');
    db.applyMigrations();

    // Production-faithful seed (operator path over an admin connection — the
    // catalog is RLS-declined platform plane). The session handler freezes
    // names from THESE rows.
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      await applyExerciseCatalogSeed(seedClient);
    } finally {
      await seedClient.$disconnect();
    }

    await seedUser(USER_A, 'a@journal-sessions-it.invalid', 'jrn_sessions_it_a');
    await seedUser(USER_B, 'b@journal-sessions-it.invalid', 'jrn_sessions_it_b');
    await seedUser(USER_C, 'c@journal-sessions-it.invalid', 'jrn_sessions_it_c');
    await seedUser(USER_D, 'd@journal-sessions-it.invalid', 'jrn_sessions_it_d');
    await seedUser(USER_E, 'e@journal-sessions-it.invalid', 'jrn_sessions_it_e');

    prisma = new PrismaService({ databaseUrl: url.toString() } as ConfigService);
    config = configFor({});
    repository = new SessionRepository();
    marks = new TrainingDayMarksService(prisma, repository);
    handler = new SessionOpHandler(repository, new SessionCreateRateLimiter(config), marks, new ExerciseCatalogNameResolver());
    delta = new SessionDeltaProvider(repository);
    reads = new SessionReadService(prisma, repository);
    reader = new JournalTrainingDayReader(prisma);

    const syncConfig = new SyncConfigService(process.env);
    const registry = new OpHandlerRegistry();
    registry.registerOpHandler(handler);
    ingestion = new SyncIngestionService(
      prisma,
      syncConfig,
      registry,
      new OpLedgerStore(),
      new IdempotencyKeyStore(),
      new AuditService(prisma),
    );
  })();
}, 240_000);

afterAll(async () => {
  await prisma?.onModuleDestroy();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('happy path — mixed formats through the REAL ingestion path (§1)', () => {
  it('applies a weighted+timed+notes session; snapshots freeze from the catalog; ack is payload-free', async () => {
    const ack = await ingest(USER_A, 1, [sessionOp(1, { payload: mixedSnapshot('2026-10-12', 'Push day') })]);
    expect(ack.status).toBe(200);
    const body = ack.body as AckBody;
    expect(body.results).toEqual([{ opId: opId(1), outcome: 'applied' }]);
    expect(ack.raw).not.toContain('Barbell'); // the ack envelope never echoes payloads (I12)

    const stored = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionAggregate(tx, USER_A, entityId(1)));
    expect(stored).not.toBeNull();
    const squat = stored?.exercises.find((e) => e.exercise.exerciseId === EX_SQUAT);
    expect(squat?.exercise.nameSnapshotEn).toBe(SQUAT_NAME_EN);
    expect(squat?.exercise.nameSnapshotAr).toBe(SQUAT_NAME_AR);
    const formats = squat?.sets.map((s) => s.format);
    expect(formats).toEqual(['weighted', 'weighted', 'weighted']);
    const plank = stored?.exercises.find((e) => e.exercise.exerciseId === EX_PLANK);
    expect(plank?.sets.map((s) => s.durationSeconds)).toEqual([60, 45]);
    const wod = stored?.exercises.find((e) => e.exercise.exerciseId === EX_BURPEE);
    expect(wod?.sets[0]?.notesText).toBe('WOD 21-15-9 — cash-out unbroken');
  });

  it('the delta feed upsert carries the §2 PROJECTION (Ruling 4): frozen name snapshots ride the feed; the day read projects the same aggregate', async () => {
    const page = await inUserScopeTx(prisma, CTX_A, (tx) => delta.changesSince(null, 10, CTX_A, tx));
    const upsert = page.changes.find((c) => c.entityId === entityId(1));
    expect(upsert?.change).toBe('upsert');
    expect(upsert?.kind).toBe('journal_session');
    const payload = upsert?.payload as {
      id: string; localDate: string; title?: string; updatedAt: string;
      exercises: { id: string; exerciseId: string; position: number; nameSnapshotEn: string; nameSnapshotAr: string | null; sets: { id: string; position: number; format: string }[] }[];
    };
    expect(payload.id).toBe(entityId(1));
    expect(payload.localDate).toBe('2026-10-12');
    expect(payload.title).toBe('Push day');
    expect(typeof payload.updatedAt).toBe('string');
    expect(payload.exercises.map((e) => e.exerciseId)).toEqual([EX_SQUAT, EX_PLANK, EX_BURPEE]);
    // The frozen snapshots RIDE THE FEED (Ruling 4): a pulled session
    // displays from them offline — never from the live catalog.
    expect(payload.exercises[0]?.nameSnapshotEn).toBe(SQUAT_NAME_EN);
    expect(payload.exercises[0]?.nameSnapshotAr).toBe(SQUAT_NAME_AR);
    expect(payload.exercises[0]?.sets).toHaveLength(3);
    expect(payload.exercises[0]?.sets[0]?.format).toBe('weighted');
    // Training-day marks NEVER appear in the feed (§1.2).
    expect(page.changes.every((c) => c.kind === 'journal_session')).toBe(true);

    const day = await reads.readDay(USER_A, '2026-10-12');
    expect(day.localDate).toBe('2026-10-12');
    expect(day.sessions).toHaveLength(1);
    const view = day.sessions[0];
    expect(view?.title).toBe('Push day');
    expect(view?.localDate).toBe('2026-10-12');
    expect(typeof view?.updatedAt).toBe('string');
    const squatView = view?.exercises.find((e) => e.exerciseId === EX_SQUAT);
    expect(squatView?.nameSnapshotEn).toBe(SQUAT_NAME_EN);
    expect(squatView?.nameSnapshotAr).toBe(SQUAT_NAME_AR);
    expect(squatView?.sets[0]).toMatchObject({ format: 'weighted', weightKg: 80, reps: 5 });

    const detail = await reads.readSession(USER_A, entityId(1));
    expect(detail.id).toBe(entityId(1));
    expect(detail.exercises).toHaveLength(3);
  });

  it('an EMPTY day is an EMPTY 200; a tombstoned session leaves the day read', async () => {
    const empty = await reads.readDay(USER_A, '2026-01-01');
    expect(empty).toEqual({ localDate: '2026-01-01', sessions: [] });
  });
});

describe('validation/boundary (§1.1) — per-op rejection, batch continues', () => {
  it('a zero-reps op is rejected_validation while a valid sibling op in the SAME batch applies', async () => {
    const invalid = sessionOp(2, {
      entityId: entityId(2),
      payload: {
        localDate: '2026-10-12',
        exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 0 }] }],
      },
    });
    const valid = sessionOp(3, { entityId: entityId(3), payload: mixedSnapshot('2026-10-12') });
    const ack = await ingest(USER_A, 2, [invalid, valid]);
    const results = (ack.body as AckBody).results;
    expect(results?.[0]).toEqual({ opId: opId(2), outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(results?.[1]).toEqual({ opId: opId(3), outcome: 'applied' });
    const appliedRow = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionIncludingDeleted(tx, USER_A, entityId(3)));
    expect(appliedRow).not.toBeNull();
  });

  it('an unknown exercise reference is rejected_validation (malformed and foreign-shape ids indistinguishable)', async () => {
    const outcome = await applyHandlerStack(config, USER_A, sessionOp(4, {
      entityId: entityId(4),
      payload: {
        localDate: '2026-10-12',
        exercises: [{ exerciseId: '00000000-0000-4000-8000-00000000f2ff', position: 0, sets: [weightedSet()] }],
      },
    }));
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    const row = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionIncludingDeleted(tx, USER_A, entityId(4)));
    expect(row).toBeNull();
  });

  it('day-boundary carry: finished 23:59, synced later — the CARRIED date is the stored date (never re-derived from any clock)', async () => {
    const outcome = await applyHandlerStack(config, USER_A, sessionOp(5, {
      entityId: entityId(5),
      clientUpdatedAt: T_2359, // the client-authored finish instant — 23:59 Cairo of the carried day
      localDate: '2026-10-12', // the client-carried session day; the sync itself lands whenever this test runs
      payload: mixedSnapshot('2026-10-12'),
    }));
    expect(outcome).toEqual({ outcome: 'applied' });
    const row = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionIncludingDeleted(tx, USER_A, entityId(5)));
    expect(row?.localDate.toISOString().slice(0, 10)).toBe('2026-10-12'); // NEVER re-derived from receive time
  });
});

describe('sync/idempotency (§1.2/§1.3/§1.4/§1.5)', () => {
  it('replay of the same op ⇒ duplicate with ZERO side effects (no rows, no limiter re-tick)', async () => {
    await ingest(USER_A, 3, [sessionOp(6, { entityId: entityId(6) })]);
    const before = await inUserScopeTx(prisma, CTX_A, async (tx) => ({
      sessions: await tx.journalSession.count({ where: { userId: USER_A } }),
      counter: await tx.$queryRaw<{ hour_count: number }[]>`SELECT hour_count FROM journal_session_create_counters WHERE user_id = ${USER_A}::uuid`,
    }));
    const ack = await ingest(USER_A, 4, [sessionOp(6, { entityId: entityId(6) })]); // NEW Idempotency-Key, SAME opId
    expect((ack.body as AckBody).results).toEqual([{ opId: opId(6), outcome: 'duplicate' }]);
    const after = await inUserScopeTx(prisma, CTX_A, async (tx) => ({
      sessions: await tx.journalSession.count({ where: { userId: USER_A } }),
      counter: await tx.$queryRaw<{ hour_count: number }[]>`SELECT hour_count FROM journal_session_create_counters WHERE user_id = ${USER_A}::uuid`,
    }));
    expect(after.sessions).toBe(before.sessions);
    expect(after.counter[0]?.hour_count).toBe(before.counter[0]?.hour_count);
  });

  it('delete ⇒ applied; delta surfaces a payload-free tombstone; same-entity-ID create is blocked (no resurrection); update-after-delete is rejected_deleted', async () => {
    await ingest(USER_A, 5, [sessionOp(7, { entityId: entityId(7) })]);
    // A delete is a NEW op with its OWN opId (dedupe keys on (user, opId)).
    const del = await ingest(USER_A, 6, [sessionOp(17, { opId: opId(17), entityId: entityId(7), action: 'delete', payload: undefined })]);
    expect((del.body as AckBody).results).toEqual([{ opId: opId(17), outcome: 'applied' }]);

    const page = await inUserScopeTx(prisma, CTX_A, (tx) => delta.changesSince(null, 50, CTX_A, tx));
    const tombstone = page.changes.find((c) => c.entityId === entityId(7));
    expect(tombstone?.change).toBe('delete');
    expect(tombstone?.payload).toBeUndefined();

    const resurrect = await applyHandlerStack(config, USER_A, sessionOp(8, { opId: opId(8), entityId: entityId(7), action: 'create' }));
    expect(resurrect).toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const staleUpdate = await applyHandlerStack(config, USER_A, sessionOp(9, { opId: opId(9), entityId: entityId(7), action: 'update' }));
    expect(staleUpdate).toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const row = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionIncludingDeleted(tx, USER_A, entityId(7)));
    expect(row?.deletedAt).not.toBeNull();
  });

  it('LWW: a newer update applies and replaces children; an equal-timestamp LOSER (lower opId) is acked applied and changes nothing; the higher opId wins the tiebreak', async () => {
    await ingest(USER_A, 7, [sessionOp(10, { entityId: entityId(10), clientUpdatedAt: T0, payload: mixedSnapshot('2026-10-12', 'v1') })]);
    // Winning update (later clientUpdatedAt): title v2, children replaced.
    const win = await applyHandlerStack(config, USER_A, sessionOp(11, {
      opId: opId(11),
      entityId: entityId(10),
      action: 'update',
      clientUpdatedAt: T1,
      payload: mixedSnapshot('2026-10-12', 'v2'),
    }));
    expect(win).toEqual({ outcome: 'applied' });
    let agg = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionAggregate(tx, USER_A, entityId(10)));
    expect(agg?.session.title).toBe('v2');
    expect(agg?.session.updatedAt.toISOString()).toBe(T1);
    // Children replaced as a full snapshot: exactly one entry per exercise, no duplicates.
    expect(agg?.exercises).toHaveLength(3);

    // Equal timestamp, LOWER opId ⇒ deterministic loser: acked applied, NOTHING changes.
    const lose = await applyHandlerStack(config, USER_A, sessionOp(12, {
      opId: '7d0f0000-0000-4000-8000-000000000008', // < the winning op 11's id → lower
      entityId: entityId(10),
      action: 'update',
      clientUpdatedAt: T1,
      payload: mixedSnapshot('2026-10-12', 'loser'),
    }));
    expect(lose).toEqual({ outcome: 'applied' });
    agg = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionAggregate(tx, USER_A, entityId(10)));
    expect(agg?.session.title).toBe('v2');

    // Equal timestamp, HIGHER opId ⇒ wins the tiebreak.
    const tieWin = await applyHandlerStack(config, USER_A, sessionOp(13, {
      opId: '7d0f0000-0000-4000-8000-00000000000d', // > op 11's id
      entityId: entityId(10),
      action: 'update',
      clientUpdatedAt: T1,
      payload: mixedSnapshot('2026-10-12', 'tie-winner'),
    }));
    expect(tieWin).toEqual({ outcome: 'applied' });
    agg = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findSessionAggregate(tx, USER_A, entityId(10)));
    expect(agg?.session.title).toBe('tie-winner');
  });

  it('update-on-missing ⇒ rejected_conflict; create-on-active ⇒ rejected_conflict', async () => {
    const missing = await applyHandlerStack(config, USER_A, sessionOp(14, { entityId: entityId(14), action: 'update' }));
    expect(missing).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    const conflict = await applyHandlerStack(config, USER_A, sessionOp(15, { entityId: entityId(10), action: 'create' }));
    expect(conflict).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });
});

describe('rate guard (§1.2/§6 — the W3 ruling posture, config-point caps)', () => {
  it('two-config trip point: cap 2 ⇒ applied, applied, rejected_rate_limited; cap 3 ⇒ applied ×3 then rejected', async () => {
    const cap2 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '2', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000' });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await applyHandlerStack(cap2, USER_D, sessionOp(20 + i, { opId: opId(20 + i), entityId: entityId(20 + i) }));
      outcomes.push(outcome.outcome === 'applied' ? 'applied' : (outcome as { code: string }).code);
    }
    expect(outcomes).toEqual(['applied', 'applied', 'rejected_rate_limited']);
    // The rejected create ticked NOTHING: the counter sits at the cap, not above it.
    const counter = await adminQuery(db, `SELECT hour_count, day_count FROM journal_session_create_counters WHERE user_id = $1`, [USER_D]);
    expect(counter.rows[0]).toEqual({ hour_count: 2, day_count: 2 });

    const cap3 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '3', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000' });
    const outcomesCap3: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const outcome = await applyHandlerStack(cap3, USER_E, sessionOp(30 + i, { opId: opId(30 + i), entityId: entityId(30 + i) }));
      outcomesCap3.push(outcome.outcome === 'applied' ? 'applied' : (outcome as { code: string }).code);
    }
    expect(outcomesCap3).toEqual(['applied', 'applied', 'applied', 'rejected_rate_limited']);
  });

  it('over-limit through the REAL ingestion path: acked retryable, NO ledger row, no session row; the SAME opId retried after the window rolls off APPLIES', async () => {
    const cap2 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '2', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000' });
    const stackHandler = new SessionOpHandler(repository, new SessionCreateRateLimiter(cap2), marks, new ExerciseCatalogNameResolver());
    const registry = new OpHandlerRegistry();
    registry.registerOpHandler(stackHandler);
    const limitedIngestion = new SyncIngestionService(
      prisma,
      new SyncConfigService(process.env),
      registry,
      new OpLedgerStore(),
      new IdempotencyKeyStore(),
      new AuditService(prisma),
    );
    const ops = [0, 1, 2].map((i) => sessionOp(40 + i, { opId: opId(40 + i), entityId: entityId(40 + i) }));
    const ack = await limitedIngestion.ingest(
      { kind: 'consumer', userId: USER_D },
      { deviceId: 'device-D-limited', ops },
      batchKey(50),
    );
    const results = (JSON.parse(ack.body) as AckBody).results;
    expect(results?.[2]).toEqual({ opId: opId(42), outcome: 'rejected', code: 'rejected_rate_limited', retryable: true });
    // NO ledger row for the rate-limited op (the w3 acked-not-recorded ruling)…
    const ledgerRow = await adminQuery(db, `SELECT count(*)::int AS n FROM sync_operations WHERE user_id = $1 AND client_op_id = $2`, [USER_D, opId(42)]);
    expect(ledgerRow.rows[0]?.n).toBe(0);
    // …and NO session row (nothing was applied).
    const sessionRow = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = $1 AND id = $2`, [USER_D, entityId(42)]);
    expect(sessionRow.rows[0]?.n).toBe(0);

    // Harness clock lapse: both windows roll off; the SAME opId (fresh
    // Idempotency-Key) re-runs the handler and applies cleanly.
    await adminQuery(
      db,
      `UPDATE journal_session_create_counters
         SET hour_window_start = now() - interval '2 hours',
             day_window_start  = now() - interval '25 hours'
       WHERE user_id = $1`,
      [USER_D],
    );
    const retry = await limitedIngestion.ingest(
      { kind: 'consumer', userId: USER_D },
      { deviceId: 'device-D-limited', ops: [ops[2]] },
      batchKey(51),
    );
    expect((JSON.parse(retry.body) as AckBody).results).toEqual([{ opId: opId(42), outcome: 'applied' }]);
    const appliedRow = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = $1 AND id = $2`, [USER_D, entityId(42)]);
    expect(appliedRow.rows[0]?.n).toBe(1);
  });

  it('the DAY window trips independently of the HOUR window (cap 2 daily, hourly at its in-bounds max)', async () => {
    const dayCap2 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '100', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '2' });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await applyHandlerStack(dayCap2, USER_B, sessionOp(60 + i, { opId: opId(60 + i), entityId: entityId(60 + i) }));
      outcomes.push(outcome.outcome === 'applied' ? 'applied' : (outcome as { code: string }).code);
    }
    expect(outcomes).toEqual(['applied', 'applied', 'rejected_rate_limited']);
  });

  it('updates and deletes are NEVER rate-limited', async () => {
    await ingest(USER_A, 8, [sessionOp(70, { entityId: entityId(70) })]);
    const hourly1 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '1', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1' });
    // The hour+day caps are already consumed for USER_A — an UPDATE must still apply.
    const update = await applyHandlerStack(hourly1, USER_A, sessionOp(71, {
      opId: opId(71),
      entityId: entityId(70),
      action: 'update',
      clientUpdatedAt: T1,
      payload: mixedSnapshot('2026-10-12', 'edited'),
    }));
    expect(update).toEqual({ outcome: 'applied' });
    const del = await applyHandlerStack(hourly1, USER_A, sessionOp(72, { opId: opId(72), entityId: entityId(70), action: 'delete', payload: undefined }));
    expect(del).toEqual({ outcome: 'applied' });
  });
});

describe('isolation seeds (the same-ID negatives s4 builds on)', () => {
  it("B replaying A's op id never matches A's dedupe; B's update/delete against A's entity id are the same denials whether or not A's row exists; A's rows are untouched", async () => {
    // A owns entity(80) (applied above as op 10-series; use a fresh one here).
    await ingest(USER_A, 9, [sessionOp(80, { entityId: entityId(80) })]);
    const aRowBefore = await adminQuery(db, `SELECT updated_at, deleted_at FROM journal_sessions WHERE user_id = $1 AND id = $2`, [USER_A, entityId(80)]);

    // B pushes the SAME op id (different entity): never matches A's ledger row.
    const ack = await ingest(USER_B, 10, [sessionOp(80, { entityId: entityId(81) })]);
    expect((ack.body as AckBody).results).toEqual([{ opId: opId(80), outcome: 'applied' }]); // fresh application under B
    const bOwns = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = $1 AND id = $2`, [USER_B, entityId(81)]);
    expect(bOwns.rows[0]?.n).toBe(1);

    // B's update on A's entity id: A's row is invisible ⇒ rejected_conflict.
    const bUpdate = await applyHandlerStack(config, USER_B, sessionOp(82, { opId: opId(82), entityId: entityId(80), action: 'update' }));
    expect(bUpdate).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });

    // B's delete on A's entity id: idempotent `applied`, NOTHING of A's touched.
    const bDelete = await applyHandlerStack(config, USER_B, sessionOp(83, { opId: opId(83), entityId: entityId(80), action: 'delete', payload: undefined }));
    expect(bDelete).toEqual({ outcome: 'applied' });
    const aRowAfter = await adminQuery(db, `SELECT updated_at, deleted_at FROM journal_sessions WHERE user_id = $1 AND id = $2`, [USER_A, entityId(80)]);
    expect(aRowAfter.rows[0]).toEqual(aRowBefore.rows[0]);
    expect(aRowAfter.rows[0]?.deleted_at).toBeNull();

    // B's read of A's session: the generic NOT_FOUND denial. A's day read still lists it; B's day read does not.
    await expect(reads.readSession(USER_B, entityId(80))).rejects.toThrow(/NOT_FOUND/u);
    const aDay = await reads.readDay(USER_A, '2026-10-12');
    expect(aDay.sessions.some((s) => s.id === entityId(80))).toBe(true);
    const bDay = await reads.readDay(USER_B, '2026-10-12');
    expect(bDay.sessions.some((s) => s.id === entityId(80))).toBe(false);
    // No existence oracle in the denial set: B's read of a NONEXISTENT id is the SAME generic denial.
    await expect(reads.readSession(USER_B, entityId(999))).rejects.toThrow(/NOT_FOUND/u);

    // C control: C's own fresh session is fully visible to C (denials above are authorization-driven).
    await ingest(USER_C, 11, [sessionOp(84, { entityId: entityId(84) })]);
    const cDetail = await reads.readSession(USER_C, entityId(84));
    expect(cDetail?.id).toBe(entityId(84));
  });
});

describe('history honesty (the I11 freeze)', () => {
  it('a post-apply catalog-name edit does NOT change the applied session’s frozen snapshot', async () => {
    await ingest(USER_A, 12, [sessionOp(90, { entityId: entityId(90), payload: mixedSnapshot('2026-10-12') })]);
    // Operator-style catalog rename over the admin connection (the governed
    // edit path — the session domain never rewrites history from it).
    await adminQuery(db, `UPDATE exercises SET name_en = 'Barbell back squat (renamed)' WHERE id = $1`, [EX_SQUAT]);
    const after = await reads.readSession(USER_A, entityId(90));
    const squat = after.exercises.find((e) => e.exerciseId === EX_SQUAT);
    expect(squat?.nameSnapshotEn).toBe(SQUAT_NAME_EN); // frozen at apply time — the rename never propagates
    const day = await reads.readDay(USER_A, '2026-10-12');
    const daySquat = day.sessions.find((s) => s.id === entityId(90))?.exercises.find((e) => e.exerciseId === EX_SQUAT);
    expect(daySquat?.nameSnapshotEn).toBe(SQUAT_NAME_EN);
    // An EDIT (winning update) re-freezes at THAT apply — an edit is a new log event.
    const edit = await applyHandlerStack(config, USER_A, sessionOp(91, {
      opId: opId(91),
      entityId: entityId(90),
      action: 'update',
      clientUpdatedAt: T1,
      payload: mixedSnapshot('2026-10-12'),
    }));
    expect(edit).toEqual({ outcome: 'applied' });
    const afterEdit = await reads.readSession(USER_A, entityId(90));
    const squatAfterEdit = afterEdit.exercises.find((e) => e.exerciseId === EX_SQUAT);
    expect(squatAfterEdit?.nameSnapshotEn).toBe('Barbell back squat (renamed)');
    // Restore the catalog name for the other assertions' fixtures.
    await adminQuery(db, `UPDATE exercises SET name_en = $2 WHERE id = $1`, [EX_SQUAT, SQUAT_NAME_EN]);
  });
});

describe('training-day marks (derived-never-synced, idempotent)', () => {
  it('apply ⇒ mark; second session ⇒ still one mark; deleting one of two keeps it; deleting the LAST un-marks; a day move recomputes both days', async () => {
    // Fresh day for USER_C: 2026-10-20.
    const day1 = '2026-10-20';
    await ingest(USER_C, 13, [sessionOp(100, { entityId: entityId(100), localDate: day1, payload: mixedSnapshot(day1) })]);
    expect(await reader.isTrainingDay(USER_C, day1)).toBe(true);
    await ingest(USER_C, 14, [sessionOp(101, { entityId: entityId(101), localDate: day1, payload: mixedSnapshot(day1) })]);
    const marksOnDay = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = $1 AND local_date = $2`, [USER_C, day1]);
    expect(marksOnDay.rows[0]?.n).toBe(1); // idempotent: still exactly ONE mark row

    // Delete ONE of the two ⇒ the mark REMAINS (∃ active session). Deletes are new ops (own opIds).
    await ingest(USER_C, 15, [sessionOp(105, { opId: opId(105), entityId: entityId(100), action: 'delete', payload: undefined })]);
    expect(await reader.isTrainingDay(USER_C, day1)).toBe(true);

    // Delete the LAST one ⇒ un-marks (the frozen rule).
    await ingest(USER_C, 16, [sessionOp(106, { opId: opId(106), entityId: entityId(101), action: 'delete', payload: undefined })]);
    expect(await reader.isTrainingDay(USER_C, day1)).toBe(false);
    const gone = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = $1 AND local_date = $2`, [USER_C, day1]);
    expect(gone.rows[0]?.n).toBe(0); // the projection stays EXACT (∃ active ⇔ row)

    // A winning update that MOVES a session between days marks the new day and un-marks the old.
    await ingest(USER_C, 17, [sessionOp(102, { entityId: entityId(102), localDate: '2026-10-21', payload: mixedSnapshot('2026-10-21') })]);
    expect(await reader.isTrainingDay(USER_C, '2026-10-21')).toBe(true);
    await ingest(USER_C, 18, [sessionOp(103, {
      opId: opId(103),
      entityId: entityId(102),
      action: 'update',
      clientUpdatedAt: T1,
      localDate: '2026-10-22',
      payload: mixedSnapshot('2026-10-22'),
    })]);
    expect(await reader.isTrainingDay(USER_C, '2026-10-21')).toBe(false);
    expect(await reader.isTrainingDay(USER_C, '2026-10-22')).toBe(true);

    // Range read (the W5 seam): inclusive [from, to].
    const range = await reader.trainingDaysBetween(USER_C, '2026-10-22', '2026-10-29');
    expect(range).toEqual(['2026-10-22']);

    // A rate-limited create (never applied) never marks a day.
    const cap1 = configFor({ JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '1', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000' });
    const refused = await applyHandlerStack(cap1, USER_C, sessionOp(104, { opId: opId(104), entityId: entityId(104), localDate: '2026-10-23', payload: mixedSnapshot('2026-10-23') }));
    expect(refused).toEqual({ outcome: 'rejected', code: 'rejected_rate_limited', retryable: true });
    expect(await reader.isTrainingDay(USER_C, '2026-10-23')).toBe(false);
  });
});
