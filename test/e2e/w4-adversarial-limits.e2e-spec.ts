/**
 * Kal — wave-4 s4 adversarial: the journal session-create rate-guard battery
 * (criterion 7) over the REAL ingestion route.
 *
 * The W3 user-food limiter ruling applied to sessions (w4 contract §1.2):
 *   - trip-point proof via the TWO-CONFIG method (config moves ⇒ threshold
 *     moves — nothing hardcoded): CONFIG 1 trips the rolling HOUR window,
 *     CONFIG 2 the rolling DAY window, at the same call count;
 *   - over-limit ⇒ per-op `rejected_rate_limited` retryable:true, the batch
 *     continues, and a rejected op ticks NOTHING (the counter sits at the
 *     cap, never above it);
 *   - NO ledger row for a rate-limited op (the w3 acked-not-recorded
 *     ruling, DB-verified); the same opId retried after the window rolls
 *     off applies cleanly (windows moved by the harness clock — the app
 *     role holds no such grant);
 *   - updates and deletes are NEVER rate-limited; other kinds in the same
 *     batch are unaffected;
 *   - rate-limited acks are outcome-identical across users (no
 *     user-distinguishing denial shape).
 *
 * Two fully separate app+db+triad boots (one per config), the
 * w3-adversarial-limits structure.
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
  advUuid,
  countRows,
  createThreeUserHarness,
  diaryCreateOp,
  expectAckOutcomesIdentical,
  pushBatch,
  type OpInput,
  type ThreeUserHarness,
} from '../integration/helpers/three-user-harness.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../integration/helpers/ephemeral-db.js';

const NS = 'f5e2'; // suite uuid namespace (4 hex)
const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';
const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';

interface Boot {
  readonly app: INestApplication<App>;
  readonly db: EphemeralKalDb;
  readonly users: ThreeUserHarness;
}

const boots: Boot[] = [];

function sessionSnapshot(): Record<string, unknown> {
  return {
    localDate: DAY,
    exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 8 }] }],
  };
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

function sessionCreate(tag: string, at = T0): JournalOpLike {
  return { opId: advUuid(NS, tag), kind: 'journal_session', entityId: advUuid(NS, `${tag}e`), action: 'create', clientUpdatedAt: at, localDate: DAY, payload: sessionSnapshot() };
}

function journalOpFrom(parts: JournalOpLike): OpInput {
  return parts as unknown as OpInput;
}

function resultsOf(response: request.Response): { opId: string; outcome: string; code?: string; retryable?: boolean }[] {
  return (response.body as { results?: { opId: string; outcome: string; code?: string; retryable?: boolean }[] }).results ?? [];
}

async function bootWithLimits(dbLabel: string, env: Record<string, string>, accounts: { a: [string, string]; b: [string, string]; c: [string, string] }): Promise<Boot> {
  const db = await createEphemeralKalDb(dbLabel);
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
  try {
    await applyExerciseCatalogSeed(seedClient);
  } finally {
    await seedClient.$disconnect();
  }
  const bootEnv: Record<string, string> = { ...env, DATABASE_URL: url.toString() };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(bootEnv)) {
    previous[key] = process.env[key];
    process.env[key] = bootEnv[key];
  }
  let app: INestApplication<App>;
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
  const users = await createThreeUserHarness(app, db, {
    a: { email: `${accounts.a[0]}@example.com`, phone: accounts.a[1], username: accounts.a[0] },
    b: { email: `${accounts.b[0]}@example.com`, phone: accounts.b[1], username: accounts.b[0] },
    c: { email: `${accounts.c[0]}@example.com`, phone: accounts.c[1], username: accounts.c[0] },
  });
  const boot: Boot = { app, db, users };
  boots.push(boot);
  return boot;
}

/** The journal counter row (the app role cannot read it — admin connection). */
async function journalCounters(boot: Boot, userId: string): Promise<{ hourCount: number; dayCount: number } | null> {
  const result = await adminQuery(boot.db, `SELECT hour_count, day_count FROM journal_session_create_counters WHERE user_id = $1`, [userId]);
  const row = result.rows[0] as { hour_count: number; day_count: number } | undefined;
  return row === undefined ? null : { hourCount: row.hour_count, dayCount: row.day_count };
}

/** Harness-clock lapse of BOTH journal limiter windows for one user. */
async function lapseJournalWindows(boot: Boot, userId: string): Promise<void> {
  await adminQuery(
    boot.db,
    `UPDATE journal_session_create_counters
        SET hour_window_start = now() - interval '2 hours', day_window_start = now() - interval '25 hours'
      WHERE user_id = $1`,
    [userId],
  );
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return advUuid(NS, `k${String(keySeq).padStart(4, '0')}`);
}

