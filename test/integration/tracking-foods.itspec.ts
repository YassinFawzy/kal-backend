/**
 * Integration / isolation — the tracking foods lane on an EPHEMERAL database
 * (full migration history + the production-faithful seed; A/B/C isolation
 * posture per the harness rules).
 *
 * Required cases proven here (task contract):
 *   seed        — loads IDEMPOTENTLY from the contract manifest (re-runs
 *                 upsert, never duplicate) with manifest↔seed value fidelity
 *                 for EVERY row (incl. the amendment-1 shawarma aliases).
 *   seam        — the `user_food` and `favorite` apply-handlers through the
 *                 FROZEN seam interfaces (§4) on the real database: §1.3
 *                 state machine, LWW winners/losers on real rows,
 *                 no-resurrection, replay-safety under batch retry after an
 *                 ABORTED transaction.
 *   rate limit  — the shared limiter's SYNC path: two-config proofs for BOTH
 *                 windows (hourly, daily) with `rejected_rate_limited`
 *                 retryable outcomes (§1.7 directed resolution).
 *   delta       — provider pages: deterministic (updatedAt, id) order,
 *                 strictly-after cursor semantics, payload-less tombstones,
 *                 exhaustion.
 *   isolation   — B cannot read/locate/enumerate A's user foods (search-page
 *                 parity), B's outcomes on A's entity ids are byte-identical
 *                 to absent-entity outcomes (no existence oracle, I7), the
 *                 RLS backstop refuses an app-role write with NO user
 *                 context (the database blocks what application code
 *                 forgets), favorites never cross accounts (compound
 *                 reference + explicit predicates).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { PrismaService } from '../../src/db/prisma.service.js';
import type { ConfigService } from '../../src/config/config.service.js';
import { normalize } from '../../src/tracking/normalization/normalization.js';
import { inUserScopeTx } from '../../src/tracking/foods/app-role-tx.js';
import { FavoriteOpHandler } from '../../src/tracking/foods/favorite-op.handler.js';
import { FavoriteDeltaProvider, UserFoodDeltaProvider } from '../../src/tracking/foods/foods-delta.providers.js';
import { FoodsRepository } from '../../src/tracking/foods/foods.repository.js';
import { TrackingConfigService } from '../../src/tracking/foods/tracking.config.js';
import { UserFoodOpHandler } from '../../src/tracking/foods/user-food-op.handler.js';
import { UserFoodRateLimiter } from '../../src/tracking/foods/user-food-rate-limiter.js';
import type { SyncOpContext, SyncOpEnvelope } from '../../src/tracking/sync-seams.js';
import { applyFoodCatalogSeed } from '../../prisma/seed-apply.ts';
import { SEED_FOODS } from '../../prisma/seed-manifest.ts';
import { asUserlessApp, USER_A, USER_B, USER_C } from './helpers/acting-user.js';

/** Synthetic limiter-proof users (fresh counters — the windows are rolling). */
const USER_D = '44444444-4444-4444-8444-dddddddddddd';
const USER_E = '44444444-4444-4444-8444-eeeeeeeeeeee';
import { createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

const T0 = '2026-10-08T07:00:00.000Z';
const T1 = '2026-10-08T08:00:00.000Z';
const T2 = '2026-10-08T09:00:00.000Z';

const FOOD_F001 = '00000000-0000-4000-8000-00000000f001';
const FOOD_F00D = '00000000-0000-4000-8000-00000000f00d';

let db: EphemeralKalDb;
let prisma: PrismaService;
let repository: FoodsRepository;
let handlers: {
  config: TrackingConfigService;
  userFood: UserFoodOpHandler;
  favorite: FavoriteOpHandler;
  userFoodDelta: UserFoodDeltaProvider;
  favoriteDelta: FavoriteDeltaProvider;
};

const CTX_A: SyncOpContext = { userId: USER_A, deviceId: 'device-A' };
const CTX_B: SyncOpContext = { userId: USER_B, deviceId: 'device-B' };
const CTX_C: SyncOpContext = { userId: USER_C, deviceId: 'device-C' };

/** A fresh lane stack with its OWN config values (the two-config proof basis). */
function makeStack(config: TrackingConfigService): {
  repository: FoodsRepository;
  userFood: UserFoodOpHandler;
  favorite: FavoriteOpHandler;
  userFoodDelta: UserFoodDeltaProvider;
  favoriteDelta: FavoriteDeltaProvider;
} {
  const repo = new FoodsRepository({ normalize });
  const limiter = new UserFoodRateLimiter(config);
  return {
    repository: repo,
    userFood: new UserFoodOpHandler(repo, limiter),
    favorite: new FavoriteOpHandler(repo),
    userFoodDelta: new UserFoodDeltaProvider(repo),
    favoriteDelta: new FavoriteDeltaProvider(repo),
  };
}

function configFor(env: Record<string, string>): TrackingConfigService {
  const keys = Object.keys(env);
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return new TrackingConfigService('test');
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

function userFoodOp(entityId: string, overrides: Partial<SyncOpEnvelope> = {}): SyncOpEnvelope {
  return {
    opId: `a1000000-0000-4000-8000-${entityId.slice(-12)}`,
    kind: 'user_food',
    entityId,
    action: 'create',
    clientUpdatedAt: T0,
    payload: { nameEn: 'Seam granola', nameAr: 'جرانولا خاصة', energyKcal: 420, proteinG: 10, carbsG: 60, fatG: 14 },
    ...overrides,
  };
}

async function seedUser(userId: string, email: string, username: string): Promise<void> {
  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [userId, email, username]);
  }, { commit: true });
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('trk-foods-it');
    db.applyMigrations();

    // Production-faithful seed (operator path over an admin connection — the
    // catalog is RLS-declined platform plane).
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      await applyFoodCatalogSeed(seedClient);
    } finally {
      await seedClient.$disconnect();
    }

    await seedUser(USER_A, 'a@tracking-foods-it.invalid', 'trk_foods_it_a');
    await seedUser(USER_B, 'b@tracking-foods-it.invalid', 'trk_foods_it_b');
    await seedUser(USER_C, 'c@tracking-foods-it.invalid', 'trk_foods_it_c');
    await seedUser(USER_D, 'd@tracking-foods-it.invalid', 'trk_foods_it_d');
    await seedUser(USER_E, 'e@tracking-foods-it.invalid', 'trk_foods_it_e');


    prisma = new PrismaService({ databaseUrl: url.toString() } as ConfigService);
    const defaultConfig = configFor({});
    handlers = { config: defaultConfig, ...makeStack(defaultConfig) };
    repository = handlers.repository;
  })();
}, 240_000);

