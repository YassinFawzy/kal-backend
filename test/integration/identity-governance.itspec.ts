/**
 * Kal identity GOVERNANCE integration suite (wave-02, task s4-adversarial) —
 * the database-level half of the adversarial pass, on the wave-01 harness
 * pattern (ephemeral `kal_it_s4gov_*` database, full migration history, and
 * the `SET LOCAL ROLE` + `current_user` proof discipline for every behavioral
 * assertion — a superuser connection's assertions prove nothing).
 *
 * What is attacked here (the HTTP layer's A/B/C matrix lives in the e2e
 * suites; this file attacks what the SCHEMA must enforce):
 *   - Audit immutability (I14): the append-only guarantee is structural —
 *     no UPDATE/DELETE grant for either service role, plus the BEFORE
 *     UPDATE/DELETE trigger backstop. Attacked in-role with captured errors;
 *     an un-captured error (undefined) means the attack LANDED (fail-open).
 *   - Account deletion (FR-008/lifecycle): sessions/recovery_tickets are
 *     `ON DELETE RESTRICT` children — even the platform role cannot delete a
 *     user account without removing children first (the explicit platform
 *     job shape). Attacked in-role; the full housekeeping sequence is then
 *     exercised as the documented control.
 *   - auth_attempt_counters: platform-owned throttle state keyed by
 *     SERVER-KEYED DIGESTS ONLY — no user_id column, no FK to users (that is
 *     what lets counters tick for identifiers that belong to no account,
 *     contract §3).kal_app holds no DELETE; the failed_count CHECK rejects
 *     negative tampering.
 *   - RLS-decline reality (contract §5): identity tables carry no row
 *     security — the harness pins the BEHAVIORAL consequence (a context-less
 *     kal_app session reads all rows) so the documented decline posture stays
 *     honest and the app-layer I1/I2 obligation stays visible.
 *   - F-W2-1 detectability: the timezone-pin control probes (a shifted
 *     session really shifts; the pinned form really is +00) — the control
 *     that makes the e2e timezone suite meaningful.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MigrationApplyResult } from './helpers/ephemeral-db.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { asDbRole, asPlatform, asUserlessApp, capturePgError } from './helpers/acting-user.js';

const FIXTURE_HASH = '$argon2id$v=19$m=65536,t=3,p=1$govfixture$fixturehashvalue000000';

let db: EphemeralKalDb;
let firstApply: MigrationApplyResult;

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('s4gov');
    firstApply = db.applyMigrations();
  })();
});

afterAll(() => {
  return db.drop();
});

// ---------------------------------------------------------------------------

describe('cold apply (harness proof)', () => {
  it('applies the full migration history including identity_core', () => {
    expect(firstApply.exitCode).toBe(0);
    expect(firstApply.stdout).toContain('identity_core');
  });
});

describe('audit immutability is structural (I14) — attacked in-role', () => {
  const SEED = { actor: 'system:governance-fixture', action: 's4.governance.probe', target: 'fixture:audit-row', justification: 's4 governance suite fixture append.' };

  beforeAll(() => {
    return (async () => {
      // Seed one audit row through the sanctioned append shape (kal_app INSERT).
      await asDbRole(db, 'kal_app', null, async (query) => {
        await query('INSERT INTO audit_events (actor, action, target, justification) VALUES ($1, $2, $3, $4)', [
          SEED.actor,
          SEED.action,
          SEED.target,
          SEED.justification,
        ]);
      }, { commit: true });
    })();
  });

  it.each(['kal_app', 'kal_platform'] as const)('%s CANNOT update an audit event (attack lands as a captured error, never silently)', async (role) => {
    const error = await capturePgError(() =>
      asDbRole(db, role, null, async (query) => {
        await query('UPDATE audit_events SET justification = $1 WHERE action = $2', ['tampered-by-attack', SEED.action]);
      }, { commit: true }),
    );
    expect(error, `${role} UPDATE on audit_events must be refused (fail-open regression if undefined)`).toBeDefined();
    // No UPDATE grant (42501) or the append-only trigger (P0001) — both are refusals.
    expect(['42501', 'P0001']).toContain(error?.code);

    const untouched = await adminQuery<{ justification: string }>(
      db,
      'SELECT justification FROM audit_events WHERE action = $1',
      [SEED.action],
    );
    expect(untouched.rows[0]?.justification).toBe(SEED.justification);
  });

  it.each(['kal_app', 'kal_platform'] as const)('%s CANNOT delete an audit event', async (role) => {
    const error = await capturePgError(() =>
      asDbRole(db, role, null, async (query) => {
        await query('DELETE FROM audit_events WHERE action = $1', [SEED.action]);
      }, { commit: true }),
    );
    expect(error, `${role} DELETE on audit_events must be refused`).toBeDefined();
    expect(['42501', 'P0001']).toContain(error?.code);
    const still = await adminQuery<{ count: number }>(db, 'SELECT COUNT(*)::int AS count FROM audit_events WHERE action = $1', [SEED.action]);
    expect((still.rows[0] as { count: number }).count).toBe(1);
  });
});

describe('account deletion is RESTRICTed (explicit platform job shape)', () => {
  const EMAIL = 's4-gov-victim@invalid';
  const USERNAME = 's4_gov_victim';

  beforeAll(() => {
    return (async () => {
      // Seed: one user with one live session and one outstanding ticket (kal_app INSERTs).
      await asDbRole(db, 'kal_app', null, async (query) => {
        await query('INSERT INTO users (email, username, phone, password_hash, status) VALUES ($1, $2, $3, $4, $5)', [
          EMAIL,
          USERNAME,
          '+202200000001',
          FIXTURE_HASH,
          'active',
        ]);
        await query(
          `INSERT INTO sessions (id, user_id, device_label, expires_at, refresh_token_hash)
           SELECT gen_random_uuid(), id, 'gov-fixture', now() + interval '7 days', repeat('a', 64) FROM users WHERE email = $1`,
          [EMAIL],
        );
        await query(
          `INSERT INTO recovery_tickets (id, user_id, token_hash, expires_at)
           SELECT gen_random_uuid(), id, repeat('b', 64), now() + interval '30 minutes' FROM users WHERE email = $1`,
          [EMAIL],
        );
      }, { commit: true });
    })();
  });

  it('kal_platform cannot delete a user with live children — the attack raises RESTRICT (23503)', async () => {
    const error = await capturePgError(() =>
      asPlatform(db, async (query) => {
        await query('DELETE FROM users WHERE email = $1', [EMAIL]);
      }, { commit: true }),
    );
    expect(error, 'the deletion attack must be refused (fail-open regression if undefined)').toBeDefined();
    expect(error?.code, 'ON DELETE RESTRICT must raise 23503').toBe('23503');

    const survived = await adminQuery<{ count: number }>(db, 'SELECT COUNT(*)::int AS count FROM users WHERE email = $1', [EMAIL]);
    expect((survived.rows[0] as { count: number }).count).toBe(1);
  });

  it('the documented explicit-job sequence works: children removed first, then the account — and the roles proven at every step', async () => {
    await asPlatform(db, async (query) => {
      const proof = await query('SELECT current_user');
      expect(proof.rows[0]?.current_user).toBe('kal_platform');
      await query(
        'DELETE FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1)',
        [EMAIL],
      );
      await query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)', [EMAIL]);
      await query('DELETE FROM users WHERE email = $1', [EMAIL]);
    }, { commit: true });
    const gone = await adminQuery<{ count: number }>(db, 'SELECT COUNT(*)::int AS count FROM users WHERE email = $1', [EMAIL]);
    expect((gone.rows[0] as { count: number }).count).toBe(0);
  });
});

describe('auth_attempt_counters: digest-keyed, user-binding-free throttle state (contract §3/§5)', () => {
  it('carries NO foreign key to users and NO user column — counters can tick for identifiers that belong to no account', async () => {
    const fks = await adminQuery<{ conname: string }>(
      db,
      `SELECT conname FROM pg_constraint WHERE conrelid = 'auth_attempt_counters'::regclass AND contype = 'f'`,
    );
    expect(fks.rows, 'no FK from counters to users (structural basis for ticking on unknown identifiers)').toEqual([]);

    const columns = await adminQuery<{ column_name: string }>(
      db,
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_attempt_counters' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'subject_key',
      'device_key',
      'failed_count',
      'first_failed_at',
      'last_failed_at',
      'locked_until',
    ]);
  });

  it('kal_app can tick (INSERT/UPDATE the counter columns) but CANNOT delete counters; kal_platform holds the enumerated SELECT/DELETE housekeeping shape', async () => {
    const appPrivs = await adminQuery<{ priv_type: string; allowed: boolean }>(
      db,
      `SELECT privs.priv_type, has_table_privilege('kal_app', 'auth_attempt_counters', privs.priv_type) AS allowed
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privs(priv_type) ORDER BY privs.priv_type`,
    );
    expect(appPrivs.rows).toEqual([
      { priv_type: 'DELETE', allowed: false },
      { priv_type: 'INSERT', allowed: true },
      { priv_type: 'SELECT', allowed: true },
      // Table-level UPDATE is false: only the four counter columns are granted.
      { priv_type: 'UPDATE', allowed: false },
    ]);
    const appColumns = await adminQuery<{ column_name: string; updatable: boolean }>(
      db,
      `SELECT cols.column_name,
              has_column_privilege('kal_app', 'auth_attempt_counters', cols.column_name, 'UPDATE') AS updatable
         FROM (VALUES ('subject_key'), ('device_key'), ('failed_count'), ('first_failed_at'), ('last_failed_at'), ('locked_until'))
              AS cols(column_name)
        ORDER BY cols.column_name`,
    );
    expect(appColumns.rows).toEqual([
      { column_name: 'device_key', updatable: false },
      { column_name: 'failed_count', updatable: true },
      { column_name: 'first_failed_at', updatable: true },
      { column_name: 'last_failed_at', updatable: true },
      { column_name: 'locked_until', updatable: true },
      { column_name: 'subject_key', updatable: false },
    ]);

    const platformPrivs = await adminQuery<{ priv_type: string; allowed: boolean }>(
      db,
      `SELECT privs.priv_type, has_table_privilege('kal_platform', 'auth_attempt_counters', privs.priv_type) AS allowed
         FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privs(priv_type) ORDER BY privs.priv_type`,
    );
    expect(platformPrivs.rows).toEqual([
      { priv_type: 'DELETE', allowed: true },
      { priv_type: 'INSERT', allowed: false },
      { priv_type: 'SELECT', allowed: true },
      { priv_type: 'UPDATE', allowed: false },
    ]);
  });

  it('a negative failed_count tamper is rejected by the CHECK (23514); an unknown-identifier counter row inserts fine (digest-only key)', async () => {
    // Unknown-identifier counter: inserts fine — this is the structural fact
    // behind "counters tick regardless of identifier existence".
    await asDbRole(db, 'kal_app', null, async (query) => {
      await query(
        `INSERT INTO auth_attempt_counters (subject_key, device_key, failed_count, first_failed_at, last_failed_at)
         VALUES (repeat('c', 64), repeat('d', 64), 1, now(), now())`,
      );
    }, { commit: true });

    const negative = await capturePgError(() =>
      asDbRole(db, 'kal_app', null, async (query) => {
        await query('UPDATE auth_attempt_counters SET failed_count = -1 WHERE subject_key = $1', ['c'.repeat(64)]);
      }, { commit: true }),
    );
    expect(negative, 'negative-count tamper must be refused').toBeDefined();
    expect(negative?.code).toBe('23514');

    // Housekeeping shape (control): the platform role removes the fixture row.
    await asPlatform(db, async (query) => {
      await query('DELETE FROM auth_attempt_counters WHERE subject_key = $1', ['c'.repeat(64)]);
    }, { commit: true });
  });
});

describe('RLS-decline reality on identity tables (contract §5 — the documented posture, pinned behaviorally)', () => {
  it('a context-less kal_app session (fresh, current_user-proven) reads identity rows — row filtering is the APP layer’s I1/I2 job, not the database’s', async () => {
    // Seed one marker row so the read is non-trivial.
    await asDbRole(db, 'kal_app', null, async (query) => {
      await query(
        `INSERT INTO users (email, username, phone, password_hash, status) VALUES ($1, $2, $3, $4, $5)`,
        ['s4-gov-decline@invalid', 's4_gov_decline', '+202200000002', FIXTURE_HASH, 'active'],
      );
    }, { commit: true });

    // Fresh session, NO app.user_id ever set, acting as kal_app (proof inside).
    await asUserlessApp(db, async (query) => {
      const proof = await query('SELECT current_user');
      expect(proof.rows[0]?.current_user).toBe('kal_app');
      const guc = await query("SELECT current_setting('app.user_id', true) AS guc");
      expect(guc.rows[0]?.guc).toBeNull(); // never set on this fresh session
      const rows = await query('SELECT COUNT(*)::int AS count FROM users');
      expect((rows.rows[0] as { count: number }).count, 'decline = no row filtering at the database; I1/I2 scoping is enforced in the identity service (attacked at the HTTP layer by the s4 A/B/C suites)').toBeGreaterThanOrEqual(1);
    });
  });
});

describe('F-W2-1 probe detectability (the control behind identity-tz.e2e-spec.ts)', () => {
  it('a shifted session really shifts timestamptz rendering; the UTC-pinned transaction form really is +00', async () => {
    const shiftedClient = await db.connectIsolated();
    try {
      await shiftedClient.query("SET TIME ZONE 'Africa/Cairo'");
      const shifted = await shiftedClient.query<{ rendered: string }>(
        `SELECT ('2026-10-07T09:00:00.123Z'::timestamptz)::text AS rendered`,
      );
      expect(shifted.rows[0]?.rendered).toMatch(/\+0[23]$/u);
    } finally {
      await shiftedClient.end();
    }

    const client = await db.connectIsolated();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('TimeZone', 'UTC', true), set_config('role', 'kal_app', true)`);
      const pinned = await client.query<{ rendered: string; who: string }>(
        `SELECT ('2026-10-07T09:00:00.123Z'::timestamptz)::text AS rendered, current_user AS who`,
      );
      await client.query('ROLLBACK');
      expect(pinned.rows[0]?.who).toBe('kal_app'); // the app-role posture, proven
      expect(pinned.rows[0]?.rendered).toBe('2026-10-07 09:00:00.123+00');
    } finally {
      await client.end();
    }
  });
});
