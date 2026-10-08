/**
 * Kal — wire projections for the foods surface (wave-03 contract §2 read
 * shapes: "§2 read shapes are the projection of the same snapshot" as the
 * sync payloads — §1.1).
 *
 * Every food payload carries its provenance tier (FR-011 data basis:
 * kal_reviewed | imported | user_created; `vendor_declared` is the Phase 3
 * reserved tier — type only, no W3 code path). Platform rows carry their
 * license partition (attribution obligations travel with the row —
 * ARCHITECTURE §19; ODbL rows are license-partitioned, contract §5).
 *
 * Decimals serialize as JSON numbers: the columns are DECIMAL(9,2)/(9,3),
 * exact within double precision — `Number()` round-trips them losslessly
 * (Prisma Decimal's default JSON form is a string; never served raw).
 */
import type { Food, Favorite, Prisma, ServingVariant, UserFood, UserFoodServing } from '../../../generated/prisma/client.ts';
import type { OffProductSnapshot } from './barcode/barcode-lookup.port.js';

type Numeric = Prisma.Decimal | number | null;

/** Prisma Decimal | number → JSON number (see module doc). */
export function decimalToNumber(value: Numeric): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === 'number' ? value : value.toNumber();
}

export interface FoodItemProjection {
  readonly id: string | null;
  readonly type: string;
  readonly provenance: string;
  readonly licensePartition: string | null;
  readonly nameEn: string | null;
  readonly nameAr: string | null;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
}

export interface ServingVariantProjection {
  readonly id: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly grams: number;
  readonly isDefault: boolean;
}

/** Platform catalog food item (search item + detail `food` member). */
export function projectPlatformFood(food: Food): FoodItemProjection {
  return {
    id: food.id,
    type: food.type,
    provenance: food.provenance,
    licensePartition: food.licensePartition,
    nameEn: food.nameEn,
    nameAr: food.nameAr,
    energyKcal: decimalToNumber(food.energyKcal) as number,
    proteinG: decimalToNumber(food.proteinG) as number,
    carbsG: decimalToNumber(food.carbsG) as number,
    fatG: decimalToNumber(food.fatG) as number,
  };
}

export function projectServingVariant(variant: ServingVariant): ServingVariantProjection {
  return {
    id: variant.id,
    labelEn: variant.labelEn,
    labelAr: variant.labelAr,
    grams: decimalToNumber(variant.grams) as number,
    isDefault: variant.isDefault,
  };
}

/**
 * A caller-owned user food, projected as a food item. `type` is the
 * user-custom vocabulary value (the catalog's `user_custom` type never
 * appears on platform rows — schema doc); `provenance` is fixed
 * `user_created` — enforced by the write path, not stored (schema doc).
 */
export function projectUserFoodItem(food: UserFood): FoodItemProjection {
  return {
    id: food.id,
    type: 'user_custom',
    provenance: 'user_created',
    licensePartition: null,
    nameEn: food.nameEn,
    nameAr: food.nameAr,
    energyKcal: decimalToNumber(food.energyKcal) as number,
    proteinG: decimalToNumber(food.proteinG) as number,
    carbsG: decimalToNumber(food.carbsG) as number,
    fatG: decimalToNumber(food.fatG) as number,
  };
}

export interface UserFoodServingProjection {
  readonly id: string;
  readonly labelEn: string | null;
  readonly labelAr: string | null;
  readonly grams: number;
}

export interface UserFoodProjection extends FoodItemProjection {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly servings: readonly UserFoodServingProjection[];
}

/** Full user-food resource (REST 201 body member; delta-feed upsert payload). */
export function projectUserFood(
  food: UserFood,
  servings: readonly UserFoodServing[],
): UserFoodProjection {
  return {
    ...projectUserFoodItem(food),
    createdAt: food.createdAt.toISOString(),
    updatedAt: food.updatedAt.toISOString(),
    servings: servings.map((serving) => ({
      id: serving.id,
      labelEn: serving.labelEn,
      labelAr: serving.labelAr,
      grams: decimalToNumber(serving.grams) as number,
    })),
  };
}

/** Favorite snapshot (delta-feed upsert payload — full entity snapshot, §1.6). */
export function projectFavorite(favorite: Favorite): {
  readonly foodId: string | null;
  readonly userFoodId: string | null;
} {
  return { foodId: favorite.foodId, userFoodId: favorite.userFoodId };
}

/**
 * An adapter-resolved (Open Food Facts) product as a food item: provenance
 * `imported`, license partition `odbl` — the attribution obligations travel
 * with the payload (cached snapshot data, contract §2/§5). No catalog row
 * exists behind a W3 adapter hit (catalog imports are platform jobs; none
 * exists this wave — ledger §6), so `id` is null and the FR-012 gram weight
 * rides in the single package serving variant.
 */
export function projectOffSnapshotAsFood(snapshot: OffProductSnapshot): {
  readonly food: FoodItemProjection & { readonly servingVariants: readonly ServingVariantProjection[] };
} {
  return {
    food: {
      id: null,
      type: 'packaged',
      provenance: 'imported',
      licensePartition: 'odbl',
      nameEn: snapshot.nameEn,
      nameAr: snapshot.nameAr,
      energyKcal: snapshot.energyKcal,
      proteinG: snapshot.proteinG,
      carbsG: snapshot.carbsG,
      fatG: snapshot.fatG,
      servingVariants: [
        {
          id: `off:${snapshot.barcode}`,
          labelEn: 'Package',
          labelAr: 'عبوة',
          grams: snapshot.servingGrams,
          isDefault: true,
        },
      ],
    },
  };
}
