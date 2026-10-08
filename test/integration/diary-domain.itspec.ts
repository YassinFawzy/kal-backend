/**
 * Kal — diary DOMAIN integration suite (wave-03, lane s2c-diary).
 *
 * The real AppModule against its own ephemeral `kal_it_*` database (harness
 * pattern): the `diary_entry` sync op apply-handler, the diary delta
 * provider, the rollups service, and the day-read service are exercised
 * through the FROZEN §4 seam — a dispatch test double replicates exactly
 * what sync ingestion does at the batch level (one transaction per batch,
 * `SET LOCAL ROLE kal_app` + `app.user_id` + `TimeZone UTC` per the F1
 * guidance) and calls the REAL handler logic. The HTTP surface itself is
 * pinned by `test/diary.e2e-spec.ts`; this suite pins the domain semantics:
 *
 *   - The frozen per-op state machine (contract §1.3): create/update/delete
 *     outcomes, LWW with the deterministic tiebreak (§1.4), tombstones win
 *     over stale ops, no resurrection (same-ID create-after-delete blocked;
 *     fresh ID = a NEW entry), idempotent deletes, batch-retry determinism.
 *   - Frozen nutrient snapshots (I11 — the criterion-5 test): a later food
 *     correction never rewrites a historical entry; edits re-snapshot only
 *     from the op payload (never re-resolved from the catalog).
 *   - Rollups recomputed transactionally on apply (create/update/delete and
 *     day-move updates recompute every affected bucket).
 *   - The day-boundary rule (§1.8): the carried date is authoritative —
 *     23:59 log / 00:01 sync stays on the original local day.
 *   - Delta feed (§1.6): a keyset over the user's OWN ROWS in their current
 *     state (not a change log — a tombstoned row appears once, as its
 *     payload-free `delete`), deterministic `(updatedAt, entityId)` order
 *     within the kind, strict keyset continuation, null-cursor first pull,
 *     full-snapshot upserts.
 *   - A/B/C negatives: B can neither read nor mutate A's diary entries
 *     through the handler, the delta feed, or raw SQL under RLS — denials
 *     byte-identical whether or not A's object exists (no existence
 *     oracles, I7); C is the control.
 *
 * Seeding uses direct INSERTs for synthetic fixture users and one platform
 * catalog food (synthetic UUIDs, placeholder-free); EVERY behavioral
 * assertion runs through sanctioned postured paths (the harness discipline:
 * superuser authority proves nothing). Each state-machine case logs on its
 * OWN carried day (uniqueDate()) so cases never observe each other's
 * entries — every day-read assertion is exact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { KalProblemException } from '../../src/problems/kal-problem.exception.js';
import { DiaryDeltaProvider } from '../../src/tracking/diary/diary-delta.service.js';
import { DiaryEntryOpHandler } from '../../src/tracking/diary/diary-apply.service.js';
import { DiaryReadService } from '../../src/tracking/diary/diary-read.service.js';
import type { DeltaChange, DeltaCursorState, SyncOpHandlerResult, SyncOpEnvelope } from '../../src/tracking/sync-seams.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { asUser, capturePgError } from './helpers/acting-user.js';

/** Synthetic fixture users (no relationship to any real identity). */
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const USER_D = '44444444-4444-4444-8444-444444444444'; // delta-ordering context
const USER_E = '55555555-5555-4555-8555-555555555555'; // delta-pagination context
/** Synthetic platform food (the seed manifest's f001 slot shape — fixture values). */
const FOOD_F001 = '00000000-0000-4000-8000-00000000f001';
/** Synthetic user food owned by A (seeded directly; RLS hides it from B). */
const USER_FOOD_A = '11111111-1111-4111-8111-0000000000a1';

const DAY_1 = '2026-01-15';
/** Sequential unique carried days so state-machine cases never share a bucket. */
let uniqueDayCounter = 0;
function uniqueDay(): string {
  uniqueDayCounter += 1;
  const date = new Date(Date.UTC(2026, 6, uniqueDayCounter)); // 2026-07-01..
  return date.toISOString().slice(0, 10);
}

let app: INestApplication;
let db: EphemeralKalDb;
let prisma: PrismaService;
let handler: DiaryEntryOpHandler;
let delta: DiaryDeltaProvider;
let reads: DiaryReadService;

/** Op-id/entity-id generators (unique per case — stable IDs, dedupe only). */
const opId = (): string => randomUUID();
const entityId = (): string => randomUUID();

function diaryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localDate: DAY_1,
    mealSlot: 'breakfast',
    entryMethod: 'search',
    foodId: FOOD_F001,
    quantity: 2,
    servingLabelEn: 'Bowl',
    servingLabelAr: 'طاسة',
    servingGramWeight: 200,
    energyKcal: 220,
    proteinG: 15.2,
    carbsG: 38.6,
    fatG: 1,
    status: 'confirmed',
    ...overrides,
  };
}

function diaryOp(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}): SyncOpEnvelope {
  return {
    opId: opId(),
    kind: 'diary_entry',
    action: 'create',
    entityId: entityId(),
    clientUpdatedAt: '2026-01-15T20:00:00Z',
    localDate: DAY_1,
    payload: diaryPayload(payloadOverrides),
    ...overrides,
  } as SyncOpEnvelope;
}

