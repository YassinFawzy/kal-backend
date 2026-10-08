/**
 * Kal — the foods surface service (wave-03 contract §2; PRD §9 workflows).
 *
 * Sanctioned path per mutation/read: controller → service (validate →
 * authorize → unit-of-work in the app-role/user-scoped posture → project).
 * Errors are problem-details registry codes only (conventions §4/§5); denials
 * are byte-identical whether or not the object exists (I7); no health data in
 * logs (I12) — this module logs nothing.
 *
 * Surfaces:
 *   - `tracking.foods.search`   GET /tracking/foods — normalized query over
 *     platform foods + the caller's own non-deleted user foods (one ranked
 *     list; §2/§7 matching model), user-bound opaque cursor pagination.
 *   - `tracking.foods.get`      GET /tracking/foods/{foodId} — catalog detail;
 *     404 byte-identical for absent/malformed/foreign ids (I7).
 *   - `tracking.barcode.resolve` GET /tracking/barcode/{barcode} — the FROZEN
 *     pipeline order: platform product cache → OFF adapter seam →
 *     success-shaped `not_found` (FR-017; first resolution wins).
 *   - `tracking.user-foods.create` POST /tracking/user-foods — the ONLINE
 *     create path; same payload + validation as the sync op; ticks the SHARED
 *     limiter (§1.7); 429 + Retry-After over-limit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx, type TrackingTx } from './app-role-tx.js';
import type { OffProductSnapshot } from './barcode/barcode-lookup.port.js';
import { KAL_BARCODE_LOOKUP } from './barcode/barcode-lookup.port.js';
import { FoodsRepository } from './foods.repository.js';
import { TRACKING_NORMALIZER, type TrackingNormalizer } from './normalizer.port.js';
import { TrackingConfigService } from './tracking.config.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
} from './search-cursor.js';
import { UserFoodRateLimiter } from './user-food-rate-limiter.js';
import { validateUserFoodPayload } from './user-food.payload.js';
import {
  projectOffSnapshotAsFood,
  projectPlatformFood,
  projectServingVariant,
  projectUserFood,
  projectUserFoodItem,
  type FoodItemProjection,
} from './projection.js';

/** The frozen query-parameter contract (conventions §2 + contract §2). */
const QUERY_MAX_LENGTH = 80;
const LIMIT_DEFAULT = 50;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const BARCODE_PATTERN = /^[0-9]{8,14}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface FoodSearchItem {
  readonly id: string;
  readonly food: FoodItemProjection;
}

export interface FoodSearchResponse {
  readonly data: readonly FoodSearchItem[];
  readonly nextCursor: string | null;
}

export type BarcodeResolution =
  | { readonly result: 'resolved'; readonly food: FoodItemProjection & { readonly servingVariants: unknown } }
  | { readonly result: 'not_found' };

@Injectable()
export class FoodsService {
  constructor(
    private readonly db: PrismaService,
    private readonly repository: FoodsRepository,
    private readonly limiter: UserFoodRateLimiter,
    private readonly config: TrackingConfigService,
    private readonly requestContext: RequestContextService,
    @Inject(TRACKING_NORMALIZER) private readonly normalizer: TrackingNormalizer,
    @Inject(KAL_BARCODE_LOOKUP) private readonly barcodeLookup: { lookup(barcode: string): Promise<OffProductSnapshot | null> },
  ) {}

