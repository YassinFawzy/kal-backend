/**
 * Kal — the tracking-internal food-reference seam the diary lane consumes
 * (wave-03 contract §4 module gates; task contract "Module gates").
 *
 * The diary apply-handler must validate a payload's food REFERENCES without
 * ever resolving food CONTENT: the entry's nutrient snapshot is what the
 * client froze at log time (I11) — the catalog's current values must never
 * enter the diary write path (a correction to a food row can never rewrite
 * an entry, because the diary never looks at it).
 *
 * This port is deliberately existence/ownership-only. The default adapter
 * (below, this lane's file) performs the two referential reads against the
 * frozen schema tables with explicit user-scoped predicates (I1); when the
 * foods area (s2a) ships its lookup service, the TrackingModule can rebind
 * this port to it without touching diary logic — the module gate vs other
 * modules (sync, community, …) is unaffected either way: this is
 * tracking-internal wiring only.
 *
 * Failure is indistinguishable-by-design (I7): a reference that is absent,
 * malformed, or owned by ANOTHER user yields the same `false` — the caller
 * answers the per-op `rejected_validation` outcome byte-identically in all
 * three cases (RLS hides foreign rows; the explicit user predicate makes the
 * app layer agree with the database).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { DiaryEntrySnapshot } from './diary-snapshot.js';

export interface DiaryFoodResolutionPort {
  /**
   * True when every food reference in the snapshot is resolvable in the
   * caller's context: a platform food that exists, and/or the caller's OWN
   * non-deleted user food. Never reads (and never returns) nutrition.
   */
  validateDiaryReferences(tx: Prisma.TransactionClient, userId: string, snapshot: DiaryEntrySnapshot): Promise<boolean>;
}

/** Default adapter: referential reads only, explicit predicates, RLS-postured transaction. */
@Injectable()
export class DiaryFoodReferenceValidator implements DiaryFoodResolutionPort {
  async validateDiaryReferences(tx: Prisma.TransactionClient, userId: string, snapshot: DiaryEntrySnapshot): Promise<boolean> {
    if (snapshot.foodId !== undefined) {
      const food = await tx.food.findUnique({
        where: { id: snapshot.foodId },
        select: { id: true },
      });
      if (food === null) {
        return false; // unknown platform food — same rejection as any bad reference
      }
    }
    if (snapshot.userFoodId !== undefined) {
      // Compound user binding (I3): the row must exist AND be the caller's
      // own, non-deleted food. Foreign and absent are the same outcome here.
      const userFood = await tx.userFood.findFirst({
        where: { id: snapshot.userFoodId, userId, deletedAt: null },
        select: { id: true },
      });
      if (userFood === null) {
        return false;
      }
    }
    return true;
  }
}
