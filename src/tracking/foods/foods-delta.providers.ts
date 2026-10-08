/**
 * Kal — delta providers for the tracking-owned entities (wave-03 contract
 * §1.6/§4): per-kind pages of the caller's OWN changes, deterministic
 * `(updatedAt, entityId)` ascending order, strictly after the sync-decoded
 * cursor state, `≤ limit` records. Upserts carry the FULL entity snapshot
 * (the same projection the REST reads serve); deletes carry no payload —
 * tombstones propagate so a stale pull can never resurrect a deleted row
 * (§1.5). Sync owns cursor mint/verify and the cross-kind merge; these
 * providers only page their own tables under the caller's binding (I1/I2).
 *
 * Page identity/order comes from the repository's raw page (minimal aliased
 * columns); full rows are then HYDRATED through the caller-scoped typed
 * client (explicit predicate, camelCase model fields — the ordering key is
 * carried separately so hydration order never matters).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import type { DeltaChange, DeltaCursorState, SyncOpContext, TrackingDeltaProvider } from '../sync-seams.js';
import { FoodsRepository } from './foods.repository.js';
import { projectFavorite, projectUserFood } from './projection.js';

/** Millisecond-precise ISO instant (matches the cursor ordering's truncation). */
function msIso(instant: Date): string {
  return new Date(Math.floor(instant.getTime() / 1000) * 1000).toISOString();
}

@Injectable()
export class UserFoodDeltaProvider implements TrackingDeltaProvider {
  readonly kind = 'user_food' as const;

  constructor(private readonly repository: FoodsRepository) {}

  async changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
    const page = await this.repository.userFoodChangePage(tx, ctx.userId, cursor, limit);
    const rows = await this.repository.findManyOwnUserFoodsIncludingDeleted(
      tx,
      ctx.userId,
      page.rows.map((row) => row.id),
    );
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const servings = await this.repository.listActiveServingsForMany(tx, ctx.userId, rows.map((row) => row.id));
    const byFood = new Map<string, typeof servings>();
    for (const serving of servings) {
      const list = byFood.get(serving.userFoodId) ?? [];
      list.push(serving);
      byFood.set(serving.userFoodId, list);
    }
    const changes: DeltaChange[] = page.rows.flatMap((pageRow): DeltaChange[] => {
      const row = rowById.get(pageRow.id);
      if (row === undefined) {
        return []; // unobservable: page ids come from the same scoped tables
      }
      if (row.deletedAt !== null) {
        return [{ kind: this.kind, entityId: row.id, change: 'delete' as const, updatedAt: msIso(row.updatedAt) }];
      }
      return [{
        kind: this.kind,
        entityId: row.id,
        change: 'upsert' as const,
        updatedAt: msIso(row.updatedAt),
        payload: projectUserFood(row, byFood.get(row.id) ?? []),
      }];
    });
    return { changes, exhausted: page.exhausted };
  }
}

@Injectable()
export class FavoriteDeltaProvider implements TrackingDeltaProvider {
  readonly kind = 'favorite' as const;

  constructor(private readonly repository: FoodsRepository) {}

  async changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
    const page = await this.repository.favoriteChangePage(tx, ctx.userId, cursor, limit);
    const rows = await this.repository.findManyOwnFavorites(
      tx,
      ctx.userId,
      page.rows.map((row) => row.id),
    );
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const changes: DeltaChange[] = page.rows.flatMap((pageRow): DeltaChange[] => {
      const row = rowById.get(pageRow.id);
      if (row === undefined) {
        return [];
      }
      if (row.deletedAt !== null) {
        return [{ kind: this.kind, entityId: row.id, change: 'delete' as const, updatedAt: msIso(row.updatedAt) }];
      }
      return [{
        kind: this.kind,
        entityId: row.id,
        change: 'upsert' as const,
        updatedAt: msIso(row.updatedAt),
        payload: projectFavorite(row),
      }];
    });
    return { changes, exhausted: page.exhausted };
  }
}
