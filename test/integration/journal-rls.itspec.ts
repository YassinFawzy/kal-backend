/**
 * Journal isolation — the W4 RLS adopt/decline proofs + grants matrix on the
 * new tables (contract: docs/api/wave-04-contract.md §5; ledger criterion 1).
 *
 *   A owns the target rows (journal session + children, routine + children,
 *   training-day mark). B attacks every structural path with B's VALID
 *   context (the app role under B's own GUC). C is the control: C's rows
 *   behave exactly like A's, proving denials are authorization-driven.
 *
 * Required cases (task contract — "RLS fail-closed proofs on adopted journal
 * tables per the W3 itspec pattern; grants matrix pinned"):
 *   - context-less query ⇒ ZERO rows on every ADOPTED journal table;
 *   - wrong GUC ⇒ zero foreign rows (row-count assertions — RLS hides, it
 *     does not raise);
 *   - WITH CHECK refuses foreign writes (42501);
 *   - compound user references (I3): B cannot create a session exercise/set
 *     or routine exercise/set referencing A's parents — structurally
 *     impossible (23503);
 *   - user binding immutability: no UPDATE grant on id/user_id/created_at;
 *   - no DELETE on the owned journal history tables (tombstones only) — the
 *     ONE documented DELETE exception is the journal_training_days
 *     projection (derived cache, not history);
 *   - the platform catalog (exercises) is SELECT-only for both roles;
 *   - the counter table: window/count columns updatable, identity not;
 *   - the `w4` sync_operations kind registry: journal_session ops carry
 *     local_date, journal_routine ops must NOT, unknown kinds are refused
 *     (CHECK-pinned at the database — the last line, not the only one);
 *   - set-format discriminated parity bounds (negative/zero reps, negative
 *     weight, over-bound weight, zero duration, over-length notes, format
 *     pollution) refused by the CHECKs (23514);
 *   - Prisma-client round-trip across every new model (schema ↔ migration ↔
 *     generated client coherence).
 *
 * Fixture discipline: synthetic users only; neutral placeholders; no real
 * identities, secrets, or health content.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  asUser,
  asUserlessApp,
  capturePgError,
  inRoleTx,
  openRoleSession,
  USER_A,
  USER_B,
  USER_C,
  type CapturedPgError,
} from './helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

const DAY = '2026-10-12';
const T0 = '2026-10-12T07:00:00Z';

let db: EphemeralKalDb;

/** Synthetic catalog row (platform-authored, the production seed posture). */
const EXERCISE_ID = '00000000-0000-4000-8000-00000000fe01';
const SESSION_A = '11111111-1111-4111-8111-611111111101';
const SESSION_EX_A = '11111111-1111-4111-8111-611111111102';
const SET_A = '11111111-1111-4111-8111-611111111103';
const ROUTINE_A = '11111111-1111-4111-8111-611111111104';
const ROUTINE_EX_A = '11111111-1111-4111-8111-611111111105';
const ROUTINE_SET_A = '11111111-1111-4111-8111-611111111106';

async function seedUser(userId: string, email: string, username: string): Promise<void> {
  // Through the app role, the way the signup service writes (users is not an
  // RLS table; the INSERT grant is the signup path's grant).
  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [
      userId,
      email,
      username,
    ]);
  }, { commit: true });
}

