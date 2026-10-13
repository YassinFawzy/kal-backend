/**
 * Kal — journal ROUTINES + PRs + RECENTS domain integration suite (wave-04,
 * lane s2c).
 *
 * The real AppModule against its own ephemeral `kal_it_*` database (harness
 * pattern): the `journal_routine` sync op apply-handler, the routine delta
 * provider, the routine read service, the derived-never-stored PR read
 * model, and the recents inputs service are exercised through the FROZEN §4
 * seam — a dispatch test double replicates exactly what sync ingestion does
 * at the batch level (one transaction per batch, `SET LOCAL ROLE kal_app` +
 * `app.user_id` + `TimeZone UTC`) and calls the REAL handler logic. The
 * HTTP surfaces (the PR read; post-rebase, the real ingestion path) are
 * pinned by `test/pr.e2e-spec.ts`; this suite pins the DOMAIN semantics:
 *
 *   - The frozen per-op state machine (w3 §1.3 inherited verbatim):
 *     create/update/delete outcomes, LWW with the deterministic tiebreak
 *     (§1.4), tombstones win over stale ops, no resurrection (same-ID
 *     create-after-delete blocked), idempotent deletes.
 *   - Validation (w4 §1.1): exact payload bounds per-op
 *     `rejected_validation`; unknown/nonexistent `exerciseId`.
 *   - Name snapshots (w4 §1.1): server-derived at apply; later catalog
 *     edits never rewrite a template; an applying edit re-freezes at THAT
 *     apply and REPLACES the child tree (the W3 serving-set pattern —
 *     superseded children soft-delete).
 *   - Delta feed (w4 §1.4 / w3 §1.6): keyset over the user's OWN rows;
 *     full-snapshot upserts (server child ids + frozen snapshots);
 *     tombstones propagate once as payload-free `delete`; strict
 *     continuation; exhausted polarity; foreign context ⇒ empty feed (I7).
 *   - PR derivation (w4 §1.3): the frozen Epley read model over applied
 *     session rows — mixed-format sessions contribute weighted sets only;
 *     equal estimates keep the FIRST achievement (earlier date wins);
 *     deleted sessions/entries/sets never contribute; re-derivation is
 *     idempotent; owning-user-only (I7 — B's reads are C-like empty while
 *     A holds PRs); 404 parity for malformed ≡ absent catalog ids.
 *   - Recents inputs (w4 §9 posture): distinct newest-first exercises from
 *     the user's own sessions; deleted sessions never contribute.
 *   - A/B/C negatives: B can neither read nor mutate A's rows through the
 *     handler, the delta feed, the read services, or raw SQL under RLS —
 *     denials are the generic shapes, byte-stable whether or not A's object
 *     exists (no existence oracles); C is the control.
 *
 * Seeding uses direct admin INSERTs for synthetic fixture users and two
 * platform catalog exercises (synthetic UUIDs outside the seed manifest's
 * reserved range); EVERY behavioral assertion runs through sanctioned
 * postured paths (the harness discipline: superuser authority proves
 * nothing). NOTE: `journal_session` ops are lane s2a's surface — sessions
 * here are seeded directly (as applied rows) so the PR/recents read models
 * are pinned against real applied-session shapes; the post-rebase union
 * suite drives sessions through the real ingestion path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { PrService } from '../../src/journal/prs/pr.service.js';import { RecentsService } from '../../src/journal/recents/recents.service.js';
import { RoutineDeltaProviderService } from '../../src/journal/routines/routine-delta.provider.js';
import { RoutineOpHandler } from '../../src/journal/routines/routine-apply.handler.js';
import { RoutineReadService } from '../../src/journal/routines/routine-read.service.js';
import type {
  DeltaChange,
  DeltaCursorState,
  SyncOpEnvelope,
  SyncOpHandlerResult,
} from '../../src/tracking/sync-seams.js';
import type { ProjectedRoutineExercise, RoutineProjection } from '../../src/journal/routines/routine-payload.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { asUser } from './helpers/acting-user.js';

/** Synthetic fixture users (no relationship to any real identity). */
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
/** Dedicated delta-feed context — its feed assertions assert EXACT page arrays. */
const USER_D = '44444444-4444-4444-8444-444444444444';

/** Synthetic platform catalog rows (OUTSIDE the seed manifest's reserved …f2nn range). */
const EX_SQUAT = '00000000-0000-4000-8000-00000000f901';
const EX_PRESS = '00000000-0000-4000-8000-00000000f902';

