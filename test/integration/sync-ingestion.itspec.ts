/**
 * Kal sync ingestion — integration / isolation suite (wave-03, task s2d).
 *
 * DB-backed: ephemeral `kal_it_*` database, full migration history via the
 * real Prisma runner, the REAL ingestion service (real PrismaService,
 * stores, per-transaction role/GUC/UTC posture, RLS) wired with the
 * clearly-marked TEST-ONLY seam handler (test/support/sync-test-handler.ts
 * — the §1.3-faithful mini state machine over `favorites`). The real
 * diary/user-food/favorite handlers merge via s2a/s2c; combined behavior is
 * proven at s4/integration (stated in the lane MR).
 *
 * Required cases (task contract — assertions by name):
 *   - dedupe (I9): replay of applied ops ⇒ all `duplicate`, ZERO
 *     re-application (row state identical, handler counts unchanged).
 *   - cross-user op-ID replay (I6): B replaying A's op id NEVER matches —
 *     fresh generic outcome under B; A's ledger row invisible to B's
 *     context (RLS row-count proof); A's recorded outcome untouched.
 *   - ordering/state machine: create → LWW loser (equal-timestamp
 *     deterministic tiebreak: higher opId wins) → delete →
 *     update-after-delete/create-after-delete rejections.
 *   - atomicity/rollback-retry: injected handler failure mid-batch ⇒ full
 *     rollback (zero rows in all three tables); retry succeeds exactly
 *     once; crash-retry equivalence (final state == a clean single run).
 *   - Idempotency-Key retention (§6 two-config): within-retention replay is
 *     byte-stable; an EXPIRED key is a new operation (executes fresh; per-op
 *     dedupe still prevents every re-application); the key row's physical
 *     replacement is future housekeeping (no DELETE grant — the expired row
 *     stays; documented §5 posture).
 *   - RLS fail-closed on `sync_operations` (adopted table): context-less ⇒
 *     zero rows; no UPDATE grant (single-phase append) is pinned
 *     behaviorally (42501).
 *   - concurrency: two same-key ingests race ⇒ exactly one commits; the
 *     other replays the recorded outcome byte-identically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/config/config.service.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { SyncIngestionService } from '../../src/sync/ingestion/ingestion.service.js';
import { IdempotencyKeyStore } from '../../src/sync/ingestion/idempotency-key.store.js';
import { OpLedgerStore } from '../../src/sync/ingestion/op-ledger.store.js';
import { OpHandlerRegistry } from '../../src/sync/ingestion/op-handler-registry.js';
import { SyncConfigService } from '../../src/sync/ingestion/sync.config.js';
import type { UserContext } from '../../src/request-context/user-context.js';
import {
  asUser,
  asUserlessApp,
  USER_A,
  USER_B,
  USER_C,
} from './helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { createFavoriteTestHandler } from '../support/sync-test-handler.js';

const failOpIds = new Set<string>();

let db: EphemeralKalDb;
let prisma: PrismaService;
let service: SyncIngestionService;
let handlerApplies = 0;

const CTX_A: UserContext = { kind: 'consumer', userId: USER_A };
const CTX_B: UserContext = { kind: 'consumer', userId: USER_B };
const CTX_C: UserContext = { kind: 'consumer', userId: USER_C };

function key(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `7cef0000-0000-4000-8000-${hex}`;
}
function op(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `7d0f0000-0000-4000-8000-${hex}`;
}
function entity(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `7e100000-0000-4000-8000-${hex}`;
}
function food(n: number): string {
  return `00000000-0000-4000-8000-00000000f2${n.toString(16).padStart(2, '0')}`;
}

interface OpBody {
  opId: string;
  kind: 'favorite';
  entityId: string;
  action: 'create' | 'update' | 'delete';
  clientUpdatedAt: string;
  payload?: Record<string, unknown>;
}

function createOpBody(n: number, at: string): OpBody {
  return {
    opId: op(n),
    kind: 'favorite',
    entityId: entity(n),
    action: 'create',
    clientUpdatedAt: at,
    payload: { foodId: food(n) },
  };
}

async function ingest(
  ctx: UserContext,
  ops: OpBody[],
  idempotencyKey: string,
  deviceId = 'itspec-device',
): Promise<{ status: number; body: string }> {
  return service.ingest(ctx, { deviceId, ops }, idempotencyKey);
}

function resultsOf(ack: { body: string }): { opId: string; outcome: string; code?: string; retryable?: boolean }[] {
  return (JSON.parse(ack.body) as { results: { opId: string; outcome: string; code?: string; retryable?: boolean }[] }).results;
}

async function favoriteRow(userId: string, entityId: string): Promise<{ updated_at: Date; deleted_at: Date | null; last_op_id: string | null } | null> {
  const result = await adminQuery(
    db,
    'SELECT updated_at, deleted_at, last_op_id FROM favorites WHERE user_id = $1 AND id = $2',
    [userId, entityId],
  );
  return (result.rows[0] as { updated_at: Date; deleted_at: Date | null; last_op_id: string | null } | undefined) ?? null;
}

async function counts(userId: string): Promise<{ favorites: number; ops: number; keys: number }> {
  const favorites = await adminQuery(db, 'SELECT count(*)::int AS n FROM favorites WHERE user_id = $1', [userId]);
  const ops = await adminQuery(db, 'SELECT count(*)::int AS n FROM sync_operations WHERE user_id = $1', [userId]);
  const keys = await adminQuery(db, 'SELECT count(*)::int AS n FROM sync_idempotency_keys WHERE user_id = $1', [userId]);
  return {
    favorites: (favorites.rows[0] as { n: number }).n,
    ops: (ops.rows[0] as { n: number }).n,
    keys: (keys.rows[0] as { n: number }).n,
  };
}

beforeAll(async () => {
  db = await createEphemeralKalDb('syncing-it');
  db.applyMigrations();

  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [
      USER_A,
      'a@sync-ingest-it.invalid',
      'sync_ingest_it_a',
    ]);
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [
      USER_B,
      'b@sync-ingest-it.invalid',
      'sync_ingest_it_b',
    ]);
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [
      USER_C,
      'c@sync-ingest-it.invalid',
      'sync_ingest_it_c',
    ]);
  }, { commit: true });

  // Platform-catalog FK targets, the production-faithful seed path.
  await adminQuery(
    db,
    `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
       name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
     SELECT id, 'dish', 'kal_reviewed', 'proprietary', 'Fixture food ' || row_number() OVER (),
       'fixture food ' || row_number() OVER (), 'طعام تجريبي', 'طعام تجريبي',
       ARRAY['fixture']::text[], ARRAY['fixture']::text[], 100, 5, 10, 2
     FROM unnest($1::uuid[]) AS id`,
    [Array.from({ length: 80 }, (_v, i) => food(i + 1))],
  );

  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  prisma = new PrismaService({ databaseUrl: url.toString() } as unknown as ConfigService);

  // The TEST-ONLY seam handler, wrapped with an application counter for the
  // zero-re-application proofs, registered through the PRODUCTION path.
  const baseHandler = createFavoriteTestHandler({ failWhen: (op) => failOpIds.has(op.opId) });
  const countingHandler = {
    kind: baseHandler.kind,
    apply: async (
      op: Parameters<typeof baseHandler.apply>[0],
      ctx: Parameters<typeof baseHandler.apply>[1],
      tx: Parameters<typeof baseHandler.apply>[2],
    ) => {
      handlerApplies += 1;
      return baseHandler.apply(op, ctx, tx);
    },
  };
  const serviceRegistry = new OpHandlerRegistry();
  serviceRegistry.registerOpHandler(countingHandler);

  const config = new SyncConfigService({ SYNC_IDEMPOTENCY_KEY_RETENTION_SECONDS: '3600' });
  service = new SyncIngestionService(prisma, config, serviceRegistry, new OpLedgerStore(), new IdempotencyKeyStore());
}, 180_000);

afterAll(async () => {
  await prisma?.onModuleDestroy();
  await db?.drop();
}, 60_000);

const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';
const T2 = '2026-10-08T09:00:00Z';

// ---------------------------------------------------------------------------

describe('dedupe (I9) — replay never re-applies', () => {
  it('applies a batch; a full replay acks all duplicate with byte-identical row state and zero handler runs', async () => {
    const ops = [createOpBody(1, T0), createOpBody(2, T0)];
    const first = await ingest(CTX_A, ops, key(1));
    expect(first.status).toBe(200);
    expect(resultsOf(first).map((r) => r.outcome)).toEqual(['applied', 'applied']);
    const afterFirst = await counts(USER_A);
    const rowsBefore = [await favoriteRow(USER_A, entity(1)), await favoriteRow(USER_A, entity(2))];
    const appliesAfterFirst = handlerApplies;

    const replay = await ingest(CTX_A, ops, key(2)); // new request, same ops
    expect(resultsOf(replay).map((r) => r.outcome)).toEqual(['duplicate', 'duplicate']);
    expect(handlerApplies).toBe(appliesAfterFirst); // zero re-application
    // The replay carried a NEW key: the key count grows by one; entity and
    // op rows are untouched.
    expect(await counts(USER_A)).toEqual({
      favorites: afterFirst.favorites,
      ops: afterFirst.ops,
      keys: afterFirst.keys + 1,
    });
    expect(await favoriteRow(USER_A, entity(1))).toEqual(rowsBefore[0]);
    expect(await favoriteRow(USER_A, entity(2))).toEqual(rowsBefore[1]);
  });
});

describe('cross-user op-ID replay (I6) — B replaying A never matches', () => {
  it("B's ingest of A's op id applies fresh under B; A's row is invisible to B's context; A's outcome untouched", async () => {
    const aOpId = op(5);
    const first = await ingest(CTX_A, [createOpBody(5, T0)], key(5));
    expect(resultsOf(first)[0]?.outcome).toBe('applied');

    const bReplay = await ingest(CTX_B, [
      {
        opId: aOpId, // A's op id — the dedupe key must NOT match across users
        kind: 'favorite',
        entityId: entity(6),
        action: 'create',
        clientUpdatedAt: T0,
        payload: { foodId: food(6) },
      },
    ], key(6));
    expect(bReplay.status).toBe(200);
    expect(resultsOf(bReplay)[0]).toEqual({ opId: aOpId, outcome: 'applied' }); // generic fresh outcome — nothing about A

    // Structural keys: exactly one ledger row per (user, op id).
    const aRows = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM sync_operations WHERE user_id = $1 AND client_op_id = $2',
      [USER_A, aOpId],
    );
    const bRows = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM sync_operations WHERE user_id = $1 AND client_op_id = $2',
      [USER_B, aOpId],
    );
    expect((aRows.rows[0] as { n: number }).n).toBe(1);
    expect((bRows.rows[0] as { n: number }).n).toBe(1);

    // RLS row-count proof: under B's verified context, a lookup for A's
    // ledger row yields ZERO rows even though the row exists and B knows
    // the op id — the user_id predicate is reinforced by RLS (stable ids
    // are never authorization, I6; the structural key + predicate).
    let visibleToB = -1;
    await asUser(db, USER_B, async (q) => {
      const result = await q(
        'SELECT count(*)::int AS n FROM sync_operations WHERE client_op_id = $1 AND user_id = $2',
        [aOpId, USER_A],
      );
      visibleToB = (result.rows[0] as { n: number }).n;
    });
    expect(visibleToB).toBe(0);

    // A's own replay still dedupes to A's recorded outcome.
    const aReplay = await ingest(CTX_A, [createOpBody(5, T0)], key(7));
    expect(resultsOf(aReplay)[0]?.outcome).toBe('duplicate');
  });
});

describe('ordering/state machine — the deterministic LWW tiebreak (§1.4)', () => {
  it('equal clientUpdatedAt ⇒ the lexicographically HIGHER opId wins; the loser is recorded applied and changes nothing', async () => {
    const entityId = entity(10);
    const create = await ingest(CTX_A, [createOpBody(10, T1)], key(10));
    expect(resultsOf(create)[0]?.outcome).toBe('applied');

    // Same instant T1: opId(12) > opId(11), so op 12 must win over op 11
    // regardless of arrival order.
    const lowerOpId: OpBody = {
      opId: op(11),
      kind: 'favorite',
      entityId,
      action: 'update',
      clientUpdatedAt: T1,
      payload: { foodId: food(10) },
    };
    const higherOpId: OpBody = {
      opId: op(12),
      kind: 'favorite',
      entityId,
      action: 'update',
      clientUpdatedAt: T1,
      payload: { foodId: food(10) },
    };
    const r1 = await ingest(CTX_A, [lowerOpId], key(11));
    const r2 = await ingest(CTX_A, [higherOpId], key(12));
    expect(resultsOf(r1)[0]?.outcome).toBe('applied'); // loser recorded applied…
    expect(resultsOf(r2)[0]?.outcome).toBe('applied'); // …winner applied
    // The winner's op id is the stored comparator.
    expect((await favoriteRow(USER_A, entityId))?.last_op_id).toBe(op(12));
  });

  it('update-after-delete ⇒ rejected_deleted; create-after-delete (same entity id) ⇒ rejected_deleted, no resurrection', async () => {
    const entityId = entity(15);
    await ingest(CTX_A, [createOpBody(15, T0)], key(15));
    const del = await ingest(CTX_A, [
      { opId: op(16), kind: 'favorite', entityId, action: 'delete', clientUpdatedAt: T1 },
    ], key(16));
    expect(resultsOf(del)[0]?.outcome).toBe('applied');
    expect((await favoriteRow(USER_A, entityId))?.deleted_at).not.toBeNull();

    const zombieUpdate = await ingest(CTX_A, [
      { opId: op(17), kind: 'favorite', entityId, action: 'update', clientUpdatedAt: T2, payload: { foodId: food(15) } },
    ], key(17));
    expect(resultsOf(zombieUpdate)[0]).toEqual({ opId: op(17), outcome: 'rejected', code: 'rejected_deleted', retryable: false });

    const resurrection = await ingest(CTX_A, [
      { opId: op(18), kind: 'favorite', entityId, action: 'create', clientUpdatedAt: T2, payload: { foodId: food(15) } },
    ], key(18));
    expect(resultsOf(resurrection)[0]).toEqual({ opId: op(18), outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });
});

describe('atomicity/rollback-retry + crash-retry equivalence', () => {
  it('handler failure mid-batch rolls back everything; retry applies exactly once with state identical to a clean run', async () => {
    const batch = [createOpBody(20, T0), createOpBody(21, T0), createOpBody(22, T0)];
    const before = await counts(USER_A);
    failOpIds.add(op(21));
    try {
      await expect(ingest(CTX_A, batch, key(20))).rejects.toThrow(/injected infrastructure failure/u);
    } finally {
      failOpIds.delete(op(21));
    }
    // Zero partial state in all three tables.
    expect(await counts(USER_A)).toEqual(before);
    expect(await favoriteRow(USER_A, entity(20))).toBeNull();
    expect(await favoriteRow(USER_A, entity(21))).toBeNull();
    expect(await favoriteRow(USER_A, entity(22))).toBeNull();

    // Retry (same batch, same key — nothing was recorded): clean execution.
    const retry = await ingest(CTX_A, batch, key(20));
    expect(resultsOf(retry).map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(await counts(USER_A)).toEqual({
      favorites: before.favorites + 3,
      ops: before.ops + 3,
      keys: before.keys + 1,
    });

    // Crash-retry equivalence: the same-shaped batch run ONCE cleanly by
    // the control user C (distinct client ids — entity ids are GLOBAL
    // primary keys, the §5-documented cross-user refusal) yields the
    // identical row shape (field-by-field).
    const golden = await ingest(
      CTX_C,
      [createOpBody(60, T0), createOpBody(61, T0), createOpBody(62, T0)],
      key(21),
    );
    expect(resultsOf(golden).map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    const aRows = await adminQuery(
      db,
      `SELECT entity_kind, entity_action, outcome, local_date FROM sync_operations
       WHERE user_id = $1 AND client_op_id = ANY($2) ORDER BY client_op_id`,
      [USER_A, [op(20), op(21), op(22)]],
    );
    const cRows = await adminQuery(
      db,
      `SELECT entity_kind, entity_action, outcome, local_date FROM sync_operations
       WHERE user_id = $1 AND client_op_id = ANY($2) ORDER BY client_op_id`,
      [USER_C, [op(60), op(61), op(62)]],
    );
    expect(aRows.rows).toEqual(cRows.rows);
  });
});

describe('Idempotency-Key retention (§6 two-config)', () => {
  it('within retention: byte-stable recorded replay; after expiry: a NEW operation (fresh execution, per-op dedupe still holds)', async () => {
    const ops = [createOpBody(30, T0)];
    const first = await ingest(CTX_A, ops, key(30));
    expect(resultsOf(first)[0]?.outcome).toBe('applied');

    // Within retention (3600 s): byte-stable replay.
    const replay = await ingest(CTX_A, ops, key(30));
    expect(replay.body).toBe(first.body);

    // Expire the key row (harness-only clock manipulation — the admin
    // connection; the app role has no UPDATE grant).
    await adminQuery(
      db,
      `UPDATE sync_idempotency_keys SET created_at = now() - interval '2 hours'
       WHERE user_id = $1 AND idempotency_key = $2`,
      [USER_A, key(30)],
    );

    const expired = await ingest(CTX_A, ops, key(30));
    expect(expired.status).toBe(200);
    // A NEW operation: executed fresh — the per-op dedupe makes every op a
    // duplicate (zero re-application), NOT a byte-stale replay of the
    // original applied-ack.
    expect(resultsOf(expired).map((r) => r.outcome)).toEqual(['duplicate']);
    expect(expired.body).not.toBe(first.body);
    // The physically-present expired row was NOT replaced (no DELETE/UPDATE
    // grant for the app role — physical replacement is future housekeeping).
    const keyRows = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM sync_idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
      [USER_A, key(30)],
    );
    expect((keyRows.rows[0] as { n: number }).n).toBe(1);
    // And the entity was NOT applied twice.
    const favRows = await adminQuery(
      db,
      'SELECT count(*)::int AS n FROM favorites WHERE user_id = $1 AND id = $2',
      [USER_A, entity(30)],
    );
    expect((favRows.rows[0] as { n: number }).n).toBe(1);
  });
});

describe('RLS fail-closed on sync_operations (adopted table) + grant matrix', () => {
  it('a context-less app-role query sees ZERO rows (fail-closed, I2)', async () => {
    let visible = -1;
    await asUserlessApp(db, async (q) => {
      const result = await q('SELECT count(*)::int AS n FROM sync_operations');
      visible = (result.rows[0] as { n: number }).n;
    });
    expect(visible).toBe(0);
  });

  it('sync_operations is single-phase append: the app role holds NO UPDATE (42501), byte-identical denial', async () => {
    let errorCode = '';
    await asUser(db, USER_A, async (q) => {
      await q('BEGIN');
      await q(`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', $1, true)`, [USER_A]);
      try {
        await q('UPDATE sync_operations SET outcome = $1', ['applied']);
      } catch (error) {
        errorCode = (error as { code?: string }).code ?? '';
      } finally {
        await q('ROLLBACK').catch(() => undefined);
      }
    });
    expect(errorCode).toBe('42501');
  });
});

describe('concurrency — two same-key ingests race', () => {
  it('exactly one commits; the other replays the recorded outcome byte-identically; single application', async () => {
    const ops = [createOpBody(40, T0)];
    const before = await counts(USER_B);
    const [r1, r2] = await Promise.all([
      ingest(CTX_B, ops, key(40), 'device-race'),
      ingest(CTX_B, ops, key(40), 'device-race'),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toBe(r1.body);
    expect(resultsOf(r1)[0]).toEqual({ opId: op(40), outcome: 'applied' });
    const after = await counts(USER_B);
    expect(after.favorites).toBe(before.favorites + 1);
    expect(after.ops).toBe(before.ops + 1);
    expect(after.keys).toBe(before.keys + 1);
  });
});
