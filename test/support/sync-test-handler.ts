/**
 * TEST-ONLY sync seam handler — NO PRODUCTION SURFACE.
 *
 * The wave-03 contract (§4) freezes the `sync` ↔ `tracking` op-handler
 * registry; the REAL user-food/favorite handlers (s2a) and diary handler
 * (s2c) are registered by the sync module at init in the assembled system.
 * This handler exists for the lanes' OWN registry-scoped suites (unit fakes
 * + the integration itspec, which constructs its own registry): it
 * implements the frozen seam faithfully at miniature scale so the ingestion
 * engine's semantics (dedupe, ordering, atomicity, per-op outcomes,
 * Idempotency-Key, cross-user isolation) are provable in isolation, with
 * deterministic failure injection the real handlers do not offer:
 *
 *  - Implements the §1.3 state machine on the REAL `favorites` table
 *    (an adopted, RLS-guarded health table): create-on-active ⇒
 *    `rejected_conflict`; create-on-tombstone / update-on-tombstone ⇒
 *    `rejected_deleted`; update-on-absent ⇒ `rejected_conflict`;
 *    delete-of-absent/tombstoned ⇒ applied (idempotent no-write); LWW on
 *    `(clientUpdatedAt, opId)` with the REST-row (`last_op_id NULL`) rule.
 *  - Entity-level payload validation yields `rejected_validation`
 *    (validation precedes rate limiting, §1.3).
 *  - GRANT-FAITHFUL writes only: the favorites UPDATE grant covers the LWW/
 *    tombstone columns exclusively; a re-favorite is a NEW entity id.
 *  - Unique-predicate discipline: handlers PRE-READ their unique predicates
 *    (a 23505 inside the batch transaction poisons it — 25P02 cascade), so
 *    the deterministic rejection happens before any INSERT; a residual
 *    23505 (global cross-user entity-id collision — the §5-documented
 *    refusal — or a cross-request race) PROPAGATES and the engine's batch
 *    boundary converges it (rollback, zero partial state).
 *
 * The production e2e suite does NOT use this handler: it exercises the REAL
 * registered handlers (diary/user_food/favorite) end-to-end, including the
 * shared limiter's acked-not-recorded `rejected_rate_limited` path.
 */
import { Prisma } from '../../generated/prisma/client.ts';
import type {
  SyncOpContext,
  SyncOpEnvelope,
  SyncOpHandler,
  SyncOpHandlerResult,
} from '../../src/tracking/sync-seams.js';

