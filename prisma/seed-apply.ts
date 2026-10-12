/**
 * Kal — seed execution module: curated Egyptian core pack (wave-03 contract
 * §8; lane s2a owns seed execution — the manifest itself is s1's authority,
 * `seed-manifest.ts`, and is never edited by this lane).
 *
 * Extracted from `seed.ts` (behavior-identical) so the integration suite can
 * run the seed against an ephemeral database and prove the contract's
 * required case: the seed loads IDEMPOTENTLY from the manifest (re-runs
 * upsert, never duplicate) with manifest↔seed value fidelity.
 *
 * Values are ENGINEERING-INITIAL pending founder nutrition review (ledger
 * §7-E2, HD-12). Ids are the manifest's fixed synthetic UUIDs (reserved
 * fixture range `…f0nn`/`…f1nn`) so re-runs upsert and both repositories
 * (backend seed + app core-pack asset) reference identical ids. The platform
 * catalog tables are RLS-declined (no user scope) — the seed's admin
 * connection writes them without any GUC setup; that is the documented
 * posture, not an accident.
 */
import type { PrismaClient } from '../generated/prisma/client.ts';
import { SEED_FOODS } from './seed-manifest.ts';
import { SEED_EXERCISES } from './seed-exercises.ts';

export interface FoodCatalogSeedResult {
  readonly foods: number;
  readonly servingVariants: number;
}

/**
 * Applies the food-catalog seed (upsert per manifest row and per serving
 * variant). Idempotent: replaying against a seeded database changes no values
 * (upsert-by-fixed-id; serving variants likewise).
 */
export async function applyFoodCatalogSeed(prisma: PrismaClient): Promise<FoodCatalogSeedResult> {
  for (const food of SEED_FOODS) {
    await prisma.food.upsert({
      where: { id: food.id },
      update: {
        type: food.type,
        provenance: food.provenance,
        licensePartition: 'proprietary',
        nameEn: food.nameEn,
        nameEnNormalized: food.nameEnNormalized,
        nameAr: food.nameAr,
        nameArNormalized: food.nameArNormalized,
        aliases: [...food.aliases],
        aliasesNormalized: [...food.aliasesNormalized],
        energyKcal: food.energyKcal,
        proteinG: food.proteinG,
        carbsG: food.carbsG,
        fatG: food.fatG,
      },
      create: {
        id: food.id,
        type: food.type,
        provenance: food.provenance,
        licensePartition: 'proprietary',
        nameEn: food.nameEn,
        nameEnNormalized: food.nameEnNormalized,
        nameAr: food.nameAr,
        nameArNormalized: food.nameArNormalized,
        aliases: [...food.aliases],
        aliasesNormalized: [...food.aliasesNormalized],
        energyKcal: food.energyKcal,
        proteinG: food.proteinG,
        carbsG: food.carbsG,
        fatG: food.fatG,
      },
    });
    for (const variant of food.servingVariants) {
      await prisma.servingVariant.upsert({
        where: { id: variant.id },
        update: {
          foodId: food.id,
          labelEn: variant.labelEn,
          labelAr: variant.labelAr,
          grams: variant.grams,
          isDefault: variant.isDefault,
        },
        create: {
          id: variant.id,
          foodId: food.id,
          labelEn: variant.labelEn,
          labelAr: variant.labelAr,
          grams: variant.grams,
          isDefault: variant.isDefault,
        },
      });
    }
  }
  const [foods, servingVariants] = await Promise.all([
    prisma.food.count(),
    prisma.servingVariant.count(),
  ]);
  return { foods, servingVariants };
}

export interface ExerciseCatalogSeedResult {
  readonly exercises: number;
}

/**
 * Applies the exercise-catalog seed (wave-04 contract note §8 — upsert per
 * manifest row). Idempotent: replaying against a seeded database changes no
 * values (upsert-by-fixed-id). The catalog is RLS-declined platform data —
 * the seed's admin connection writes it without any GUC setup (the
 * documented posture). Content is ENGINEERING-INITIAL pending founder
 * review (ledger §7-C).
 */
export async function applyExerciseCatalogSeed(prisma: PrismaClient): Promise<ExerciseCatalogSeedResult> {
  for (const exercise of SEED_EXERCISES) {
    await prisma.exercise.upsert({
      where: { id: exercise.id },
      update: {
        provenance: exercise.provenance,
        nameEn: exercise.nameEn,
        nameEnNormalized: exercise.nameEnNormalized,
        nameAr: exercise.nameAr,
        nameArNormalized: exercise.nameArNormalized,
        aliases: [...exercise.aliases],
        aliasesNormalized: [...exercise.aliasesNormalized],
        instructionsEn: exercise.instructionsEn,
        instructionsAr: exercise.instructionsAr,
        muscleGroups: [...exercise.muscleGroups],
        tags: [...exercise.tags],
      },
      create: {
        id: exercise.id,
        provenance: exercise.provenance,
        nameEn: exercise.nameEn,
        nameEnNormalized: exercise.nameEnNormalized,
        nameAr: exercise.nameAr,
        nameArNormalized: exercise.nameArNormalized,
        aliases: [...exercise.aliases],
        aliasesNormalized: [...exercise.aliasesNormalized],
        instructionsEn: exercise.instructionsEn,
        instructionsAr: exercise.instructionsAr,
        muscleGroups: [...exercise.muscleGroups],
        tags: [...exercise.tags],
      },
    });
  }
  return { exercises: await prisma.exercise.count() };
}