afterAll(async () => {
  for (const boot of boots.reverse()) {
    await boot.app?.close();
    await boot.db?.drop();
  }
}, 120_000);

// ===========================================================================
// CONFIG 1 — hour cap 2, day cap 1000: the THIRD create trips the HOUR window
// ===========================================================================

describe('config JOURNAL_SESSION_CREATE_MAX_PER_HOUR=2/_PER_DAY=1000 — the hour-window trip', () => {
  let boot: Boot;
  let firstBatchKey = '';
  let firstBatchRaw = '';

  beforeAll(async () => {
    boot = await bootWithLimits(
      'w4adv4l1',
      { IDENTITY_JWT_SIGNING_KEY: 'w4lim1x7hourtrip7fixed7key7material7enough7entropy1', NODE_ENV: 'test', JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '2', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '1000' },
      { a: ['w4lim1_owner_a', '+201950000101'], b: ['w4lim1_attacker_b', '+201950000102'], c: ['w4lim1_control_c', '+201950000103'] },
    );
  }, 240_000);

  it('creates 1–2 apply, create 3 rejects retryable rate_limited; the counter sits at the cap (2/2), never above', async () => {
    const ops = [sessionCreate('c1'), sessionCreate('c2'), sessionCreate('c3')];
    firstBatchKey = nextKey();
    const response = await pushBatch(boot.app, boot.users.b.token, ops.map(journalOpFrom), firstBatchKey);
    firstBatchRaw = response.text;
    expect(response.status).toBe(200);
    const results = resultsOf(response);
    expect(results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'rejected']);
    expect(results[2]).toMatchObject({ code: 'rejected_rate_limited', retryable: true });
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
  });

  it('the over-limit create left NO ledger row (the acked-not-recorded ruling, DB-verified)', async () => {
    expect(await countRows(boot.db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [boot.users.b.userId, advUuid(NS, 'c3')])).toBe(0);
    expect(await countRows(boot.db, 'journal_sessions', 'user_id = $1', [boot.users.b.userId])).toBe(2);
    // The applied ops of the same batch are recorded (count 2 for c1/c2 checked implicitly by the session rows + explicit below).
    expect(await countRows(boot.db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [boot.users.b.userId, advUuid(NS, 'c1')])).toBe(1);
  });

  it('replaying the SAME batch key returns the STORED ack byte-identically (rate-limited entry included) and ticks nothing', async () => {
    const ops = [sessionCreate('c1'), sessionCreate('c2'), sessionCreate('c3')];
    const replay = await pushBatch(boot.app, boot.users.b.token, ops.map(journalOpFrom), firstBatchKey);
    expect(replay.status).toBe(200);
    expect(replay.text).toBe(firstBatchRaw); // the Idempotency-Key stored-response replay
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
  });

  it('a fresh-key retry of the same opId while the window is live: still limited, still nothing recorded', async () => {
    const retry = await pushBatch(boot.app, boot.users.b.token, [journalOpFrom(sessionCreate('c3'))], nextKey());
    expect(resultsOf(retry).map((result) => result.outcome)).toEqual(['rejected']);
    expect(resultsOf(retry)[0]).toMatchObject({ code: 'rejected_rate_limited', retryable: true });
    expect(await countRows(boot.db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [boot.users.b.userId, advUuid(NS, 'c3')])).toBe(0);
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
  });

  it('after the harness-clock lapse the SAME opId applies cleanly — ledger 0→1, counter 0→1', async () => {
    await lapseJournalWindows(boot, boot.users.b.userId);
    const retry = await pushBatch(boot.app, boot.users.b.token, [journalOpFrom(sessionCreate('c3'))], nextKey());
    expect(resultsOf(retry).map((result) => result.outcome)).toEqual(['applied']);
    expect(await countRows(boot.db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [boot.users.b.userId, advUuid(NS, 'c3')])).toBe(1);
    expect(await countRows(boot.db, 'journal_sessions', 'user_id = $1', [boot.users.b.userId])).toBe(3);
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 1, dayCount: 1 });
  });

  it('updates and deletes are NEVER limited (even under cap 2/1000)', async () => {
    const update = await pushBatch(
      boot.app,
      boot.users.b.token,
      [journalOpFrom({ ...sessionCreate('c1'), opId: advUuid(NS, 'u1'), action: 'update' as const })],
      nextKey(),
    );
    expect(resultsOf(update)[0]).toMatchObject({ outcome: 'applied' });
    const delOp = { ...sessionCreate('c1'), opId: advUuid(NS, 'd1'), action: 'delete' as const };
    delete (delOp as { payload?: unknown }).payload; // delete ops carry NO payload (envelope rule)
    const del = await pushBatch(boot.app, boot.users.b.token, [journalOpFrom(delOp)], nextKey());
    expect(resultsOf(del).map((result) => result.outcome)).toEqual(['applied']);
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 1, dayCount: 1 }); // neither ticked
  });

  it('a limited session create does not touch the OTHER kinds in the same batch (per-op resolution)', async () => {
    const diaryOp = diaryCreateOp(NS, 'mixd1', 'mixde1', T0, DAY);
    const mixed = await pushBatch(
      boot.app,
      boot.users.b.token,
      [journalOpFrom(sessionCreate('mix1')), diaryOp, journalOpFrom(sessionCreate('mix2'))],
      nextKey(),
    );
    const results = resultsOf(mixed);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ outcome: 'applied' }); // window has room (lapsed above)
    expect(results[1]).toMatchObject({ outcome: 'applied' }); // diary unaffected throughout
    expect(results[2]).toMatchObject({ outcome: 'rejected', code: 'rejected_rate_limited' }); // hour cap 2 re-trips
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
  });

  it('A and C trip independently; the rate-limited ack triples are outcome-identical (no user shape)', async () => {
    // A and C both hold untouched windows in this boot — the same three
    // creates produce the same [applied, applied, rejected] shape.
    const aBatch = await pushBatch(boot.app, boot.users.a.token, [sessionCreate('a1'), sessionCreate('a2'), sessionCreate('a3')].map(journalOpFrom), nextKey());
    const cBatch = await pushBatch(boot.app, boot.users.c.token, [sessionCreate('g1'), sessionCreate('g2'), sessionCreate('g3')].map(journalOpFrom), nextKey());
    expect(resultsOf(aBatch).map((result) => result.outcome)).toEqual(['applied', 'applied', 'rejected']);
    expectAckOutcomesIdentical(aBatch, cBatch, 'A ≡ C rate-limited ack triples');
  });
});

