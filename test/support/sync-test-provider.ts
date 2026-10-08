/**
 * TEST SUPPORT — sanctioned-path seeding helpers (s2e lane). NOT shipped
 * surface code.
 *
 * Since s2a/s2c merged, the delta feed composes the REAL tracking providers
 * (registered at SyncModule init through the canonical seam); the pull
 * suites exercise those directly. What the e2e/itspec still need is a way
 * to place fixture rows — through the app role under the caller's
 * per-transaction posture (`SET LOCAL ROLE kal_app` + `app.user_id` GUC +
 * TimeZone UTC), exactly the write path the ingestion handler uses:
 *
 *   - `seedDiaryEntry` inserts a neutral fixture diary row (quick_add — the
 *     bare legal shape under the source-XOR CHECK) with an explicit
 *     `updated_at` so tests control feed ordering;
 *   - `tombstoneDiaryEntry` performs the §1.5 soft delete (deleted_at +
 *     updated_at bump) the delete handler performs.
 *
 * Values are synthetic fixture data (no real health content).
 */
import type { PrismaService } from '../../src/db/prisma.service.js';

/** Neutral fixture-shape diary row (synthetic values only). */
export interface SeedDiaryEntry {
  readonly userId: string;
  readonly id?: string;
  readonly localDate: string;
  readonly updatedAt: Date;
  readonly mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  /** Defaults to 'quick_add' — the bare legal shape under the source-XOR CHECK. */
  readonly entryMethod?: 'search' | 'recents' | 'favorites' | 'copy_yesterday' | 'quick_add' | 'barcode';
  readonly quantity?: number;
  readonly energyKcal?: number;
}

/** Inserts one diary entry THROUGH the app role (the production write path). */
export async function seedDiaryEntry(prisma: PrismaService, entry: SeedDiaryEntry): Promise<string> {
  const id = entry.id ?? crypto.randomUUID();
  await prisma.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${entry.userId}, true), set_config('TimeZone', 'UTC', true)`;
    await tx.$queryRaw`
      INSERT INTO diary_entries (id, user_id, local_date, meal_slot, entry_method, quantity, energy_kcal, protein_g, carbs_g, fat_g, status, updated_at)
      VALUES (${id}::uuid, ${entry.userId}::uuid, ${entry.localDate}::date,
              ${entry.mealSlot ?? 'breakfast'}, ${entry.entryMethod ?? 'quick_add'},
              ${entry.quantity ?? 100}, ${entry.energyKcal ?? 100}, ${entry.quantity ?? 100} * 0.1, 10, 2,
              'confirmed', ${entry.updatedAt})`;
  });
  return id;
}

/** Tombstones one entry THROUGH the app role — the delete path's write. */
export async function tombstoneDiaryEntry(prisma: PrismaService, userId: string, id: string, at: Date): Promise<void> {
  await prisma.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userId}, true), set_config('TimeZone', 'UTC', true)`;
    await tx.$queryRaw`UPDATE diary_entries SET deleted_at = ${at}, updated_at = ${at} WHERE id = ${id}::uuid`;
  });
}
