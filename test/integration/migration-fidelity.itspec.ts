/**
 * Migration fidelity (task s4, required case): the full migration history
 * applies to a FRESH ephemeral database as the migration role, the applied
 * structure carries the whole role/policy/GRANT contract, and a re-run of the
 * history is a no-op (ARCHITECTURE.md §11 — migrations are reviewed, immutable,
 * forward-only; README "Database migrations" — clean-apply gate).
 *
 * Catalog assertions here pin the s1 contract (prisma/migrations/
 * 20261006081957_roles_rls_pilot + 20261006082537_role_contract_assertions)
 * plus the founder-directed user_id rename forward-fix
 * (20261006145631_rename_weight_log_owner_to_user_id, ledger §10 2026-10-06).
 * Behavioral proof lives in rls-pilot.itspec.ts; this file proves the STRUCTURE
 * that behavior relies on exists after a cold apply — on every future cluster,
 * not just the dev machine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationApplyResult } from './helpers/ephemeral-db.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

const EXPECTED_MIGRATIONS = [
  '20261006081941_init_foundation',
  '20261006081957_roles_rls_pilot',
  '20261006082537_role_contract_assertions',
  '20261006145631_rename_weight_log_owner_to_user_id',
  // W2 identity core (lane w02-s1-schema): users/sessions/recovery_tickets/
  // auth_attempt_counters + governance — appended additively by the owning
  // schema lane (contract: the harness must not break; the history pin must
  // stay truthful as it grows).
  '20261007101836_identity_core',
  '20261007205611_rename_password_hash_to_password',
] as const;

let db: EphemeralKalDb;
let firstApply: MigrationApplyResult;

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('migration-fidelity');
    firstApply = db.applyMigrations();
  })();
});

afterAll(() => {
  return db.drop();
});

describe('cold apply of the full history', () => {
  it('applies every migration successfully on the fresh database', () => {
    expect(firstApply.exitCode).toBe(0);
    for (const name of EXPECTED_MIGRATIONS) {
      expect(firstApply.stdout).toContain(name);
    }
  });

  it('records exactly the expected history in _prisma_migrations, all finished, none failed', async () => {
    const rows = await adminQuery<{ migration_name: string; done: boolean; failed: boolean }>(
      db,
      `SELECT migration_name,
              finished_at IS NOT NULL AS done,
              finished_at IS NULL AND applied_steps_count > 0 AS failed
         FROM _prisma_migrations
        ORDER BY migration_name`,
    );
    expect(rows.rows.map((row) => row.migration_name)).toEqual([...EXPECTED_MIGRATIONS].sort());
    expect(rows.rows.every((row) => row.done)).toBe(true);
    expect(rows.rows.every((row) => !row.failed)).toBe(true);
  });
});

describe('re-run of the full history is a no-op', () => {
  it('applies nothing new and leaves the recorded history unchanged', async () => {
    const second = db.applyMigrations();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain('Applying migration');
    expect(second.stdout).toContain('No pending migrations');
    const rows = await adminQuery<{ count: string }>(db, 'SELECT count(*)::text AS count FROM _prisma_migrations');
    expect(rows.rows[0]?.count).toBe(String(EXPECTED_MIGRATIONS.length));
  });

  it('guards are idempotent: roles exist exactly once after the re-run', async () => {
    const rows = await adminQuery<{ rolname: string; n: number }>(
      db,
      `SELECT rolname, count(*)::int AS n FROM pg_roles WHERE rolname IN ('kal_app', 'kal_platform') GROUP BY rolname ORDER BY rolname`,
    );
    expect(rows.rows).toEqual([
      { rolname: 'kal_app', n: 1 },
      { rolname: 'kal_platform', n: 1 },
    ]);
  });
});

describe('role contract (least-privilege, asserted by migration history)', () => {
  it.each(['kal_app', 'kal_platform'] as const)('%s carries the full fail-closed attribute set', async (role) => {
    const rows = await adminQuery<{
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      db,
      `SELECT rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
      [role],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({
      rolsuper: false,
      rolinherit: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });
});

describe('RLS pilot structure on weight_log', () => {
  it('has row security ENABLED and FORCED, carries the renamed per-user column + index, no owner_id residue', async () => {
    const rows = await adminQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      db,
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'weight_log'::regclass`,
    );
    expect(rows.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // Founder-directed rename (ledger §10, 2026-10-06): forward-fix migration
    // renames the column and its index; nothing with the retired names stays.
    const columns = await adminQuery<{ column_name: string }>(
      db,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'weight_log' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(['id', 'user_id', 'recorded_at', 'weight_kg']);
    const indexes = await adminQuery<{ indexname: string }>(
      db,
      `SELECT indexname FROM pg_indexes WHERE tablename = 'weight_log' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'weight_log_pkey',
      'weight_log_user_id_recorded_at_idx',
    ]);
  });

  it('carries exactly the three documented policies (user context + enumerated platform exemptions)', async () => {
    const rows = await adminQuery<{ policyname: string; cmd: string; roles: string[] }>(
      db,
      `SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'weight_log' ORDER BY policyname`,
    );
    expect(rows.rows).toEqual([
      { policyname: 'weight_log_platform_deletion', cmd: 'DELETE', roles: '{kal_platform}' },
      { policyname: 'weight_log_platform_export', cmd: 'SELECT', roles: '{kal_platform}' },
      { policyname: 'weight_log_user_context', cmd: 'ALL', roles: '{kal_app}' },
    ]);
  });

  it('the user policy is fail-closed on an unset GUC (current_setting(..., true) form, not plain current_setting)', async () => {
    const rows = await adminQuery<{ qual: string; with_check: string }>(
      db,
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'weight_log' AND policyname = 'weight_log_user_context'`,
    );
    // The `true` argument makes current_setting return NULL when the GUC is
    // unset ⇒ the predicate is NULL ⇒ zero rows (fail closed, ADR-0002 §2).
    // (PG stores the normalized expression with an explicit ::text cast.)
    // GUC is `app.user_id` — the founder-directed rename recreated the policy
    // precisely because a column rename does NOT rewrite the GUC string.
    expect(rows.rows[0]?.qual).toContain("current_setting('app.user_id'::text, true)");
    expect(rows.rows[0]?.with_check).toContain("current_setting('app.user_id'::text, true)");
    // The renamed column is bound on both sides of the predicate.
    expect(rows.rows[0]?.qual).toContain('user_id =');
    expect(rows.rows[0]?.with_check).toContain('user_id =');
    // No residue of the retired GUC name anywhere in the catalog.
    const stale = await adminQuery<{ count: string }>(
      db,
      `SELECT count(*)::text AS count FROM pg_policies
        WHERE tablename = 'weight_log'
          AND (qual LIKE '%current_owner%' OR with_check LIKE '%current_owner%'
               OR qual LIKE '%owner_id%' OR with_check LIKE '%owner_id%')`,
    );
    expect(stale.rows[0]?.count).toBe('0');
  });
});

describe('least-privilege grants', () => {
  it('kal_app: SELECT/INSERT/DELETE on weight_log, column-scoped UPDATE only (user_id immutable, I1)', async () => {
    const tablePrivs = await adminQuery<{ priv_type: string; allowed: boolean }>(
      db,
      `SELECT privs.priv_type,
              has_table_privilege('kal_app', 'weight_log', privs.priv_type) AS allowed
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privs(priv_type)
        ORDER BY privs.priv_type`,
    );
    expect(tablePrivs.rows).toEqual([
      { priv_type: 'DELETE', allowed: true },
      { priv_type: 'INSERT', allowed: true },
      { priv_type: 'SELECT', allowed: true },
      // Table-level UPDATE is false: only the two data columns are granted.
      { priv_type: 'UPDATE', allowed: false },
    ]);

    const columnPrivs = await adminQuery<{ column_name: string; updatable: boolean }>(
      db,
      `SELECT cols.column_name,
              has_column_privilege('kal_app', 'weight_log', cols.column_name, 'UPDATE') AS updatable
         FROM (VALUES ('user_id'), ('recorded_at'), ('weight_kg')) AS cols(column_name)
        ORDER BY cols.column_name`,
    );
    expect(columnPrivs.rows).toEqual([
      { column_name: 'recorded_at', updatable: true },
      { column_name: 'user_id', updatable: false },
      { column_name: 'weight_kg', updatable: true },
    ]);
  });

  it('kal_platform: SELECT + DELETE only (enumerated export/deletion job shapes)', async () => {
    const rows = await adminQuery<{ priv_type: string; allowed: boolean }>(
      db,
      `SELECT privs.priv_type,
              has_table_privilege('kal_platform', 'weight_log', privs.priv_type) AS allowed
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privs(priv_type)
        ORDER BY privs.priv_type`,
    );
    expect(rows.rows).toEqual([
      { priv_type: 'DELETE', allowed: true },
      { priv_type: 'INSERT', allowed: false },
      { priv_type: 'SELECT', allowed: true },
      { priv_type: 'UPDATE', allowed: false },
    ]);
  });

  it('audit_events: append-only for both service roles — no UPDATE/DELETE grant for anyone', async () => {
    const rows = await adminQuery<{ role_name: string; priv_type: string; allowed: boolean }>(
      db,
      `SELECT roles.role_name, privs.priv_type,
              has_table_privilege(roles.role_name, 'audit_events', privs.priv_type) AS allowed
         FROM (VALUES ('kal_app'), ('kal_platform')) AS roles(role_name)
        CROSS JOIN (VALUES ('UPDATE'), ('DELETE')) AS privs(priv_type)
        ORDER BY roles.role_name, privs.priv_type`,
    );
    expect(rows.rows.every((row) => row.allowed === false)).toBe(true);
  });

  it('audit_events append-only trigger is present and non-internal', async () => {
    const rows = await adminQuery<{ tgname: string }>(
      db,
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal`,
    );
    expect(rows.rows.map((row) => row.tgname)).toContain('audit_events_append_only');
  });

  it('PUBLIC lost ALL rights on schema public (default-deny posture); the two service roles hold explicit USAGE', async () => {
    // REVOKE ALL removes USAGE as well as CREATE — PUBLIC keeps nothing; the
    // service roles were granted USAGE explicitly in the same migration.
    const rows = await adminQuery<{ public_create: boolean; public_usage: boolean; app_usage: boolean; platform_usage: boolean }>(
      db,
      `SELECT has_schema_privilege('public', 'public', 'CREATE') AS public_create,
              has_schema_privilege('public', 'public', 'USAGE') AS public_usage,
              has_schema_privilege('kal_app', 'public', 'USAGE') AS app_usage,
              has_schema_privilege('kal_platform', 'public', 'USAGE') AS platform_usage`,
    );
    expect(rows.rows[0]).toEqual({
      public_create: false,
      public_usage: false,
      app_usage: true,
      platform_usage: true,
    });
  });
});