// ===========================================================================
// CONFIG 2 — hour cap 100, day cap 2: the SAME call count trips the DAY window
// ===========================================================================

describe('config JOURNAL_SESSION_CREATE_MAX_PER_HOUR=100/_PER_DAY=2 — the day-window trip (two-config proof)', () => {
  let boot: Boot;

  beforeAll(async () => {
    boot = await bootWithLimits(
      'w4adv4l2',
      { IDENTITY_JWT_SIGNING_KEY: 'w4lim2x7daytrip7fixed7key7material7enough7entropy2', NODE_ENV: 'test', JOURNAL_SESSION_CREATE_MAX_PER_HOUR: '100', JOURNAL_SESSION_CREATE_MAX_PER_DAY: '2' },
      { a: ['w4lim2_owner_a', '+201960000101'], b: ['w4lim2_attacker_b', '+201960000102'], c: ['w4lim2_control_c', '+201960000103'] },
    );
  }, 240_000);

  it('the SAME 3rd create now trips the DAY window — the threshold moved with the config, not the code', async () => {
    const ops = [sessionCreate('d1'), sessionCreate('d2'), sessionCreate('d3')];
    const response = await pushBatch(boot.app, boot.users.b.token, ops.map(journalOpFrom), nextKey());
    const results = resultsOf(response);
    expect(results.map((result) => result.outcome)).toEqual(['applied', 'applied', 'rejected']);
    expect(results[2]).toMatchObject({ code: 'rejected_rate_limited', retryable: true });
    // The HOUR window had room (2 << 100) — the refusal came from the DAY window.
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 2, dayCount: 2 });
    expect(await countRows(boot.db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [boot.users.b.userId, advUuid(NS, 'd3')])).toBe(0);
  });

  it('laping only the DAY window frees the create — window independence', async () => {
    await adminQuery(
      boot.db,
      `UPDATE journal_session_create_counters SET day_window_start = now() - interval '25 hours' WHERE user_id = $1`,
      [boot.users.b.userId],
    );
    const retry = await pushBatch(boot.app, boot.users.b.token, [journalOpFrom(sessionCreate('d3'))], nextKey());
    expect(resultsOf(retry).map((result) => result.outcome)).toEqual(['applied']);
    expect(await journalCounters(boot, boot.users.b.userId)).toEqual({ hourCount: 3, dayCount: 1 });
  });
});
