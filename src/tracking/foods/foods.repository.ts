/**
 * Kal — tracking foods repository (the ONLY data access this lane's services
 * and handlers use).
 *
 * Isolation posture (I1/I2 — every query here is explicit):
 *   - USER-OWNED tables (`user_foods`, `user_food_servings`, `favorites`)
 *     bind `userId` into EVERY statement — an absent predicate is a
 *     review-blocking defect; the surrounding transaction also carries the
 *     app-role/GUC posture (`app-role-tx.ts`) as the independent ADR-0002
 *     backstop (handlers run on sync's batch transaction, which sets the same
 *     posture per the frozen seam).
 *   - PLATFORM-plane tables (`foods`, `serving_variants`,
 *     `barcode_product_cache`, `user_food_create_counters`) are RLS-declined
 *     catalog/abuse-control state (contract §5) — no user predicate exists to
 *     bind (there is no user column); reads run in the app-role transaction
 *     for least privilege.
 *   - No method here queries diary or sync tables (module gate); sync talks
 *     to this module only through the frozen seam (handlers/providers).
 *
 * Entity-state writes are explicit raw SQL: the LWW substrate requires the
 * stored `updated_at` to equal the op's client-authored `clientUpdatedAt`
 * (contract §1.1/§1.4), and the generated client's `@updatedAt` directive
 * would overwrite client-authored values with server time. Raw statements run
 * under the same transaction, grants, and RLS policies — nothing bypassed.
 * Reads use the typed client where no such override exists.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { Food, Favorite, ServingVariant, UserFood, UserFoodServing } from '../../../generated/prisma/client.ts';
import type { OffProductSnapshot } from './barcode/barcode-lookup.port.js';
import type { TrackingTx } from './app-role-tx.js';
import type { SearchCursorState } from './search-cursor.js';
import { TRACKING_NORMALIZER, type TrackingNormalizer } from './normalizer.port.js';
import type { UserFoodPayload } from './user-food.payload.js';

export type BarcodeCacheSource = 'platform' | 'open_food_facts';

export interface BarcodeCacheRow {
  readonly id: string;
  readonly barcode: string;
  readonly source: BarcodeCacheSource;
  readonly foodId: string | null;
  readonly payload: OffProductSnapshot | null;
}

/** One ranked search page entry before hydration (contract §2 ordering). */
export interface SearchPageEntry {
  readonly id: string;
  readonly kind: 'platform' | 'user_food';
  readonly rank: number;
}

@Injectable()
export class FoodsRepository {
  constructor(
    // The frozen normalization pipeline (contract §7) via the module binding —
    // writers apply it to stored forms; the database never re-derives them.
    @Inject(TRACKING_NORMALIZER) private readonly normalizer: TrackingNormalizer,
  ) {}

  // -------------------------------------------------------------------------
  // Catalog search (platform + own user foods, one ranked union)
  // -------------------------------------------------------------------------

