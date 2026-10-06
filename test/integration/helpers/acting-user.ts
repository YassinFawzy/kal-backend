/**
 * Acting-as-user helper — the harness primitive every later wave reuses
 * (ADR-0002 "Consequences for testing": a one-time "acting as user X"
 * transaction helper; feature tests run inside it transparently).
 *
 * Production-faithfulness rules locked by the task contract:
 *
 *   - The app role `kal_app` is NOLOGIN: a session assumes it via SET ROLE.
 *     Every behavioral assertion here runs inside an explicit transaction that
 *     first does `SET LOCAL ROLE <role>`, then PROVES `current_user` matches —
 *     a superuser connection that forgot to SET ROLE would bypass row security
 *     silently, so the proof is part of the helper (fail-closed harness).
 *   - The user context is the transaction-local GUC `app.user_id`,
 *     set with `set_config(..., true)` exactly the way sanctioned application
 *     code must set it (README "Roles & row-level security").
 *   - Suites default to ROLLBACK: cases mutate and throw away their effects.
 *     Seeding phases opt into COMMIT explicitly; the database is ephemeral
 *     regardless (helpers/ephemeral-db.ts).
 *   - Denials are ROW-COUNT assertions (ADR-0002): RLS hides rows, it does not
 *     raise for SELECT/UPDATE/DELETE. Exceptions are asserted only where the
 *     database actually raises (INSERT WITH CHECK, missing column grants,
 *     malformed GUC casts, privilege escalation attempts).
 *
 * Session-state caveat (proven by the harness, documented for later waves):
 * after a session has set `app.user_id` once (even transaction-locally),
 * an UNSET GUC reads back as the empty string — not SQL NULL — so a
 * no-context query fails with the 22P02 uuid-cast error instead of returning
 * zero rows. Both are fail-closed (no rows, no leak); only a session that has
 * NEVER set the GUC exhibits the "NULL ⇒ zero rows" form. Suites assert both
 * realities; `openRoleSession(db, true)` + `inRoleTx` give full control over
 * session state for such probes. Practical consequence for application code:
 * context-less work must run on sessions that never set the GUC (or must
 * reset it), and pools must treat 22P02 on context-less paths as fail-closed.
 *
 * Escalation caveat: `SET ROLE` permission is checked against the SESSION
 * user. The harness connects as the admin/migration user (a superuser on the
 * dev machine by design), so a behavioral "kal_app cannot SET ROLE
 * kal_platform" probe is meaningless here — the superuser session user is
 * always allowed. The structural fact (no membership path between the roles)
 * is asserted against pg_auth_members instead. Neither role is a member of
 * anything and NOINHERIT is asserted by migration fidelity + the role
 * contract; request-scope code connects as a NON-superuser in production, so
 * the production posture is the membership graph, not this harness's session
 * user.
 *
 * Fixtures: USER_A/B/C are synthetic UUIDs with no relationship to any real
 * identity. Weight values used by suites are neutral numeric placeholders.
 */

import type { QueryResult, QueryResultRow } from 'pg';
import type { EphemeralKalDb, IsolatedClient } from './ephemeral-db.js';

/** Synthetic user A — owns the attack-target rows. */
export const USER_A = '11111111-1111-4111-8111-111111111111';
/** Synthetic user B — the adversary (valid credentials, hostile intent). */
export const USER_B = '22222222-2222-4222-8222-222222222222';
/** Synthetic user C — the control (parity proves denials are authorization-driven). */
export const USER_C = '33333333-3333-4333-8333-333333333333';

export type KalRole = 'kal_app' | 'kal_platform';

/** Query function bound to one in-role transaction. */
export type RoleQuery = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<QueryResult<R>>;

/** A dedicated (or pooled) connection the harness drives in-role transactions on. */
export interface RoleSession {
  query(text: string, params?: readonly unknown[]): Promise<QueryResult>;
  finish(): Promise<void>;
}

export interface RoleTxOptions {
  /** COMMIT instead of ROLLBACK on success (seeding only). */
  readonly commit?: boolean;
  /** Use a dedicated never-before-used connection (fresh session state). */
  readonly fresh?: boolean;
}

