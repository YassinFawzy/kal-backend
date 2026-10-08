/**
 * Kal — the `favorite` sync apply-handler (wave-03 contract §1.3 state
 * machine; tracking side of the frozen seam, §4).
 *
 * Favorites are created and removed EXCLUSIVELY via sync ops (schema doc —
 * no REST surface exists). The payload carries exactly one target: a platform
 * food id XOR the caller's OWN user-food id (schema CHECK XOR; the user-food
 * side carries the compound user reference, I3, so a cross-account target is
 * structurally impossible — the handler additionally rejects it generically).
 *
 * Entity semantics (frozen by the migration's grants matrix + schema doc):
 * favorites are CREATE + TOMBSTONE entities — the UPDATE grant covers only
 * the LWW/tombstone columns, so a target-retargeting update is not an
 * applicable snapshot and is rejected `rejected_validation` (retryable
 * false). A same-target update refreshes the LWW columns when it wins.
 * Duplicate active favorites on one target resolve to `rejected_conflict`
 * (the partial unique index is the structural backstop).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import { isUuid } from '../../request-context/user-context.js';
import type { SyncOpContext, SyncOpEnvelope, SyncOpHandler, SyncOpHandlerResult } from '../sync-seams.js';
import { FoodsRepository } from './foods.repository.js';
import { lwwOpWins } from './lww.js';
import { validateFavoritePayload, type FavoritePayload } from './user-food.payload.js';
import { rawWriteConstraintClass } from './raw-write-error.js';

const applied: SyncOpHandlerResult = { outcome: 'applied' };
function rejected(code: 'rejected_validation' | 'rejected_rate_limited' | 'rejected_conflict' | 'rejected_deleted', retryable: boolean): SyncOpHandlerResult {
  return { outcome: 'rejected', code, retryable };
}

@Injectable()
export class FavoriteOpHandler implements SyncOpHandler {
  readonly kind = 'favorite' as const;

  constructor(private readonly repository: FoodsRepository) {}

  async apply(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
    if (op.kind !== this.kind || !isUuid(op.entityId) || !isUuid(op.opId)) {
      return rejected('rejected_validation', false);
    }
    const clientUpdatedAtMs = Date.parse(op.clientUpdatedAt);
    if (!Number.isFinite(clientUpdatedAtMs) || (op.localDate !== undefined && op.localDate !== null)) {
      return rejected('rejected_validation', false); // localDate must be ABSENT on favorite ops (§1.1)
    }
    const clientUpdatedAt = new Date(clientUpdatedAtMs);

    const existing = await this.repository.findFavoriteIncludingDeleted(tx, ctx.userId, op.entityId);

    switch (op.action) {
      case 'create': {
        if (existing !== null) {
          return existing.deletedAt === null
            ? rejected('rejected_conflict', false) // entity-id misuse (§1.3)
            : rejected('rejected_deleted', false); // no resurrection (I9/§1.3)
        }
        const validated = validateFavoritePayload(op.payload);
        if (!validated.ok || validated.value === undefined) {
          return rejected('rejected_validation', false);
        }
        const target = await this.resolveTarget(tx, ctx, validated.value);
        if (target === null) {
          return rejected('rejected_validation', false); // absent/foreign/unownable target — one generic outcome
        }
        try {
          await this.repository.insertFavorite(tx, {
            userId: ctx.userId,
            entityId: op.entityId,
            foodId: validated.value.foodId,
            userFoodId: validated.value.userFoodId,
            clientUpdatedAt,
            opId: op.opId,
          });
        } catch (error) {
          const constraint = rawWriteConstraintClass(error);
          if (constraint === 'unique') {
            return rejected('rejected_conflict', false); // active duplicate for the same target
          }
          if (constraint === 'foreign_key') {
            return rejected('rejected_validation', false); // broken reference raced past the pre-check
          }
          throw error;
        }
        return applied;
      }
      case 'update': {
        if (existing === null) {
          return rejected('rejected_conflict', false);
        }
        if (existing.deletedAt !== null) {
          return rejected('rejected_deleted', false);
        }
        const validated = validateFavoritePayload(op.payload);
        if (!validated.ok || validated.value === undefined) {
          return rejected('rejected_validation', false);
        }
        const retargets =
          validated.value.foodId !== existing.foodId || validated.value.userFoodId !== existing.userFoodId;
        if (retargets) {
          return rejected('rejected_validation', false); // not an applicable snapshot (create + tombstone entity)
        }
        if (!lwwOpWins(clientUpdatedAtMs, op.opId, existing.updatedAt, existing.lastOpId)) {
          return applied; // LWW loser: recorded applied, changes nothing
        }
        await this.repository.refreshFavoriteLww(tx, {
          userId: ctx.userId,
          entityId: op.entityId,
          clientUpdatedAt,
          opId: op.opId,
        });
        return applied;
      }
      case 'delete': {
        if (existing === null || existing.deletedAt !== null) {
          return applied; // idempotent (§1.3)
        }
        await this.repository.tombstoneFavorite(tx, {
          userId: ctx.userId,
          entityId: op.entityId,
          clientUpdatedAt,
          opId: op.opId,
        });
        return applied;
      }
      default:
        return rejected('rejected_validation', false);
    }
  }

  /**
   * Target authorization: the platform food must exist; a user-food target
   * must be an ACTIVE row of the CALLER (the explicit predicate — a foreign
   * id is indistinguishable from an absent one, I7).
   */
  private async resolveTarget(
    tx: Prisma.TransactionClient,
    ctx: SyncOpContext,
    payload: FavoritePayload,
  ): Promise<{ ok: true } | null> {
    if (payload.foodId !== null) {
      const food = await this.repository.findFood(tx, payload.foodId);
      return food === null ? null : { ok: true };
    }
    if (payload.userFoodId !== null) {
      const ownFood = await this.repository.findUserFoodIncludingDeleted(tx, ctx.userId, payload.userFoodId);
      return ownFood !== null && ownFood.deletedAt === null ? { ok: true } : null;
    }
    return null;
  }
}
