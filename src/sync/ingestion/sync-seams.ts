/**
 * Kal — the frozen `sync` ↔ `tracking` op-handler seam (wave-03 contract §4).
 *
 * FREEZE (docs/api/wave-03-contract.md §4 — do not reshape per-lane): `sync`
 * owns the registries and dispatches op application ONLY through them;
 * `tracking` registers one handler per entity kind at module init (lanes
 * w03-s2a/w03-s2c) and implements the entity state machine INSIDE `apply`.
 * `sync` never queries tracking's tables; tracking never queries sync's
 * op-ledger tables (ARCHITECTURE §9 module gates — both modules reach the
 * database only through their own sanctioned service layer with a validated
 * UserContext under the per-transaction posture: `SET LOCAL ROLE kal_app` +
 * `app.user_id` GUC + `TimeZone UTC`; never session-level GUCs on pooled
 * clients).
 *
 * CANONICAL-TYPE NOTE (supervisor-routed, 2026-10-08): lane w03-s2c ships
 * the canonical §4 seam types at `src/tracking/sync-seams.ts`
 * (SyncOpContext/SyncOpHandler + the delta shapes). THIS file is the s2d
 * in-lane transcription of the same freeze, used only until the rebase onto
 * s2c's merge; at that point every type below is consumed as a TYPE-LEVEL
 * import from the canonical file (the sanctioned direction — tracking
 * implements, sync consumes) and this declaration set is removed. The
 * REGISTRY (this lane's handler registry + wiring in src/sync/ingestion)
 * stays sync-owned per §4.
 *
 * "Throw nothing: outcomes are values" — a handler expresses every
 * domain-level outcome (applied / rejected+code+retryable) as its return
 * value. A handler THROWING is an infrastructure failure: the whole batch
 * transaction rolls back and the caller retries with the same batch (§1.2);
 * it is never mapped to a per-op outcome.
 *
 * The delta-provider seam (`TrackingDeltaProvider` in the contract sketch)
 * is owned by the delta-pull lane (w03-s2e, `src/sync/pull/**`) and is
 * deliberately NOT declared here.
 */
import type { Prisma } from '../../../generated/prisma/client.ts';

/** The frozen entity-kind registry — exhaustive for W3 (contract §1.1). */
export type SyncEntityKind = 'diary_entry' | 'user_food' | 'favorite';

/** The frozen op actions (contract §1.1). */
export type SyncEntityAction = 'create' | 'update' | 'delete';

/**
 * Sync-domain per-op rejection codes (contract §1.3). These live in the ack
 * envelope ONLY — they are NOT problem-details registry codes (conventions
 * §4 stays intact; no new registry codes this wave).
 */
export type RejectionCode =
  | 'rejected_validation'
  | 'rejected_rate_limited'
  | 'rejected_conflict'
  | 'rejected_deleted';

/**
 * Context handed to every op handler (already authorized): the validated
 * UserContext binding (I2/I6) plus the batch's device metadata. The userId
 * is the sole ownership authority — op payloads carry client entity ids that
 * are never authorization (I6).
 */
export interface SyncOpContext {
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * One parsed, shape-validated sync operation (contract §1.1 envelope).
 * Field parity and primitive shapes are enforced by the batch parser BEFORE
 * any handler runs; handlers own entity-level validation (payload content,
 * meal slots, macros, source XOR) and surface `rejected_validation` as a
 * value.
 */
export interface SyncOpEnvelope {
  /** Stable client-generated operation id (UUID) — dedupe key with the user. */
  readonly opId: string;
  readonly kind: SyncEntityKind;
  /** Stable client-generated entity id (UUID) — never authorization (I6). */
  readonly entityId: string;
  readonly action: SyncEntityAction;
  /**
   * Client-authored LWW substrate parsed to an instant — stored as the
   * entity's `updated_at` (via the handler) and on the ledger row.
   */
  readonly clientUpdatedAt: Date;
  /**
   * The exact client-authored ISO 8601 UTC instant string, preserved so a
   * handler-side LWW comparator is not bounded by the driver's millisecond
   * Date precision (timestamptz(6) columns hold microseconds).
   */
  readonly clientUpdatedAtIso: string;
  /** `YYYY-MM-DD` on diary_entry ops; null on every other kind (§1.1 parity). */
  readonly localDate: string | null;
  /** Full entity snapshot for create/update; null for delete (§1.1 parity). */
  readonly payload: Readonly<Record<string, unknown>> | null;
}

/** The outcome value a handler returns — never thrown. */
export type SyncOpVerdict =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'rejected'; code: RejectionCode; retryable: boolean };

/** One op handler per entity kind. Implemented by tracking; consumed by sync. */
export interface SyncOpHandler {
  readonly kind: SyncEntityKind;
  apply(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<SyncOpVerdict>;
}
