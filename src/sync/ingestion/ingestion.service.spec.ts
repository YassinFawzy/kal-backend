/**
 * Unit — the sync ingestion service decision matrix (wave-03 contract
 * §1.2/§1.3; conventions §3).
 *
 * The transactional/database-level behavior (real unique-index races, RLS,
 * retention clock) is pinned by the integration + e2e suites; THIS suite
 * pins the service's frozen decision tree over in-memory store fakes with
 * snapshot-rollback transaction semantics:
 *
 *   - per-op dedupe replays (duplicate / same-rejection, handler never
 *     re-run — I9);
 *   - `rejected_rate_limited` acked but NOT recorded (retry re-runs the
 *     handler — §1.7);
 *   - registry-miss ⇒ per-op rejected (validation class), recorded;
 *   - a rejected op never aborts the batch;
 *   - Idempotency-Key: byte-stable recorded replay / 409 on changed payload;
 *   - atomicity: handler failure mid-batch ⇒ nothing recorded;
 *   - the batch-boundary race convergence (recorded ⇒ replay; absent ⇒ one
 *     clean re-run).
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.ts';
import { PrismaService } from '../../db/prisma.service.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import type { UserContext } from '../../request-context/user-context.js';
import { buildAckEnvelope, serializeAckEnvelope, type AckResult } from './ack.js';
import { canonicalRequestDigest } from './canonical-json.js';
import { SyncIngestionService } from './ingestion.service.js';
import { IdempotencyKeyStore, type InsertKeyInput, type RecordedKeyResponse } from './idempotency-key.store.js';
import { OpLedgerStore, type InsertRecordedInput, type RecordedSyncOp } from './op-ledger.store.js';
import { OpHandlerRegistry } from './op-handler-registry.js';
import { SyncConfigService } from './sync.config.js';
import type { SyncOpHandler, SyncOpHandlerResult } from '../../tracking/sync-seams.js';

// ---------------------------------------------------------------------------
// fakes (snapshot-rollback transaction semantics)
// ---------------------------------------------------------------------------

type LedgerKey = string;
const ledgerKey = (userId: string, opId: string): LedgerKey => `${userId}:${opId}`;
type KeyRow = { digest: string; status: number; body: unknown };
const keyRowId = (userId: string, endpoint: string, key: string): string => `${userId}:${endpoint}:${key}`;

class FakeLedger {
  readonly rows = new Map<LedgerKey, RecordedSyncOp>();
  /** When non-null, the NEXT insert throws this error (once). */
  throwOnceOnInsert: Error | null = null;

  async findRecorded(_tx: unknown, userId: string, clientOpId: string): Promise<RecordedSyncOp | null> {
    return this.rows.get(ledgerKey(userId, clientOpId)) ?? null;
  }

  async insertRecorded(_tx: unknown, input: InsertRecordedInput): Promise<void> {
    if (this.throwOnceOnInsert !== null) {
      const error = this.throwOnceOnInsert;
      this.throwOnceOnInsert = null;
      throw error;
    }
    this.rows.set(ledgerKey(input.userId, input.clientOpId), {
      outcome: input.outcome,
      rejectionCode: input.rejectionCode ?? null,
      retryable: input.retryable ?? null,
    });
  }

  snapshot(): [LedgerKey, RecordedSyncOp][] {
    return [...this.rows.entries()];
  }

  restore(snapshot: [LedgerKey, RecordedSyncOp][]): void {
    this.rows.clear();
    for (const [k, v] of snapshot) {
      this.rows.set(k, v);
    }
  }
}

class FakeKeys {
  readonly rows = new Map<string, KeyRow>();

  async findLive(
    _tx: unknown,
    userId: string,
    endpoint: string,
    idempotencyKey: string,
    _retentionSeconds: number,
  ): Promise<RecordedKeyResponse | null> {
    const row = this.rows.get(keyRowId(userId, endpoint, idempotencyKey));
    if (row === undefined) {
      return null;
    }
    return { requestDigest: row.digest, responseStatus: row.status, responseBody: row.body };
  }

  async insertRecordOnConflictDoNothing(_tx: unknown, input: InsertKeyInput): Promise<void> {
    const id = keyRowId(input.userId, input.endpoint, input.idempotencyKey);
    if (!this.rows.has(id)) {
      this.rows.set(id, { digest: input.requestDigest, status: input.responseStatus, body: input.responseBody });
    }
  }

  snapshot(): [string, KeyRow][] {
    return [...this.rows.entries()];
  }