/**
 * Open a role-capable session: pooled by default, isolated (`fresh: true`)
 * for session-state probes. The caller MUST call `finish()`.
 */
export async function openRoleSession(db: EphemeralKalDb, fresh: boolean): Promise<RoleSession> {
  if (!fresh) {
    const client = await db.pool.connect();
    return { query: (text, params) => client.query(text, params), finish: () => { client.release(); return Promise.resolve(); } };
  }
  const isolated: IsolatedClient = await db.connectIsolated();
  return { query: (text, params) => isolated.query(text, params), finish: () => isolated.end() };
}

/**
 * Run `fn` inside one transaction on `session`, acting as `role` (with an
 * optional transaction-local user context). Always ROLLBACKs unless
 * `commit: true`; the session stays open for further transactions.
 */
export async function inRoleTx(
  session: RoleSession,
  role: KalRole,
  userId: string | null,
  fn: (query: RoleQuery) => Promise<void>,
  commit = false,
): Promise<void> {
  const query: RoleQuery = (text, params) => session.query(text, params);
  await session.query('BEGIN');
  try {
    await session.query(`SET LOCAL ROLE ${role}`);
    const proof = await session.query('SELECT current_user');
    if (proof.rows[0]?.current_user !== role) {
      throw new Error(
        `RLS PROOF INVALID: connection is acting as ${String(proof.rows[0]?.current_user)}, not ${role}. ` +
          'Superuser sessions must never assert row-security behavior (README "Roles & row-level security").',
      );
    }
    if (userId !== null) {
      await query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
    }
    await fn(query);
    await session.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await session.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** One-shot: fresh-or-pooled session, one in-role transaction, session closed afterwards. */
export async function asDbRole(
  db: EphemeralKalDb,
  role: KalRole,
  userId: string | null,
  fn: (query: RoleQuery) => Promise<void>,
  options: RoleTxOptions = {},
): Promise<void> {
  const session = await openRoleSession(db, options.fresh === true);
  try {
    await inRoleTx(session, role, userId, fn, options.commit === true);
  } finally {
    await session.finish();
  }
}

/** Act as the request-scope app role with a user context (the sanctioned path). */
export function asUser(
  db: EphemeralKalDb,
  userId: string,
  fn: (query: RoleQuery) => Promise<void>,
  options: RoleTxOptions = {},
): Promise<void> {
  return asDbRole(db, 'kal_app', userId, fn, options);
}

/**
 * Act as the request-scope app role with NO user context. Defaults to a
 * FRESH session (the GUC never set) — the faithful "no context" shape. Pass
 * `{ fresh: false }` to probe pooled-session behavior (see the session-state
 * caveat in the module docblock: expect 22P02, still fail-closed).
 */
export function asUserlessApp(
  db: EphemeralKalDb,
  fn: (query: RoleQuery) => Promise<void>,
  options: RoleTxOptions = { fresh: true },
): Promise<void> {
  return asDbRole(db, 'kal_app', null, fn, options);
}

/**
 * Act as the platform-scope bypass role. No GUC is set by default: the
 * platform exemption is enumerated by role+table+command, not by context.
 */
export function asPlatform(
  db: EphemeralKalDb,
  fn: (query: RoleQuery) => Promise<void>,
  options: RoleTxOptions & { readonly user?: string } = {},
): Promise<void> {
  return asDbRole(db, 'kal_platform', options.user ?? null, fn, options);
}

export interface CapturedPgError {
  readonly code: string;
  readonly message: string;
}

/**
 * Capture an expected PostgreSQL error (class code + message) without failing
 * the surrounding transaction bookkeeping. `undefined` means "no error was
 * raised" — suites assert on that to catch fail-open regressions.
 *
 * NOTE: an error ABORTS its transaction; subsequent statements on the same
 * transaction raise 25P02 (in_failed_sql_transaction). Every expected-error
 * probe therefore runs in its OWN transaction.
 */
export async function capturePgError(run: () => Promise<unknown>): Promise<CapturedPgError | undefined> {
  try {
    await run();
  } catch (error) {
    const err = error as { code?: unknown; message?: unknown };
    return {
      code: typeof err.code === 'string' ? err.code : '',
      message: typeof err.message === 'string' ? err.message : String(error),
    };
  }
  return undefined;
}
