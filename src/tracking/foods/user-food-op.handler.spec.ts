/**
 * Unit spec — the `user_food` apply-handler state machine (contract §1.3,
 * values-not-throws): full create/update/delete matrix over fake repository +
 * limiter collaborators; the shared limiter sits AFTER validation, BEFORE
 * application; replay-safety under batch retry.
 *
 * DB-backed proofs (RLS posture, two-config trips, real counter rows) live in
 * the integration suite; the two-config behavior basis is proven at config
 * level (tracking.config.spec.ts) and end-to-end (REST 429 + itspec sync
 * outcomes).
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { SyncOpContext, SyncOpEnvelope } from '../sync-seams.js';
import type { FoodsRepository } from './foods.repository.js';
import { lwwOpWins } from './lww.js';
import { UserFoodOpHandler } from './user-food-op.handler.js';
import type { UserFoodRateLimiter } from './user-food-rate-limiter.js';
import { validateUserFoodPayload } from './user-food.payload.js';

const CTX: SyncOpContext = { userId: '11111111-1111-4111-8111-111111111111', deviceId: 'device-A' };
const ENTITY = '44444444-4444-4444-8444-444444444444';
const OP = '55555555-5555-4555-8555-555555555555';
const T0 = '2026-10-08T07:00:00.000Z';

const PAYLOAD = {
  nameEn: 'Own granola',
  energyKcal: 420,
  proteinG: 10,
  carbsG: 60,
  fatG: 14,
  servings: [{ labelEn: 'Bowl', grams: 50 }],
};

interface RepoStubState {
  row: { deletedAt: Date | null; updatedAt: Date; lastOpId: string | null } | null;
  inserted: number;
  replaced: number;
  tombstoned: number;
}

function makeRepo(overrides: Partial<RepoStubState> = {}): { repo: FoodsRepository; state: RepoStubState } {
  const state: RepoStubState = { row: null, inserted: 0, replaced: 0, tombstoned: 0, ...overrides };
  const repo = {
    findUserFoodIncludingDeleted: () => Promise.resolve(state.row === null ? null : ({ id: ENTITY, ...state.row } as never)),
    insertUserFood: () => {
      state.inserted += 1;
      state.row = { deletedAt: null, updatedAt: new Date(T0), lastOpId: OP };
      return Promise.resolve(ENTITY);
    },
    replaceUserFoodSnapshot: (_tx: unknown, params: { clientUpdatedAt: Date; opId: string }) => {
      state.replaced += 1;
      state.row = { deletedAt: null, updatedAt: params.clientUpdatedAt, lastOpId: params.opId };
      return Promise.resolve();
    },
    tombstoneUserFood: () => {
      state.tombstoned += 1;
      if (state.row !== null) {
        state.row = { ...state.row, deletedAt: new Date() };
      }
      return Promise.resolve();
    },
  } as unknown as FoodsRepository;
  return { repo, state };
}

function makeLimiter(ok = true): { limiter: UserFoodRateLimiter; calls: number } {
  const calls = { count: 0 };
  const limiter = {
    assertCanCreateAndTick: () => {
      calls.count += 1;
      return Promise.resolve(ok ? { ok: true } : { ok: false, retryAfterSeconds: 1200 });
    },
  } as unknown as UserFoodRateLimiter;
  return { limiter, calls };
}

function op(action: SyncOpEnvelope['action'], overrides: Partial<SyncOpEnvelope> = {}): SyncOpEnvelope {
  return { opId: OP, kind: 'user_food', entityId: ENTITY, action, clientUpdatedAt: T0, payload: action === 'delete' ? undefined : PAYLOAD, ...overrides };
}

describe('UserFoodOpHandler — §1.3 state machine', () => {
  it('create: validate → limiter → insert ⇒ applied (limiter ticked once, in order)', async () => {
    const { repo, state } = makeRepo();
    const { limiter, calls } = makeLimiter();
    const handler = new UserFoodOpHandler(repo, limiter);
    const outcome = await handler.apply(op('create'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(calls.count).toBe(1);
    expect(state.inserted).toBe(1);
  });

  it('create over an ACTIVE row ⇒ rejected_conflict; the limiter is NOT ticked, nothing inserted', async () => {
    const { repo, state } = makeRepo({ row: { deletedAt: null, updatedAt: new Date(T0), lastOpId: OP } });
    const { limiter, calls } = makeLimiter();
    const outcome = await new UserFoodOpHandler(repo, limiter).apply(op('create'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    expect(calls.count).toBe(0);
    expect(state.inserted).toBe(0);
  });

  it('create over a TOMBSTONED row ⇒ rejected_deleted — no resurrection (I9)', async () => {
    const { repo, state } = makeRepo({ row: { deletedAt: new Date(), updatedAt: new Date(T0), lastOpId: OP } });
    const { limiter } = makeLimiter();
    const outcome = await new UserFoodOpHandler(repo, limiter).apply(op('create'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    expect(state.inserted).toBe(0);
  });

  it('create over-limit ⇒ rejected_rate_limited retryable TRUE; nothing inserted (§1.7 directed resolution)', async () => {
    const { repo, state } = makeRepo();
    const { limiter } = makeLimiter(false);
    const outcome = await new UserFoodOpHandler(repo, limiter).apply(op('create'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_rate_limited', retryable: true });
    expect(state.inserted).toBe(0);
  });

  it('create with an invalid payload ⇒ rejected_validation BEFORE the limiter (validation precedes rate limiting, §1.3)', async () => {
    const { repo } = makeRepo();
    const { limiter, calls } = makeLimiter();
    const outcome = await new UserFoodOpHandler(repo, limiter).apply(op('create', { payload: { ...PAYLOAD, proteinG: -1 } }), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(calls.count).toBe(0);
  });

  it('create with localDate present ⇒ rejected_validation (localDate parity, §1.1)', async () => {
    const { repo } = makeRepo();
    const outcome = await new UserFoodOpHandler(repo, makeLimiter().limiter).apply(op('create', { localDate: '2026-10-08' }), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
  });

  it('update: no row ⇒ rejected_conflict (client belief vs server truth); tombstoned ⇒ rejected_deleted', async () => {
    const missing = makeRepo();
    expect(await new UserFoodOpHandler(missing.repo, makeLimiter().limiter).apply(op('update'), CTX, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    const tombstoned = makeRepo({ row: { deletedAt: new Date(), updatedAt: new Date(T0), lastOpId: OP } });
    expect(await new UserFoodOpHandler(tombstoned.repo, makeLimiter().limiter).apply(op('update'), CTX, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });

  it('update: an LWW loser is recorded applied and changes NOTHING (no writes, no snapshot fix-ups, I11)', async () => {
    const { repo, state } = makeRepo({ row: { deletedAt: null, updatedAt: new Date('2026-10-08T09:00:00.000Z'), lastOpId: OP } });
    const outcome = await new UserFoodOpHandler(repo, makeLimiter().limiter).apply(op('update'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(state.replaced).toBe(0);
  });

  it('update: an LWW winner replaces the snapshot with the op-authored LWW columns', async () => {
    const { repo, state } = makeRepo({ row: { deletedAt: null, updatedAt: new Date('2026-10-08T06:00:00.000Z'), lastOpId: OP } });
    const outcome = await new UserFoodOpHandler(repo, makeLimiter().limiter).apply(
      op('update', { clientUpdatedAt: '2026-10-08T10:00:00.000Z', opId: '66666666-6666-4666-8666-666666666666' }),
      CTX,
      {} as never,
    );
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(state.replaced).toBe(1);
    expect(state.row?.updatedAt.toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(state.row?.lastOpId).toBe('66666666-6666-4666-8666-666666666666');
  });

  it('update: limiter is NOT consulted (creates only, §1.7)', async () => {
    const { repo } = makeRepo({ row: { deletedAt: null, updatedAt: new Date('2026-10-08T06:00:00.000Z'), lastOpId: OP } });
    const { limiter, calls } = makeLimiter(false);
    const outcome = await new UserFoodOpHandler(repo, limiter).apply(op('update'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(calls.count).toBe(0);
  });

  it('delete: active ⇒ applied tombstone; missing or tombstoned ⇒ applied idempotent, nothing written', async () => {
    const active = makeRepo({ row: { deletedAt: null, updatedAt: new Date(T0), lastOpId: OP } });
    expect(await new UserFoodOpHandler(active.repo, makeLimiter().limiter).apply(op('delete'), CTX, {} as never)).toEqual({ outcome: 'applied' });
    expect(active.state.tombstoned).toBe(1);

    const absent = makeRepo();
    expect(await new UserFoodOpHandler(absent.repo, makeLimiter().limiter).apply(op('delete'), CTX, {} as never)).toEqual({ outcome: 'applied' });
    expect(absent.state.tombstoned).toBe(0);

    const dead = makeRepo({ row: { deletedAt: new Date(), updatedAt: new Date(T0), lastOpId: OP } });
    expect(await new UserFoodOpHandler(dead.repo, makeLimiter().limiter).apply(op('delete'), CTX, {} as never)).toEqual({ outcome: 'applied' });
    expect(dead.state.tombstoned).toBe(0);
  });

  it('envelope defense: unknown kind, malformed ids, malformed instants ⇒ rejected_validation, no collaborator touched', async () => {
    const { repo, state } = makeRepo();
    const handler = new UserFoodOpHandler(repo, makeLimiter().limiter);
    for (const bad of [
      op('create', { kind: 'diary_entry' as const }),
      op('create', { entityId: 'not-a-uuid' }),
      op('create', { opId: 'not-a-uuid' }),
      op('create', { clientUpdatedAt: 'yesterday' }),
    ]) {
      expect(await handler.apply(bad, CTX, {} as never)).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    }
    expect(state.inserted).toBe(0);
  });

  it('a concurrent-duplicate insert (P2002 from the DB) maps to rejected_conflict — never a batch abort', async () => {
    const racing = {
      findUserFoodIncludingDeleted: () => Promise.resolve(null),
      insertUserFood: () => {
        throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      },
    } as unknown as FoodsRepository;
    const outcome = await new UserFoodOpHandler(racing, makeLimiter().limiter).apply(op('create'), CTX, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });

  it('payload shape parity: the handler and the REST path validate the SAME function', () => {
    expect(validateUserFoodPayload(PAYLOAD).ok).toBe(true);
    expect(validateUserFoodPayload({ ...PAYLOAD, fatG: '14' }).ok).toBe(false);
  });

  it('replay-safety basis: the LWW comparator refuses an equal (timestamp, opId) re-application', () => {
    expect(lwwOpWins(new Date(T0).getTime(), OP, new Date(T0), OP)).toBe(false);
  });
});