  restore(snapshot: [string, KeyRow][]): void {
    this.rows.clear();
    for (const [k, v] of snapshot) {
      this.rows.set(k, v);
    }
  }
}

class FakeDb {
  constructor(
    private readonly ledger: FakeLedger,
    private readonly keys: FakeKeys,
  ) {}

  async transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const ledgerSnap = this.ledger.snapshot();
    const keysSnap = this.keys.snapshot();
    const tx = { $queryRaw: async () => [] };
    try {
      return await work(tx);
    } catch (error) {
      this.ledger.restore(ledgerSnap);
      this.keys.restore(keysSnap);
      throw error;
    }
  }
}

/** A recording fake seam handler with a scripted verdict per op. */
class RecordingHandler implements SyncOpHandler {
  readonly calls: string[] = [];
  script: (opId: string) => SyncOpHandlerResult = () => ({ outcome: 'applied' });

  constructor(readonly kind: SyncOpHandler['kind']) {}

  async apply(op: { opId: string }): Promise<SyncOpHandlerResult> {
    this.calls.push(op.opId);
    return this.script(op.opId);
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const USER_A: UserContext = { kind: 'consumer', userId: '11111111-1111-4111-8111-111111111111' };

const OP_1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OP_2 = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const OP_3 = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const OP_4 = '3f2504e0-4f89-41d3-9a0c-0305e82c3304';
const ENTITY = '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d01';
const FOOD = '00000000-0000-4000-8000-00000000f001';

function favoriteOp(opId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId,
    kind: 'favorite',
    entityId: ENTITY,
    action: 'create',
    clientUpdatedAt: '2026-10-08T07:00:00Z',
    payload: { foodId: FOOD },
    ...overrides,
  };
}

interface Harness {
  readonly service: SyncIngestionService;
  readonly ledger: FakeLedger;
  readonly keys: FakeKeys;
  readonly registry: OpHandlerRegistry;
  readonly favorite: RecordingHandler;
}

function makeHarness(env: Record<string, string> = {}): Harness {
  const ledger = new FakeLedger();
  const keys = new FakeKeys();
  const db = new FakeDb(ledger, keys);
  const registry = new OpHandlerRegistry();
  const favorite = new RecordingHandler('favorite');
  registry.registerOpHandler(favorite);
  const config = new SyncConfigService(env);
  const service = new SyncIngestionService(
    db as unknown as PrismaService,
    config,
    registry,
    ledger as unknown as OpLedgerStore,
    keys as unknown as IdempotencyKeyStore,
  );
  return {
    service,
    ledger,
    keys,
    registry,
    favorite,
  };
}

function problemOf(error: unknown): KalProblemException {
  expect(error).toBeInstanceOf(KalProblemException);
  return error as KalProblemException;
}

// ---------------------------------------------------------------------------
// the matrix
// ---------------------------------------------------------------------------

describe('SyncIngestionService — happy batch (PRD §23.1 scenario shape)', () => {
  it('applies a 4-op batch (three creates + one edit) in request order with per-op applied acks', async () => {
    const h = makeHarness();
    const ops = [
      favoriteOp(OP_1),
      favoriteOp(OP_2, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d02' }),
      favoriteOp(OP_3, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d03' }),
      favoriteOp(OP_4, { action: 'update', entityId: ENTITY, clientUpdatedAt: '2026-10-08T08:00:00Z' }),
    ];
    const ack = await h.service.ingest(USER_A, { deviceId: 'device-01', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    expect(ack.status).toBe(200);
    const parsed = JSON.parse(ack.body) as { results: AckResult[] };
    expect(parsed.results.map((r) => [r.opId, r.outcome])).toEqual([
      [OP_1, 'applied'],
      [OP_2, 'applied'],
      [OP_3, 'applied'],
      [OP_4, 'applied'],
    ]);
    // Dispatch order == request order (the frozen per-device ordering).
    expect(h.favorite.calls).toEqual([OP_1, OP_2, OP_3, OP_4]);
    expect(h.ledger.rows.size).toBe(4);
  });
});

describe('SyncIngestionService — per-op dedupe replays (I9)', () => {
  it('replaying the whole batch (new request, same ops) acks all duplicate and never re-applies', async () => {
    const h = makeHarness();
    const ops = [favoriteOp(OP_1), favoriteOp(OP_2, { action: 'update' })];
    const key1 = 'c1d9f0aa-0000-4000-8000-000000000001';
    const key2 = 'c1d9f0aa-0000-4000-8000-000000000002';
    const first = await h.service.ingest(USER_A, { deviceId: 'device-01', ops }, key1);
    const callsAfterFirst = h.favorite.calls.length;

    const replay = await h.service.ingest(USER_A, { deviceId: 'device-01', ops }, key2);
    const parsed = JSON.parse(replay.body) as { results: AckResult[] };
    expect(parsed.results.map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
    expect(h.favorite.calls.length).toBe(callsAfterFirst); // zero re-application
    expect(h.ledger.rows.size).toBe(2);
    expect(first.status).toBe(200);
  });

  it('a replayed rejected op acks the SAME rejection (code + retryable from the record; handler not re-run)', async () => {
    const h = makeHarness();
    h.favorite.script = (opId) =>
      opId === OP_1
        ? { outcome: 'rejected', code: 'rejected_validation', retryable: false }
        : { outcome: 'applied' };
    const ops = [favoriteOp(OP_1), favoriteOp(OP_2, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d02' })];
    await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const callsAfterFirst = h.favorite.calls.length;

    const replay = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000002');
    const parsed = JSON.parse(replay.body) as { results: AckResult[] };
    expect(parsed.results[0]).toEqual({ opId: OP_1, outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(parsed.results[1]?.outcome).toBe('duplicate');
    expect(h.favorite.calls.length).toBe(callsAfterFirst);
  });

  it('the same opId pushed by the SAME user with a different device still dedupes (key is user+op, not device)', async () => {
    const h = makeHarness();
    const ops = [favoriteOp(OP_1)];
    await h.service.ingest(USER_A, { deviceId: 'device-A', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const calls = h.favorite.calls.length;
    const replay = await h.service.ingest(USER_A, { deviceId: 'device-B', ops }, 'c1d9f0aa-0000-4000-8000-000000000002');
    expect((JSON.parse(replay.body) as { results: AckResult[] }).results[0]?.outcome).toBe('duplicate');
    expect(h.favorite.calls.length).toBe(calls);
  });

  it('a duplicate opId twice within ONE batch acks applied then duplicate (in-transaction visibility)', async () => {
    const h = makeHarness();
    const ops = [favoriteOp(OP_1), favoriteOp(OP_1)];
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const parsed = JSON.parse(ack.body) as { results: AckResult[] };
    expect(parsed.results.map((r) => r.outcome)).toEqual(['applied', 'duplicate']);
    expect(h.favorite.calls.length).toBe(1);
  });
});

describe('SyncIngestionService — rejected_rate_limited (§1.7 directed resolution)', () => {
  it('acks rejected_rate_limited retryable=true and does NOT record it (a retry re-runs the handler)', async () => {
    const h = makeHarness();
    h.favorite.script = (opId) =>
      opId === OP_1
        ? { outcome: 'rejected', code: 'rejected_rate_limited', retryable: true }
        : { outcome: 'applied' };
    const ops = [favoriteOp(OP_1), favoriteOp(OP_2, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d02' })];
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const parsed = JSON.parse(ack.body) as { results: AckResult[] };
    expect(parsed.results[0]).toEqual({ opId: OP_1, outcome: 'rejected', code: 'rejected_rate_limited', retryable: true });
    // The terminal rejection of op2 IS recorded; the rate-limit is NOT.
    expect(h.ledger.rows.size).toBe(1);

    // Retry after the window (injection off): the handler re-runs and applies.
    h.favorite.script = () => ({ outcome: 'applied' });
    const retry = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000002');
    const retryParsed = JSON.parse(retry.body) as { results: AckResult[] };
    expect(retryParsed.results.map((r) => r.outcome)).toEqual(['applied', 'duplicate']);
    expect(h.favorite.calls.filter((id) => id === OP_1).length).toBe(2);
  });
});

describe('SyncIngestionService — registry dispatch (§4)', () => {
  it('an enum-valid kind with no registered handler ⇒ per-op rejected_validation, recorded for deterministic replay', async () => {
    const h = makeHarness();
    const ops = [
      favoriteOp(OP_1),
      { ...favoriteOp(OP_2), kind: 'diary_entry', localDate: '2026-10-08', payload: { mealSlot: 'breakfast' } },
    ];
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const parsed = JSON.parse(ack.body) as { results: AckResult[] };
    expect(parsed.results[0]?.outcome).toBe('applied');
    expect(parsed.results[1]).toEqual({ opId: OP_2, outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(h.ledger.rows.get(ledgerKey(USER_A.userId, OP_2))?.outcome).toBe('rejected');

    // Deterministic replay of the recorded rejection.
    const replay = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000002');
    expect((JSON.parse(replay.body) as { results: AckResult[] }).results[1]).toEqual({
      opId: OP_2,
      outcome: 'rejected',
      code: 'rejected_validation',
      retryable: false,
    });
  });

  it('a rejected op NEVER aborts the batch (per-op outcomes are independent)', async () => {
    const h = makeHarness();
    h.favorite.script = (opId) => (opId === OP_2 ? { outcome: 'rejected', code: 'rejected_conflict', retryable: false } : { outcome: 'applied' });
    const ops = [
      favoriteOp(OP_1, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d01' }),
      favoriteOp(OP_2, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d02' }),
      favoriteOp(OP_3, { entityId: '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d03' }),
    ];
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    const parsed = JSON.parse(ack.body) as { results: AckResult[] };
    expect(parsed.results.map((r) => r.outcome)).toEqual(['applied', 'rejected', 'applied']);
    expect(h.favorite.calls.length).toBe(3);
  });
});

describe('SyncIngestionService — batch shape (database-free, whole-batch)', () => {
  it('a malformed batch ⇒ VALIDATION_FAILED with zero store interaction', async () => {
    const h = makeHarness();
    const error = await h.service.ingest(USER_A, { deviceId: '', ops: [] }, 'c1d9f0aa-0000-4000-8000-000000000001').catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('VALIDATION_FAILED');
    expect(h.ledger.rows.size).toBe(0);
    expect(h.keys.rows.size).toBe(0);
    expect(h.favorite.calls.length).toBe(0);
  });

  it('a missing/malformed Idempotency-Key ⇒ VALIDATION_FAILED before anything else', async () => {
    const h = makeHarness();
    const error = await h.service.ingest(USER_A, { deviceId: 'd', ops: [] }, 'not-a-uuid').catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('VALIDATION_FAILED');
    expect(h.keys.rows.size).toBe(0);
  });

  it('the configured batch cap is enforced at the service boundary (config-driven, two-config)', async () => {
    const strict = makeHarness({ SYNC_MAX_OPS_PER_BATCH: '2' });
    const ops = [favoriteOp(OP_1), favoriteOp(OP_2), favoriteOp(OP_3)];
    const error = await strict.service
      .ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001')
      .catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('VALIDATION_FAILED');

    const loose = makeHarness({ SYNC_MAX_OPS_PER_BATCH: '3' });
    const ack = await loose.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    expect(ack.status).toBe(200);
  });

  it('fail-closed (I2): a non-consumer context is refused', async () => {
    const h = makeHarness();
    const error = await h.service
      .ingest({ kind: 'admin', userId: USER_A.userId }, { deviceId: 'd', ops: [] }, 'c1d9f0aa-0000-4000-8000-000000000001')
      .catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('FORBIDDEN');
  });
});

describe('SyncIngestionService — Idempotency-Key (conventions §3)', () => {
  const BODY = { deviceId: 'd', ops: [favoriteOp(OP_1)] };
  const KEY = 'c1d9f0aa-0000-4000-8000-000000000001';

  it('same key + same payload ⇒ the recorded outcome replays byte-stably (handler runs once)', async () => {
    const h = makeHarness();
    const first = await h.service.ingest(USER_A, BODY, KEY);
    const calls = h.favorite.calls.length;

    const replay = await h.service.ingest(USER_A, structuredClone(BODY), KEY);
    expect(replay.status).toBe(200);
    expect(replay.body).toBe(first.body); // byte-identical
    expect(h.favorite.calls.length).toBe(calls);
  });

  it('same key + changed payload ⇒ 409 CONFLICT (and nothing new recorded)', async () => {
    const h = makeHarness();
    await h.service.ingest(USER_A, BODY, KEY);
    const changed = { deviceId: 'd', ops: [favoriteOp(OP_1, { clientUpdatedAt: '2026-10-08T09:00:00Z' })] };
    const error = await h.service.ingest(USER_A, changed, KEY).catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('CONFLICT');
    expect(h.ledger.rows.size).toBe(1);
  });

  it('the recorded key replay works when the ops were ALL duplicates too (recorded bytes served)', async () => {
    const h = makeHarness();
    await h.service.ingest(USER_A, BODY, KEY);
    // A different key applies the same op (duplicate), then the ORIGINAL key replays its original bytes.
    await h.service.ingest(USER_A, BODY, 'c1d9f0aa-0000-4000-8000-000000000002');
    const replay = await h.service.ingest(USER_A, BODY, KEY);
    const parsed = JSON.parse(replay.body) as { results: AckResult[] };
    expect(parsed.results[0]?.outcome).toBe('applied'); // the ORIGINAL outcome, byte-stable
  });

  it('an empty batch records its key and replays byte-stably', async () => {
    const h = makeHarness();
    const first = await h.service.ingest(USER_A, { deviceId: 'd', ops: [] }, KEY);
    expect(JSON.parse(first.body)).toEqual({ results: [] });
    const replay = await h.service.ingest(USER_A, { deviceId: 'd', ops: [] }, KEY);
    expect(replay.body).toBe(first.body);
  });
});

describe('SyncIngestionService — atomicity and race convergence', () => {
  it('a handler failure mid-batch rolls back EVERYTHING (zero partial state) and the error surfaces', async () => {
    const h = makeHarness();
    h.favorite.script = (opId) => {
      if (opId === OP_3) {
        throw new Error('sync-test: injected infrastructure failure');
      }
      return { outcome: 'applied' };
    };
    const ops = [favoriteOp(OP_1), favoriteOp(OP_2), favoriteOp(OP_3), favoriteOp(OP_4)];
    const error = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('injected infrastructure failure');
    // Rollback: no ledger rows, no key record, no ack.
    expect(h.ledger.rows.size).toBe(0);
    expect(h.keys.rows.size).toBe(0);

    // Retry with the same batch (injection removed): clean, applies exactly once.
    h.favorite.script = () => ({ outcome: 'applied' });
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops }, 'c1d9f0aa-0000-4000-8000-000000000001');
    expect((JSON.parse(ack.body) as { results: AckResult[] }).results.map((r) => r.outcome)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(h.favorite.calls.filter((id) => id === OP_1).length).toBe(2); // first (rolled-back) + retry
    expect(h.ledger.rows.size).toBe(4);
  });

  it('a unique-violation race with a settled same-key winner replays the recorded outcome byte-stably', async () => {
    const h = makeHarness();
    const ops = [favoriteOp(OP_1)];
    const key = 'c1d9f0aa-0000-4000-8000-000000000001';
    const digestBody = { deviceId: 'd', ops };

    // Simulate the winner having settled: seed the key record with ITS ack.
    const winnerAck = buildAckEnvelope([{ opId: OP_1, outcome: 'applied' }]);
    h.keys.rows.set(keyRowIdFor(USER_A.userId, key), {
      digest: digestOf(digestBody),
      status: 200,
      body: winnerAck,
    });
    // And the racing request's per-op ledger insert collides (the winner's row).
    h.ledger.throwOnceOnInsert = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });

    const ack = await h.service.ingest(USER_A, digestBody, key);
    expect(ack.status).toBe(200);
    expect(ack.body).toBe(serializeAckEnvelope(winnerAck));
  });

  it('a unique-violation race with NOTHING recorded re-runs the batch cleanly exactly once', async () => {
    const h = makeHarness();
    h.ledger.throwOnceOnInsert = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const ack = await h.service.ingest(USER_A, { deviceId: 'd', ops: [favoriteOp(OP_1)] }, 'c1d9f0aa-0000-4000-8000-000000000001');
    expect(ack.status).toBe(200);
    expect((JSON.parse(ack.body) as { results: AckResult[] }).results[0]?.outcome).toBe('applied');
    expect(h.ledger.rows.size).toBe(1);
  });

  it('a CONFLICT thrown by the pre-check never triggers the race path (propagates as 409)', async () => {
    const h = makeHarness();
    const key = 'c1d9f0aa-0000-4000-8000-000000000001';
    await h.service.ingest(USER_A, { deviceId: 'd', ops: [favoriteOp(OP_1)] }, key);
    const error = await h.service
      .ingest(USER_A, { deviceId: 'd', ops: [favoriteOp(OP_1, { clientUpdatedAt: '2026-10-08T10:00:00Z' })] }, key)
      .catch((e: unknown) => e);
    expect(problemOf(error).code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// digest helpers (mirror the service's canonical digest)
// ---------------------------------------------------------------------------

function digestOf(body: unknown): string {
  return canonicalRequestDigest(body);
}
function keyRowIdFor(userId: string, key: string): string {
  return keyRowId(userId, '/sync/ops', key);
}