/** A's owned journal fixture, written under A's own context (never admin). */
async function seedAJournal(): Promise<void> {
  await asUser(db, USER_A, async (q) => {
    await q(
      `INSERT INTO journal_sessions (id, user_id, local_date, title, updated_at, last_op_id)
       VALUES ($1, $2, $3, 'Push day', $4, '11111111-1111-4111-8111-6111111111ff')`,
      [SESSION_A, USER_A, DAY, T0],
    );
    await q(
      `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id,
         name_snapshot_en, name_snapshot_ar, position, updated_at)
       VALUES ($1, $2, $3, $4, 'Bench press', 'بنش برس', 0, $5)`,
      [SESSION_EX_A, SESSION_A, USER_A, EXERCISE_ID, T0],
    );
    await q(
      `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format,
         weight_kg, reps, updated_at)
       VALUES ($1, $2, $3, 0, 'weighted', 60, 8, $4)`,
      [SET_A, SESSION_EX_A, USER_A, T0],
    );
    await q(
      `INSERT INTO journal_routines (id, user_id, name, updated_at, last_op_id)
       VALUES ($1, $2, 'Push template', $3, '11111111-1111-4111-8111-6111111111fe')`,
      [ROUTINE_A, USER_A, T0],
    );
    await q(
      `INSERT INTO journal_routine_exercises (id, routine_id, user_id, exercise_id,
         name_snapshot_en, name_snapshot_ar, position, updated_at)
       VALUES ($1, $2, $3, $4, 'Bench press', 'بنش برس', 0, $5)`,
      [ROUTINE_EX_A, ROUTINE_A, USER_A, EXERCISE_ID, T0],
    );
    await q(
      `INSERT INTO journal_routine_sets (id, routine_exercise_id, user_id, position, format,
         weight_kg, reps, updated_at)
       VALUES ($1, $2, $3, 0, 'weighted', 60, 8, $4)`,
      [ROUTINE_SET_A, ROUTINE_EX_A, USER_A, T0],
    );
    await q(
      `INSERT INTO journal_training_days (user_id, local_date) VALUES ($1, $2)`,
      [USER_A, DAY],
    );
  }, { commit: true });
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('journal-rls');
    db.applyMigrations();

    await seedUser(USER_A, 'a@journal-rls.invalid', 'journal_rls_a');
    await seedUser(USER_B, 'b@journal-rls.invalid', 'journal_rls_b');
    await seedUser(USER_C, 'c@journal-rls.invalid', 'journal_rls_c');

    // The platform catalog row is seeded the production-faithful way, via
    // the admin connection (RLS-declined platform data — the documented
    // posture; the seed path).
    await adminQuery(
      db,
      `INSERT INTO exercises (id, provenance, name_en, name_en_normalized, name_ar, name_ar_normalized,
         aliases, aliases_normalized, instructions_en, instructions_ar, muscle_groups, tags)
       VALUES ($1, 'kal_reviewed', 'Bench press', 'bench press', 'بنش برس', 'بنش برس',
         ARRAY['bench']::text[], ARRAY['bench']::text[],
         'Lower the bar to mid-chest, press up.',
         'نزّل البار على وسط الصدر و ادفع لفوق.',
         ARRAY['chest']::text[], ARRAY['compound']::text[])`,
      [EXERCISE_ID],
    );

    await seedAJournal();
  })();
});

afterAll(async () => {
  await db?.drop();
});