/**
 * The seam dispatch test double: exactly the batch posture sync ingestion
 * owns (one transaction per batch; per-transaction role + user GUC + UTC —
 * F1), calling the REAL handler. Sync's own concerns (envelope batch
 * validation, dedupe on (user, op id), ack assembly) are s2d's and are not
 * replicated here.
 */
async function dispatch(op: SyncOpEnvelope, userId: string): Promise<SyncOpHandlerResult> {
  return prisma.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userId}::text, true), set_config('TimeZone', 'UTC', true)`;
    return handler.apply(op, { userId, deviceId: 'itspec-device' }, tx);
  });
}

/** A dispatch whose transaction posture is deliberately WRONG for the op context. */
async function dispatchWithMismatchedPosture(op: SyncOpEnvelope, opUserId: string, txUserId: string | null): Promise<SyncOpHandlerResult> {
  return prisma.transaction(async (tx) => {
    if (txUserId !== null) {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${txUserId}::text, true), set_config('TimeZone', 'UTC', true)`;
    } else {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`;
    }
    return handler.apply(op, { userId: opUserId, deviceId: 'itspec-device' }, tx);
  });
}

function readDay(userId: string, localDate: string): Promise<Awaited<ReturnType<DiaryReadService['readDay']>>> {
  return reads.readDay(userId, localDate);
}

const feedBegin: DeltaCursorState = {
  updatedAt: '1970-01-01T00:00:00.000Z',
  entityId: '00000000-0000-4000-8000-000000000000',
};

function feedSince(userId: string, cursor: DeltaCursorState | null, limit: number): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
  return prisma.transaction((tx) => delta.changesSince(cursor, limit, { userId, deviceId: 'itspec-device' }, tx));
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('s2cdiary');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    Object.assign(process.env, { DATABASE_URL: url.toString() });

    // Seed: synthetic fixture users + one platform catalog food + one user
    // food owned by A (admin INSERTs — seeding only; every assertion below
    // runs through postured paths).
    await db.pool.query(
      `INSERT INTO users (id, email, username, phone, password, status) VALUES
         ($1, 'a.diary@example.com', 'diary_a', '+201111111111', 'seed-only-not-a-real-hash', 'active'),
         ($2, 'b.diary@example.com', 'diary_b', '+201111111112', 'seed-only-not-a-real-hash', 'active'),
         ($3, 'c.diary@example.com', 'diary_c', '+201111111113', 'seed-only-not-a-real-hash', 'active'),
         ($4, 'd.diary@example.com', 'diary_d', '+201111111114', 'seed-only-not-a-real-hash', 'active'),
         ($5, 'e.diary@example.com', 'diary_e', '+201111111115', 'seed-only-not-a-real-hash', 'active')`,
      [USER_A, USER_B, USER_C, USER_D, USER_E],
    );
    await db.pool.query(
      `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_ar, name_en_normalized, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
       VALUES ($1, 'dish', 'kal_reviewed', 'proprietary', 'Ful medames', 'فول مدمس', 'ful medames', 'فول مدمس', ARRAY['foul']::text[], ARRAY['foul']::text[], 110, 7.6, 19.3, 0.5)`,
      [FOOD_F001],
    );
    await db.pool.query(
      `INSERT INTO user_foods (id, user_id, name_en, name_en_normalized, energy_kcal, protein_g, carbs_g, fat_g)
       VALUES ($1, $2, 'Nana own mix', 'nana own mix', 250, 12, 30, 9)`,
      [USER_FOOD_A, USER_A],
    );

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    handler = app.get(DiaryEntryOpHandler);
    delta = app.get(DiaryDeltaProvider);
    reads = app.get(DiaryReadService);
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

// ---------------------------------------------------------------------------

describe('the frozen per-op state machine (§1.3) — happy paths through the seam', () => {
  it('create applies end-to-end: row + rollup + day read agree', async () => {
    const day = uniqueDay();
    const op = diaryOp({ localDate: day }, { localDate: day });
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries).toHaveLength(1);
    const entry = view.entries[0];
    expect(entry?.id).toBe(op.entityId);
    expect(entry?.sourceKind).toBe('platform_food');
    expect(entry?.foodId).toBe(FOOD_F001);
    expect(entry?.quantity).toBe(2);
    expect(entry?.energyKcal).toBe(220);
    expect(view.totals).toEqual({ energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1, entryCount: 1 });
    // The LWW substrate is client-authored: updated_at = clientUpdatedAt.
    expect(entry?.updatedAt).toBe('2026-01-15T20:00:00.000Z');
  });

  it('update ("ate half"-style scale) re-snapshots from the payload — the full snapshot replaces, nothing re-resolves', async () => {
    const day = uniqueDay();
    const create = diaryOp({ localDate: day }, { localDate: day, energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1, quantity: 2 });
    await dispatch(create, USER_A);
    const update = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day },
      { localDate: day, quantity: 1, servingGramWeight: 200, energyKcal: 110, proteinG: 7.6, carbsG: 19.3, fatG: 0.5, status: 'edited' },
    );
    await expect(dispatch(update, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ quantity: 1, energyKcal: 110, proteinG: 7.6, status: 'edited' });
    expect(view.totals).toEqual({ energyKcal: 110, proteinG: 7.6, carbsG: 19.3, fatG: 0.5, entryCount: 1 });
  });

  it('quick-add applies (bare self-snapshot — no food reference, no serving fields) and reads back as quick_add', async () => {
    const day = uniqueDay();
    const op = diaryOp(
      { localDate: day },
      {
        localDate: day,
        mealSlot: 'dinner',
        entryMethod: 'quick_add',
        foodId: undefined,
        userFoodId: undefined,
        servingLabelEn: undefined,
        servingLabelAr: undefined,
        servingGramWeight: undefined,
        quantity: 1,
        energyKcal: 350,
        proteinG: 0,
        carbsG: 0,
        fatG: 12,
        status: 'confirmed',
      },
    );
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]?.sourceKind).toBe('quick_add');
    expect(view.entries[0]?.foodId).toBeNull();
    expect(view.entries[0]?.servingGramWeight).toBeNull();
    expect(view.totals).toEqual({ energyKcal: 350, proteinG: 0, carbsG: 0, fatG: 12, entryCount: 1 });
  });

  it('23:59 log / 00:01 sync stays on the ORIGINAL carried day (server never re-derives, §1.8)', async () => {
    const day = uniqueDay();
    const nextDay = uniqueDay();
    const op = diaryOp(
      { localDate: day, clientUpdatedAt: `${nextDay}T00:01:00Z` }, // synced after Cairo midnight
      { localDate: day },
    );
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const carriedDay = await readDay(USER_A, day);
    expect(carriedDay.entries.map((entry) => entry.id)).toContain(op.entityId);
    const dayAfter = await readDay(USER_A, nextDay);
    expect(dayAfter.entries.map((entry) => entry.id)).not.toContain(op.entityId);
  });

  it('delete tombstones: deleted_at server-side, updated_at client-authored, rollup drops the entry', async () => {
    const day = uniqueDay();
    const create = diaryOp({ localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const del = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T22:30:00Z',
      payload: undefined,
      localDate: day,
    });
    await expect(dispatch(del, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries.map((entry) => entry.id)).not.toContain(create.entityId);
    expect(view.totals.entryCount).toBe(0);
    // The tombstone itself is visible in the raw table with the frozen shape.
    const rows = await db.pool.query<{ deleted_at: string | null; updated_at: Date; last_op_id: string }>(
      `SELECT deleted_at, updated_at, last_op_id FROM diary_entries WHERE id = $1`,
      [create.entityId],
    );
    expect(rows.rows[0]?.deleted_at).not.toBeNull();
    expect(new Date(rows.rows[0]!.updated_at).toISOString()).toBe('2026-01-15T22:30:00.000Z');
    expect(rows.rows[0]?.last_op_id).toBe(del.opId);
  });
});

describe('LWW + tombstones (§1.4/§1.5, I9)', () => {
  it('a stale update is acked applied and changes NOTHING (the delta feed is the convergence channel)', async () => {
    const day = uniqueDay();
    const create = diaryOp({ clientUpdatedAt: '2026-01-15T20:00:00Z', localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const newer = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day },
      { localDate: day, energyKcal: 300 },
    );
    await expect(dispatch(newer, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const stale = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T20:30:00Z', localDate: day },
      { localDate: day, energyKcal: 999 },
    );
    await expect(dispatch(stale, USER_A)).resolves.toEqual({ outcome: 'applied' }); // recorded applied, no change
    const view = await readDay(USER_A, day);
    expect(view.entries[0]?.energyKcal).toBe(300); // the winner's snapshot stands
  });

  it('equal timestamps: the HIGHER opId wins (frozen deterministic tiebreak — no third state)', async () => {
    const day = uniqueDay();
    const create = diaryOp({ clientUpdatedAt: '2026-01-15T20:00:00Z', localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const lowerOpId = '00000000-0000-4000-8000-000000000001';
    const higherOpId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const winner = diaryOp(
      { entityId: create.entityId, action: 'update', opId: higherOpId, clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day },
      { localDate: day, energyKcal: 500 },
    );
    const loser = diaryOp(
      { entityId: create.entityId, action: 'update', opId: lowerOpId, clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day },
      { localDate: day, energyKcal: 111 },
    );
    await expect(dispatch(winner, USER_A)).resolves.toEqual({ outcome: 'applied' });
    await expect(dispatch(loser, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries[0]?.energyKcal).toBe(500);
    expect(view.entries[0]?.updatedAt).toBe('2026-01-15T21:00:00.000Z');
  });

  it('delete-then-stale-update: the tombstone WINS over stale ops — and even a newer update never undeletes', async () => {
    const day = uniqueDay();
    const create = diaryOp({ clientUpdatedAt: '2026-01-15T20:00:00Z', localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const del = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T20:10:00Z',
      payload: undefined,
      localDate: day,
    });
    await dispatch(del, USER_A);
    const staleUpdate = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T20:05:00Z', localDate: day },
      { localDate: day, energyKcal: 42 },
    );
    await expect(dispatch(staleUpdate, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const newerUpdate = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T23:00:00Z', localDate: day },
      { localDate: day, energyKcal: 42 },
    );
    await expect(dispatch(newerUpdate, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const rows = await db.pool.query<{ deleted_at: string | null }>(`SELECT deleted_at FROM diary_entries WHERE id = $1`, [create.entityId]);
    expect(rows.rows[0]?.deleted_at).not.toBeNull();
  });

  it('create-after-delete on the SAME entity id is blocked — no resurrection (I9); a FRESH id is a new entry', async () => {
    const day = uniqueDay();
    const create = diaryOp({ localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const del = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T20:10:00Z',
      payload: undefined,
      localDate: day,
    });
    await dispatch(del, USER_A);
    const resurrect = diaryOp({ entityId: create.entityId, opId: opId(), clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day }, { localDate: day, energyKcal: 777 });
    await expect(dispatch(resurrect, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const rows = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries WHERE id = $1`, [create.entityId]);
    expect(rows.rows[0]?.count).toBe('1'); // still exactly the tombstone — never a second row
    const fresh = diaryOp({ opId: opId(), clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: day }, { localDate: day, energyKcal: 777 });
    await expect(dispatch(fresh, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await readDay(USER_A, day);
    expect(view.entries.map((entry) => entry.id)).toContain(fresh.entityId);
  });

  it('create on an ACTIVE entity → rejected_conflict; update on a missing entity → rejected_conflict', async () => {
    const day = uniqueDay();
    const create = diaryOp({ localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const duplicateCreate = diaryOp({ entityId: create.entityId, opId: opId(), localDate: day }, { localDate: day, energyKcal: 1 });
    await expect(dispatch(duplicateCreate, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    const updateMissing = diaryOp({ action: 'update', opId: opId(), localDate: day }, { localDate: day });
    await expect(dispatch(updateMissing, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });

  it('delete is idempotent: on a missing entity and on an existing tombstone it is applied and writes NOTHING', async () => {
    const day = uniqueDay();
    const delMissing = diaryOp({ action: 'delete', opId: opId(), payload: undefined, entityId: entityId(), localDate: day });
    await expect(dispatch(delMissing, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const create = diaryOp({ localDate: day }, { localDate: day });
    await dispatch(create, USER_A);
    const del = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T20:10:00Z',
      payload: undefined,
      localDate: day,
    });
    await dispatch(del, USER_A);
    const firstTombstone = await db.pool.query<{ deleted_at: Date }>(`SELECT deleted_at FROM diary_entries WHERE id = $1`, [create.entityId]);
    const delAgain = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T23:00:00Z',
      payload: undefined,
      localDate: day,
    });
    await expect(dispatch(delAgain, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const secondTombstone = await db.pool.query<{ deleted_at: Date; updated_at: Date }>(`SELECT deleted_at, updated_at FROM diary_entries WHERE id = $1`, [
      create.entityId,
    ]);
    expect(secondTombstone.rows[0]?.deleted_at).toEqual(firstTombstone.rows[0]?.deleted_at); // nothing rewritten
    expect(new Date(secondTombstone.rows[0]!.updated_at).toISOString()).toBe('2026-01-15T20:10:00.000Z'); // the WINNING delete's substrate stands
  });

  it('batch-retry determinism at the state machine: replaying ops in fresh transactions converges to the same state', async () => {
    const day = uniqueDay();
    const create = diaryOp({ localDate: day }, { localDate: day, energyKcal: 220 });
    const update = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T20:05:00Z', localDate: day },
      { localDate: day, energyKcal: 240 },
    );
    const del = diaryOp({
      entityId: create.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T20:06:00Z',
      payload: undefined,
      localDate: day,
    });
    // The "batch", then the client's identical retry (sync's (user, opId)
    // dedupe acks replays without re-running the handler; even if a retry
    // DID re-run the machine, the outcome set is deterministic):
    for (const batch of [
      [create, update, del],
      [create, update, del],
    ] as const) {
      for (const op of batch) {
        await dispatch(op, USER_A);
      }
    }
    const rows = await db.pool.query<{ count: string; energy: string }>(
      `SELECT count(*)::text AS count, max(energy_kcal)::text AS energy FROM diary_entries WHERE id = $1`,
      [create.entityId],
    );
    expect(rows.rows[0]?.count).toBe('1'); // exactly one row ever
    expect(rows.rows[0]?.energy).toBe('240.00'); // the winning update's frozen snapshot
    const view = await readDay(USER_A, day);
    expect(view.entries.map((entry) => entry.id)).not.toContain(create.entityId); // the delete stands
    expect(view.totals.entryCount).toBe(0);
  });
});

describe('per-op validation outcomes precede the state machine (§1.3)', () => {
  it('malformed payloads/dates/ids are rejected_validation — retryable false, nothing written', async () => {
    const before = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries`);
    const cases: SyncOpEnvelope[] = [
      diaryOp({ payload: diaryPayload({ mealSlot: 'suhoor' }) }), // unknown meal slot (HD-17: Ramadan slots deferred)
      diaryOp({ payload: diaryPayload({ energyKcal: -5 }) }), // negative macro
      diaryOp({ payload: diaryPayload({ foodId: undefined, userFoodId: undefined }) }), // source XOR violated
      diaryOp({ localDate: '15-01-2026' }), // bad carried date shape
      diaryOp({ entityId: 'not-a-uuid' }),
      diaryOp({ clientUpdatedAt: '2026-01-15 20:00:00' }), // not an ISO UTC instant
      diaryOp({ payload: diaryPayload({ localDate: '2026-01-16' }) }), // payload/envelope date mismatch
    ];
    for (const [index, op] of cases.entries()) {
      await expect(dispatch(op, USER_A), `case #${index} rejected_validation`).resolves.toEqual({
        outcome: 'rejected',
        code: 'rejected_validation',
        retryable: false,
      });
    }
    const after = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count); // zero writes from rejections
  });

  it('an unresolvable platform food reference is rejected_validation (never a raw FK batch abort)', async () => {
    const op = diaryOp({}, { foodId: '00000000-0000-4000-8000-00000000ffff' });
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
  });

  it('a delete carrying a payload or a bad localDate is rejected_validation (envelope parity)', async () => {
    const withPayload = diaryOp({ action: 'delete', payload: diaryPayload() });
    await expect(dispatch(withPayload, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    const badDate = diaryOp({ action: 'delete', payload: undefined, localDate: '2026-1-15' });
    await expect(dispatch(badDate, USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
  });

  it('the handler refuses a transaction whose user context does not match the op (I6, fail-closed throw)', async () => {
    const day = uniqueDay();
    const op = diaryOp({ localDate: day }, { localDate: day });
    await expect(dispatchWithMismatchedPosture(op, USER_A, USER_B)).rejects.toThrow(/fail-closed/iu);
    await expect(dispatchWithMismatchedPosture(op, USER_A, null)).rejects.toThrow(/fail-closed/iu);
    const rows = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries WHERE id = $1`, [op.entityId]);
    expect(rows.rows[0]?.count).toBe('0'); // nothing was written by the refused applies
  });
});

describe('I11 — frozen nutrient snapshots (the criterion-5 test)', () => {
  it('a later food correction NEVER rewrites a historical entry; edits re-snapshot only from the payload', async () => {
    const day = uniqueDay();
    // Log from the platform food (frozen at log time).
    const create = diaryOp({ localDate: day }, { localDate: day, quantity: 2, servingGramWeight: 200, energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1 });
    await dispatch(create, USER_A);
    const before = await readDay(USER_A, day);
    expect(before.entries[0]?.energyKcal).toBe(220);

    // The catalog is CORRECTED (the in-house verification flow, HD-12).
    await db.pool.query(`UPDATE foods SET energy_kcal = 150, protein_g = 9.9, carbs_g = 25, fat_g = 3 WHERE id = $1`, [FOOD_F001]);

    // The historical entry is UNCHANGED — totals included.
    const after = await readDay(USER_A, day);
    expect(after.entries[0]?.energyKcal).toBe(220);
    expect(after.entries[0]?.proteinG).toBe(15.2);
    expect(after.totals).toEqual(before.totals);

    // A no-op edit (same snapshot) re-freezes the SAME values — never the food's new ones.
    const edit = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T21:30:00Z', localDate: day },
      { localDate: day, quantity: 2, servingGramWeight: 200, energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1, status: 'edited' },
    );
    await dispatch(edit, USER_A);
    const afterEdit = await readDay(USER_A, day);
    expect(afterEdit.entries[0]?.energyKcal).toBe(220);

    // A scale edit re-snapshots from the op payload (client-computed halves) — NOT from the catalog.
    const scale = diaryOp(
      { entityId: create.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T21:45:00Z', localDate: day },
      { localDate: day, quantity: 1, servingGramWeight: 200, energyKcal: 110, proteinG: 7.6, carbsG: 19.3, fatG: 0.5, status: 'edited' },
    );
    await dispatch(scale, USER_A);
    const afterScale = await readDay(USER_A, day);
    expect(afterScale.entries[0]?.energyKcal).toBe(110); // the payload's frozen value…
    expect(afterScale.entries[0]?.energyKcal).not.toBe(75); // …not a re-resolution from the corrected food (150 per 100 g × ½)
  });
});

describe('diary-day rollups recomputed transactionally on apply', () => {
  it('multi-entry days: creates, updates, deletes and day-moves keep every bucket exact', async () => {
    const day = uniqueDay();
    const nextDay = uniqueDay();
    const breakfast = diaryOp({ localDate: day }, { localDate: day, mealSlot: 'breakfast', energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1 });
    const lunch = diaryOp({ localDate: day }, { localDate: day, mealSlot: 'lunch', energyKcal: 340, proteinG: 20, carbsG: 40, fatG: 10 });
    const dinnerDay2 = diaryOp({ localDate: nextDay }, { localDate: nextDay, mealSlot: 'dinner', energyKcal: 500, proteinG: 30, carbsG: 50, fatG: 15 });
    await dispatch(breakfast, USER_A);
    await dispatch(lunch, USER_A);
    await dispatch(dinnerDay2, USER_A);
    const day1 = await readDay(USER_A, day);
    expect(day1.totals).toEqual({ energyKcal: 560, proteinG: 35.2, carbsG: 78.6, fatG: 11, entryCount: 2 });

    // Update moves lunch to nextDay — both buckets recompute.
    const move = diaryOp(
      { entityId: lunch.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-01-15T21:00:00Z', localDate: nextDay },
      { localDate: nextDay, mealSlot: 'lunch', energyKcal: 340, proteinG: 20, carbsG: 40, fatG: 10 },
    );
    await expect(dispatch(move, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const day1AfterMove = await readDay(USER_A, day);
    expect(day1AfterMove.totals).toEqual({ energyKcal: 220, proteinG: 15.2, carbsG: 38.6, fatG: 1, entryCount: 1 });
    const day2AfterMove = await readDay(USER_A, nextDay);
    expect(day2AfterMove.totals).toEqual({ energyKcal: 840, proteinG: 50, carbsG: 90, fatG: 25, entryCount: 2 });

    // Delete from nextDay recomputes that bucket only.
    const del = diaryOp({
      entityId: dinnerDay2.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-16T10:00:00Z',
      payload: undefined,
      localDate: nextDay,
    });
    await dispatch(del, USER_A);
    const day2AfterDelete = await readDay(USER_A, nextDay);
    expect(day2AfterDelete.totals).toEqual({ energyKcal: 340, proteinG: 20, carbsG: 40, fatG: 10, entryCount: 1 });
  });

  it('a day emptied by deletions rolls up to zeros (rollups read non-deleted entries only, §1.5)', async () => {
    const day = uniqueDay();
    const solo = diaryOp({ localDate: day }, { localDate: day, energyKcal: 90 });
    await dispatch(solo, USER_A);
    const del = diaryOp({
      entityId: solo.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-01-15T23:50:00Z',
      payload: undefined,
      localDate: day,
    });
    await dispatch(del, USER_A);
    const view = await readDay(USER_A, day);
    expect(view.totals).toEqual({ energyKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entryCount: 0 });
    expect(view.entries).toEqual([]);
  });
});

describe('delta provider (§1.6) — a keyset over the user\u2019s rows, deterministic order, tombstone propagation', () => {
  it('emits deterministic (updatedAt, entityId)-ordered changes with full-snapshot upserts and payload-free tombstones', async () => {
    const userId = USER_D;
    const e1 = diaryOp({ clientUpdatedAt: '2026-03-01T10:00:00Z', localDate: '2026-03-01' }, { localDate: '2026-03-01', energyKcal: 100 });
    const e2 = diaryOp({ clientUpdatedAt: '2026-03-01T09:00:00Z', localDate: '2026-03-01' }, { localDate: '2026-03-01', energyKcal: 200 });
    const e3 = diaryOp({ clientUpdatedAt: '2026-03-01T10:00:00Z', localDate: '2026-03-01' }, { localDate: '2026-03-01', energyKcal: 300 });
    await dispatch(e2, userId);
    await dispatch(e1, userId);
    await dispatch(e3, userId);
    await dispatch(
      diaryOp({ entityId: e2.entityId, action: 'delete', opId: opId(), clientUpdatedAt: '2026-03-01T11:00:00Z', payload: undefined, localDate: '2026-03-01' }),
      userId,
    );

    // The feed reflects CURRENT row state, not a change log: e2 appears once,
    // as its tombstone (sorted at the winning delete's clientUpdatedAt).
    const page = await feedSince(userId, null, 50); // first pull — the feed starts at its beginning
    expect(page.changes).toHaveLength(3);
    const byId = new Map(page.changes.map((change) => [change.entityId, change]));
    const tombstone = byId.get(e2.entityId);
    expect(tombstone?.change).toBe('delete');
    expect(tombstone?.payload).toBeUndefined();
    expect(tombstone?.updatedAt).toBe('2026-03-01T11:00:00.000Z');
    for (const upsertTarget of [e1, e3]) {
      const change = byId.get(upsertTarget.entityId);
      expect(change?.change).toBe('upsert');
      expect(change?.payload).toMatchObject({ localDate: '2026-03-01', energyKcal: expect.any(Number), mealSlot: 'breakfast', status: 'confirmed' });
    }
    expect(byId.get(e1.entityId)?.payload).toMatchObject({ energyKcal: 100 });
    expect(byId.get(e3.entityId)?.payload).toMatchObject({ energyKcal: 300 });
    // Deterministic ascending order over the whole page.
    for (let index = 1; index < page.changes.length; index += 1) {
      const previous = page.changes[index - 1]!;
      const current = page.changes[index]!;
      const [prevMs, currMs] = [new Date(previous.updatedAt).getTime(), new Date(current.updatedAt).getTime()];
      expect(currMs).toBeGreaterThanOrEqual(prevMs);
      if (currMs === prevMs) {
        expect(current.entityId > previous.entityId).toBe(true); // id tiebreak ascending
      }
    }
    // The two 10:00 upserts precede the 11:00 tombstone.
    const tombstoneIndex = page.changes.findIndex((change) => change.entityId === e2.entityId);
    expect(tombstoneIndex).toBe(2);
    expect(page.exhausted).toBe(true);
  });

  it('paginates strictly after the cursor state and honours the limit (exhausted flag exact)', async () => {
    const userId = USER_E;
    const entries: SyncOpEnvelope[] = [];
    for (let index = 0; index < 5; index += 1) {
      const op = diaryOp(
        { clientUpdatedAt: `2026-03-02T0${index}:00:00Z`, localDate: '2026-03-02' },
        { localDate: '2026-03-02', energyKcal: 100 + index },
      );
      await dispatch(op, userId);
      entries.push(op);
    }
    const sorted = [...entries].sort((a, b) => a.clientUpdatedAt.localeCompare(b.clientUpdatedAt));
    const page1 = await feedSince(userId, null, 3);
    expect(page1.changes.map((change) => change.entityId)).toEqual(sorted.slice(0, 3).map((op) => op.entityId));
    expect(page1.exhausted).toBe(false);
    const last = page1.changes[page1.changes.length - 1]!;
    const page2 = await feedSince(userId, { updatedAt: last.updatedAt, entityId: last.entityId }, 3);
    expect(page2.changes.map((change) => change.entityId)).toEqual(sorted.slice(3).map((op) => op.entityId));
    expect(page2.exhausted).toBe(true);
    // A page after the final position is EMPTY and renders like any page.
    const last2 = page2.changes[page2.changes.length - 1]!;
    const page3 = await feedSince(userId, { updatedAt: last2.updatedAt, entityId: last2.entityId }, 3);
    expect(page3.changes).toEqual([]);
    expect(page3.exhausted).toBe(true);
  });

  it('the per-kind cursor state resumes strictly after its own position (global kind-merge is sync\u2019s assembly)', async () => {
    const userId = USER_D;
    const atX = diaryOp({ clientUpdatedAt: '2026-03-03T08:00:00Z', localDate: '2026-03-03' }, { localDate: '2026-03-03' });
    await dispatch(atX, userId);
    // The canonical cursor state is PER KIND ({updatedAt, entityId}): a
    // cursor parked on this kind's own row resumes strictly after it — the
    // feed never re-emits the parked row. (The cross-kind merge of the three
    // providers' pages into the global (updatedAt, kind, entityId) order is
    // sync's assembly concern, not the provider's.)
    const parkedOnSelf: DeltaCursorState = { updatedAt: '2026-03-03T08:00:00Z', entityId: atX.entityId };
    const afterSelf = await feedSince(userId, parkedOnSelf, 50);
    expect(afterSelf.changes.map((change) => change.entityId)).not.toContain(atX.entityId);
    // A cursor parked at the same instant on an earlier entity id: the row
    // at X sorts after it (id tiebreak) → emitted.
    const parkedEarlierSameInstant: DeltaCursorState = { updatedAt: '2026-03-03T08:00:00Z', entityId: '00000000-0000-4000-8000-000000000000' };
    const afterEarlier = await feedSince(userId, parkedEarlierSameInstant, 50);
    expect(afterEarlier.changes.map((change) => change.entityId)).toContain(atX.entityId);
    // The first pull (null cursor) and a begin-of-feed positioned cursor are
    // the same deterministic page.
    const firstPull = await feedSince(userId, null, 50);
    expect(firstPull).toEqual(await feedSince(userId, feedBegin, 50));
  });

  it('a malformed cursor state or limit is a refused seam violation (sync owns verification — fail closed)', async () => {
    const badCursor: DeltaCursorState = { updatedAt: 'not-an-instant', entityId: 'x' };
    await expect(feedSince(USER_D, badCursor, 10)).rejects.toThrow(RangeError);
    const goodCursor: DeltaCursorState = {
      updatedAt: '2026-03-03T08:00:00Z',
      entityId: '00000000-0000-4000-8000-000000000000',
    };
    await expect(feedSince(USER_D, goodCursor, 0)).rejects.toThrow(RangeError);
  });
});

describe('A/B/C — B can never read or mutate A\u2019s diary through the handler, the feed, or raw SQL', () => {
  let aEntry: SyncOpEnvelope;

  beforeAll(() => {
    return (async () => {
      const day = uniqueDay();
      aEntry = diaryOp({ clientUpdatedAt: '2026-04-01T10:00:00Z', localDate: day }, { localDate: day, energyKcal: 460 });
      await dispatch(aEntry, USER_A);
    })();
  });

  it('B\u2019s update of A\u2019s entity id → rejected_conflict, byte-identical to an absent id (no oracle)', async () => {
    const againstA = diaryOp({ entityId: aEntry.entityId, action: 'update', opId: opId(), clientUpdatedAt: '2026-04-01T11:00:00Z' }, { energyKcal: 1 });
    const againstNothing = diaryOp({ action: 'update', opId: opId(), clientUpdatedAt: '2026-04-01T11:00:00Z' }, { energyKcal: 1 });
    const outcomeA = await dispatch(againstA, USER_B);
    const outcomeNothing = await dispatch(againstNothing, USER_B);
    expect(outcomeA).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    expect(JSON.stringify(outcomeA)).toBe(JSON.stringify(outcomeNothing));
  });

  it('B\u2019s delete of A\u2019s entity id → the idempotent applied, and A\u2019s row is UNTOUCHED', async () => {
    const delAgainstA = diaryOp({
      entityId: aEntry.entityId,
      action: 'delete',
      opId: opId(),
      clientUpdatedAt: '2026-04-01T11:00:00Z',
      payload: undefined,
    });
    const delAgainstNothing = diaryOp({ action: 'delete', opId: opId(), clientUpdatedAt: '2026-04-01T11:00:00Z', payload: undefined });
    const outcomeA = await dispatch(delAgainstA, USER_B);
    const outcomeNothing = await dispatch(delAgainstNothing, USER_B);
    expect(outcomeA).toEqual({ outcome: 'applied' });
    expect(JSON.stringify(outcomeA)).toBe(JSON.stringify(outcomeNothing));
    const rows = await db.pool.query<{ deleted_at: string | null }>(`SELECT deleted_at FROM diary_entries WHERE id = $1 AND user_id = $2`, [
      aEntry.entityId,
      USER_A,
    ]);
    expect(rows.rows[0]?.deleted_at).toBeNull(); // A's entry lives
  });

  it('B\u2019s create referencing A\u2019s user food → rejected_validation, byte-identical to a garbage id (I3/I7; C control)', async () => {
    const againstA = diaryOp({}, { foodId: undefined, userFoodId: USER_FOOD_A, entryMethod: 'favorites' });
    const againstGarbage = diaryOp({}, { foodId: undefined, userFoodId: '99999999-9999-4999-8999-999999999999', entryMethod: 'favorites' });
    const outcomeB = await dispatch(againstA, USER_B);
    const outcomeGarbage = await dispatch(againstGarbage, USER_B);
    expect(outcomeB).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(JSON.stringify(outcomeB)).toBe(JSON.stringify(outcomeGarbage));
    // Control (C): the same foreign reference attempt is equally rejected — parity across contexts.
    const outcomeC = await dispatch(againstA, USER_C);
    expect(JSON.stringify(outcomeC)).toBe(JSON.stringify(outcomeB));
    // The owner CAN reference their own user food.
    const ownUse = diaryOp({}, { foodId: undefined, userFoodId: USER_FOOD_A, entryMethod: 'favorites' });
    await expect(dispatch(ownUse, USER_A)).resolves.toEqual({ outcome: 'applied' });
  });

  it('B\u2019s day read (service) on A\u2019s date is byte-identical to a truly empty day; the feed yields nothing', async () => {
    const bDay = await readDay(USER_B, '2026-04-01');
    const emptyControl = await readDay(USER_C, '2026-04-01'); // same date, a context with no entries that day
    expect(JSON.stringify(bDay)).toBe(JSON.stringify(emptyControl));
    expect(bDay.entries).toEqual([]);
    const feed = await feedSince(USER_B, null, 50);
    expect(feed.changes).toEqual([]); // B's feed never carries A's rows
  });

  it('raw RLS row-count negatives (the database backstop): B\u2019s context sees zero A rows; attacks affect nothing', async () => {
    await asUser(db, USER_B, async (q) => {
      const visible = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries WHERE user_id = $1`, [USER_A]);
      expect(visible.rows[0]?.count).toBe('0');
      const anyVisible = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries`);
      expect(Number(anyVisible.rows[0]?.count)).toBe(0);
      const update = await q<{ count: string }>(`UPDATE diary_entries SET energy_kcal = 1 WHERE id = $1`, [aEntry.entityId]);
      expect(update.rowCount).toBe(0); // RLS hides A's row: the UPDATE touches nothing (no error raised)
    });
    // Expected-error probes run in their OWN transactions (an error aborts
    // its transaction — the harness discipline).
    await asUser(db, USER_B, async (q) => {
      // DELETE has NO grant for kal_app (tombstones only, by design) — the
      // database itself refuses with 42501 before any row-level question.
      const deleteError = await capturePgError(async () => {
        await q(`DELETE FROM diary_entries WHERE id = $1`, [aEntry.entityId]);
      });
      expect(deleteError?.code).toBe('42501');
    });
    await asUser(db, USER_B, async (q) => {
      // Cross-account INSERT is blocked by the WITH CHECK clause — the
      // forged-rollup attack does NOT land.
      const forgedRollup = await capturePgError(async () => {
        await q(`INSERT INTO diary_days (user_id, local_date, energy_kcal, protein_g, carbs_g, fat_g, entry_count) VALUES ($1, '2026-04-01', 1, 0, 0, 0, 1)`, [USER_A]);
      });
      expect(forgedRollup).toBeDefined();
    });
    await asUser(db, USER_B, async (q) => {
      // …while B's OWN rollup row for the same date is legitimate (control).
      const ownRollup = await q<{ count: string }>(
        `INSERT INTO diary_days (user_id, local_date, energy_kcal, protein_g, carbs_g, fat_g, entry_count) VALUES ($1, '2026-04-01', 1, 0, 0, 0, 1)`,
        [USER_B],
      );
      expect(ownRollup.rowCount).toBe(1);
    });
    await asUser(db, USER_A, async (q) => {
      const own = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries WHERE user_id = $1`, [USER_A]);
      expect(Number(own.rows[0]?.count)).toBeGreaterThan(0); // A still sees exactly A's rows
    });
  });
});

describe('day-read service validation', () => {
  it('a malformed localDate is the generic VALIDATION_FAILED problem (value-free, byte-stable)', async () => {
    for (const bad of ['2026-1-15', 'not-a-date', '2026-02-30', '2026-01-15T00:00:00Z', 15, null, undefined]) {
      await expect(reads.readDay(USER_A, bad)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    const caught: unknown = await reads.readDay(USER_A, '2026-02-30').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KalProblemException);
  });

  it('an absent day is an EMPTY 200-shaped view (zeros, no entries — never a 404)', async () => {
    const view = await readDay(USER_A, '2026-06-01');
    expect(view).toEqual({ localDate: '2026-06-01', totals: { energyKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entryCount: 0 }, entries: [] });
  });
});