afterAll(async () => {
  await prisma?.onModuleDestroy();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('seed — idempotent load from the contract manifest (§8, amendment 1)', () => {
  it('applies from the manifest; a SECOND application changes nothing (upsert-by-fixed-id)', async () => {
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const client = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      const first = await applyFoodCatalogSeed(client);
      expect(first.foods).toBe(SEED_FOODS.length);
      const variantTotal = SEED_FOODS.reduce((sum, food) => sum + food.servingVariants.length, 0);
      expect(first.servingVariants).toBe(variantTotal);

      // Fingerprint the catalog, re-apply, compare.
      const fingerprint = async (): Promise<unknown[]> => {
        const rows = await client.$queryRaw<Record<string, unknown>[]>`SELECT * FROM foods ORDER BY id`;
        const variants = await client.$queryRaw<Record<string, unknown>[]>`SELECT * FROM serving_variants ORDER BY id`;
        return [
          rows.map((row) => ({ ...row, created_at: undefined, updated_at: undefined })),
          variants.map((row) => ({ ...row, created_at: undefined, updated_at: undefined })),
        ];
      };
      const before = await fingerprint();
      const second = await applyFoodCatalogSeed(client);
      expect(second.foods).toBe(first.foods);
      expect(second.servingVariants).toBe(first.servingVariants);
      expect(await fingerprint()).toEqual(before);
    } finally {
      await client.$disconnect();
    }
  });

  it('manifest↔seed fidelity: EVERY manifest row and variant is stored value-identical', async () => {
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    const client = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
    try {
      for (const food of SEED_FOODS) {
        const row = await client.food.findUnique({ where: { id: food.id }, include: { servingVariants: true } });
        expect(row, `food ${food.id} missing`).not.toBeNull();
        expect(row?.type).toBe(food.type);
        expect(row?.provenance).toBe('kal_reviewed');
        expect(row?.licensePartition).toBe('proprietary');
        expect(row?.nameEn).toBe(food.nameEn);
        expect(row?.nameEnNormalized).toBe(food.nameEnNormalized);
        expect(row?.nameAr).toBe(food.nameAr);
        expect(row?.nameArNormalized).toBe(food.nameArNormalized);
        expect(row?.aliases).toEqual([...food.aliases]);
        expect(row?.aliasesNormalized).toEqual([...food.aliasesNormalized]);
        expect(row?.energyKcal.toNumber()).toBe(food.energyKcal);
        expect(row?.proteinG.toNumber()).toBe(food.proteinG);
        expect(row?.carbsG.toNumber()).toBe(food.carbsG);
        expect(row?.fatG.toNumber()).toBe(food.fatG);
        expect(row?.servingVariants).toHaveLength(food.servingVariants.length);
        for (const variant of food.servingVariants) {
          const stored = row?.servingVariants.find((candidate) => candidate.id === variant.id);
          expect(stored, `variant ${variant.id} missing`).toBeDefined();
          expect(stored?.labelEn).toBe(variant.labelEn);
          expect(stored?.labelAr).toBe(variant.labelAr);
          expect(stored?.grams.toNumber()).toBe(variant.grams);
          expect(stored?.isDefault).toBe(variant.isDefault);
        }
      }
      // The amendment-1 shawarma aliases are live (data-carried equivalence).
      const shawarma = await client.food.findUnique({ where: { id: FOOD_F00D } });
      expect(shawarma?.aliasesNormalized).toContain('شاورمه');
      expect(shawarma?.aliasesNormalized).toContain('شاورمه فراخ');
    } finally {
      await client.$disconnect();
    }
  });
});

describe('user_food apply-handler through the frozen seam (§4, §1.3)', () => {
  it('create ⇒ applied; the row lands under the caller binding and is searchable ONLY by its owner', async () => {
    const outcome = await inUserScopeTx(prisma, CTX_A, (tx) => handlers.userFood.apply(userFoodOp('44444444-4444-4444-8444-444444444444'), CTX_A, tx));
    expect(outcome).toEqual({ outcome: 'applied' });
    const page = await inUserScopeTx(prisma, CTX_A, (tx) => repository.searchPage(tx, USER_A, 'جرانولا خاصه', 50, null));
    expect(page.entries.map((entry) => entry.id)).toContain('44444444-4444-4444-8444-444444444444');
    const pageB = await inUserScopeTx(prisma, CTX_B, (tx) => repository.searchPage(tx, USER_B, 'جرانولا خاصه', 50, null));
    expect(pageB.entries).toEqual([]); // B's page is EMPTY — same query, foreign rows invisible
  });

  it('B\'s outcomes on A\'s entity ids are IDENTICAL to absent-entity outcomes (no existence oracle, I7)', async () => {
    const onA = await inUserScopeTx(prisma, CTX_B, (tx) => handlers.userFood.apply(userFoodOp('44444444-4444-4444-8444-444444444444', { action: 'update' }), CTX_B, tx));
    const onAbsent = await inUserScopeTx(prisma, CTX_B, (tx) => handlers.userFood.apply(userFoodOp('55555555-5555-4555-8555-555555555555', { action: 'update' }), CTX_B, tx));
    expect(onA).toEqual(onAbsent);
    expect(onA).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
    // B create-colliding-with-A's-id: conflict, same as any active row.
    const createOnA = await inUserScopeTx(prisma, CTX_B, (tx) => handlers.userFood.apply(userFoodOp('44444444-4444-4444-8444-444444444444'), CTX_B, tx));
    expect(createOnA).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });

  it('update: LWW winner replaces the snapshot; loser recorded applied and changes nothing', async () => {
    const entityId = '44444444-4444-4444-8444-444444444444';
    const loser = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, {
        action: 'update',
        clientUpdatedAt: '2026-10-08T06:00:00.000Z', // OLDER than the row's LWW instant (T0) — loses
        opId: 'b2000000-0000-4000-8000-000000000001',
        payload: { nameEn: 'Loser snapshot', energyKcal: 1, proteinG: 1, carbsG: 1, fatG: 1 },
      }), CTX_A, tx));
    expect(loser).toEqual({ outcome: 'applied' });
    const rowAfterLoser = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findUserFoodIncludingDeleted(tx, USER_A, entityId));
    expect(rowAfterLoser?.nameEn).toBe('Seam granola'); // untouched (I11 — no snapshot fix-ups)

    const winner = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, {
        action: 'update',
        clientUpdatedAt: T2,
        opId: 'b2000000-0000-4000-8000-000000000002',
        payload: { nameEn: 'Winner snapshot', energyKcal: 500, proteinG: 12, carbsG: 50, fatG: 20 },
      }), CTX_A, tx));
    expect(winner).toEqual({ outcome: 'applied' });
    const row = await inUserScopeTx(prisma, CTX_A, (tx) => repository.findUserFoodIncludingDeleted(tx, USER_A, entityId));
    expect(row?.nameEn).toBe('Winner snapshot');
    expect(row?.updatedAt.toISOString()).toBe(T2);
    expect(row?.lastOpId).toBe('b2000000-0000-4000-8000-000000000002');
  });

  it('delete ⇒ tombstone; re-create on the tombstoned id ⇒ rejected_deleted (no resurrection); delete idempotent', async () => {
    const entityId = '44444444-4444-4444-8444-444444444444';
    const removed = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, { action: 'delete', clientUpdatedAt: T2, opId: 'b2000000-0000-4000-8000-000000000003' }), CTX_A, tx));
    expect(removed).toEqual({ outcome: 'applied' });
    const again = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, { action: 'delete', clientUpdatedAt: T2 }), CTX_A, tx));
    expect(again).toEqual({ outcome: 'applied' }); // idempotent
    const resurrect = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, { clientUpdatedAt: T2 }), CTX_A, tx));
    expect(resurrect).toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
    const stale = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFood.apply(userFoodOp(entityId, { action: 'update', clientUpdatedAt: T2 }), CTX_A, tx));
    expect(stale).toEqual({ outcome: 'rejected', code: 'rejected_deleted', retryable: false });
  });

  it('batch retry after an ABORTED transaction ⇒ exactly one row (replay-safe application)', async () => {
    const entityId = '66666666-6666-4666-8666-666666666666';
    const op = userFoodOp(entityId, { opId: 'c3000000-0000-4000-8000-000000000001', payload: { nameEn: 'Retry granola', energyKcal: 300, proteinG: 6, carbsG: 50, fatG: 8 } });
    await expect(
      inUserScopeTx(prisma, CTX_A, async (tx) => {
        await handlers.userFood.apply(op, CTX_A, tx);
        throw new Error('simulated mid-batch database failure'); // abort ⇒ rollback
      }),
    ).rejects.toThrow('simulated mid-batch database failure');
    const retry = await inUserScopeTx(prisma, CTX_A, (tx) => handlers.userFood.apply(op, CTX_A, tx));
    expect(retry).toEqual({ outcome: 'applied' });
    const rows = await inUserScopeTx(prisma, CTX_A, (tx) => repository.searchPage(tx, USER_A, 'retry granola', 50, null));
    expect(rows.entries).toHaveLength(1);
  });

  it('the RLS backstop: an app-role write with NO user context is refused by the DATABASE (fail closed)', async () => {
    await expect(
      prisma.transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('TimeZone', 'UTC', true)`; // NO app.user_id
        return handlers.userFood.apply(userFoodOp('77777777-7777-4777-8777-777777777777'), CTX_A, tx);
      }),
    ).rejects.toThrow(); // WITH CHECK violation — the row never lands
    const page = await inUserScopeTx(prisma, CTX_A, (tx) => repository.searchPage(tx, USER_A, 'seam granola', 50, null));
    expect(page.entries.every((entry) => entry.id !== '77777777-7777-4777-8777-777777777777')).toBe(true);
  });
});

describe('favorite apply-handler through the frozen seam', () => {
  it('platform-food favorite ⇒ applied; duplicate active target with a NEW entity id ⇒ rejected_conflict (P2002)', async () => {
    const first = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000001', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000aaaa', action: 'create', clientUpdatedAt: T0, payload: { foodId: FOOD_F001 } }, CTX_A, tx));
    expect(first).toEqual({ outcome: 'applied' });
    const duplicate = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000002', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000bbbb', action: 'create', clientUpdatedAt: T1, payload: { foodId: FOOD_F001 } }, CTX_A, tx));
    expect(duplicate).toEqual({ outcome: 'rejected', code: 'rejected_conflict', retryable: false });
  });

  it('own user-food favorite ⇒ applied; a FOREIGN user-food target is the SAME generic rejection as an absent one (I7)', async () => {
    const ownFoodId = '44444444-4444-4444-8444-444444444444'; // A's (tombstoned earlier — use C's fresh food)
    // C creates an active user food; A favorites C's id — the explicit
    // predicate makes it indistinguishable from an absent id (I7).
    await inUserScopeTx(prisma, CTX_C, (tx) =>
      handlers.userFood.apply(userFoodOp('88888888-8888-4888-8888-888888888888', { opId: 'c3000000-0000-4000-8000-000000000002', payload: { nameEn: 'C own food', energyKcal: 10, proteinG: 1, carbsG: 1, fatG: 1 } }), CTX_C, tx));
    const foreign = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000003', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000cccc', action: 'create', clientUpdatedAt: T0, payload: { userFoodId: '88888888-8888-4888-8888-888888888888' } }, CTX_A, tx));
    const absent = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000004', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000dddd', action: 'create', clientUpdatedAt: T0, payload: { userFoodId: '99999999-9999-4999-8999-999999999999' } }, CTX_A, tx));
    expect(foreign).toEqual(absent);
    expect(foreign).toEqual({ outcome: 'rejected', code: 'rejected_validation', retryable: false });
    void ownFoodId;

    // C favorites its OWN food: applied.
    const own = await inUserScopeTx(prisma, CTX_C, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000005', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000eeee', action: 'create', clientUpdatedAt: T0, payload: { userFoodId: '88888888-8888-4888-8888-888888888888' } }, CTX_C, tx));
    expect(own).toEqual({ outcome: 'applied' });
  });

  it('favorite delete ⇒ tombstone; re-favorite with a NEW entity id ⇒ applied (a fresh id is a NEW favorite)', async () => {
    const removed = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000006', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000aaaa', action: 'delete', clientUpdatedAt: T2 }, CTX_A, tx));
    expect(removed).toEqual({ outcome: 'applied' });
    const refavorite = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.favorite.apply({ opId: 'd4000000-0000-4000-8000-000000000007', kind: 'favorite', entityId: 'd4000000-0000-4000-8000-00000000ffff', action: 'create', clientUpdatedAt: T2, payload: { foodId: FOOD_F001 } }, CTX_A, tx));
    expect(refavorite).toEqual({ outcome: 'applied' }); // the partial uniqueness binds ACTIVE rows only
  });
});

describe('the shared limiter — SYNC path, two-config proofs (§1.7)', () => {
  const PAYLOAD = { nameEn: 'Limiter probe', energyKcal: 5, proteinG: 0.5, carbsG: 0.5, fatG: 0.5 };

  async function applyCreates(config: TrackingConfigService, ctx: SyncOpContext, count: number, prefix: string): Promise<string[]> {
    const stack = makeStack(config);
    const outcomes: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const entityId = `${prefix}-0000-4000-8000-${index.toString().padStart(12, '0')}`;
      const outcome = await inUserScopeTx(prisma, ctx, (tx) =>
        stack.userFood.apply(
          {
            opId: `f6000000-0000-4000-8000-${(index + 1000).toString().padStart(11, '0')}${prefix.slice(-1)}`,
            kind: 'user_food',
            entityId,
            action: 'create',
            clientUpdatedAt: T0,
            payload: PAYLOAD,
          },
          ctx,
          tx,
        ),
      );
      outcomes.push(outcome.outcome === 'applied' ? 'applied' : outcome.code);
    }
    return outcomes;
  }

  it('hourly: cap 2 ⇒ applied, applied, rejected_rate_limited (retryable); cap 3 ⇒ applied ×3 then rejected', async () => {
    const cap2 = configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '2', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '1000' });
    const outcomes = await applyCreates(cap2, { userId: USER_D, deviceId: 'device-D' }, 3, 'e5000001');
    expect(outcomes).toEqual(['applied', 'applied', 'rejected_rate_limited']);
    const retryOutcome = await inUserScopeTx(prisma, { userId: USER_D, deviceId: 'device-D' }, async (tx) => {
      const stack = makeStack(cap2);
      return stack.userFood.apply(
        { opId: 'f6000000-0000-4000-8000-000000000009', kind: 'user_food', entityId: 'e5000001-0000-4000-8000-000000000009', action: 'create', clientUpdatedAt: T0, payload: PAYLOAD },
        { userId: USER_D, deviceId: 'device-D' },
        tx,
      );
    });
    expect(retryOutcome).toEqual({ outcome: 'rejected', code: 'rejected_rate_limited', retryable: true });

    // TWO-CONFIG: raising the cap changes the behavior at the threshold.
    const cap3 = configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '3', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '1000' });
    const outcomesCap3 = await applyCreates(cap3, { userId: USER_E, deviceId: 'device-E' }, 4, 'e5000002');
    expect(outcomesCap3).toEqual(['applied', 'applied', 'applied', 'rejected_rate_limited']);
  });

  it('daily: cap 2 with a high hourly cap ⇒ the DAY window trips, proving independent windows', async () => {
    const dayCap2 = configFor({ TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '1000', TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '2' });
    const outcomes = await applyCreates(dayCap2, { userId: USER_B, deviceId: 'device-B-fresh' }, 3, 'e5000003');
    expect(outcomes).toEqual(['applied', 'applied', 'rejected_rate_limited']);
  });
});

describe('delta providers through the frozen seam (§1.6)', () => {
  it('pages are deterministic (updatedAt, id) ascending, strictly after the cursor; tombstones carry NO payload; exhausted flag walks to the end', async () => {
    // A has exactly two user-food rows: 4444… (tombstoned) and 6666…
    // (Retry granola, active). Page of 2 ⇒ both, and EXHAUSTED (amend-2:
    // probe-based — the limit+1 fetch found no extra row, so the feed is
    // drained; TRUE = drained per the pinned polarity).
    const firstPage = await inUserScopeTx(prisma, CTX_A, (tx) => handlers.userFoodDelta.changesSince(null, 2, CTX_A, tx));
    expect(firstPage.changes).toHaveLength(2);
    expect(firstPage.exhausted).toBe(true);
    for (const change of firstPage.changes) {
      expect(change.kind).toBe('user_food');
      if (change.change === 'upsert') {
        expect(change.payload).toMatchObject({ provenance: 'user_created' });
      } else {
        expect(change.payload).toBeUndefined();
      }
    }
    // Ordering: (updatedAt, entityId) ascending.
    const keys = firstPage.changes.map((change) => `${change.updatedAt}:${change.entityId}`);
    expect([...keys].sort()).toEqual(keys);

    // Strictly after: the follow-up page is EMPTY and exhausted (drained —
    // end of collection renders like any other page, conventions §2).
    const last = firstPage.changes[firstPage.changes.length - 1]!;
    const secondPage = await inUserScopeTx(prisma, CTX_A, (tx) =>
      handlers.userFoodDelta.changesSince({ updatedAt: last.updatedAt, entityId: last.entityId }, 2, CTX_A, tx));
    expect(secondPage.changes).toEqual([]);
    expect(secondPage.exhausted).toBe(true);

    // The tombstoned 4444… entity propagates as a payload-less delete; the
    // active one as a full upsert snapshot.
    const tombstone = firstPage.changes.find((change) => change.entityId === '44444444-4444-4444-8444-444444444444');
    expect(tombstone?.change).toBe('delete');
    expect(tombstone?.payload).toBeUndefined();
    const upsert = firstPage.changes.find((change) => change.entityId === '66666666-6666-4666-8666-666666666666');
    expect(upsert?.change).toBe('upsert');
    expect(upsert?.payload).toMatchObject({ id: '66666666-6666-4666-8666-666666666666', provenance: 'user_created', nameEn: 'Retry granola' });
  });

  it('favorite delta pages mirror the same contract (upsert payloads carry the target snapshot)', async () => {
    const page = await inUserScopeTx(prisma, CTX_C, (tx) => handlers.favoriteDelta.changesSince(null, 10, CTX_C, tx));
    const upsert = page.changes.find((change) => change.change === 'upsert');
    expect(upsert?.kind).toBe('favorite');
    expect(upsert?.payload).toMatchObject({ foodId: null, userFoodId: '88888888-8888-4888-8888-888888888888' });
  });
});