describe('journal RLS — fail-closed proofs on the seven ADOPTED tables (ADR-0002, w4 note §5)', () => {
  const ADOPTED_TABLES = [
    'journal_sessions',
    'journal_session_exercises',
    'journal_exercise_sets',
    'journal_routines',
    'journal_routine_exercises',
    'journal_routine_sets',
    'journal_training_days',
  ] as const;

  it('RLS is ENABLED and FORCED on every adopted table (structural pin)', async () => {
    const rows = await adminQuery<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      db,
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'`,
      [ADOPTED_TABLES],
    );
    expect(rows.rows.length).toBe(ADOPTED_TABLES.length);
    for (const row of rows.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  for (const table of ADOPTED_TABLES) {
    it(`${table}: context-less query ⇒ ZERO rows (fail-closed, I2)`, async () => {
      await asUserlessApp(db, async (q) => {
        const rows = await q(`SELECT * FROM ${table}`);
        expect(rows.rows.length).toBe(0);
      });
    });

    it(`${table}: wrong GUC ⇒ zero foreign rows (B sees none of A; C parity)`, async () => {
      await asUser(db, USER_B, async (q) => {
        const rows = await q(`SELECT * FROM ${table}`);
        expect(rows.rows.length).toBe(0);
      });
      await asUser(db, USER_C, async (q) => {
        const rows = await q(`SELECT * FROM ${table}`);
        expect(rows.rows.length).toBe(0);
      });
      await asUser(db, USER_A, async (q) => {
        const rows = await q(`SELECT count(*)::int AS n FROM ${table}`);
        expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
      });
    });

    it(`${table}: simulated application bug — predicate-less mutation clamped to zero foreign rows`, async () => {
      await asUser(db, USER_B, async (q) => {
        // The training-days projection carries NO UPDATE grant at all (an
        // INSERT-only projection; DELETE is its derivation semantic), so its
        // clamp probe is a predicate-less DELETE; every other adopted table
        // carries the LWW column and no DELETE grant.
        const result =
          table === 'journal_training_days'
            ? await q(`DELETE FROM ${table}`)
            : await q(`UPDATE ${table} SET updated_at = now()`);
        expect(result.rowCount).toBe(0);
      });
    });
  }

  it('WITH CHECK refuses foreign writes on every adopted table (42501)', async () => {
    // Each expected-error probe runs in its OWN transaction (an error aborts
    // its transaction — the capturePgError note in helpers/acting-user.ts).
    const probes: readonly (readonly [table: string, insert: string])[] = [
      ['journal_sessions', `INSERT INTO journal_sessions (id, user_id, local_date) VALUES ('11111111-1111-4111-8111-611111111201', '${USER_A}', '${DAY}')`],
      ['journal_session_exercises', `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, name_snapshot_en, position) VALUES ('11111111-1111-4111-8111-611111111202', '${SESSION_A}', '${USER_A}', '${EXERCISE_ID}', 'X', 0)`],
      ['journal_exercise_sets', `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps) VALUES ('11111111-1111-4111-8111-611111111203', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 60, 8)`],
      ['journal_routines', `INSERT INTO journal_routines (id, user_id, name) VALUES ('11111111-1111-4111-8111-611111111204', '${USER_A}', 'X')`],
      ['journal_training_days', `INSERT INTO journal_training_days (user_id, local_date) VALUES ('${USER_A}', '${DAY}')`],
    ];
    for (const [table, insert] of probes) {
      let error: CapturedPgError | undefined;
      await asUser(db, USER_B, async (q) => {
        error = await capturePgError(() => q(insert));
      });
      expect(error, table).toBeDefined();
      expect(error!.code, table).toBe('42501');
    }
  });

  it('compound user references (I3): B cannot reference A’s parents — structurally impossible (23503)', async () => {
    // Every expected-error probe runs in its OWN transaction (an error
    // aborts its transaction — helpers/acting-user.ts capturePgError note).
    let sessionChild: CapturedPgError | undefined;
    await asUser(db, USER_B, async (q) => {
      sessionChild = await capturePgError(() =>
        q(
          `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, name_snapshot_en, position)
           VALUES ('11111111-1111-4111-8111-611111111210', $1, $2, $3, 'X', 0)`,
          [SESSION_A, USER_B, EXERCISE_ID],
        ),
      );
    });
    expect(sessionChild?.code).toBe('23503');
    let setChild: CapturedPgError | undefined;
    await asUser(db, USER_B, async (q) => {
      setChild = await capturePgError(() =>
        q(
          `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps)
           VALUES ('11111111-1111-4111-8111-611111111211', $1, $2, 0, 'weighted', 60, 8)`,
          [SESSION_EX_A, USER_B],
        ),
      );
    });
    expect(setChild?.code).toBe('23503');
    let routineChild: CapturedPgError | undefined;
    await asUser(db, USER_B, async (q) => {
      routineChild = await capturePgError(() =>
        q(
          `INSERT INTO journal_routine_exercises (id, routine_id, user_id, exercise_id, name_snapshot_en, position)
           VALUES ('11111111-1111-4111-8111-611111111212', $1, $2, $3, 'X', 0)`,
          [ROUTINE_A, USER_B, EXERCISE_ID],
        ),
      );
    });
    expect(routineChild?.code).toBe('23503');
    let routineSetChild: CapturedPgError | undefined;
    await asUser(db, USER_B, async (q) => {
      routineSetChild = await capturePgError(() =>
        q(
          `INSERT INTO journal_routine_sets (id, routine_exercise_id, user_id, position, format, weight_kg, reps)
           VALUES ('11111111-1111-4111-8111-611111111213', $1, $2, 0, 'weighted', 60, 8)`,
          [ROUTINE_EX_A, USER_B],
        ),
      );
    });
    expect(routineSetChild?.code).toBe('23503');
  });
});

describe('journal grants matrix (w4 note §5 — least-privilege, column-scoped)', () => {
  it('owned history tables: no DELETE grant (tombstones only); the training-days projection is the documented DELETE exception', async () => {
    // Probe transactions (each expected error in its own transaction).
    const probe = async (sql: string, params: readonly unknown[]): Promise<CapturedPgError | undefined> => {
      let error: CapturedPgError | undefined;
      await asUser(db, USER_A, async (q) => {
        error = await capturePgError(() => q(sql, params));
      });
      return error;
    };
    expect((await probe(`DELETE FROM journal_sessions WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    expect((await probe(`DELETE FROM journal_routines WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    expect((await probe(`DELETE FROM journal_exercise_sets WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    // The projection: hard delete is the derivation semantic, scoped by RLS
    // to the caller's OWN rows. A's predicate-less DELETE removes exactly
    // A's row (then re-inserted); B's predicate-less DELETE removes nothing
    // of A's — the clamped-to-own-rows shape.
    await asUser(db, USER_A, async (q) => {
      const ownRows = await q(`DELETE FROM journal_training_days`);
      expect(ownRows.rowCount).toBe(1); // A's own mark — the grant works
      const reinsert = await q(`INSERT INTO journal_training_days (user_id, local_date) VALUES ($1, $2)`, [USER_A, DAY]);
      expect(reinsert.rowCount).toBe(1);
    });
    await asUser(db, USER_B, async (q) => {
      const foreign = await q(`DELETE FROM journal_training_days`);
      expect(foreign.rowCount).toBe(0); // RLS clamps B to B's (empty) rows
    });
    // A's mark survives B's probe exactly intact.
    await asUser(db, USER_A, async (q) => {
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = $1`, [USER_A]);
      expect(Number(rows.rows[0]!.n)).toBe(1);
    });
  });

  it('identity columns are immutable: no UPDATE grant on id/user_id/created_at (I1)', async () => {
    const probe = async (sql: string, params: readonly unknown[]): Promise<CapturedPgError | undefined> => {
      let error: CapturedPgError | undefined;
      await asUser(db, USER_A, async (q) => {
        error = await capturePgError(() => q(sql, params));
      });
      return error;
    };
    expect((await probe(`UPDATE journal_sessions SET id = gen_random_uuid() WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    expect((await probe(`UPDATE journal_sessions SET user_id = $1 WHERE user_id = $2`, [USER_B, USER_A]))?.code).toBe('42501');
    expect((await probe(`UPDATE journal_routines SET created_at = now() WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    expect((await probe(`UPDATE journal_exercise_sets SET user_id = $1 WHERE user_id = $2`, [USER_B, USER_A]))?.code).toBe('42501');
  });

  it('content columns carry UPDATE within the owner context (session edit posture)', async () => {
    await asUser(db, USER_A, async (q) => {
      const updated = await q(`UPDATE journal_sessions SET title = 'Push day B' WHERE id = $1 AND user_id = $2`, [SESSION_A, USER_A]);
      expect(updated.rowCount).toBe(1);
      const set = await q(`UPDATE journal_exercise_sets SET weight_kg = 62.5 WHERE id = $1 AND user_id = $2`, [SET_A, USER_A]);
      expect(set.rowCount).toBe(1);
      const reverted = await q(`UPDATE journal_sessions SET title = 'Push day' WHERE id = $1`, [SESSION_A]);
      expect(reverted.rowCount).toBe(1);
    });
    await asUser(db, USER_B, async (q) => {
      const foreign = await q(`UPDATE journal_sessions SET title = 'hijacked' WHERE id = $1`, [SESSION_A]);
      expect(foreign.rowCount).toBe(0);
    });
  });

  it('exercises (platform catalog, RLS DECLINED): SELECT-only for kal_app; kal_platform reads the same governed rows', async () => {
    await asUser(db, USER_A, async (q) => {
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM exercises`);
      expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
    });
    const probe = async (sql: string): Promise<CapturedPgError | undefined> => {
      let error: CapturedPgError | undefined;
      await asUser(db, USER_A, async (q) => {
        error = await capturePgError(() => q(sql));
      });
      return error;
    };
    expect((await probe(`INSERT INTO exercises (id, provenance, name_en, name_en_normalized, name_ar, name_ar_normalized, aliases, aliases_normalized, instructions_en, instructions_ar, muscle_groups, tags)
           VALUES (gen_random_uuid(), 'kal_reviewed', 'x', 'x', 'س', 'س', ARRAY[]::text[], ARRAY[]::text[], 'x', 'س', ARRAY[]::text[], ARRAY[]::text[])`))?.code).toBe('42501');
    expect((await probe(`UPDATE exercises SET name_en = 'x'`))?.code).toBe('42501');
    expect((await probe(`DELETE FROM exercises`))?.code).toBe('42501');
    await asPlatform(db, async (q) => {
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM exercises`);
      expect(Number(rows.rows[0]!.n)).toBeGreaterThan(0);
    });
  });

  it('session-create counters (RLS DECLINED platform state): window/count UPDATE only, identity immutable', async () => {
    await asUser(db, USER_A, async (q) => {
      await q(`INSERT INTO journal_session_create_counters (user_id, hour_window_start, hour_count, day_window_start, day_count)
               VALUES ($1, now(), 0, now(), 0)`, [USER_A]);
      const tick = await q(`UPDATE journal_session_create_counters SET hour_count = hour_count + 1 WHERE user_id = $1`, [USER_A]);
      expect(tick.rowCount).toBe(1);
    });
    const probe = async (sql: string, params: readonly unknown[]): Promise<CapturedPgError | undefined> => {
      let error: CapturedPgError | undefined;
      await asUser(db, USER_A, async (q) => {
        error = await capturePgError(() => q(sql, params));
      });
      return error;
    };
    expect((await probe(`UPDATE journal_session_create_counters SET user_id = $1 WHERE user_id = $2`, [USER_B, USER_A]))?.code).toBe('42501');
    expect((await probe(`DELETE FROM journal_session_create_counters WHERE user_id = $1`, [USER_A]))?.code).toBe('42501');
    await asUser(db, USER_B, async (q) => {
      const rows = await q(`SELECT * FROM journal_session_create_counters`);
      expect(rows.rows.length).toBe(0);
    });
  });

  it('no kal_platform grants/policies exist on ADOPTED journal tables (no bypass without a job — the w3 posture stands)', async () => {
    const grants = await adminQuery<{ table_name: string; grantee: string }>(
      db,
      `SELECT table_name, grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = 'kal_platform'
          AND table_name IN ('journal_sessions','journal_session_exercises','journal_exercise_sets',
                             'journal_routines','journal_routine_exercises','journal_routine_sets',
                             'journal_training_days')`,
    );
    expect(grants.rows.length).toBe(0);
    const policies = await adminQuery<{ tablename: string }>(
      db,
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'journal_%'`,
    );
    // Exactly seven policies, all scoped TO kal_app with the GUC predicate.
    expect(policies.rows.length).toBe(7);
    const policyDefs = await adminQuery<{ policyname: string; roles: string; qual: string; with_check: string }>(
      db,
      `SELECT policyname, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'journal_%'`,
    );
    for (const policy of policyDefs.rows) {
      expect(policy.roles, policy.policyname).toBe('{kal_app}');
      expect(policy.qual, policy.policyname).toContain('current_setting(');
      expect(policy.with_check, policy.policyname).toContain('current_setting(');
    }
  });
});

describe('the w4 sync_operations kind registry (CHECK-pinned at the database)', () => {
  it('journal_session ops are accepted WITH local_date; journal_routine ops WITHOUT', async () => {
    // COMMIT: these rows are the replay-read cell's fixture (the W3
    // seeding rule — user-owned rows written under their own context).
    await asUser(db, USER_A, async (q) => {
      await q(
        `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
           local_date, client_updated_at, payload, outcome)
         VALUES ($1, '11111111-1111-4111-8111-611111111301', 'device-a', 'journal_session', 'create', $2, $3, $4, $5::jsonb, 'applied')`,
        [USER_A, SESSION_A, DAY, T0, JSON.stringify({ title: 'Push day', localDate: DAY, exercises: [] })],
      );
      await q(
        `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
           client_updated_at, payload, outcome)
         VALUES ($1, '11111111-1111-4111-8111-611111111302', 'device-a', 'journal_routine', 'create', $2, $3, $4::jsonb, 'applied')`,
        [USER_A, ROUTINE_A, T0, JSON.stringify({ name: 'Push template', exercises: [] })],
      );
    }, { commit: true });
  });

  it('the parity rule is enforced: session ops without local_date and routine ops with it are refused (23514)', async () => {
    let missingDate: CapturedPgError | undefined;
    await asUser(db, USER_A, async (q) => {
      missingDate = await capturePgError(() =>
        q(
          `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
             client_updated_at, payload, outcome)
           VALUES ($1, '11111111-1111-4111-8111-611111111303', 'device-a', 'journal_session', 'create', $2, $3, '{}'::jsonb, 'applied')`,
          [USER_A, SESSION_A, T0],
        ),
      );
    });
    expect(missingDate?.code).toBe('23514');
    let extraDate: CapturedPgError | undefined;
    await asUser(db, USER_A, async (q) => {
      extraDate = await capturePgError(() =>
        q(
          `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
             local_date, client_updated_at, payload, outcome)
           VALUES ($1, '11111111-1111-4111-8111-611111111304', 'device-a', 'journal_routine', 'create', $2, $3, $4, '{}'::jsonb, 'applied')`,
          [USER_A, ROUTINE_A, DAY, T0],
        ),
      );
    });
    expect(extraDate?.code).toBe('23514');
  });

  it('unknown kinds stay refused by the widened CHECK (23514) — no new kinds without a change package', async () => {
    await asUser(db, USER_A, async (q) => {
      const unknown = await capturePgError(() =>
        q(
          `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
             client_updated_at, payload, outcome)
           VALUES ($1, '11111111-1111-4111-8111-611111111305', 'device-a', 'journal_program', 'create', $2, $3, '{}'::jsonb, 'applied')`,
          [USER_A, SESSION_A, T0],
        ),
      );
      expect(unknown?.code).toBe('23514');
    });
  });

  it('the ledger mirrors health payloads → RLS still scopes replay reads (B dedupe lookups see none of A)', async () => {
    await asUser(db, USER_B, async (q) => {
      const rows = await q(`SELECT * FROM sync_operations WHERE client_op_id = '11111111-1111-4111-8111-611111111301'`);
      expect(rows.rows.length).toBe(0);
    });
    await asUser(db, USER_A, async (q) => {
      const rows = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM sync_operations WHERE entity_kind IN ('journal_session','journal_routine')`,
      );
      expect(Number(rows.rows[0]!.n)).toBe(2);
    });
  });
});

