/**
 * Identity schema structure (lane w02-s1-schema, Wave 2) — the structural pin
 * for the W2 identity tables after a COLD apply of the full history, on the
 * same ephemeral-database pattern as migration-fidelity.itspec.ts.
 *
 * What is pinned here and why:
 *   - RLS is DECLINED on every identity table (users, sessions,
 *     recovery_tickets, auth_attempt_counters) per ADR-0002's narrow scope —
 *     the per-table adopt/decline decision is a documented artifact
 *     (docs/api/wave-02-contract.md §5; README "Roles & row-level security").
 *     This suite pins that the DECLINE is what actually shipped: no row
 *     security, no policies. Isolation for these tables is the identity
 *     module's mandatory user-scoped predicates (I1/I2) — attacked
 *     behaviorally by the s4 A/B/C suites.
 *   - Structural uniqueness of the three sign-in identifiers (I3/D-06).
 *   - Immutable user binding: per-plane user_id has NO UPDATE grant anywhere;
 *     sessions/recovery_tickets reference users(id) with ON DELETE RESTRICT.
 *   - Identifier/credential shape CHECKs (canonical forms) — rejected writes
 *     are SQL failures, never application-disclosed detail.
 *
 * Behavioral assertions run through the wave-1 harness role helpers (never a
 * superuser connection — README "Roles & row-level security").
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationApplyResult } from './helpers/ephemeral-db.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { asDbRole, capturePgError } from './helpers/acting-user.js';

const IDENTITY_TABLES = ['users', 'sessions', 'recovery_tickets', 'auth_attempt_counters'] as const;

let db: EphemeralKalDb;
let firstApply: MigrationApplyResult;

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('identity-schema');
    firstApply = db.applyMigrations();
  })();
});

afterAll(() => {
  return db.drop();
});

describe('identity tables exist after the cold apply', () => {
  it('applies the full history including the identity migration', () => {
    expect(firstApply.exitCode).toBe(0);
    expect(firstApply.stdout).toContain('identity_core');
  });

  it('all four identity tables are present', async () => {
    const rows = await adminQuery<{ tablename: string }>(
      db,
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
      [[...IDENTITY_TABLES]],
    );
    expect(rows.rows.map((row) => row.tablename)).toEqual([...IDENTITY_TABLES].sort());
  });
});

describe('RLS adopt/decline — the documented decline shipped (ADR-0002 narrow scope)', () => {
  it.each(IDENTITY_TABLES)('%s carries NO row security and NO policies (decline is structural)', async (table) => {
    const security = await adminQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      db,
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
      [table],
    );
    expect(security.rows).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);
    const policies = await adminQuery<{ policyname: string }>(db, `SELECT policyname FROM pg_policies WHERE tablename = $1`, [table]);
    expect(policies.rows, `${table} must have zero RLS policies (documented decline)`).toEqual([]);
  });

  it('the RLS pilot table is untouched — weight_log keeps its fail-closed policies', async () => {
    const policies = await adminQuery<{ policyname: string }>(
      db,
      `SELECT policyname FROM pg_policies WHERE tablename = 'weight_log' ORDER BY policyname`,
    );
    expect(policies.rows.map((row) => row.policyname)).toEqual([
      'weight_log_platform_deletion',
      'weight_log_platform_export',
      'weight_log_user_context',
    ]);
  });
});

describe('structural identifier uniqueness (D-06: phone/email/username)', () => {
  it('users pins all three identifiers with unique indexes', async () => {
    const rows = await adminQuery<{ indexname: string }>(
      db,
      `SELECT indexname FROM pg_indexes WHERE tablename = 'users' ORDER BY indexname`,
    );
    expect(rows.rows.map((row) => row.indexname)).toEqual(['users_email_key', 'users_phone_key', 'users_pkey', 'users_username_key']);
  });

  it('sessions/recovery_tickets pin their secret hashes uniquely', async () => {
    const sessions = await adminQuery<{ indexname: string }>(
      db,
      `SELECT indexname FROM pg_indexes WHERE tablename = 'sessions' ORDER BY indexname`,
    );
    expect(sessions.rows.map((row) => row.indexname)).toEqual([
      'sessions_pkey',
      'sessions_refresh_token_hash_key',
      'sessions_user_id_created_at_idx',
    ]);
    const tickets = await adminQuery<{ indexname: string }>(
      db,
      `SELECT indexname FROM pg_indexes WHERE tablename = 'recovery_tickets' ORDER BY indexname`,
    );
    expect(tickets.rows.map((row) => row.indexname)).toEqual([
      'recovery_tickets_pkey',
      'recovery_tickets_token_hash_key',
      'recovery_tickets_user_id_created_at_idx',
    ]);
  });
});

describe('user binding is immutable (I1/I3)', () => {
  it('sessions and recovery_tickets reference users(id) with ON DELETE RESTRICT', async () => {
    const rows = await adminQuery<{ conname: string; confdeltype: char; confupdtype: char }>(
      db,
      `SELECT conname, confdeltype, confupdtype FROM pg_constraint
         WHERE contype = 'f' AND conrelid IN ('sessions'::regclass, 'recovery_tickets'::regclass) ORDER BY conname`,
    );
    expect(rows.rows).toEqual([
      { conname: 'recovery_tickets_user_id_fkey', confdeltype: 'r', confupdtype: 'c' },
      { conname: 'sessions_user_id_fkey', confdeltype: 'r', confupdtype: 'c' },
    ]);
  });

  it('kal_app CANNOT update identity columns on users (email/username/phone/status/created_at)', async () => {
    const rows = await adminQuery<{ column_name: string; updatable: boolean }>(
      db,
      `SELECT cols.column_name,
              has_column_privilege('kal_app', 'users', cols.column_name, 'UPDATE') AS updatable
         FROM information_schema.columns cols
        WHERE cols.table_name = 'users' AND cols.column_name IN
              ('id', 'email', 'username', 'phone', 'status', 'created_at', 'password_hash', 'updated_at')
        ORDER BY cols.column_name`,
    );
    expect(rows.rows).toEqual([
      { column_name: 'created_at', updatable: false },
      { column_name: 'email', updatable: false },
      { column_name: 'id', updatable: false },
      { column_name: 'password_hash', updatable: true },
      { column_name: 'phone', updatable: false },
      { column_name: 'status', updatable: false },
      { column_name: 'updated_at', updatable: true },
      { column_name: 'username', updatable: false },
    ]);
  });

  it('kal_app CANNOT update the user binding or row identity on sessions/recovery_tickets', async () => {
    const rows = await adminQuery<{ table_name: string; column_name: string; updatable: boolean }>(
      db,
      `SELECT cols.table_name, cols.column_name,
              has_column_privilege('kal_app', cols.table_name, cols.column_name, 'UPDATE') AS updatable
         FROM information_schema.columns cols
        WHERE (cols.table_name = 'sessions' AND cols.column_name IN ('id', 'user_id', 'created_at', 'expires_at', 'device_label', 'revoked_at'))
           OR (cols.table_name = 'recovery_tickets' AND cols.column_name IN ('id', 'user_id', 'created_at', 'expires_at', 'token_hash', 'consumed_at'))
        ORDER BY cols.table_name, cols.column_name`,
    );
    expect(rows.rows).toEqual([
      { table_name: 'recovery_tickets', column_name: 'consumed_at', updatable: true },
      { table_name: 'recovery_tickets', column_name: 'created_at', updatable: false },
      { table_name: 'recovery_tickets', column_name: 'expires_at', updatable: false },
      { table_name: 'recovery_tickets', column_name: 'id', updatable: false },
      { table_name: 'recovery_tickets', column_name: 'token_hash', updatable: false },
      { table_name: 'recovery_tickets', column_name: 'user_id', updatable: false },
      { table_name: 'sessions', column_name: 'created_at', updatable: false },
      { table_name: 'sessions', column_name: 'device_label', updatable: false },
      { table_name: 'sessions', column_name: 'expires_at', updatable: false },
      { table_name: 'sessions', column_name: 'id', updatable: false },
      { table_name: 'sessions', column_name: 'revoked_at', updatable: true },
      { table_name: 'sessions', column_name: 'user_id', updatable: false },
    ]);
  });

  it('kal_app CANNOT delete owned rows (housekeeping/deletion are platform shapes)', async () => {
    for (const table of ['users', 'sessions', 'recovery_tickets', 'auth_attempt_counters']) {
      const rows = await adminQuery<{ allowed: boolean }>(
        db,
        `SELECT has_table_privilege('kal_app', $1, 'DELETE') AS allowed`,
        [table],
      );
      expect(rows.rows[0]?.allowed, `${table}: kal_app DELETE denied`).toBe(false);
    }
  });
});

describe('canonical-shape CHECKs reject malformed identity data at the database', () => {
  async function insertUserExpecting(dbHandle: EphemeralKalDb, username: string, email: string, phone: string | null, status: string): Promise<string | undefined> {
    const error = await capturePgError(() =>
      asDbRole(dbHandle, 'kal_app', null, async (query) => {
        await query(
          `INSERT INTO users (email, username, phone, password_hash, status) VALUES ($1, $2, $3, $4, $5)`,
          [email, username, phone, '$argon2id$v=19$m=65536,t=3,p=1$fixture$fixturehashvalue', status],
        );
      }, { commit: true }),
    );
    return error?.code;
  }

  it('accepts a canonical fixture user and rejects malformed shapes', async () => {
    // Canonical accept (fixture PHC string — never a real credential).
    await asDbRole(db, 'kal_app', null, async (query) => {
      await query(
        `INSERT INTO users (email, username, phone, password_hash, status)
         VALUES ('fixture-a@invalid', 'fixture_user_a', '+201000000001', '$argon2id$v=19$m=65536,t=3,p=1$fixture$fixturehashvalue', 'active')`,
      );
    }, { commit: true });

    expect(await insertUserExpecting(db, 'Bad Username', 'fixture-b@invalid', '+201000000002', 'active')).toBe('23514');
    expect(await insertUserExpecting(db, 'fixture_user_b', 'fixture-b.invalid', '+201000000002', 'active')).toBe('23514');
    expect(await insertUserExpecting(db, 'fixture_user_b', 'fixture-b@invalid', '201000000002', 'active')).toBe('23514');
    expect(await insertUserExpecting(db, 'fixture_user_b', 'fixture-b@invalid', '+201000000002', 'bogus')).toBe('23514');
    // Cleanup so the unique-index probes below start clean.
    await asDbRole(db, 'kal_platform', null, async (query) => {
      await query(`DELETE FROM users WHERE username = 'fixture_user_a'`);
    }, { commit: true });
  });
});
