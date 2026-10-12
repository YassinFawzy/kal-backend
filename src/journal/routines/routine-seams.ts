/**
 * Kal — the journal-side view of the frozen `sync` ↔ `journal` seam
 * (wave-04 contract §4).
 *
 * PRE-UNION TRANSCRIPTION (the W3 s2d precedent): the canonical seam
 * declarations live in `src/tracking/sync-seams.ts`; its `SyncOpKind` union
 * is still the W3-exhaustive registry until the s2a merge lands the
 * `journal_session` widening. THIS lane owns the `journal_routine` widening
 * of that union ONLY at its post-s2a registration-union rebase (supervisor
 * ruling 1, wave-04 ledger: "at YOUR post-s2a rebase union you add
 * journal_routine to the same three sites"). Until that rebase this module
 * holds the STRUCTURAL MIRROR below — identical member-for-member to the
 * canonical seam except the widened kind — so the domain logic, handlers,
 * providers, and suites are complete and compilable now, and the union
 * commit is the mechanical, reviewable swap to canonical type-level imports
 * (`implements SyncOpHandler` and registry registration become valid there).
 *
 * NOTHING here relaxes semantics: outcomes are values (handlers throw
 * nothing), `SyncOpContext.userId` is the validated UserContext binding
 * (I2/I6), and the frozen per-op state machine lives inside this module's
 * handler exactly as the canonical seam requires.
 */
import type { Prisma } from '../../../generated/prisma/client.ts';

/** Rejection codes for per-op outcomes (frozen, exhaustive — no new codes in w4). */
export type RejectionCode =
  | 'rejected_validation'
  | 'rejected_rate_limited'
  | 'rejected_conflict'
  | 'rejected_deleted';

/**
 * The entity-kind registry as THIS lane sees it: the canonical union plus
 * the `journal_routine` kind this lane owns (additive; mirrors the s1
 * migration's `sync_operations_entity_kind_enum` widening).
 */
export type JournalSyncOpKind =
  | 'diary_entry'
  | 'user_food'
  | 'favorite'
  | 'journal_session'
  | 'journal_routine';

/** The kinds this lane touches (the union commit narrows this to the one kind). */
export type RoutineSyncOpKind = Extract<JournalSyncOpKind, 'journal_routine'>;

export type SyncOpAction = 'create' | 'update' | 'delete';

/** Outcome acked per op: applied | duplicate | rejected. */
export type SyncOpOutcome = 'applied' | 'duplicate' | 'rejected';

/**
 * One sync operation, already envelope-validated and deduped by sync —
 * structural mirror of the canonical `SyncOpEnvelope` with the widened
 * kind. `payload` is the full entity snapshot for create/update and ABSENT
 * for delete; `localDate` is ABSENT on `journal_routine` ops (a template
 * has no day — the envelope layer and the `sync_operations_local_date_parity`
 * CHECK both enforce the parity; the handler re-checks defensively).
 */
export interface RoutineOpEnvelope {
  /** Stable client-generated operation id — dedupe key, never authorization (I6). */
  readonly opId: string;
  readonly kind: RoutineSyncOpKind;
  /** Stable client-generated entity id — the row id; the server never re-ids. */
  readonly entityId: string;
  readonly action: SyncOpAction;
  /** Client-authored ISO 8601 UTC instant — the LWW substrate; never compared against the server clock. */
  readonly clientUpdatedAt: string;
  /** ABSENT on journal_routine ops (the local-date parity rule). */
  readonly localDate?: string;
  readonly payload?: unknown;
}

/** Context handed to every op handler / delta provider (already authorized). */
export interface RoutineOpContext {
  readonly userId: string; // validated UserContext binding (I2/I6)
  readonly deviceId: string;
}

/** The handler result: outcomes are values — handlers throw nothing. */
export type RoutineOpHandlerResult =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'rejected'; readonly code: RejectionCode; readonly retryable: boolean };

/** The handler half of the canonical `SyncOpHandler` seam (widened kind). */
export interface RoutineOpHandler {
  readonly kind: RoutineSyncOpKind;
  apply(
    op: RoutineOpEnvelope,
    ctx: RoutineOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<RoutineOpHandlerResult>;
}

/**
 * One change record in the delta feed: `upsert` carries the full entity
 * snapshot; `delete` carries no payload (tombstones propagate; §1.5).
 */
export interface RoutineDeltaChange {
  readonly kind: RoutineSyncOpKind;
  readonly entityId: string;
  readonly change: 'upsert' | 'delete';
  /** The stored `updated_at` (the winning op's clientUpdatedAt) as an ISO instant. */
  readonly updatedAt: string;
  readonly payload?: unknown;
}

/**
 * The decoded sync cursor state for ONE entity kind — structural mirror of
 * the canonical `DeltaCursorState` (ordering `(updatedAt, kind, entityId)`
 * ascending; within a kind the resume key is `(updatedAt, entityId)`; the
 * opaque user-bound token itself is minted/verified by sync).
 */
export interface RoutineDeltaCursorState {
  readonly updatedAt: string;
  readonly entityId: string;
}

/** The provider half of the canonical `TrackingDeltaProvider` seam (widened kind). */
export interface RoutineDeltaProvider {
  readonly kind: RoutineSyncOpKind;
  /** Changes strictly after the cursor state, deterministic order, ≤ limit.
   * TRUE ⇔ drained (no further changes exist strictly after the returned batch). */
  changesSince(
    cursor: RoutineDeltaCursorState | null,
    limit: number,
    ctx: RoutineOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: RoutineDeltaChange[]; exhausted: boolean }>;
}
