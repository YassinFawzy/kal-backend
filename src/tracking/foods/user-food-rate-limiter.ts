/**
 * Kal — the shared user-food create limiter (PRD §8; wave-03 contract §1.7).
 *
 * ONE implementation, TWO enforcement points: the REST create
 * (`POST /tracking/user-foods`) and the `user_food` sync apply-handler both
 * tick the SAME per-account counters (`user_food_create_counters`) through
 * `assertCanCreateAndTick` inside their unit-of-work transaction. REST
 * over-limit ⇒ `429 RATE_LIMITED` + `Retry-After` (the caller maps it); sync
 * over-limit ⇒ per-op outcome `rejected_rate_limited`, retryable `true`.
 *
 * Windows are ROLLING (window start = first tick inside it): one hour and one
 * 24 h window per account. Thresholds are config points ONLY (§6 — PRD §8
 * initial values, HD-23-tunable; never hardcoded). A rejected (over-limit)
 * create does NOT tick: the client is directed to retry after the window
 * rolls off, and retry storms must not extend their own lockout.
 *
 * `Retry-After` is SERVER-COMPUTED (contract §3): the time until every
 * exhausted window has rolled off (max over exhausted windows, ≥ 1 s),
 * computed in PostgreSQL clock arithmetic so it never depends on client or
 * driver clocks. A tick that fails its food INSERT rolls back with the
 * transaction (same UoW — no phantom consumption).
 */
import { Injectable } from '@nestjs/common';
import type { TrackingTx } from './app-role-tx.js';
import { TrackingConfigService } from './tracking.config.js';

export type LimiterOutcome = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

interface CounterRow {
  hour_window_start: Date;
  hour_count: number;
  day_window_start: Date;
  day_count: number;
}

@Injectable()
export class UserFoodRateLimiter {
  constructor(private readonly config: TrackingConfigService) {}

  /**
   * Checks both rolling windows for the account and, when under both caps,
   * ticks them (+1/+1) — atomically, on the caller's transaction. Over-limit
   * returns the computed retry delay and ticks NOTHING.
   */
  async assertCanCreateAndTick(tx: TrackingTx, userId: string): Promise<LimiterOutcome> {
    const maxPerHour = this.config.values.userFoodCreateMaxPerHour;
    const maxPerDay = this.config.values.userFoodCreateMaxPerDay;

    // Ensure the single per-account row exists (first tick races resolve on
    // the primary key). The row is created at ZERO — the single +1 tick is
    // the UPDATE below, so exactly one tick lands per applied create.
    await tx.$queryRaw`INSERT INTO user_food_create_counters (user_id, hour_window_start, hour_count, day_window_start, day_count)
      VALUES (${userId}::uuid, now(), 0, now(), 0)
      ON CONFLICT (user_id) DO NOTHING`;
    const locked = await tx.$queryRaw<CounterRow[]>`SELECT hour_window_start, hour_count, day_window_start, day_count
      FROM user_food_create_counters WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const row = locked[0];
    if (row === undefined) {
      // Unreachable: the upsert above guarantees the row (or failed the tx).
      throw new Error('limiter: counter row missing after upsert');
    }

    const evaluated = await tx.$queryRaw<
      { hour_count: number; day_count: number; retry_after_seconds: number | null }[]
    >`WITH reset AS (
        UPDATE user_food_create_counters
           SET hour_window_start = CASE WHEN hour_window_start <= now() - interval '1 hour' THEN now() ELSE hour_window_start END,
               hour_count        = CASE WHEN hour_window_start <= now() - interval '1 hour' THEN 0 ELSE hour_count END,
               day_window_start  = CASE WHEN day_window_start <= now() - interval '24 hours' THEN now() ELSE day_window_start END,
               day_count         = CASE WHEN day_window_start <= now() - interval '24 hours' THEN 0 ELSE day_count END
         WHERE user_id = ${userId}::uuid
        RETURNING hour_window_start, hour_count, day_window_start, day_count
      ), verdict AS (
        SELECT hour_count, day_count,
          CASE
            WHEN hour_count >= ${maxPerHour}::int AND day_count >= ${maxPerDay}::int THEN
              GREATEST(EXTRACT(EPOCH FROM (hour_window_start + interval '1 hour' - now())),
                       EXTRACT(EPOCH FROM (day_window_start + interval '24 hours' - now())))
            WHEN hour_count >= ${maxPerHour}::int THEN
              EXTRACT(EPOCH FROM (hour_window_start + interval '1 hour' - now()))
            WHEN day_count >= ${maxPerDay}::int THEN
              EXTRACT(EPOCH FROM (day_window_start + interval '24 hours' - now()))
            ELSE NULL
          END AS retry_after_seconds
        FROM reset
      )
      SELECT hour_count, day_count, retry_after_seconds FROM verdict`;

    const verdict = evaluated[0];
    if (verdict === undefined) {
      throw new Error('limiter: verdict missing after evaluation');
    }
    const retryAfterSeconds = verdict.retry_after_seconds;
    if (retryAfterSeconds !== null) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) };
    }

    await tx.$queryRaw`UPDATE user_food_create_counters
      SET hour_count = hour_count + 1, day_count = day_count + 1
      WHERE user_id = ${userId}::uuid`;
    return { ok: true };
  }
}
