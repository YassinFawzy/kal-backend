/**
 * Kal — the frozen `sync` ↔ `tracking` module seam (wave-03 contract §4).
 *
 * TRACKING-SIDE DECLARATION: `sync` owns the handler/delta registries and
 * dispatches op application and delta assembly ONLY through the interfaces
 * below; `tracking` implements them (lane s2a: user_food + favorite; lane
 * s2c: diary_entry) and registers the implementations with sync at module
 * init. `sync` never queries tracking's tables and vice versa (ARCHITECTURE
 * §9 module gates); every value crossing this seam is already user-authorized
 * (`SyncOpContext.userId` is the validated UserContext binding — I2/I6).
 *
 * Everything here is transcribed from the FROZEN wave-03 contract
 * (docs/api/wave-03-contract.md §1/§4); semantics live there, not in code:
 *   - the op envelope (§1.1) and batch ingestion are sync-owned;
 *   - the per-op application state machine (§1.3), LWW + tiebreak (§1.4),
 *     tombstones (§1.5) are implemented INSIDE tracking's handlers;
 *   - outcomes are VALUES — handlers throw nothing;
 *   - the user-food rate limit is enforced INSIDE tracking's user_food
 *     handler and inside tracking's REST controller — one limiter, one
 *     module (§1.7); sync holds no limiter logic.
 *
 * Registration (module init, sync-side): `registerOpHandler(handler)` and
 * `registerDeltaProvider(kind, provider)` — owned by the sync module (lanes
 * s2d/s2e); the tracking module exports the implementations for it.
 */
import type { Prisma } from '../../generated/prisma/client.ts';

/** Rejection codes for per-op outcomes (contract §1.3 — frozen, exhaustive). */
export type RejectionCode =
  | 'rejected_validation'
  | 'rejected_rate_limited'
  | 'rejected_conflict'
  | 'rejected_deleted';

/** The entity-kind registry (contract §1.1 — frozen, exhaustive for W3). */
export type SyncOpKind = 'diary_entry' | 'user_food' | 'favorite';

export type SyncOpAction = 'create' | 'update' | 'delete';

/** Outcome acked per op (contract §1.2): applied | duplicate | rejected. */
export type SyncOpOutcome = 'applied' | 'duplicate' | 'rejected';

/**
 * One sync operation, already envelope-validated and deduped by sync
 * (contract §1.1). `payload` is the full entity snapshot for create/update
 * (same shape both — no patch semantics) and ABSENT for delete; `localDate`
 * is present on diary_entry ops only. Field shapes per kind are frozen by
 * the implementing lanes' round-trip suites against the contract's field
 * lists (§2 read shapes are the projection of the same snapshot).
 */
export interface SyncOpEnvelope {
  /** Stable client-generated operation id — dedupe key, never authorization (I6). */
  readonly opId: string;
  readonly kind: SyncOpKind;
  /** Stable client-generated entity id — the row id; the server never re-ids. */
  readonly entityId: string;
  readonly action: SyncOpAction;
  /**
   * Client-authored ISO 8601 UTC instant — the LWW substrate and the entity's
   * stored `updated_at`. Never compared against the server clock.
   */
  readonly clientUpdatedAt: string;
  /** Required on diary_entry ops; ABSENT on all others (batch-shape rule, §1.1). */
  readonly localDate?: string;
  readonly payload?: unknown;
}

/** Context handed to every op handler / delta provider (already authorized). */
export interface SyncOpContext {
  readonly userId: string; // validated UserContext binding (I2/I6)
  readonly deviceId: string;
}

/** The handler result: outcomes are values — handlers throw nothing. */
export type SyncOpHandlerResult =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'rejected'; readonly code: RejectionCode; readonly retryable: boolean };

/** One op handler per entity kind (contract §4). */
export interface SyncOpHandler {
  readonly kind: SyncOpKind;
  apply(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<SyncOpHandlerResult>;
}

/**
 * One change record in the delta feed (contract §1.6). `upsert` carries the
 * full entity snapshot; `delete` carries no payload (tombstones propagate so
 * deleted rows never reappear; §1.5).
 */
export interface DeltaChange {
  readonly kind: SyncOpKind;
  readonly entityId: string;
  readonly change: 'upsert' | 'delete';
  /** The stored `updated_at` (the winning op's clientUpdatedAt) as an ISO instant. */
  readonly updatedAt: string;
  readonly payload?: unknown;
}

/**
 * The decoded sync cursor state for ONE entity kind (contract §1.6):
 * ordering is `(updatedAt, kind, entityId)` ascending, so within a kind the
 * resume key is `(updatedAt, entityId)`. The opaque, HMAC-tagged,
 * user-bound cursor token itself is minted/verified by sync (§4 — cursor
 * mint/verify is sync-owned); sync decodes the token into this state.
 */
export interface DeltaCursorState {
  /** ISO 8601 UTC instant of the last emitted change (strictly after). */
  readonly updatedAt: string;
  /** Entity id of the last emitted change (tiebreak — strictly after). */
  readonly entityId: string;
}

/** Delta assembly over the tracking module's own tables (contract §4). */
export interface TrackingDeltaProvider {
  readonly kind: SyncOpKind;
  /** Returns changes strictly after the cursor state, deterministic order, ≤ limit.
   *
   * `exhausted` polarity (SUPERVISOR AMENDMENT 2, 2026-10-08 — pinned after the
   * two tracking lanes shipped opposite readings): **TRUE ⇔ the provider is
   * DRAINED — no further changes exist strictly after the returned batch.**
   * FALSE ⇔ more may exist (compose the next page). Implementations may be
   * probe-based (know drained on a full final page) or conservative (report
   * drained only on a short/empty page) — both are polarity-conformant; the
   * composer treats an extra empty page as a normal page (conventions §2). */
  changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }>;
}
