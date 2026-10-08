/**
 * Kal — the per-transaction app-role + user-context posture for the tracking
 * module (F1 GUC pool guidance, wave-03 ledger §5 — BINDING).
 *
 * Every user-scoped tracking transaction runs the identity `inAppRoleTx`
 * pattern, extended with the user binding the adopted-table RLS policies read:
 *
 *     SET LOCAL ROLE kal_app            (least-privilege request-scope role)
 *     SET LOCAL app.user_id = <userId>  (the fail-closed RLS GUC)
 *     SET LOCAL TimeZone = 'UTC'        (timestamptz rendering invariant)
 *
 * `SET LOCAL` / `set_config(..., true)` is transaction-scoped: it reverts at
 * commit/rollback, so a POOLED connection never carries the role, the GUC, or
 * the zone into the next borrower's work — session-level GUCs on pooled
 * clients are forbidden (the exact hazard the guidance names).
 *
 * Every call site binds `ctx.userId` into its predicates explicitly (I1/I2);
 * the GUC is the independent database-side backstop (ADR-0002), never the
 * only isolation layer. Op handlers invoked by sync receive the batch's
 * transaction client (sync sets the same posture on it) and do NOT open
 * transactions of their own.
 */
import type { Prisma } from '../../../generated/prisma/client.ts';
import type { PrismaService } from '../../db/prisma.service.js';

export type TrackingTx = Prisma.TransactionClient;

/** Anything carrying the validated user binding (SyncOpContext is a superset). */
export interface SyncOpScope {
  readonly userId: string;
}

/** Runs the unit of work in the app-role/user-scoped transaction posture. */
export function inUserScopeTx<T>(
  db: PrismaService,
  ctx: SyncOpScope,
  work: (tx: TrackingTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${ctx.userId}, true), set_config('TimeZone', 'UTC', true)`;
    return work(tx);
  });
}