  /**
   * One ordered candidate page for the already-normalized query: rank 0 exact
   * normalized equality → 1 prefix → 2 substring containment, deterministic
   * tiebreak by id ascending (contract §2/§7 matching model). Platform foods
   * AND the caller's own non-deleted user foods in ONE list. Fetches
   * `limit + 1` entries so the caller can detect exhaustion. Empty queries
   * never reach this method (the service short-circuits to the empty set).
   */
  async searchPage(
    tx: TrackingTx,
    userId: string,
    normalizedQuery: string,
    limit: number,
    cursor: SearchCursorState | null,
  ): Promise<{ entries: SearchPageEntry[]; exhausted: boolean }> {
    const q = normalizedQuery;
    const cursorFilter = cursor
      ? Prisma.sql`WHERE (candidate.rank, candidate.id) > (${cursor.rank}::int, ${cursor.id}::text)`
      : Prisma.empty;
    const rows = await tx.$queryRaw<SearchPageEntry[]>`
      SELECT candidate.id, candidate.kind, candidate.rank
      FROM (
        SELECT f.id::text AS id,
               'platform'::text AS kind,
               LEAST(
                 CASE WHEN f.name_en_normalized = ${q} OR f.name_ar_normalized = ${q}
                           OR EXISTS (SELECT 1 FROM unnest(f.aliases_normalized) a WHERE a = ${q})
                      THEN 0 ELSE 3 END,
                 CASE WHEN strpos(f.name_en_normalized, ${q}) = 1 OR strpos(f.name_ar_normalized, ${q}) = 1
                           OR EXISTS (SELECT 1 FROM unnest(f.aliases_normalized) a WHERE strpos(a, ${q}) = 1)
                      THEN 1 ELSE 3 END,
                 CASE WHEN strpos(f.name_en_normalized, ${q}) > 0 OR strpos(f.name_ar_normalized, ${q}) > 0
                           OR EXISTS (SELECT 1 FROM unnest(f.aliases_normalized) a WHERE strpos(a, ${q}) > 0)
                      THEN 2 ELSE 3 END
               ) AS rank
        FROM foods f
        WHERE strpos(f.name_en_normalized, ${q}) > 0
           OR strpos(f.name_ar_normalized, ${q}) > 0
           OR EXISTS (SELECT 1 FROM unnest(f.aliases_normalized) a WHERE strpos(a, ${q}) > 0)
        UNION ALL
        SELECT u.id::text,
               'user_food'::text,
               LEAST(
                 CASE WHEN u.name_en_normalized = ${q} OR u.name_ar_normalized = ${q} THEN 0 ELSE 3 END,
                 CASE WHEN strpos(u.name_en_normalized, ${q}) = 1 OR strpos(u.name_ar_normalized, ${q}) = 1 THEN 1 ELSE 3 END,
                 CASE WHEN strpos(u.name_en_normalized, ${q}) > 0 OR strpos(u.name_ar_normalized, ${q}) > 0 THEN 2 ELSE 3 END
               ) AS rank
        FROM user_foods u
        WHERE u.user_id = ${userId}::uuid
          AND u.deleted_at IS NULL
          AND (strpos(u.name_en_normalized, ${q}) > 0 OR strpos(u.name_ar_normalized, ${q}) > 0)
      ) candidate
      ${cursorFilter}
      ORDER BY candidate.rank ASC, candidate.id ASC
      LIMIT ${limit + 1}`;
    const exhausted = rows.length > limit;
    return { entries: rows.slice(0, limit), exhausted };
  }

  // -------------------------------------------------------------------------
  // Platform catalog reads + barcode cache (platform plane, RLS declined)
  // -------------------------------------------------------------------------

  findFood(tx: TrackingTx, foodId: string): Promise<Food | null> {
    return tx.food.findUnique({ where: { id: foodId } });
  }