export interface SyncTestHandlerOptions {
  /** When true for an op, the handler THROWS (infrastructure failure). */
  readonly failWhen?: (op: SyncOpEnvelope) => boolean;
  /** When true for an op, the handler returns `rejected_rate_limited`. */
  readonly rateLimitWhen?: (op: SyncOpEnvelope) => boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Rejection value helpers. */
const appliedVerdict: SyncOpHandlerResult = { outcome: 'applied' };
function rejected(code: 'rejected_validation' | 'rejected_conflict' | 'rejected_deleted'): SyncOpHandlerResult {
  return { outcome: 'rejected', code, retryable: false };
}

/**
 * The mini LWW comparator (§1.4): higher `clientUpdatedAt` wins; on equal
 * instants the lexicographically higher `opId` wins. A stored row with
 * `last_op_id NULL` (REST-created) loses to ANY sync op.
 */
export function lwwOpWins(
  opUpdatedAt: Date,
  opId: string,
  rowUpdatedAt: Date,
  rowLastOpId: string | null,
): boolean {
  if (rowLastOpId === null) {
    return true;
  }
  if (opUpdatedAt.getTime() !== rowUpdatedAt.getTime()) {
    return opUpdatedAt.getTime() > rowUpdatedAt.getTime();
  }
  return opId > rowLastOpId;
}

/** Creates the TEST-ONLY handler for the `favorite` kind. */
export function createFavoriteTestHandler(options: SyncTestHandlerOptions = {}): SyncOpHandler {
  return {
    kind: 'favorite',

    async apply(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
      if (options.failWhen?.(op) === true) {
        throw new Error('sync-test-handler: injected infrastructure failure');
      }
      if (options.rateLimitWhen?.(op) === true) {
        // §1.7: sync-domain retryable rejection — the op is NOT applied and
        // NOT recorded by the engine (retry after the window re-runs).
        return { outcome: 'rejected', code: 'rejected_rate_limited', retryable: true };
      }

      // Entity-level validation (§1.3: precedes rate limiting; the handler's
      // business rules — here a mini snapshot shape).
      if (op.action !== 'delete') {
        const validation = validateFavoritePayload(op);
        if (validation !== null) {
          return validation;
        }
      }

      // The canonical envelope carries the exact client-authored instant
      // STRING; the handler parses it (its own LWW substrate).
      const clientUpdatedAt = new Date(op.clientUpdatedAt);
      const existing = await (tx as Prisma.TransactionClient).favorite.findFirst({
        where: { id: op.entityId, userId: ctx.userId },
      });

      if (op.action === 'create') {
        if (existing !== null) {
          return existing.deletedAt === null ? rejected('rejected_conflict') : rejected('rejected_deleted');
        }
        // Pre-read the one-active-per-food predicate (the partial unique
        // index "favorites_active_user_food_key"): handlers own enforcing
        // their unique predicates by READING state — a 23505 raised inside
        // the batch transaction poisons it (25P02 cascade), so the
        // deterministic rejection happens before any INSERT (§1.3).
        const payload = (op.payload ?? {}) as Record<string, unknown>;
        const foodId = String(payload['foodId']);
        const activeForFood = await (tx as Prisma.TransactionClient).favorite.findFirst({
          where: { userId: ctx.userId, foodId, deletedAt: null },
        });
        if (activeForFood !== null) {
          return rejected('rejected_conflict');
        }
        // NOTE (deliberate, engine-design-faithful): a residual 23505 here
        // (e.g. a GLOBAL collision with another user's entity id — the
        // §5-documented refusal; or a cross-request race) PROPAGATES. A
        // caught-and-continued P2002 is impossible in-transaction: the
        // database has already aborted the batch. The engine's batch-
        // boundary path rolls back with zero partial state and converges.
        await (tx as Prisma.TransactionClient).favorite.create({
          data: {
            id: op.entityId,
            userId: ctx.userId,
            foodId,
            updatedAt: clientUpdatedAt,
            lastOpId: op.opId,
          },
        });
        return appliedVerdict;
      }

      if (op.action === 'update') {
        if (existing === null) {
          return rejected('rejected_conflict');
        }
        if (existing.deletedAt !== null) {
          return rejected('rejected_deleted');
        }
        // LWW: a loser is recorded applied and changes nothing (§1.3).
        if (!lwwOpWins(clientUpdatedAt, op.opId, existing.updatedAt, existing.lastOpId)) {
          return appliedVerdict;
        }
        // GRANT-FAITHFUL write: the frozen column matrix gives favorites
        // UPDATE on (updated_at, deleted_at, last_op_id) ONLY — entity
        // content is immutable per row; a re-favorite is a NEW entity id.
        await (tx as Prisma.TransactionClient).favorite.update({
          where: { id: existing.id },
          data: {
            updatedAt: clientUpdatedAt,
            lastOpId: op.opId,
          },
        });
        return appliedVerdict;
      }

      // delete: idempotent — the deletion goal already holds (§1.3).
      if (existing !== null && existing.deletedAt === null) {
        await (tx as Prisma.TransactionClient).favorite.update({
          where: { id: existing.id },
          data: {
            deletedAt: new Date(), // server-side tombstone instant (§1.3)
            updatedAt: clientUpdatedAt,
            lastOpId: op.opId,
          },
        });
      }
      return appliedVerdict;
    },
  };
}

/** Mini payload validation — `foodId` must be a UUID; no negative numbers. */
function validateFavoritePayload(op: SyncOpEnvelope): SyncOpHandlerResult | null {
  const payload = op.payload;
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return rejected('rejected_validation');
  }
  const record = payload as Record<string, unknown>;
  const foodId = record['foodId'];
  if (typeof foodId !== 'string' || !UUID_PATTERN.test(foodId)) {
    return rejected('rejected_validation');
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'number' && Number.isFinite(value) && value < 0) {
      return rejected('rejected_validation');
    }
  }
  return null;
}
