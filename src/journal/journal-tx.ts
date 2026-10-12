/**
 * Kal — the per-transaction app-role + user-context posture for the journal
 * module (the tracking module's `foods/app-role-tx.ts` pattern, instance for
 * the journal bounded context — F1 GUC pool guidance, wave-03 ledger §5).
 *
 * Every user-scoped journal transaction runs the identity `inAppRoleTx`
 * pattern:
 *
 *     SET LOCAL ROLE kal_app            (least-privilege request-scope role)
 *     SET LOCAL app.user_id = <userId>  (the fail-closed RLS GUC)
 *     SET LOCAL TimeZone = 'UTC'        (timestamptz rendering invariant)
 *
 * `SET LOCAL` is transaction-scoped: it reverts at commit/rollback, so a
 * POOLED connection never carries the role, the GUC, or the zone into the
 * next borrower's work — session-level GUCs on pooled clients are forbidden.
 *
 * The exercise catalog is RLS-DECLINED platform data (w4 contract note §5 —
 * the `foods` posture), but its reads still run through this posture for
 * least privilege (the `kal_app` role carries the catalog's SELECT grants;
 * request-scope code never works through the admin/migration role). Op
 * handlers invoked by sync receive the batch's transaction client and do NOT
 * open transactions of their own.
 */
import type { Prisma } from '../../generated/prisma/client.ts';
import type { PrismaService } from '../db/prisma.service.js';

export type JournalTx = Prisma.TransactionClient;

/** Anything carrying the validated user binding (SyncOpContext is a superset). */
export interface SyncOpScope {
  readonly userId: string;
}

/** Runs the unit of work in the app-role/user-scoped transaction posture. */
export function inUserScopeTx<T>(
  db: PrismaService,
  ctx: SyncOpScope,
  work: (tx: JournalTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${ctx.userId}, true), set_config('TimeZone', 'UTC', true)`;
    return work(tx);
  });
}