/** Sequential unique op/entity ids so cases never share entities (8-4-4-4-12 UUID shape). */
let opSeq = 0;
const nextId = (prefix: string): string => `${prefix}0000-0000-4000-8000-${String(++opSeq).padStart(12, '0')}`;
const opId = (): string => nextId('a2c1');
const routineId = (): string => nextId('b2c1');

const T0 = '2026-10-12T09:00:00Z';
const T1 = '2026-10-12T09:05:00Z';
const T2 = '2026-10-12T09:10:00Z';

function routinePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Push day',
    exercises: [
      {
        exerciseId: EX_SQUAT,
        position: 0,
        sets: [
          { format: 'weighted', weightKg: 60, reps: 8 },
          { format: 'timed', durationSeconds: 45 },
          { format: 'notes', text: 'tempo 3-1-1' },
        ],
      },
    ],
    ...overrides,
  };
}

function routineOp(overrides: Record<string, unknown> = {}, payloadOverrides: Record<string, unknown> = {}): SyncOpEnvelope {
  return {
    opId: opId(),
    kind: 'journal_routine',
    action: 'create',
    entityId: routineId(),
    clientUpdatedAt: T0,
    payload: routinePayload(payloadOverrides),
    ...overrides,
  } as SyncOpEnvelope;
}

/** Deletes carry NO payload (envelope parity §1.1/§1.2 — the handler re-checks defensively). */
function deleteOp(entityId: string, clientUpdatedAt: string): SyncOpEnvelope {
  return { opId: opId(), kind: 'journal_routine', action: 'delete', entityId, clientUpdatedAt } as SyncOpEnvelope;
}

/**
 * The seam dispatch test double: exactly the batch posture sync ingestion
 * owns (one transaction per batch; per-transaction role + user GUC + UTC —
 * F1), calling the REAL handler. Sync's own concerns (envelope batch
 * validation, dedupe on (user, op id), ack assembly) are sync's and are not
 * replicated here.
 */