  /**
   * The validated consumer binding (I2). The bearer guard has already resolved
   * and stored it; the extra fail-closed check refuses any non-consumer plane
   * (consumer health surface) with the generic object-independent denial.
   */
  private requireConsumerUserId(): string {
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('FORBIDDEN');
    }
    return context.userId;
  }

  // -------------------------------------------------------------------------
  // tracking.foods.search — GET /tracking/foods
  // -------------------------------------------------------------------------

  async search(q: unknown, limitRaw: unknown, cursorRaw: unknown): Promise<FoodSearchResponse> {
    const userId = this.requireConsumerUserId();

    if (typeof q !== 'string') {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'q', message: 'is required.' }],
      });
    }
    const trimmedQuery = q.trim();
    if (trimmedQuery.length > QUERY_MAX_LENGTH) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'q', message: `must be at most ${QUERY_MAX_LENGTH} characters after trim.` }],
      });
    }

    const limit = FoodsService.parseLimit(limitRaw);

    let cursorState: ReturnType<typeof decodeSearchCursor> = null;
    if (cursorRaw !== undefined && cursorRaw !== null) {
      if (typeof cursorRaw !== 'string') {
        throw FoodsService.genericCursorRejection();
      }
      // One generic, byte-identical rejection for EVERY failure cause —
      // malformed, truncated, or a cursor minted for another user (I7).
      cursorState = decodeSearchCursor(cursorRaw, userId, this.config.values.searchCursorKey);
      if (cursorState === null) {
        throw FoodsService.genericCursorRejection();
      }
    }

    // Empty/whitespace-only query ⇒ the EMPTY result set — not an error (§2/§7).
    if (trimmedQuery.length === 0) {
      return { data: [], nextCursor: null };
    }

    const normalizedQuery = this.normalizer.normalize(trimmedQuery);

    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const { entries, exhausted } = await this.repository.searchPage(tx, userId, normalizedQuery, limit, cursorState);

      const platformIds = entries.filter((entry) => entry.kind === 'platform').map((entry) => entry.id);
      const userIds = entries.filter((entry) => entry.kind === 'user_food').map((entry) => entry.id);
      const [platformRows, userRows] = await Promise.all([
        platformIds.length > 0 ? this.repository.findManyCatalogFoods(tx, platformIds) : Promise.resolve([]),
        userIds.length > 0 ? this.repository.findManyOwnUserFoods(tx, userId, userIds) : Promise.resolve([]),
      ]);
      const platformById = new Map(platformRows.map((row) => [row.id, row]));
      const userById = new Map(userRows.map((row) => [row.id, row]));

      const data: FoodSearchItem[] = [];
      for (const entry of entries) {
        const platform = platformById.get(entry.id);
        if (platform !== undefined) {
          data.push({ id: platform.id, food: projectPlatformFood(platform) });
          continue;
        }
        const own = userById.get(entry.id);
        if (own !== undefined) {
          data.push({ id: own.id, food: projectUserFoodItem(own) });
        }
      }

      // nextCursor: null ⇔ end of collection (conventions §2); otherwise the
      // opaque, user-bound token for the position AFTER the last entry.
      const last = entries.at(-1);
      const nextCursor = exhausted && last !== undefined
        ? encodeSearchCursor({ rank: last.rank, id: last.id }, userId, this.config.values.searchCursorKey)
        : null;
      return { data, nextCursor };
    });
  }

  /** conventions §2: clamp 1–100, default 50; non-numeric ⇒ generic 400. */
  private static parseLimit(limitRaw: unknown): number {
    if (limitRaw === undefined || limitRaw === null || limitRaw === '') {
      return LIMIT_DEFAULT;
    }
    if (typeof limitRaw !== 'string' || !/^[0-9]+$/u.test(limitRaw)) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'limit', message: 'must be a positive integer.' }],
      });
    }
    return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Number(limitRaw)));
  }

  /** The one generic cursor-rejection body (byte-stable; no errors array). */
  private static genericCursorRejection(): KalProblemException {
    return new KalProblemException('VALIDATION_FAILED');
  }

  // -------------------------------------------------------------------------
  // tracking.foods.get — GET /tracking/foods/{foodId}
  // -------------------------------------------------------------------------

  async foodDetail(foodIdRaw: string): Promise<{ food: FoodItemProjection; servingVariants: unknown[] }> {
    const userId = this.requireConsumerUserId();
    // Malformed ids are the SAME generic 404 as absent ones — byte-identical,
    // no existence oracle (I7; contract §2).
    if (!UUID_PATTERN.test(foodIdRaw)) {
      throw new KalProblemException('NOT_FOUND');
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const food = await this.repository.findFood(tx, foodIdRaw);
      if (food === null) {
        throw new KalProblemException('NOT_FOUND');
      }
      const variants = await this.repository.findServingVariants(tx, food.id);
      return {
        food: projectPlatformFood(food),
        servingVariants: variants.map(projectServingVariant),
      };
    });
  }

  // -------------------------------------------------------------------------
  // tracking.barcode.resolve — GET /tracking/barcode/{barcode}
  // -------------------------------------------------------------------------

  async resolveBarcode(barcodeRaw: string): Promise<BarcodeResolution> {
    const userId = this.requireConsumerUserId();
    if (!BARCODE_PATTERN.test(barcodeRaw)) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'barcode', message: 'must be 8 to 14 digits.' }],
      });
    }

    // Adapter seam BEFORE the transaction: no provider IO inside the unit of
    // work. The dev adapter is in-memory; a live adapter lands behind the
    // same port without changing the pipeline (contract §2).
    const snapshot = await this.barcodeLookup.lookup(barcodeRaw);

    return inUserScopeTx(this.db, { userId }, async (tx) => {
      // 1. Platform product cache first (FROZEN order).

      const cached = await this.repository.findCacheByBarcode(tx, barcodeRaw);
      if (cached !== null) {
        return FoodsService.fromCache(cached.foodId, cached.payload, tx, this.repository);
      }

      // 2a. A seeded packaged catalog row — resolve and warm the cache
      // (first resolution wins).
      const platformFood = await this.repository.findFoodByBarcode(tx, barcodeRaw);
      if (platformFood !== null) {
        await this.repository.recordCacheResolution(tx, {
          barcode: barcodeRaw,
          source: 'platform',
          foodId: platformFood.id,
          payload: null,
        });
        const variants = await this.repository.findServingVariants(tx, platformFood.id);
        return {
          result: 'resolved' as const,
          food: {
            ...projectPlatformFood(platformFood),
            servingVariants: variants.map(projectServingVariant),
          },
        };
      }

      // 2b. Adapter miss ⇒ the success-shaped `not_found` (guided
      // label-create entry point — never an error, FR-017).
      if (snapshot === null) {
        return { result: 'not_found' as const };
      }

      // 2c. Adapter hit — cache it (first resolution wins; ODbL attribution
      // rides in the payload; no catalog row is written request-scope —
      // catalog imports are platform jobs, none exists in W3, ledger §6).
      const winner = await this.repository.recordCacheResolution(tx, {
        barcode: barcodeRaw,
        source: 'open_food_facts',
        foodId: null,
        payload: snapshot,
      });
      return FoodsService.fromCache(winner.foodId, winner.payload, tx, this.repository);
    });
  }

  private static async fromCache(
    foodId: string | null,
    payload: OffProductSnapshot | null,
    tx: TrackingTx,
    repository: FoodsRepository,
  ): Promise<BarcodeResolution> {
    if (foodId !== null) {
      const food = await repository.findFood(tx, foodId);
      if (food !== null) {
        const variants = await repository.findServingVariants(tx, food.id);
        return {
          result: 'resolved',
          food: { ...projectPlatformFood(food), servingVariants: variants.map(projectServingVariant) },
        };
      }
      // Cache row referencing a missing catalog row — resolve as the recorded
      // snapshot when one exists, else the generic not_found (fail closed).
    }
    if (payload !== null) {
      return { result: 'resolved', food: projectOffSnapshotAsFood(payload).food };
    }
    return { result: 'not_found' };
  }

  // -------------------------------------------------------------------------
  // tracking.user-foods.create — POST /tracking/user-foods (the ONLINE path)
  // -------------------------------------------------------------------------

  async createUserFood(body: unknown): Promise<{ userFood: ReturnType<typeof projectUserFood> }> {
    const userId = this.requireConsumerUserId();
    // Same payload shape + same validation as the sync op (§2).
    const validated = validateUserFoodPayload(body);
    if (!validated.ok) {
      throw new KalProblemException('VALIDATION_FAILED', { errors: validated.errors });
    }

    return inUserScopeTx(this.db, { userId }, async (tx) => {
      // The SHARED limiter (§1.7) — one implementation, both paths. Over-limit
      // ⇒ 429 + server-computed Retry-After; nothing is consumed.
      const limit = await this.limiter.assertCanCreateAndTick(tx, userId);
      if (!limit.ok) {
        throw new KalProblemException('RATE_LIMITED', { retryAfterSeconds: limit.retryAfterSeconds });
      }
      const clientUpdatedAt = new Date();
      // Server-generated id; REST-created rows have last_op_id NULL (§1.4).
      const insertedId = await this.repository.insertUserFood(tx, {
        userId,
        entityId: null,
        payload: validated.value,
        clientUpdatedAt,
        lastOpId: null,
      });
      // Re-read through the caller-scoped predicate — immediately visible to
      // the owner's REST reads and delta feed (contract §2).
      const created = await this.repository.findUserFoodIncludingDeleted(tx, userId, insertedId);
      if (created === null) {
        throw new KalProblemException('INTERNAL_ERROR');
      }
      const servings = await this.repository.listActiveServings(tx, userId, created.id);
      return { userFood: projectUserFood(created, servings) };
    });
  }
}
