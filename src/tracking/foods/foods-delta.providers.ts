/**
 * Kal — delta providers for the tracking-owned entities (wave-03 contract
 * §1.6/§4): per-kind pages of the caller's OWN changes, deterministic
 * `(updatedAt, entityId)` ascending order, strictly after the sync-decoded
 * cursor state, `≤ limit` records. Upserts carry the FULL entity snapshot
 * (the same projection the REST reads serve); deletes carry no payload —
 * tombstones propagate so a stale pull can never resurrect a deleted row
 * (§1.5). Sync owns cursor mint/verify and the cross-kind merge; these
 * providers only page their own tables under the caller's binding (I1/I2).
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
    const { rows, exhausted } = await this.repository.userFoodChangesPage(tx, ctx.userId, cursor, limit);
    const servings = await this.repository.listActiveServingsForMany(tx, ctx.userId, rows.map((row) => row.id));
    const byFood = new Map<string, typeof servings>();
    for (const serving of servings) {
      const list = byFood.get(serving.userFoodId) ?? [];
      list.push(serving);
      byFood.set(serving.userFoodId, list);
    }
    const changes: DeltaChange[] = rows.map((row) => {
      if (row.deletedAt !== null) {
        return { kind: this.kind, entityId: row.id, change: 'delete' as const, updatedAt: msIso(row.updatedAt) };
      }
      return {
        kind: this.kind,
        entityId: row.id,
        change: 'upsert' as const,
        updatedAt: msIso(row.updatedAt),
        payload: projectUserFood(row, byFood.get(row.id) ?? []),
      };
    });
    return { changes, exhausted };
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
    const { rows, exhausted } = await this.repository.favoriteChangesPage(tx, ctx.userId, cursor, limit);
    const changes: DeltaChange[] = rows.map((row) => {
      if (row.deletedAt !== null) {
        return { kind: this.kind, entityId: row.id, change: 'delete' as const, updatedAt: msIso(row.updatedAt) };
      }
      return {
        kind: this.kind,
        entityId: row.id,
        change: 'upsert' as const,
        updatedAt: msIso(row.updatedAt),
        payload: projectFavorite(row),
      };
    });
    return { changes, exhausted };
  }
}
