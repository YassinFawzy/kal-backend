/**
 * Kal — the journal session-create limiter (w4 contract §1.2/§6; the W3
 * user-food ruling applied to sessions, w04 ledger §7-B).
 *
 * ONE implementation, ONE enforcement point: the `journal_session` sync
 * apply-handler ticks the per-account counters
 * (`journal_session_create_counters`) through `assertCanCreateAndTick`
 * inside its unit-of-work transaction. Journal has NO REST mutation
 * surface (the w4 note §2 freeze — mutations exist only as sync ops), so —
 * unlike the W3 user-food limiter's two enforcement points — this limiter
 * has exactly one. Over-limit ⇒ per-op outcome `rejected_rate_limited`,
 * retryable `true`.
 *
 * Windows are ROLLING (window start = first tick inside it): one hour and
 * one 24 h window per account, SERVER-clock (PostgreSQL `now()` — never a
 * client or driver clock). Thresholds are config points ONLY (§6 —
 * JOURNAL_SESSION_CREATE_MAX_PER_HOUR/_DAY, engineering-initial DEFAULT
 * PENDING APPROVAL, ledger §7-B; never hardcoded; a two-config proof is a
 * required test). A rejected (over-limit) create does NOT tick: retry
 * storms must not extend their own lockout, and — the w3 "acked-not-
 * recorded" ruling, empirically pinned there and inherited — the SAME opId
 * retried after the window rolls off applies cleanly.
 *
 * Updates and deletes are NEVER rate-limited (§1.2). A tick that fails its
 * session INSERT rolls back with the transaction (same UoW — no phantom
 * consumption).
 */
import { Injectable } from '@nestjs/common';
import type { JournalTx } from '../journal-tx.js';
import { JournalConfigService } from '../../config/journal.config.js';

export type LimiterOutcome = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

interface CounterRow {
  hour_window_start: Date;
  hour_count: number;
  day_window_start: Date;
  day_count: number;
}

@Injectable()
export class SessionCreateRateLimiter {
  constructor(private readonly config: JournalConfigService) {}

  /**
   * Checks both rolling windows for the account and, when under both caps,
   * ticks them (+1/+1) — atomically, on the caller's transaction. Over-limit
   * returns the computed retry delay and ticks NOTHING.
   */
  async assertCanCreateAndTick(tx: JournalTx, userId: string): Promise<LimiterOutcome> {
    const maxPerHour = this.config.values.sessionCreateMaxPerHour;
    const maxPerDay = this.config.values.sessionCreateMaxPerDay;

    // Ensure the single per-account row exists (first tick races resolve on
    // the primary key). The row is created at ZERO — the single +1 tick is
    // the UPDATE below, so exactly one tick lands per applied create.
    await tx.$queryRaw`INSERT INTO journal_session_create_counters (user_id, hour_window_start, hour_count, day_window_start, day_count)
      VALUES (${userId}::uuid, now(), 0, now(), 0)
      ON CONFLICT (user_id) DO NOTHING`;
    const locked = await tx.$queryRaw<CounterRow[]>`SELECT hour_window_start, hour_count, day_window_start, day_count
      FROM journal_session_create_counters WHERE user_id = ${userId}::uuid FOR UPDATE`;
    const row = locked[0];
    if (row === undefined) {
      // Unreachable: the upsert above guarantees the row (or failed the tx).
      throw new Error('limiter: counter row missing after upsert');
    }

    const evaluated = await tx.$queryRaw<
      { hour_count: number; day_count: number; retry_after_seconds: number | null }[]
    >`WITH reset AS (
        UPDATE journal_session_create_counters
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

    await tx.$queryRaw`UPDATE journal_session_create_counters
      SET hour_count = hour_count + 1, day_count = day_count + 1
      WHERE user_id = ${userId}::uuid`;
    return { ok: true };
  }
}