  findServingVariants(tx: TrackingTx, foodId: string): Promise<ServingVariant[]> {
    return tx.servingVariant.findMany({
      where: { foodId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  }

  findFoodByBarcode(tx: TrackingTx, barcode: string): Promise<Food | null> {
    return tx.food.findUnique({ where: { barcode } });
  }

  async findCacheByBarcode(tx: TrackingTx, barcode: string): Promise<BarcodeCacheRow | null> {
    const rows = await tx.$queryRaw<
      { id: string; barcode: string; source: BarcodeCacheSource; food_id: string | null; payload: OffProductSnapshot | null }[]
    >`SELECT id::text, barcode, source, food_id::text AS "food_id", payload
      FROM barcode_product_cache WHERE barcode = ${barcode} LIMIT 1`;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return { id: row.id, barcode: row.barcode, source: row.source, foodId: row.food_id, payload: row.payload };
  }

  /**
   * Records a resolution (first resolution wins — contract §2). The unique
   * barcode arbitrarates concurrent first resolutions: on conflict the
   * WINNER's row is re-read and returned; the caller resolves through it.
   */
  async recordCacheResolution(
    tx: TrackingTx,
    row: { barcode: string; source: BarcodeCacheSource; foodId: string | null; payload: OffProductSnapshot | null },
  ): Promise<BarcodeCacheRow> {
    await tx.$queryRaw`INSERT INTO barcode_product_cache (barcode, source, food_id, payload)
      VALUES (${row.barcode}, ${row.source}, ${row.foodId}::uuid, ${row.payload ? JSON.stringify(row.payload) : null}::jsonb)
      ON CONFLICT (barcode) DO NOTHING`;
    const cached = await this.findCacheByBarcode(tx, row.barcode);
    if (cached === null) {
      throw new Error('barcode cache: row missing after insert');
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // User foods (owned — explicit predicates everywhere)
  // -------------------------------------------------------------------------

  /** The §1.3 state lookup — INCLUDING tombstones (delete/update need them). */
  findUserFoodIncludingDeleted(tx: TrackingTx, userId: string, entityId: string): Promise<UserFood | null> {
    return tx.userFood.findFirst({ where: { id: entityId, userId } });
  }

  listActiveServings(tx: TrackingTx, userId: string, userFoodId: string): Promise<UserFoodServing[]> {
    return tx.userFoodServing.findMany({
      where: { userFoodId, userId, deletedAt: null },
      orderBy: { id: 'asc' },
    });
  }

  /** Active servings for MANY of the caller's foods (delta-page hydration). */
  listActiveServingsForMany(tx: TrackingTx, userId: string, userFoodIds: readonly string[]): Promise<UserFoodServing[]> {
    if (userFoodIds.length === 0) {
      return Promise.resolve([]);
    }
    return tx.userFoodServing.findMany({
      where: { userId, userFoodId: { in: [...userFoodIds] }, deletedAt: null },
    });
  }

  /** Inserts one serving set for a user food (REST create + update-op replacements). */
  async insertUserFoodServings(
    tx: TrackingTx,
    params: { userId: string; userFoodId: string; servings: UserFoodPayload['servings'] },
  ): Promise<void> {
    for (const serving of params.servings) {
      await tx.$queryRaw`INSERT INTO user_food_servings (user_food_id, user_id, label_en, label_ar, grams)
        VALUES (${params.userFoodId}::uuid, ${params.userId}::uuid, ${serving.labelEn}, ${serving.labelAr}, ${serving.grams})`;
    }
  }

  /**
   * Inserts a user food; `entityId` null ⇒ server-generated id (REST create).
   * Returns the inserted row id (RETURNING of THIS transaction's INSERT —
   * no lookup-by-guess).
   */
  async insertUserFood(
    tx: TrackingTx,
    params: {
      userId: string;
      entityId: string | null;
      payload: UserFoodPayload;
      clientUpdatedAt: Date;
      lastOpId: string | null;
    },
  ): Promise<string> {
    const p = params.payload;
    // Sync creates carry the client entity id; REST creates omit it so the
    // column default (gen_random_uuid()) assigns the server id. The columns
    // (not the VALUES) differ per case — an explicit NULL would bypass the
    // default and violate NOT NULL.
    const idColumn = params.entityId === null ? Prisma.empty : Prisma.sql`id, `;
    const idValue =
      params.entityId === null ? Prisma.empty : Prisma.sql`${params.entityId}::uuid, `;
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO user_foods
      (${idColumn}user_id, name_en, name_ar, name_en_normalized, name_ar_normalized,
       energy_kcal, protein_g, carbs_g, fat_g, updated_at, last_op_id)
      VALUES (${idValue}${params.userId}::uuid,
              ${p.nameEn}, ${p.nameAr},
              ${p.nameEn === null ? null : this.normalizer.normalize(p.nameEn)},
              ${p.nameAr === null ? null : this.normalizer.normalize(p.nameAr)},
              ${p.energyKcal}, ${p.proteinG}, ${p.carbsG}, ${p.fatG},
              ${params.clientUpdatedAt}, ${params.lastOpId}::uuid)
      RETURNING id::text`;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('user_foods: insert returned no id');
    }
    return row.id;
  }

  /** Hydration for a search page (platform side — catalog is public to authenticated users). */
  findManyCatalogFoods(tx: TrackingTx, ids: readonly string[]): Promise<Food[]> {
    return tx.food.findMany({ where: { id: { in: [...ids] } } });
  }

  /** Hydration for a search page (own user foods only — explicit predicate). */
  findManyOwnUserFoods(tx: TrackingTx, userId: string, ids: readonly string[]): Promise<UserFood[]> {
    return tx.userFood.findMany({ where: { id: { in: [...ids] }, userId, deletedAt: null } });
  }

  /** Delta hydration — the caller's rows by id (tombstones included). */
  findManyOwnUserFoodsIncludingDeleted(tx: TrackingTx, userId: string, ids: readonly string[]): Promise<UserFood[]> {
    return tx.userFood.findMany({ where: { id: { in: [...ids] }, userId } });
  }

  findManyOwnFavorites(tx: TrackingTx, userId: string, ids: readonly string[]): Promise<Favorite[]> {
    return tx.favorite.findMany({ where: { id: { in: [...ids] }, userId } });
  }

  /**
   * Applies a winning create/update snapshot: names + normalized projections
   * + macros + the LWW columns (stored `updated_at` = the op's
   * `clientUpdatedAt`, `last_op_id` = the op id — contract §1.4). Servings are
   * replaced as a set (old set soft-deleted — the migration's documented
   * update-op behavior).
   */
  async replaceUserFoodSnapshot(
    tx: TrackingTx,
    params: {
      userId: string;
      entityId: string;
      payload: UserFoodPayload;
      clientUpdatedAt: Date;
      opId: string;
    },
  ): Promise<void> {
    const p = params.payload;
    await tx.$queryRaw`UPDATE user_foods SET
        name_en = ${p.nameEn},
        name_ar = ${p.nameAr},
        name_en_normalized = ${p.nameEn === null ? null : this.normalizer.normalize(p.nameEn)},
        name_ar_normalized = ${p.nameAr === null ? null : this.normalizer.normalize(p.nameAr)},
        energy_kcal = ${p.energyKcal},
        protein_g = ${p.proteinG},
        carbs_g = ${p.carbsG},
        fat_g = ${p.fatG},
        updated_at = ${params.clientUpdatedAt},
        last_op_id = ${params.opId}::uuid
      WHERE id = ${params.entityId}::uuid AND user_id = ${params.userId}::uuid`;
    await tx.$queryRaw`UPDATE user_food_servings SET deleted_at = now()
      WHERE user_food_id = ${params.entityId}::uuid AND user_id = ${params.userId}::uuid AND deleted_at IS NULL`;
    await this.insertUserFoodServings(tx, { userId: params.userId, userFoodId: params.entityId, servings: p.servings });
  }

  /** Tombstone write (§1.3 delete): `deleted_at` server-side; LWW columns client-authored. */
  async tombstoneUserFood(
    tx: TrackingTx,
    params: { userId: string; entityId: string; clientUpdatedAt: Date; opId: string },
  ): Promise<void> {
    await tx.$queryRaw`UPDATE user_foods SET deleted_at = now(), updated_at = ${params.clientUpdatedAt}, last_op_id = ${params.opId}::uuid
      WHERE id = ${params.entityId}::uuid AND user_id = ${params.userId}::uuid`;
  }

  // -------------------------------------------------------------------------
  // Favorites (owned — explicit predicates everywhere)
  // -------------------------------------------------------------------------

  findFavoriteIncludingDeleted(tx: TrackingTx, userId: string, entityId: string): Promise<Favorite | null> {
    return tx.favorite.findFirst({ where: { id: entityId, userId } });
  }

  /** Favorite create: only the granted columns + target ids (INSERT is table-scoped). */
  async insertFavorite(
    tx: TrackingTx,
    params: {
      userId: string;
      entityId: string;
      foodId: string | null;
      userFoodId: string | null;
      clientUpdatedAt: Date;
      opId: string;
    },
  ): Promise<void> {
    await tx.$queryRaw`INSERT INTO favorites (id, user_id, food_id, user_food_id, updated_at, last_op_id)
      VALUES (${params.entityId}::uuid, ${params.userId}::uuid, ${params.foodId}::uuid, ${params.userFoodId}::uuid,
              ${params.clientUpdatedAt}, ${params.opId}::uuid)`;
  }

  /**
   * Favorite refresh of the LWW columns only. The migration's grants matrix
   * grants UPDATE on (`updated_at`, `deleted_at`, `last_op_id`) — favorites
   * are create + tombstone (schema doc); a retargeting update is NOT
   * applicable and is rejected by the handler as `rejected_validation`.
   */
  async refreshFavoriteLww(
    tx: TrackingTx,
    params: { userId: string; entityId: string; clientUpdatedAt: Date; opId: string },
  ): Promise<void> {
    await tx.$queryRaw`UPDATE favorites SET updated_at = ${params.clientUpdatedAt}, last_op_id = ${params.opId}::uuid
      WHERE id = ${params.entityId}::uuid AND user_id = ${params.userId}::uuid`;
  }

  async tombstoneFavorite(
    tx: TrackingTx,
    params: { userId: string; entityId: string; clientUpdatedAt: Date; opId: string },
  ): Promise<void> {
    await tx.$queryRaw`UPDATE favorites SET deleted_at = now(), updated_at = ${params.clientUpdatedAt}, last_op_id = ${params.opId}::uuid
      WHERE id = ${params.entityId}::uuid AND user_id = ${params.userId}::uuid`;
  }

  // -------------------------------------------------------------------------
  // Delta pages (contract §1.6 — per-kind, deterministic order, strictly after)
  // -------------------------------------------------------------------------

  /**
   * Minimal change-page rows for the delta providers (raw SQL, explicitly
   * aliased to camelCase — never SELECT *, whose snake_case keys would not
   * match the typed model). Ordering is the frozen (updatedAt, entityId)
   * ascending; the page fetches limit+1 so callers can detect exhaustion.
   * Providers hydrate full rows through the caller-scoped typed client.
   */
  async userFoodChangePage(
    tx: TrackingTx,
    userId: string,
    cursor: { readonly updatedAt: string; readonly entityId: string } | null,
    limit: number,
  ): Promise<ChangePage> {
    const rows = await tx.$queryRaw<ChangePageRow[]>`SELECT id::text AS "id", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM user_foods
      WHERE user_id = ${userId}::uuid ${cursorFilter(cursor)}
      ORDER BY date_trunc('millisecond', updated_at) ASC, id::text ASC
      LIMIT ${limit + 1}`;
    return { rows: rows.slice(0, limit), exhausted: rows.length > limit };
  }

  async favoriteChangePage(
    tx: TrackingTx,
    userId: string,
    cursor: { readonly updatedAt: string; readonly entityId: string } | null,
    limit: number,
  ): Promise<ChangePage> {
    const rows = await tx.$queryRaw<ChangePageRow[]>`SELECT id::text AS "id", updated_at AS "updatedAt", deleted_at AS "deletedAt"
      FROM favorites
      WHERE user_id = ${userId}::uuid ${cursorFilter(cursor)}
      ORDER BY date_trunc('millisecond', updated_at) ASC, id::text ASC
      LIMIT ${limit + 1}`;
    return { rows: rows.slice(0, limit), exhausted: rows.length > limit };
  }
}

export interface ChangePageRow {
  readonly id: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface ChangePage {
  readonly rows: ChangePageRow[];
  readonly exhausted: boolean;
}

function cursorFilter(cursor: { readonly updatedAt: string; readonly entityId: string } | null): Prisma.Sql {
  return cursor === null
    ? Prisma.empty
    : Prisma.sql`AND (date_trunc('millisecond', updated_at), id::text) > (${cursor.updatedAt}::timestamptz, ${cursor.entityId}::text)`;
}
