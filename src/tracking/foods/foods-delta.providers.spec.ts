/**
 * Unit spec — delta-provider mapping (contract §1.6): upserts carry the FULL
 * snapshot (the same projection REST serves); deletes carry NO payload;
 * ordering/exhaustion are the SQL page's (faked here); the caller's binding
 * is the only rows ever touched.
 */
import { describe, expect, it } from 'vitest';
import type { Favorite, UserFood, UserFoodServing } from '../../../generated/prisma/client.ts';
import type { SyncOpContext } from '../sync-seams.js';
import { FavoriteDeltaProvider, UserFoodDeltaProvider } from './foods-delta.providers.js';
import type { FoodsRepository } from './foods.repository.js';

const CTX: SyncOpContext = { userId: '11111111-1111-4111-8111-111111111111', deviceId: 'device-A' };
const T0 = new Date('2026-10-08T07:00:00.000Z');

function userFoodRow(overrides: Partial<UserFood> = {}): UserFood {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    userId: CTX.userId,
    nameEn: 'Own granola',
    nameAr: null,
    nameEnNormalized: 'own granola',
    nameArNormalized: null,
    energyKcal: { toNumber: () => 420 } as never,
    proteinG: { toNumber: () => 10 } as never,
    carbsG: { toNumber: () => 60 } as never,
    fatG: { toNumber: () => 14 } as never,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    lastOpId: '66666666-6666-4666-8666-666666666666',
    ...overrides,
  } as UserFood;
}

describe('UserFoodDeltaProvider', () => {
  it('maps an active row to an upsert with the full snapshot incl. servings (§1.6)', async () => {
    const serving = {
      id: '55555555-5555-4555-8555-555555555555',
      userFoodId: '44444444-4444-4444-8444-444444444444',
      userId: CTX.userId,
      labelEn: 'Bowl',
      labelAr: null,
      grams: { toNumber: () => 50 } as never,
    } as UserFoodServing;
    const repo = {
      userFoodChangesPage: () => Promise.resolve({ rows: [userFoodRow()], exhausted: true }),
      listActiveServingsForMany: () => Promise.resolve([serving]),
    } as unknown as FoodsRepository;
    const { changes, exhausted } = await new UserFoodDeltaProvider(repo).changesSince(null, 50, CTX, {} as never);
    expect(exhausted).toBe(true);
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change).toMatchObject({ kind: 'user_food', entityId: '44444444-4444-4444-8444-444444444444', change: 'upsert' });
    expect(change.updatedAt).toBe('2026-10-08T07:00:00.000Z');
    expect(change.payload).toMatchObject({
      id: '44444444-4444-4444-8444-444444444444',
      provenance: 'user_created',
      type: 'user_custom',
      energyKcal: 420,
      servings: [{ id: '55555555-5555-4555-8555-555555555555', labelEn: 'Bowl', grams: 50 }],
    });
  });

  it('maps a tombstoned row to a payload-less delete (tombstones propagate, §1.5)', async () => {
    const repo = {
      userFoodChangesPage: () =>
        Promise.resolve({ rows: [userFoodRow({ deletedAt: new Date('2026-10-08T08:00:00.000Z') })], exhausted: false }),
      listActiveServingsForMany: () => Promise.resolve([]),
    } as unknown as FoodsRepository;
    const { changes } = await new UserFoodDeltaProvider(repo).changesSince(null, 50, CTX, {} as never);
    expect(changes[0]).toEqual({
      kind: 'user_food',
      entityId: '44444444-4444-4444-8444-444444444444',
      change: 'delete',
      updatedAt: '2026-10-08T07:00:00.000Z', // the LWW updated_at — not the tombstone time
    });
    expect(changes[0]?.payload).toBeUndefined();
  });
});

describe('FavoriteDeltaProvider', () => {
  it('maps favorites with their target snapshot; tombstones payload-less', async () => {
    const favorite = {
      id: '66666666-6666-4666-8666-666666666666',
      userId: CTX.userId,
      foodId: '00000000-0000-4000-8000-00000000f001',
      userFoodId: null,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      lastOpId: '77777777-7777-4777-8777-777777777777',
    } as Favorite;
    const tombstoned = { ...favorite, id: '88888888-8888-4888-8888-888888888888', deletedAt: T0 } as Favorite;
    const repo = {
      favoriteChangesPage: () => Promise.resolve({ rows: [favorite, tombstoned], exhausted: false }),
    } as unknown as FoodsRepository;
    const { changes } = await new FavoriteDeltaProvider(repo).changesSince(null, 50, CTX, {} as never);
    expect(changes[0]).toMatchObject({ kind: 'favorite', change: 'upsert', payload: { foodId: '00000000-0000-4000-8000-00000000f001', userFoodId: null } });
    expect(changes[1]).toMatchObject({ kind: 'favorite', change: 'delete' });
    expect(changes[1]?.payload).toBeUndefined();
  });
});
