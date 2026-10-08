/**
 * Kal — the `user_food` sync apply-handler (wave-03 contract §1.3 state
 * machine; the tracking side of the frozen seam, §4).
 *
 * Sync dispatches here inside its batch transaction (already envelope-
 * validated and deduped); this handler owns the ENTITY state machine:
 * validate → authorize (the ctx binding is the only writer) → apply, with
 * outcomes as VALUES — it throws nothing. The shared user-food create limiter
 * (§1.7) is enforced HERE — inside tracking, no limiter logic in sync.
 *
 * Replay safety (I9): dedupe happens sync-side per (user, opId), but a batch
 * retry that re-runs this handler is still idempotent — the §1.3 state table
 * plus the LWW comparator guarantee a re-applied op changes nothing.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import { isUuid } from '../../request-context/user-context.js';
import type { SyncOpContext, SyncOpEnvelope, SyncOpHandler, SyncOpHandlerResult } from '../sync-seams.js';
import { FoodsRepository } from './foods.repository.js';
import { lwwOpWins } from './lww.js';
import { UserFoodRateLimiter } from './user-food-rate-limiter.js';
import { validateUserFoodPayload } from './user-food.payload.js';
import { rawWriteConstraintClass } from './raw-write-error.js';

const applied: SyncOpHandlerResult = { outcome: 'applied' };
function rejected(code: 'rejected_validation' | 'rejected_rate_limited' | 'rejected_conflict' | 'rejected_deleted', retryable: boolean): SyncOpHandlerResult {
  return { outcome: 'rejected', code, retryable };
}

@Injectable()
export class UserFoodOpHandler implements SyncOpHandler {
  readonly kind = 'user_food' as const;

  constructor(
    private readonly repository: FoodsRepository,
    private readonly limiter: UserFoodRateLimiter,
  ) {}

  async apply(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
    // Defensive envelope re-validation (sync pre-validates; the handler stays
    // total — outcomes are values, and hostile/corrupt envelopes must not
    // throw past the seam).
    if (op.kind !== this.kind || !isUuid(op.entityId) || !isUuid(op.opId)) {
      return rejected('rejected_validation', false);
    }
    const clientUpdatedAtMs = Date.parse(op.clientUpdatedAt);
    if (!Number.isFinite(clientUpdatedAtMs) || (op.localDate !== undefined && op.localDate !== null)) {
      // localDate must be ABSENT on user_food ops (§1.1 batch-shape parity).
      return rejected('rejected_validation', false);
    }
    const clientUpdatedAt = new Date(clientUpdatedAtMs);

    const existing = await this.repository.findUserFoodIncludingDeleted(tx, ctx.userId, op.entityId);

    switch (op.action) {
      case 'create': {
        if (existing !== null) {
          // Entity-id misuse on an active row; a tombstoned id is never
          // resurrected (§1.3) — a fresh entity id after delete is a NEW food.
          return existing.deletedAt === null
            ? rejected('rejected_conflict', false)
            : rejected('rejected_deleted', false);
        }
        const validated = validateUserFoodPayload(op.payload);
        if (!validated.ok) {
          return rejected('rejected_validation', false);
        }
        // Shared limiter (§1.7) — after validation, before application; the
        // tick commits atomically with the INSERT (one unit of work).
        const limit = await this.limiter.assertCanCreateAndTick(tx, ctx.userId);
        if (!limit.ok) {
          return rejected('rejected_rate_limited', true);
        }
        try {
          await this.repository.insertUserFood(tx, {
            userId: ctx.userId,
            entityId: op.entityId,
            payload: validated.value,
            clientUpdatedAt,
            lastOpId: op.opId,
          });
        } catch (error) {
          if (rawWriteConstraintClass(error) === 'unique') {
            return rejected('rejected_conflict', false); // concurrent same-entity create
          }
          throw error; // database failure aborts the batch (§1.2)
        }
        return applied;
      }
      case 'update': {
        if (existing === null) {
          return rejected('rejected_conflict', false); // client belief vs server truth — re-pull (§1.3)
        }
        if (existing.deletedAt !== null) {
          return rejected('rejected_deleted', false); // an update never undeletes (§1.3)
        }
        const validated = validateUserFoodPayload(op.payload);
        if (!validated.ok) {
          return rejected('rejected_validation', false);
        }
        if (!lwwOpWins(clientUpdatedAtMs, op.opId, existing.updatedAt, existing.lastOpId)) {
          return applied; // LWW loser: recorded applied, changes nothing (§1.3)
        }
        await this.repository.replaceUserFoodSnapshot(tx, {
          userId: ctx.userId,
          entityId: op.entityId,
          payload: validated.value,
          clientUpdatedAt,
          opId: op.opId,
        });
        return applied;
      }
      case 'delete': {
        if (existing === null || existing.deletedAt !== null) {
          return applied; // the deletion goal already holds — idempotent (§1.3)
        }
        await this.repository.tombstoneUserFood(tx, {
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
}