async function dispatch(op: SyncOpEnvelope, userId: string): Promise<SyncOpHandlerResult> {
  return prisma.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userId}::text, true), set_config('TimeZone', 'UTC', true)`;
    try {
      return await handler.apply(op, { userId, deviceId: 'itspec-device' }, tx);
    } catch (error) {
      const probe = await tx.$queryRaw<{ currentRole: string; gucUser: string | null }[]>`SELECT current_user AS "currentRole", current_setting('app.user_id', true) AS "gucUser"`;
      console.log('DEBUG-dispatch probe on failure:', JSON.stringify(probe[0]), 'expected userId:', userId);
      throw error;
    }
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

const feedBegin: DeltaCursorState = {
  updatedAt: '1970-01-01T00:00:00.000Z',
  entityId: '00000000-0000-4000-8000-000000000000',
};

function feedSince(userId: string, cursor: DeltaCursorState | null, limit: number): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
  return prisma.transaction((tx) => delta.changesSince(cursor, limit, { userId, deviceId: 'itspec-device' }, tx));
}

/** Direct admin seeding of one APPLIED session (lane s2a owns the op surface; the read models consume applied rows). */
interface SeedSet {
  readonly setId: string;
  readonly position: number;
  readonly format: 'weighted' | 'timed' | 'notes';
  readonly weightKg?: number;
  readonly reps?: number;
  readonly durationSeconds?: number;
  readonly text?: string;
}
interface SeedEntry {
  readonly entryId: string;
  readonly exerciseId: string;
  readonly position: number;
  readonly sets: readonly SeedSet[];
  readonly deleted?: boolean;
}
async function seedSession(
  userId: string,
  sessionId: string,
  localDate: string,
  entries: readonly SeedEntry[],
  options: { readonly deleted?: boolean; readonly updatedAt?: string } = {},
): Promise<void> {
  await db.pool.query(
    `INSERT INTO journal_sessions (id, user_id, local_date, title, updated_at, deleted_at)
     VALUES ($1, $2, $3, NULL, $4::timestamptz, $5::timestamptz)`,
    [sessionId, userId, localDate, options.updatedAt ?? `${localDate}T20:00:00Z`, options.deleted === true ? `${localDate}T23:00:00Z` : null],
  );
  for (const entry of entries) {
    await db.pool.query(
      `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, position, name_snapshot_en, name_snapshot_ar, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [entry.entryId, sessionId, userId, entry.exerciseId, entry.position, 'Seed Squat', 'سكوات تجريبي', entry.deleted === true ? `${localDate}T22:00:00Z` : null],
    );
    for (const set of entry.sets) {
      await db.pool.query(
        `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps, duration_seconds, notes_text, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
        [
          set.setId,
          entry.entryId,
          userId,
          set.position,
          set.format,
          set.weightKg ?? null,
          set.reps ?? null,
          set.durationSeconds ?? null,
          set.text ?? null,
          null,
        ],
      );
    }
  }
}

let app: INestApplication;
let db: EphemeralKalDb;
let prisma: PrismaService;
let handler: RoutineOpHandler;
let delta: RoutineDeltaProviderService;
let reads: RoutineReadService;
let prs: PrService;
let recents: RecentsService;

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('s2cjournal');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    Object.assign(process.env, { DATABASE_URL: url.toString() });

    // Seed: synthetic fixture users + two platform catalog exercises
    // (admin INSERTs — seeding only; every assertion below runs through
    // postured paths).
    await db.pool.query(
      `INSERT INTO users (id, email, username, phone, password, status) VALUES
         ($1, 'a.journal@example.com', 'journal_a', '+201234100001', 'seed-only-not-a-real-hash', 'active'),
         ($2, 'b.journal@example.com', 'journal_b', '+201234100002', 'seed-only-not-a-real-hash', 'active'),
         ($3, 'c.journal@example.com', 'journal_c', '+201234100003', 'seed-only-not-a-real-hash', 'active'),
         ($4, 'd.journal@example.com', 'journal_d', '+201234100004', 'seed-only-not-a-real-hash', 'active')`,
      [USER_A, USER_B, USER_C, USER_D],
    );
    for (const [id, en, ar] of [
      [EX_SQUAT, 'Fixture Squat', 'سكوات تجريبي'],
      [EX_PRESS, 'Fixture Press', 'ضغط تجريبي'],
    ] as const) {
      await db.pool.query(
        `INSERT INTO exercises (id, name_en, name_ar, name_en_normalized, name_ar_normalized, aliases, aliases_normalized,
           instructions_en, instructions_ar, muscle_groups, tags, provenance)
         VALUES ($1, $2, $3, $4, $5, ARRAY[]::text[], ARRAY[]::text[], 'Seed instructions.', 'تعليمات تجريبية.', ARRAY['legs']::text[], ARRAY[]::text[], 'kal_reviewed')`,
        [id, en, ar, en.toLowerCase(), ar, ],
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    handler = app.get(RoutineOpHandler);
    delta = app.get(RoutineDeltaProviderService);
    reads = app.get(RoutineReadService);
    prs = app.get(PrService);
    recents = app.get(RecentsService);
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

// ---------------------------------------------------------------------------

describe('the frozen per-op state machine (§1.3) — routine lifecycle through the seam', () => {
  it('create applies end-to-end: row + child tree + frozen snapshots land in one unit of work', async () => {
    const op = routineOp({ entityId: nextId('b2c1') }, { name: 'Full body A' });
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const view = await reads.getRoutine(USER_A, op.entityId);
    expect(view).toBeDefined();
    expect(view?.name).toBe('Full body A');
    const entry = view?.exercises[0];
    expect(entry?.exerciseId).toBe(EX_SQUAT);
    expect(entry?.nameSnapshotEn).toBe('Fixture Squat');
    expect(entry?.nameSnapshotAr).toBe('سكوات تجريبي');
    expect(entry?.sets.map((set) => set.format)).toEqual(['weighted', 'timed', 'notes']);
    expect(entry?.sets[0]).toMatchObject({ weightKg: 60, reps: 8 });
    expect(entry?.sets[1]).toMatchObject({ durationSeconds: 45 });
    expect(entry?.sets[2]).toMatchObject({ text: 'tempo 3-1-1' });
  });

  it('create on an active entity is rejected_conflict; on a tombstone it is rejected_deleted (no resurrection)', async () => {
    const op = routineOp();
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    // Same entity id, different op: create-on-active ⇒ conflict.
    await expect(dispatch(routineOp({ opId: opId(), entityId: op.entityId }), USER_A)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_conflict',
      retryable: false,
    });
    // Delete, then create on the tombstone ⇒ the no-resurrection block (I9).
    await expect(dispatch(deleteOp(op.entityId, T2), USER_A)).resolves.toEqual({
      outcome: 'applied',
    });
    await expect(dispatch(routineOp({ opId: opId(), entityId: op.entityId, clientUpdatedAt: T2 }), USER_A)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_deleted',
      retryable: false,
    });
  });

  it('update applies only when LWW wins; a loser is applied and changes nothing (§1.4)', async () => {
    const op = routineOp({ clientUpdatedAt: T1 });
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    // Stale loser: an EARLIER clientUpdatedAt loses to the stored substrate.
    await expect(
      dispatch(routineOp({ opId: opId(), entityId: op.entityId, action: 'update', clientUpdatedAt: '2026-10-12T08:00:00Z' }, { name: 'Stale name' }), USER_A),
    ).resolves.toEqual({ outcome: 'applied' });
    expect((await reads.getRoutine(USER_A, op.entityId))?.name).toBe('Push day');
    // Equal instant, higher opId wins (the deterministic tiebreak).
    const winner = routineOp({ opId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', entityId: op.entityId, action: 'update', clientUpdatedAt: T1 }, { name: 'Tiebreak winner' });
    await expect(dispatch(winner, USER_A)).resolves.toEqual({ outcome: 'applied' });
    expect((await reads.getRoutine(USER_A, op.entityId))?.name).toBe('Tiebreak winner');
  });

  it('update on a missing entity is rejected_conflict; on a tombstone rejected_deleted (an update never undeletes)', async () => {
    await expect(dispatch(routineOp({ action: 'update' }), USER_A)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_conflict',
      retryable: false,
    });
    const op = routineOp();
    await dispatch(op, USER_A);
    await dispatch(deleteOp(op.entityId, T1), USER_A);
    await expect(dispatch(routineOp({ opId: opId(), entityId: op.entityId, action: 'update', clientUpdatedAt: T2 }), USER_A)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_deleted',
      retryable: false,
    });
  });

  it('delete is idempotent — second delete (and a delete of an unknown id) applies with zero effects', async () => {
    const op = routineOp();
    await dispatch(op, USER_A);
    const first = deleteOp(op.entityId, T1);
    await expect(dispatch(first, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const again = deleteOp(op.entityId, T2);
    await expect(dispatch(again, USER_A)).resolves.toEqual({ outcome: 'applied' });
    await expect(dispatch(deleteOp(routineId(), T2), USER_A)).resolves.toEqual({ outcome: 'applied' });
    const rows = await db.pool.query('SELECT deleted_at FROM journal_routines WHERE id = $1', [op.entityId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toHaveProperty('deleted_at');
  });

  it('every exact-bounds violation is per-op rejected_validation (batch continues — outcomes are values)', async () => {
    const cases: Record<string, unknown>[] = [
      {}, // payload absent
      { name: '' },
      { name: 'x'.repeat(121) },
      { name: 'Push day', exercises: [] },
      { name: 'Push day', exercises: [{ exerciseId: 'not-a-uuid', position: 0, sets: [] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: -1, sets: [] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 0, reps: 5 }] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 0 }] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'timed', durationSeconds: 0 }] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'notes', text: '' }] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 5, text: 'mixed' }] }] },
      { name: 'Push day', exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'isometric' }] }] },
    ];
    for (const payload of cases) {
      await expect(dispatch(routineOp({ payload }), USER_A)).resolves.toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    }
  });

  it('an unknown or nonexistent exerciseId is rejected_validation (referential validation precedes the state machine)', async () => {
    const missing = '00000000-0000-4000-8000-00000000dead';
    const before = await db.pool.query('SELECT COUNT(*)::int AS count FROM journal_routines');
    const beforeCount = Number((before.rows[0] as { count: number }).count);
    await expect(dispatch(routineOp({}, { exercises: [{ exerciseId: missing, position: 0, sets: [] }] }), USER_A)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_validation',
      retryable: false,
    });
    // Mixed known/unknown: the whole op rejects — partial templates never apply.
    await expect(
      dispatch(routineOp({}, { exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [] }, { exerciseId: missing, position: 1, sets: [] }] }), USER_A),
    ).resolves.toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    const after = await db.pool.query('SELECT COUNT(*)::int AS count FROM journal_routines');
    // No partial template landed — the rejected ops wrote nothing.
    expect(Number((after.rows[0] as { count: number }).count)).toBe(beforeCount);
  });

  it('a mismatched transaction posture is a SEAM VIOLATION — the apply throws (I6 structural, fail closed)', async () => {
    const op = routineOp();
    await expect(dispatchWithMismatchedPosture(op, USER_A, USER_B)).rejects.toThrow(/context does not match/i);
    await expect(dispatchWithMismatchedPosture(op, USER_A, null)).rejects.toThrow(/context does not match/i);
    const count = await db.pool.query('SELECT COUNT(*)::int AS count FROM journal_routines WHERE id = $1', [op.entityId]);
    expect(Number((count.rows[0] as { count: number }).count)).toBe(0);
  });
});

describe('name snapshots — the I11-analog freeze (§1.1)', () => {
  it('a later catalog edit never rewrites an applied template; an applying edit re-freezes at THAT apply and replaces the child tree', async () => {
    const op = routineOp({ entityId: nextId('b2c1') });
    await expect(dispatch(op, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const before = (await reads.getRoutine(USER_A, op.entityId)) as RoutineProjection;
    expect(before.exercises[0]?.nameSnapshotEn).toBe('Fixture Squat');
    expect(before.exercises[0]?.sets).toHaveLength(3);

    // Catalog correction (admin — seeding-class mutation, the w3 I11 probe).
    await db.pool.query('UPDATE exercises SET name_en = $1 WHERE id = $2', ['Renamed Squat', EX_SQUAT]);
    const afterEdit = await reads.getRoutine(USER_A, op.entityId);
    expect(afterEdit?.exercises[0]?.nameSnapshotEn).toBe('Fixture Squat'); // frozen history untouched

    // An applying edit re-freezes from the CURRENT catalog rows and replaces
    // the superseded child tree (fresh child ids, old rows soft-deleted).
    const oldEntryIds = before.exercises.map((entry) => entry.id);
    const edit = routineOp(
      { opId: opId(), entityId: op.entityId, action: 'update', clientUpdatedAt: T1 },
      { exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 80, reps: 5 }] }] },
    );
    await expect(dispatch(edit, USER_A)).resolves.toEqual({ outcome: 'applied' });
    const afterEdit2 = (await reads.getRoutine(USER_A, op.entityId)) as RoutineProjection;
    expect(afterEdit2.exercises[0]?.nameSnapshotEn).toBe('Renamed Squat');
    expect(afterEdit2.exercises[0]?.sets).toHaveLength(1);
    for (const oldId of oldEntryIds) {
      expect(afterEdit2.exercises.some((entry) => entry.id === oldId)).toBe(false);
    }
    const superseded = await db.pool.query(
      'SELECT COUNT(*)::int AS count FROM journal_routine_exercises WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL',
      [oldEntryIds],
    );
    expect(Number((superseded.rows[0] as { count: number }).count)).toBe(oldEntryIds.length);
  });
});

describe('the delta feed (§1.4/§1.6) — full-snapshot upserts, tombstones, keyset pages', () => {
  it('a first pull emits ordered full snapshots; a tombstone propagates ONCE as a payload-free delete; a stale pull never resurrects', async () => {
    const r1 = routineOp({ entityId: nextId('b2c1'), clientUpdatedAt: '2026-10-12T10:00:00.001Z' }, { name: 'Delta one' });
    const r2 = routineOp({ entityId: nextId('b2c1'), clientUpdatedAt: '2026-10-12T10:00:00.002Z' }, { name: 'Delta two' });
    await dispatch(r1, USER_D);
    await dispatch(r2, USER_D);

    const first = await feedSince(USER_D, null, 10);
    expect(first.changes.map((change) => change.entityId)).toEqual([r1.entityId, r2.entityId]);
    expect(first.changes.every((change) => change.kind === 'journal_routine' && change.change === 'upsert')).toBe(true);
    const payload = first.changes[1]?.payload as RoutineProjection;
    expect(payload.name).toBe('Delta two');
    const entry = (payload.exercises as ProjectedRoutineExercise[])[0];
    // The feed serves the frozen snapshot — frozen at THIS apply, i.e. the
    // catalog name AS RENAMED by the earlier freeze probe (apply-time
    // freezing, not a live catalog join).
    expect(entry.nameSnapshotEn).toBe('Renamed Squat');
    expect(entry.sets).toHaveLength(3);

    // Strict keyset continuation: a cursor AT r1's position yields only r2.
    const resume = await feedSince(USER_D, { updatedAt: first.changes[0]?.updatedAt as string, entityId: r1.entityId }, 10);
    expect(resume.changes.map((change) => change.entityId)).toEqual([r2.entityId]);

    // Tombstone r2: the feed surfaces ONE payload-free delete at the winning
    // op's substrate; re-pulling from before it never resurrects (the row is
    // gone from upserts forever).
    const tombstone = deleteOp(r2.entityId, '2026-10-12T10:00:00.003Z');
    await dispatch(tombstone, USER_D);
    const afterDelete = await feedSince(USER_D, { updatedAt: '2026-10-12T10:00:00.002Z', entityId: r2.entityId }, 10);
    expect(afterDelete.changes).toHaveLength(1);
    expect(afterDelete.changes[0]?.change).toBe('delete');
    expect(afterDelete.changes[0]?.entityId).toBe(r2.entityId);
    expect(afterDelete.changes[0]?.payload).toBeUndefined();
    expect(afterDelete.exhausted).toBe(true);
    const fresh = await feedSince(USER_D, null, 10);
    expect(fresh.changes.some((change) => change.entityId === r2.entityId && change.change === 'upsert')).toBe(false);
  });

  it('paging: exhausted=false until the keyset drains; a foreign context receives an EMPTY feed (I7)', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const op = routineOp({ entityId: nextId('b2c1'), clientUpdatedAt: `2026-10-12T11:00:00.00${index + 1}Z` });
      ids.push(op.entityId);
      await dispatch(op, USER_C);
    }
    const page1 = await feedSince(USER_C, null, 2);
    expect(page1.changes).toHaveLength(2);
    expect(page1.exhausted).toBe(false);
    const page2 = await feedSince(USER_C, { updatedAt: page1.changes[1]?.updatedAt as string, entityId: page1.changes[1]?.entityId as string }, 2);
    expect(page2.changes.map((change) => change.entityId)).toEqual([ids[2]]);
    expect(page2.exhausted).toBe(true);
    const page3 = await feedSince(USER_C, { updatedAt: page2.changes[0]?.updatedAt as string, entityId: ids[2] as string }, 2);
    expect(page3.changes).toHaveLength(0);
    expect(page3.exhausted).toBe(true);
    // B (a valid, authorized context) sees NOTHING of C's rows.
    const foreign = await feedSince(USER_B, null, 10);
    expect(foreign.changes).toHaveLength(0);
    expect(foreign.exhausted).toBe(true);
  });

  it('malformed cursor states are refused before any SQL (fail-closed seam violation)', async () => {
    await expect(feedSince(USER_A, { updatedAt: 'not-an-instant', entityId: feedBegin.entityId }, 10)).rejects.toThrow(RangeError);
    await expect(feedSince(USER_A, { updatedAt: '2026-10-12T10:00:00.001Z', entityId: '' }, 10)).rejects.toThrow(RangeError);
    await expect(feedSince(USER_A, null, 0)).rejects.toThrow(RangeError);
  });
});

describe('the PR read model (§1.3) — Epley over applied sessions, owning-user-only', () => {
  const S1 = nextId('c2c1'); // 2026-03-01 — mixed formats; 100 kg × 8
  const S2 = nextId('c2c1'); // 2026-03-05 — 95 kg × 10 (ties 126.67 exactly)
  const S3 = nextId('c2c1'); // 2026-03-10 — DELETED; 200 kg × 5 (would win at 233.33)
  const S6 = nextId('c2c1'); // 2026-03-25 — duplicate 100 kg × 8 (a later equal estimate must not steal)

  beforeAll(() => {
    return (async () => {
      // A's applied sessions (seeded rows; s2a owns the session op surface).
      await seedSession(USER_A, S1, '2026-03-01', [
        {
          entryId: nextId('d2c1'),
          exerciseId: EX_SQUAT,
          position: 0,
          sets: [
            { setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 100, reps: 8 },
            { setId: nextId('e2c1'), position: 1, format: 'timed', durationSeconds: 60 },
            { setId: nextId('e2c1'), position: 2, format: 'notes', text: 'wod note' },
          ],
        },
        { entryId: nextId('d2c1'), exerciseId: EX_PRESS, position: 1, sets: [{ setId: nextId('e2c1'), position: 0, format: 'timed', durationSeconds: 30 }] },
      ]);
      await seedSession(USER_A, S2, '2026-03-05', [
        { entryId: nextId('d2c1'), exerciseId: EX_SQUAT, position: 0, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 95, reps: 10 }] },
      ]);
      await seedSession(USER_A, S3, '2026-03-10', [
        { entryId: nextId('d2c1'), exerciseId: EX_SQUAT, position: 0, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 200, reps: 5 }] },
      ], { deleted: true });
      await seedSession(USER_A, S6, '2026-03-25', [
        { entryId: nextId('d2c1'), exerciseId: EX_SQUAT, position: 0, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 100, reps: 8 }] },
      ]);
      // B's own session on the SAME exercise — never influences A's PR.
      await seedSession(USER_B, nextId('c2c1'), '2026-03-02', [
        { entryId: nextId('d2c1'), exerciseId: EX_SQUAT, position: 0, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 40, reps: 12 }] },
      ]);
    })();
  });

  it('the golden case: 100 kg × 8 → 126.67, first achievement wins the tie (95×10 later must not steal it)', async () => {
    const view = await prs.readPr(USER_A, EX_SQUAT);
    expect(view.result).toBe('pr');
    expect(view.pr).toMatchObject({
      exerciseId: EX_SQUAT,
      estimatedOneRepMaxKg: 126.67,
      sourceSet: {
        sessionId: S1,
        weightKg: 100,
        reps: 8,
        sessionLocalDate: '2026-03-01',
      },
      achievedOn: '2026-03-01',
    });
  });

  it('mixed formats contribute weighted sets only; a timed/notes-only exercise is the success-shaped "none"', async () => {
    // EX_PRESS (A) has ONLY a timed set → none, never an error.
    expect(await prs.readPr(USER_A, EX_PRESS)).toEqual({ result: 'none' });
    // The EX_SQUAT winner is a WEIGHTED set (its session also carried timed/notes rows).
    expect((await prs.readPr(USER_A, EX_SQUAT)).pr?.sourceSet.reps).toBe(8);
  });

  it('deleted sessions never contribute — the 200 kg × 5 tombstoned session is invisible to the derivation', async () => {
    const view = await prs.readPr(USER_A, EX_SQUAT);
    expect(view.pr?.sourceSet.sessionId).not.toBe(S3);
    expect(view.pr?.estimatedOneRepMaxKg).toBe(126.67);
  });

  it('idempotence: re-derivation is identical, and a later DUPLICATE equal-estimate session cannot inflate or steal the PR', async () => {
    const first = await prs.readPr(USER_A, EX_SQUAT);
    const second = await prs.readPr(USER_A, EX_SQUAT);
    expect(second).toEqual(first); // re-derivation from the same applied rows is bit-identical
    expect(first.pr?.sourceSet.sessionId).toBe(S1); // first achievement (2026-03-01), not S6 (2026-03-25)
    expect(first.pr?.sourceSet.setId).toBe((await prs.readPr(USER_A, EX_SQUAT)).pr?.sourceSet.setId);
  });

  it('a superseded (soft-deleted) exercise entry never contributes its sets', async () => {
    // Seed: a deleted entry carrying a huge weight + its active replacement.
    const sid = nextId('c2c1');
    await seedSession(USER_A, sid, '2026-03-15', [
      { entryId: nextId('d2c1'), exerciseId: EX_PRESS, position: 0, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 500, reps: 1 }], deleted: true },
      { entryId: nextId('d2c1'), exerciseId: EX_PRESS, position: 1, sets: [{ setId: nextId('e2c1'), position: 0, format: 'weighted', weightKg: 50, reps: 6 }] },
    ]);
    const view = await prs.readPr(USER_A, EX_PRESS);
    expect(view.result).toBe('pr');
    expect(view.pr?.sourceSet.weightKg).toBe(50); // the superseded 500 kg entry is invisible
  });

  it('owning-user-only: B’s PR is B’s OWN data (56 = 40 kg × 12 — never A’s 126.67); C (no sessions) gets the success-shaped none (I7)', async () => {
    const bs = await prs.readPr(USER_B, EX_SQUAT);
    expect(bs.result).toBe('pr');
    expect(bs.pr?.estimatedOneRepMaxKg).toBe(56); // 40 × (1 + 12/30) = 56 — B's own session only
    expect(bs.pr?.sourceSet.sessionId).not.toBe(S1);
    expect(await prs.readPr(USER_C, EX_SQUAT)).toEqual({ result: 'none' });
  });

  it('404 parity: a malformed id and an absent catalog id are the SAME generic NOT_FOUND denial', async () => {
    await expect(prs.readPr(USER_A, 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(prs.readPr(USER_A, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(prs.readPr(USER_A, '')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('recents inputs — derived from the user’s own sessions (no synced entity)', () => {
  it('distinct newest-first exercises from OWN sessions; deleted sessions never contribute; limit applies', async () => {
    // A: EX_SQUAT last active 2026-03-25 (S6; S3 deleted would have been 03-10), EX_PRESS 2026-03-15.
    const all = await recents.recentExercises(USER_A, 100);
    expect(all.map((row) => row.exerciseId)).toEqual([EX_SQUAT, EX_PRESS]);
    expect(all[0]).toMatchObject({ exerciseId: EX_SQUAT, lastLoggedOn: '2026-03-25', nameSnapshotEn: 'Seed Squat' });
    expect(all[1]).toMatchObject({ exerciseId: EX_PRESS, lastLoggedOn: '2026-03-15' });
    expect(await recents.recentExercises(USER_A, 1)).toEqual([all[0]]);
    // B sees only B's own; C (no sessions) is empty.
    const bs = await recents.recentExercises(USER_B, 100);
    expect(bs.map((row) => row.exerciseId)).toEqual([EX_SQUAT]);
    expect(bs[0]?.lastLoggedOn).toBe('2026-03-02');
    expect(await recents.recentExercises(USER_C, 100)).toEqual([]);
  });

  it('bounds: a nonsense limit is refused (the caller owns its input)', async () => {
    await expect(recents.recentExercises(USER_A, 0)).rejects.toThrow(RangeError);
    await expect(recents.recentExercises(USER_A, 101)).rejects.toThrow(RangeError);
  });
});

describe('isolation and the RLS runtime — A/B/C negatives through sanctioned paths', () => {
  it('B cannot read A’s routines through the read service; B’s delete/update of A’s entity id is a no-op conflict-free denial that leaves A intact', async () => {
    const op = routineOp({ entityId: nextId('b2c1') });
    await dispatch(op, USER_A);
    expect(await reads.getRoutine(USER_B, op.entityId)).toBeUndefined(); // foreign ≡ absent — no oracle
    // B's delete: the row is invisible to B ⇒ idempotent `applied`, NOTHING of A's touched.
    await expect(dispatch(deleteOp(op.entityId, T2), USER_B)).resolves.toEqual({ outcome: 'applied' });
    expect((await reads.getRoutine(USER_A, op.entityId))?.name).toBe('Push day');
    // B's update: invisible row ⇒ conflict (client belief vs server truth).
    await expect(dispatch(routineOp({ opId: opId(), entityId: op.entityId, action: 'update', clientUpdatedAt: T2 }), USER_B)).resolves.toEqual({
      outcome: 'rejected',
      code: 'rejected_conflict',
      retryable: false,
    });
  });

  it('raw-SQL row-count denials under the app role + GUC (the ADR-0002 behavioral shape)', async () => {
    const aCount = await db.pool.query('SELECT COUNT(*)::int AS count FROM journal_routines WHERE user_id = $1', [USER_A]);
    expect(Number((aCount.rows[0] as { count: number }).count)).toBeGreaterThan(0);
    await asUser(db, USER_B, async (query) => {
      const visible = await query('SELECT COUNT(*)::int AS count FROM journal_routines WHERE user_id = $1', [USER_A]);
      expect(Number((visible.rows[0] as { count: number }).count)).toBe(0); // RLS hides A's rows from B's context
      const own = await query('SELECT COUNT(*)::int AS count FROM journal_routines WHERE user_id = $1', [USER_B]);
      expect(Number((own.rows[0] as { count: number }).count)).toBe(0); // B owns none — parity (denials are authorization-driven)
    });
    await asUser(db, USER_A, async (query) => {
      const own = await query('SELECT COUNT(*)::int AS count FROM journal_routines WHERE user_id = $1', [USER_A]);
      expect(Number((own.rows[0] as { count: number }).count)).toBeGreaterThan(0); // C-parity: the SAME shape works for the owner
    });
  });

  it('the routine read service lists only the owner’s live rows in a deterministic order', async () => {
    const list = await reads.listRoutines(USER_A);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((row) => row.projection.exercises.length > 0)).toBe(true);
    const timestamps = await db.pool.query(
      'SELECT id::text AS id FROM journal_routines WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id ASC',
      [USER_A],
    );
    expect(list.map((row) => row.id)).toEqual(timestamps.rows.map((row) => (row as { id: string }).id));
  });
});
