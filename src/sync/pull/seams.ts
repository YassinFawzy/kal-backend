/**
 * Kal — the sync-side view of the frozen `sync` ↔ `tracking` seam (wave-03
 * contract note §4) plus sync's own composition types.
 *
 * The CANONICAL seam declarations live in `src/tracking/sync-seams.ts`
 * (supervisor directive, post-s2c reconciliation: tracking implements, sync
 * consumes — type-level import across the seam, erased at runtime; the
 * registries and the cross-kind assembly stay sync-owned). This module
 * re-exports them for the pull path and adds ONLY sync-internal types:
 *
 *   - `GlobalCursorPosition`: the decoded cursor's position in the FROZEN
 *     global feed order `(updatedAt, kind, entityId)` ascending (§1.6).
 *     The opaque token is minted/verified by sync and carries this global
 *     position; the composer decomposes it into each provider's per-kind
 *     `DeltaCursorState` (`{updatedAt, entityId}`) at composition time.
 *   - `SYNC_ENTITY_KINDS`: the runtime form of the frozen kind registry
 *     (the canonical file declares the type; validation needs the values).
 *   - The decomposition sentinels: entity-id bounds that translate the
 *     global position into per-kind keysets (see delta-composer.service.ts).
 */
import { isUuid } from '../../request-context/user-context.js';
import type { SyncOpKind } from '../../tracking/sync-seams.js';

export type {
  DeltaChange,
  DeltaCursorState,
  SyncOpContext,
  SyncOpKind,
  TrackingDeltaProvider,
} from '../../tracking/sync-seams.js';

/** The entity-kind registry — frozen, exhaustive for W3 (note §1.1). */
export const SYNC_ENTITY_KINDS = ['diary_entry', 'user_food', 'favorite'] as const;

/**
 * The decoded cursor's position in the global feed order. `updatedAt` is
 * the millisecond-precision ISO 8601 UTC instant exactly as the feed served
 * it (the API's serialized precision, conventions §0) — carried verbatim so
 * "pagination continues strictly after the cursor" is evaluated on the same
 * values the client saw.
 */
export interface GlobalCursorPosition {
  readonly updatedAt: string;
  readonly kind: SyncOpKind;
  readonly entityId: string;
}

/**
 * Decomposition sentinels (both outside the v4 UUID space, so no real row
 * id can collide with them): kinds sorting AFTER the position's kind resume
 * at-or-after the boundary instant (`MIN` — every entity there is globally
 * after, the kind tiebreak having decided); kinds sorting BEFORE resume
 * strictly after it (`MAX` — nothing at the boundary instant qualifies).
 */
export const CURSOR_ENTITY_MIN = '00000000-0000-0000-0000-000000000000';
export const CURSOR_ENTITY_MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** True when `value` is one of the frozen kinds (runtime validation). */
export function isSyncEntityKind(value: string): value is SyncOpKind {
  return (SYNC_ENTITY_KINDS as readonly string[]).includes(value);
}

/** True when `value` is a syntactically valid entity id for cursor states. */
export function isCursorEntityId(value: string): boolean {
  return isUuid(value) || value === CURSOR_ENTITY_MIN || value === CURSOR_ENTITY_MAX;
}