describe('set-format discriminated parity — the database is the last line (w4 note §1 bounds)', () => {
  it.each([
    ['zero reps', `('11111111-1111-4111-8111-611111111401', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 60, 0, NULL, NULL)`],
    ['negative reps', `('11111111-1111-4111-8111-611111111402', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 60, -3, NULL, NULL)`],
    ['negative weight', `('11111111-1111-4111-8111-611111111403', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', -5, 8, NULL, NULL)`],
    ['zero weight', `('11111111-1111-4111-8111-611111111404', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 0, 8, NULL, NULL)`],
    ['over-bound weight', `('11111111-1111-4111-8111-611111111405', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 1000.001, 8, NULL, NULL)`],
    ['reps over bound', `('11111111-1111-4111-8111-611111111406', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 60, 1001, NULL, NULL)`],
    ['missing weight on weighted', `('11111111-1111-4111-8111-611111111407', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', NULL, 8, NULL, NULL)`],
    ['zero duration', `('11111111-1111-4111-8111-611111111408', '${SESSION_EX_A}', '${USER_A}', 0, 'timed', NULL, NULL, 0, NULL)`],
    ['duration over bound', `('11111111-1111-4111-8111-611111111409', '${SESSION_EX_A}', '${USER_A}', 0, 'timed', NULL, NULL, 86401, NULL)`],
    ['weight polluting timed', `('11111111-1111-4111-8111-61111111140a', '${SESSION_EX_A}', '${USER_A}', 0, 'timed', 60, NULL, 30, NULL)`],
    ['empty notes', `('11111111-1111-4111-8111-61111111140b', '${SESSION_EX_A}', '${USER_A}', 0, 'notes', NULL, NULL, NULL, '')`],
    ['over-length notes', `('11111111-1111-4111-8111-61111111140c', '${SESSION_EX_A}', '${USER_A}', 0, 'notes', NULL, NULL, NULL, repeat('x', 501))`],
    ['notes polluting notes-format', `('11111111-1111-4111-8111-61111111140d', '${SESSION_EX_A}', '${USER_A}', 0, 'notes', 60, NULL, NULL, 'AMRAP 20')`],
    ['unknown format', `('11111111-1111-4111-8111-61111111140e', '${SESSION_EX_A}', '${USER_A}', 0, 'bodyweight', NULL, 10, NULL, NULL)`],
    ['negative position', `('11111111-1111-4111-8111-61111111140f', '${SESSION_EX_A}', '${USER_A}', -1, 'weighted', 60, 8, NULL, NULL)`],
  ])('set row %s is refused by the CHECKs (23514)', async (_label, tuple) => {
    await asUser(db, USER_A, async (q) => {
      const error = await capturePgError(() =>
        q(`INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps, duration_seconds, notes_text)
           VALUES ${tuple}`),
      );
      expect(error?.code).toBe('23514');
    });
  });

  it('valid rows of all three formats coexist in one exercise entry (mixed formats — FR-022)', async () => {
    await asUser(db, USER_A, async (q) => {
      await q(
        `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps)
         VALUES ('11111111-1111-4111-8111-611111111421', $1, $2, 1, 'weighted', 60, 10)`,
        [SESSION_EX_A, USER_A],
      );
      await q(
        `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, duration_seconds)
         VALUES ('11111111-1111-4111-8111-611111111422', $1, $2, 2, 'timed', 45)`,
        [SESSION_EX_A, USER_A],
      );
      await q(
        `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, notes_text)
         VALUES ('11111111-1111-4111-8111-611111111423', $1, $2, 3, 'notes', 'AMRAP 20: 5/10/15 — 6 rounds')`,
        [SESSION_EX_A, USER_A],
      );
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM journal_exercise_sets WHERE session_exercise_id = $1`, [SESSION_EX_A]);
      expect(Number(rows.rows[0]!.n)).toBe(4); // the seeded weighted row + 3
    });
  });

  it('session shape bounds: over-length title and empty routine name refused', async () => {
    let title: CapturedPgError | undefined;
    await asUser(db, USER_A, async (q) => {
      title = await capturePgError(() =>
        q(`INSERT INTO journal_sessions (id, user_id, local_date, title) VALUES ('11111111-1111-4111-8111-611111111431', $1, $2, repeat('x', 121))`, [USER_A, DAY]),
      );
    });
    expect(title?.code).toBe('23514');
    let emptyName: CapturedPgError | undefined;
    await asUser(db, USER_A, async (q) => {
      emptyName = await capturePgError(() =>
        q(`INSERT INTO journal_routines (id, user_id, name) VALUES ('11111111-1111-4111-8111-611111111432', $1, '')`, [USER_A]),
      );
    });
    expect(emptyName?.code).toBe('23514');
  });
});

describe('Prisma-client round-trip — schema ↔ migration ↔ generated client coherence', () => {
  it('every new model inserts and reads back through the generated client', async () => {
    // Admin connection (seeding posture — RLS-declined read-back check is
    // covered behaviorally above; this cell proves the CLIENT maps to the
    // migrated DDL: column names, types, relations, composite uniques).
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { Pool } = await import('pg');
    // The prisma.service pattern: an external pg Pool handed to the adapter
    // (a bare Client is not a pool — startTransaction needs pool.connect()).
    const scratchUrl = new URL(process.env['DATABASE_URL']!);
    scratchUrl.pathname = `/${db.name}`;
    const pgPool = new Pool({ connectionString: scratchUrl.toString(), options: '-c timezone=UTC' });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pgPool, { disposeExternalPool: true }) });
    try {
      const session = await prisma.journalSession.create({
        data: {
          id: '11111111-1111-4111-8111-611111111501',
          userId: USER_A,
          localDate: new Date('2026-10-13T00:00:00Z'),
          title: 'Client round-trip',
          updatedAt: new Date(T0),
          lastOpId: '11111111-1111-4111-8111-611111111502',
          exercises: {
            create: {
              id: '11111111-1111-4111-8111-611111111503',
              exerciseId: EXERCISE_ID,
              nameSnapshotEn: 'Bench press',
              nameSnapshotAr: 'بنش برس',
              position: 0,
              sets: {
                create: [
                  { id: '11111111-1111-4111-8111-611111111504', position: 0, format: 'weighted', weightKg: 62.5, reps: 5 },
                  { id: '11111111-1111-4111-8111-611111111505', position: 1, format: 'timed', durationSeconds: 60 },
                  { id: '11111111-1111-4111-8111-611111111506', position: 2, format: 'notes', notesText: 'felt strong' },
                ],
              },
            },
          },
        },
        include: { exercises: { include: { sets: true } } },
      });
      expect(session.exercises.length).toBe(1);
      expect(session.exercises[0]!.sets.length).toBe(3);
      expect(session.exercises[0]!.nameSnapshotAr).toBe('بنش برس');

      const routine = await prisma.journalRoutine.create({
        data: {
          id: '11111111-1111-4111-8111-611111111507',
          userId: USER_A,
          name: 'Client template',
          exercises: {
            create: {
              id: '11111111-1111-4111-8111-611111111508',
              exerciseId: EXERCISE_ID,
              nameSnapshotEn: 'Bench press',
              position: 0,
              sets: { create: { id: '11111111-1111-4111-8111-611111111509', position: 0, format: 'weighted', weightKg: 40, reps: 12 } },
            },
          },
        },
        include: { exercises: { include: { sets: true } } },
      });
      expect(routine.exercises[0]!.sets[0]!.weightKg!.toString()).toBe('40');

      const mark = await prisma.journalTrainingDay.create({ data: { userId: USER_A, localDate: new Date('2026-10-13T00:00:00Z') } });
      expect(mark.markedAt).toBeInstanceOf(Date);

      const counter = await prisma.journalSessionCreateCounter.create({
        data: { userId: USER_A, hourWindowStart: new Date(T0), dayWindowStart: new Date(T0) },
      });
      expect(counter.hourCount).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('control (C parity) — C owns and reads her own rows exactly like A', () => {
  it('C creates a session under her own context and reads it back', async () => {
    await asUser(db, USER_C, async (q) => {
      await q(
        `INSERT INTO journal_sessions (id, user_id, local_date, title, updated_at, last_op_id)
         VALUES ('11111111-1111-4111-8111-611111111601', $1, $2, 'C session', $3, '11111111-1111-4111-8111-611111111602')`,
        [USER_C, DAY, T0],
      );
      const rows = await q<{ n: number }>(`SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = $1`, [USER_C]);
      expect(Number(rows.rows[0]!.n)).toBe(1);
    });
    await asUser(db, USER_A, async (q) => {
      const rows = await q(`SELECT * FROM journal_sessions WHERE id = '11111111-1111-4111-8111-611111111601'`);
      expect(rows.rows.length).toBe(0);
    });
  });
});

// Session-caveat probe (the acting-user docblock): a POOLED session that set
// the GUC before reads it back as '' on an unset query — the 22P02 shape is
// fail-closed (no rows, an error, never a leak).
describe('session-state caveat — still fail-closed', () => {
  it('pooled session with stale GUC state: context-less read fails closed (22P02), never leaks', async () => {
    const session = await openRoleSession(db, false);
    try {
      await inRoleTx(session, 'kal_app', USER_A, async (q) => {
        await q(`SELECT count(*) FROM journal_sessions`);
      });
      await inRoleTx(session, 'kal_app', null, async (q) => {
        const error = await capturePgError(() => q(`SELECT * FROM journal_sessions`));
        expect(error?.code).toBe('22P02');
      });
    } finally {
      await session.finish();
    }
  });
});
