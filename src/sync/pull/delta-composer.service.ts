/**
 * Kal — the delta composer: one page of the per-user change feed assembled
 * through the frozen provider registry (wave-03 contract note §1.6/§4).
 *
 * Determinism is the contract: the merged feed is ordered by the frozen
 * global order `(updatedAt, kind, entityId)` ascending — a total order —
 * and pagination continues strictly after the cursor position, so the same
 * server state always renders the same pages (conventions §2). The kind is
 * the middle key: two providers' changes at the same instant interleave by
 * kind, and each provider's own page is `(updatedAt, entityId)` within its
 * constant kind (the canonical seam's per-kind resume key).
 *
 * Cursor decomposition (sync's assembly concern — the canonical providers
 * page per-kind): the verified GLOBAL position is translated per provider —
 *   - the position's own kind resumes strictly after `(updatedAt, entityId)`;
 *   - kinds sorting AFTER it own every change at the boundary instant (the
 *     kind tiebreak decides before entityId) → resume at-or-after, sentinel
 *     entity `CURSOR_ENTITY_MIN`;
 *   - kinds sorting BEFORE it own none of them → strictly later instants,
 *     sentinel entity `CURSOR_ENTITY_MAX`.
 * Both sentinels sit outside the v4 UUID space, so no real id collides; the
 * decomposition is pure and deterministic.
 *
 * Envelope ownership: the composer SERIALIZES the wire shape — `delete`
 * changes structurally carry no `payload` member (a tombstone can never
 * leak one, even from a misbehaving provider), `upsert` carries the full
 * snapshot verbatim (bootstrap = same mechanism, note §1.6), and
 * `updatedAt` is the provider-emitted ISO instant carried verbatim.
 *
 * End of collection: `nextCursor: null` ⇔ the feed is fully drained — the
 * page is short of nothing (nothing truncated) AND every composed provider
 * reports exhausted. Otherwise the cursor advances to the page's last
 * change; a page that follows may legitimately be empty and renders like
 * any other page (conventions §2) before the final `null`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import {
  CURSOR_ENTITY_MAX,
  CURSOR_ENTITY_MIN,
  type DeltaChange,
  type DeltaCursorState,
  type GlobalCursorPosition,
  type SyncOpContext,
  type SyncOpKind,
  type TrackingDeltaProvider,
} from './seams.js';
import { SyncDeltaRegistry } from './delta-registry.js';

/** The wire form of one change (note §1.6). */
export interface DeltaChangeWire {
  readonly kind: SyncOpKind;
  readonly entityId: string;
  readonly change: 'upsert' | 'delete';
  /** ISO 8601 UTC instant (conventions §0), verbatim from the provider. */
  readonly updatedAt: string;
  /** Present for `upsert` only; `delete` is a bare tombstone. */
  readonly payload?: unknown;
}

export interface ComposedPullPage {
  readonly changes: readonly DeltaChangeWire[];
  /** True ⇔ nothing remains in the feed after this page (⇒ nextCursor null). */
  readonly endOfCollection: boolean;
  /** The global position after this page's last change — null when the page is empty. */
  readonly lastState: GlobalCursorPosition | null;
}

/** The frozen deterministic order: `(updatedAt, kind, entityId)` ascending. */
function compareChanges(a: DeltaChange, b: DeltaChange): number {
  const byTime = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.entityId !== b.entityId) {
    return a.entityId < b.entityId ? -1 : 1;
  }
  return 0;
}

/**
 * Translates the verified global position into one provider's per-kind
 * resume key (see the module docblock). `null` (first pull) passes through:
 * every provider starts at its beginning — bootstrap = same mechanism.
 */
export function decomposeCursorPosition(cursor: GlobalCursorPosition | null, kind: SyncOpKind): DeltaCursorState | null {
  if (cursor === null) {
    return null;
  }
  if (cursor.kind === kind) {
    return { updatedAt: cursor.updatedAt, entityId: cursor.entityId };
  }
  return {
    updatedAt: cursor.updatedAt,
    entityId: cursor.kind < kind ? CURSOR_ENTITY_MIN : CURSOR_ENTITY_MAX,
  };
}

@Injectable()
export class SyncDeltaComposer {
  constructor(private readonly registry: SyncDeltaRegistry) {}

  /**
   * Composes one page (≤ `limit` changes) from every registered provider,
   * inside the caller's transaction (`tx` already carries the
   * per-transaction posture: `SET LOCAL ROLE kal_app` + the user's
   * `app.user_id` GUC + TimeZone UTC). `cursor === null` is bootstrap.
   */
  async compose(
    cursor: GlobalCursorPosition | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<ComposedPullPage> {
    const kinds = this.registry.registeredKinds();
    const providers: TrackingDeltaProvider[] = [];
    const pages: DeltaChange[][] = [];
    const exhausted: boolean[] = [];

    for (const kind of kinds) {
      const provider = this.registry.providerFor(kind);
      if (provider === undefined) {
        continue; // unreachable (kinds come from the registry) — kept for explicitness
      }
      providers.push(provider);
      const page = await provider.changesSince(decomposeCursorPosition(cursor, kind), limit, ctx, tx);
      pages.push([...page.changes]);
      exhausted.push(page.exhausted);
    }

    // Stable sort over the merged feed: deterministic given each provider's
    // deterministic page (seam contract); identical (kind, entityId) ties
    // cannot occur across kinds (kind is part of the key).
    const merged = pages.flat().sort(compareChanges);

    const truncated = merged.length > limit;
    const page = truncated ? merged.slice(0, limit) : merged;
    const endOfCollection = !truncated && (providers.length === 0 || exhausted.every(Boolean));

    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const lastState =
      last === undefined ? null : { updatedAt: last.updatedAt, kind: last.kind, entityId: last.entityId };

    return {
      changes: page.map(serializeChange),
      endOfCollection,
      lastState,
    };
  }
}

/** The composer owns the envelope shape: a tombstone structurally has no payload. */
function serializeChange(change: DeltaChange): DeltaChangeWire {
  const wire: DeltaChangeWire = {
    kind: change.kind,
    entityId: change.entityId,
    change: change.change,
    updatedAt: change.updatedAt,
  };
  if (change.change === 'upsert' && change.payload !== undefined) {
    return { ...wire, payload: change.payload };
  }
  return wire;
}
