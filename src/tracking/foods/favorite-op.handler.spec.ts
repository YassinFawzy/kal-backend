/**
 * Unit spec — the `favorite` apply-handler state machine (§1.3): XOR target
 * validation, target authorization (absent/foreign/unownable targets are ONE
 * generic rejection — I7), duplicate-active conflict, create+tombstone entity
 * semantics (retargeting updates are not applicable snapshots), idempotent
 * deletes.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { SyncOpContext, SyncOpEnvelope } from '../sync-seams.js';
import { FavoriteOpHandler } from './favorite-op.handler.js';
import type { FoodsRepository } from './foods.repository.js';

const CTX_A: SyncOpContext = { userId: '11111111-1111-4111-8111-111111111111', deviceId: 'device-A' };
const CTX_B: SyncOpContext = { userId: '22222222-2222-4222-8222-222222222222', deviceId: 'device-B' };
const FOOD = '00000000-0000-4000-8000-00000000f001';
const OWN_FOOD = '44444444-4444-4444-8444-444444444444';
const ENTITY = '55555555-5555-4555-8555-555555555555';
const OP = '66666666-6666-4666-8666-666666666666';
const T0 = '2026-10-08T07:00:00.000Z';

interface FavoriteRepoStub {
  favorites: Map<string, { deletedAt: Date | null; foodId: string | null; userFoodId: string | null; updatedAt: Date; lastOpId: string | null }>;
  foods: Set<string>;
  ownUserFoods: Set<string>;
  inserted: number;
  refreshed: number;
  tombstoned: number;
}

function makeRepo(seed: Partial<FavoriteRepoStub> = {}): { repo: FoodsRepository; state: FavoriteRepoStub } {
  const state: FavoriteRepoStub = {
    favorites: new Map(),
    foods: new Set([FOOD]),
    ownUserFoods: new Set([OWN_FOOD]),
    inserted: 0,
    refreshed: 0,
    tombstoned: 0,
    ...seed,
  };
  const repo = {
    findFavoriteIncludingDeleted: (_tx: unknown, _userId: string, entityId: string) =>
      Promise.resolve(state.favorites.get(entityId) === undefined ? null : ({ id: entityId, ...state.favorites.get(entityId) } as never)),
    findFood: (_tx: unknown, foodId: string) => Promise.resolve(state.foods.has(foodId) ? ({ id: foodId } as never) : null),
    findUserFoodIncludingDeleted: (_tx: unknown, userId: string, userFoodId: string) => {
      // The EXPLICIT predicate: only the caller's OWN rows are ever visible —
      // another user's target is indistinguishable from an absent one (I7).
      if (userId !== CTX_A.userId || !state.ownUserFoods.has(userFoodId)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ id: userFoodId, deletedAt: null } as never);
    },
    insertFavorite: (_tx: unknown, params: { entityId: string; foodId: string | null; userFoodId: string | null; clientUpdatedAt: Date; opId: string }) => {
      state.inserted += 1;
      state.favorites.set(params.entityId, {
        deletedAt: null,
        foodId: params.foodId,
        userFoodId: params.userFoodId,
        updatedAt: params.clientUpdatedAt,
        lastOpId: params.opId,
      });
      return Promise.resolve();
    },
    refreshFavoriteLww: (_tx: unknown, params: { entityId: string; clientUpdatedAt: Date; opId: string }) => {
      state.refreshed += 1;
      const row = state.favorites.get(params.entityId);
      if (row) {
        state.favorites.set(params.entityId, { ...row, updatedAt: params.clientUpdatedAt, lastOpId: params.opId });
      }
      return Promise.resolve();
    },
    tombstoneFavorite: (_tx: unknown, params: { entityId: string }) => {
      state.tombstoned += 1;
      const row = state.favorites.get(params.entityId);
      if (row) {
        state.favorites.set(params.entityId, { ...row, deletedAt: new Date() });
      }
      return Promise.resolve();
    },
  } as unknown as FoodsRepository;
  return { repo, state };
}

function op(action: SyncOpEnvelope['action'], payload: unknown, overrides: Partial<SyncOpEnvelope> = {}): SyncOpEnvelope {
  return { opId: OP, kind: 'favorite', entityId: ENTITY, action, clientUpdatedAt: T0, payload: action === 'delete' ? undefined : payload, ...overrides };
}

describe('FavoriteOpHandler — §1.3 state machine', () => {
  it('create with a platform-food target ⇒ applied', async () => {
    const { repo, state } = makeRepo();
    const outcome = await new FavoriteOpHandler(repo).apply(op('create', { foodId: FOOD }), CTX_A, {} as never);
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(state.inserted).toBe(1);
  });

  it('create with the caller OWN active user-food target ⇒ applied', async () => {
    const { repo, state } = makeRepo();
    const outcome = await new FavoriteOpHandler(repo).apply(op('create', { userFoodId: OWN_FOOD }), CTX_A, {} as never);
    expect(outcome).toEqual({ outcome: 'applied' });
    expect(state.inserted).toBe(1);
  });

  it('a FOREIGN user-food target is rejected with the SAME generic outcome as an absent one (I7)', async () => {
    const { repo, state } = makeRepo();
    const foreign = await new FavoriteOpHandler(repo).apply(op('create', { userFoodId: OWN_FOOD }), CTX_B, {} as never);
    const absent = await new FavoriteOpHandler(makeRepo().repo).apply(op('create', { userFoodId: '77777777-7777-4777-8777-777777777777' }), CTX_A, {} as never);
    expect(foreign).toEqual(absent);
    expect(foreign).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(state.inserted).toBe(0);
  });

  it('an unknown platform-food target ⇒ rejected_validation', async () => {
    const { repo } = makeRepo();
    const outcome = await new FavoriteOpHandler(repo).apply(op('create', { foodId: '88888888-8888-4888-8888-888888888888' }), CTX_A, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
  });

  it('payload XOR violations (both/neither targets, bad uuids) ⇒ rejected_validation', async () => {
    const { repo } = makeRepo();
    const handler = new FavoriteOpHandler(repo);
    for (const payload of [{}, { foodId: FOOD, userFoodId: OWN_FOOD }, { foodId: 'junk' }, null, 'favorite']) {
      expect(await handler.apply(op('create', payload), CTX_A, {} as never)).toEqual({
        outcome: 'rejected',
        code: 'rejected_validation',
        retryable: false,
      });
    }
  });

  it('create over an ACTIVE entity id ⇒ rejected_conflict; over a TOMBSTONED id ⇒ rejected_deleted', async () => {
    const active = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: null, foodId: FOOD, userFoodId: null, updatedAt: new Date(T0), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(active.repo).apply(op('create', { foodId: FOOD }), CTX_A, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });

    const dead = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: new Date(), foodId: FOOD, userFoodId: null, updatedAt: new Date(T0), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(dead.repo).apply(op('create', { foodId: FOOD }), CTX_A, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });

  it('a DB duplicate-active insert (P2002 on the partial unique) maps to rejected_conflict', async () => {
    const repo = {
      findFavoriteIncludingDeleted: () => Promise.resolve(null),
      findFood: (_tx: unknown, id: string) => Promise.resolve({ id } as never),
      findUserFoodIncludingDeleted: () => Promise.resolve(null),
      insertFavorite: () => {
        throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      },
    } as unknown as FoodsRepository;
    const outcome = await new FavoriteOpHandler(repo).apply(op('create', { foodId: FOOD }), CTX_A, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });

  it('update with a DIFFERENT target ⇒ rejected_validation (favorites are create + tombstone; grants matrix)', async () => {
    const seeded = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: null, foodId: FOOD, userFoodId: null, updatedAt: new Date(T0), lastOpId: OP }]]) });
    const outcome = await new FavoriteOpHandler(seeded.repo).apply(op('update', { userFoodId: OWN_FOOD }), CTX_A, {} as never);
    expect(outcome).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    expect(seeded.state.refreshed).toBe(0);
  });

  it('update same-target: LWW winner refreshes the LWW columns; loser recorded applied without writes', async () => {
    const winner = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: null, foodId: FOOD, userFoodId: null, updatedAt: new Date('2026-10-08T06:00:00.000Z'), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(winner.repo).apply(op('update', { foodId: FOOD }, { clientUpdatedAt: '2026-10-08T08:00:00.000Z' }), CTX_A, {} as never))
      .toEqual({ outcome: 'applied' });
    expect(winner.state.refreshed).toBe(1);

    const loser = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: null, foodId: FOOD, userFoodId: null, updatedAt: new Date('2026-10-08T09:00:00.000Z'), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(loser.repo).apply(op('update', { foodId: FOOD }), CTX_A, {} as never))
      .toEqual({ outcome: 'applied' });
    expect(loser.state.refreshed).toBe(0);
  });

  it('update on missing/tombstoned ⇒ rejected_conflict/rejected_deleted (an update never undeletes)', async () => {
    const missing = makeRepo();
    expect(await new FavoriteOpHandler(missing.repo).apply(op('update', { foodId: FOOD }), CTX_A, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    const dead = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: new Date(), foodId: FOOD, userFoodId: null, updatedAt: new Date(T0), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(dead.repo).apply(op('update', { foodId: FOOD }), CTX_A, {} as never))
      .toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });

  it('delete: active ⇒ tombstone; absent/tombstoned ⇒ applied with no write (idempotent)', async () => {
    const active = makeRepo({ favorites: new Map([[ENTITY, { deletedAt: null, foodId: FOOD, userFoodId: null, updatedAt: new Date(T0), lastOpId: OP }]]) });
    expect(await new FavoriteOpHandler(active.repo).apply(op('delete', undefined), CTX_A, {} as never)).toEqual({ outcome: 'applied' });
    expect(active.state.tombstoned).toBe(1);

    const absent = makeRepo();
    expect(await new FavoriteOpHandler(absent.repo).apply(op('delete', undefined), CTX_A, {} as never)).toEqual({ outcome: 'applied' });
    expect(absent.state.tombstoned).toBe(0);
  });
});
