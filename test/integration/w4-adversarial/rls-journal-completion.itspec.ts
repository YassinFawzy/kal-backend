/**
 * Kal — wave-4 s4 adversarial: the RLS simulated-bug completion matrix on
 * the seven ADOPTED journal tables (criterion 8 + task contract "RLS proofs").
 *
 * This suite COMPLETES the s1 F4 routed gap (the `journal-rls.itspec.ts`
 * WITH CHECK battery covered 5/7 tables — the routine children were only
 * structural) and re-pins the full adversarial matrix required of this
 * lane: per-table context-less reads (fail-closed I2), wrong-GUC reads,
 * predicate-less mutations clamped to zero foreign rows, WITH CHECK
 * refusals on ALL seven tables, the compound-FK tree for BOTH children
 * (session children AND routine children, through the grandchild level),
 * the tombstone-path DELETE refusal, the training-days DELETE exception
 * clamped to its owner, and the documented DECLINE postures (exercises,
 * counters). Method: helpers/acting-user.ts role sessions (kal_app +
 * `app.user_id` GUC), every expected-error probe in its OWN transaction.
 *
 * CANARY (supervisor amendment 1): this suite drops its own scratch
 * database FIRST and unconditionally, then asserts the cluster-global
 * zero-leftover gate excluding its own (already dropped) name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../../generated/prisma/client.ts';
import { applyExerciseCatalogSeed } from '../../../prisma/seed-apply.js';
import {
  USER_A,
  USER_B,
  USER_C,
  asUser,
  asUserlessApp,
  capturePgError,
} from '../helpers/acting-user.js';
import { adminCatalogQuery, adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';

/**
 * Structural twin of helpers/acting-user's CapturedPgError — the nested
 * test dir's `../../helpers` type import trips oxlint's resolver (the same
 * pattern at `./helpers` depth is warning-clean), so the shape is declared
 * locally and stays assignment-compatible with capturePgError's return.
 */
interface CapturedPgErrorShape {
  readonly code?: string;
  readonly message?: string;
}

const DAY = '2026-10-08';
const DAY_2 = '2026-10-09';

/** Fixed synthetic journal-tree ids (A-owned; the B/C analogues derive below). */
const SESSION_A = '44444444-4444-4444-8444-a00000000001';
const SESSION_EX_A = '44444444-4444-4444-8444-a00000000002';
const SET_A_1 = '44444444-4444-4444-8444-a00000000003';
const ROUTINE_A = '44444444-4444-4444-8444-a00000000004';
const ROUTINE_EX_A = '44444444-4444-4444-8444-a00000000005';
const ROUTINE_SET_A = '44444444-4444-4444-8444-a00000000006';
const SESSION_B = '44444444-4444-4444-8444-b00000000001';
const MARK_B = DAY_2;

const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';

/** The seven adopted tables (migration 20261012000000_w4_journal_core). */
const ADOPTED = [
  'journal_sessions',
  'journal_session_exercises',
  'journal_exercise_sets',
  'journal_routines',
  'journal_routine_exercises',
  'journal_routine_sets',
  'journal_training_days',
] as const;

let db: EphemeralKalDb;

async function seedJournalTree(): Promise<void> {
  // The synthetic users exist first (the users table is not RLS-adopted —
  // the journal-rls seedUser posture), then each family seeds under its OWN
  // user context (fail-closed WITH CHECK — a context-less seed is refused by
  // exactly the policy this suite proves).
  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, status) VALUES ('${USER_A}', 'a@w4rlsj.invalid', 'w4rlsj_a', 'active')`);
    await q(`INSERT INTO users (id, email, username, status) VALUES ('${USER_B}', 'b@w4rlsj.invalid', 'w4rlsj_b', 'active')`);
    await q(`INSERT INTO users (id, email, username, status) VALUES ('${USER_C}', 'c@w4rlsj.invalid', 'w4rlsj_c', 'active')`);
  }, { commit: true });
  await asUser(db, USER_A, async (q) => {
    // A's session tree.
    await q(
      `INSERT INTO journal_sessions (id, user_id, local_date, title) VALUES ('${SESSION_A}', '${USER_A}', '${DAY}', 'A rls session')`,
    );
    await q(
      `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, name_snapshot_en, position)
       VALUES ('${SESSION_EX_A}', '${SESSION_A}', '${USER_A}', '${EX_SQUAT}', 'Barbell back squat', 0)`,
    );
    await q(
      `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps)
       VALUES ('${SET_A_1}', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 80, 5)`,
    );
    // A's routine tree.
    await q(`INSERT INTO journal_routines (id, user_id, name) VALUES ('${ROUTINE_A}', '${USER_A}', 'A rls routine')`);
    await q(
      `INSERT INTO journal_routine_exercises (id, routine_id, user_id, exercise_id, name_snapshot_en, position)
       VALUES ('${ROUTINE_EX_A}', '${ROUTINE_A}', '${USER_A}', '${EX_SQUAT}', 'Barbell back squat', 0)`,
    );
    await q(
      `INSERT INTO journal_routine_sets (id, routine_exercise_id, user_id, position, format, weight_kg, reps)
       VALUES ('${ROUTINE_SET_A}', '${ROUTINE_EX_A}', '${USER_A}', 0, 'weighted', 60, 10)`,
    );
    // A's training-day marks (two days — one is B's attack target).
    await q(`INSERT INTO journal_training_days (user_id, local_date) VALUES ('${USER_A}', '${DAY}')`);
    await q(`INSERT INTO journal_training_days (user_id, local_date) VALUES ('${USER_A}', '${DAY_2}')`);
  }, { commit: true });
  await asUser(db, USER_B, async (q) => {
    await q(`INSERT INTO journal_sessions (id, user_id, local_date, title) VALUES ('${SESSION_B}', '${USER_B}', '${DAY}', 'B rls session')`);
    await q(`INSERT INTO journal_training_days (user_id, local_date) VALUES ('${USER_B}', '${MARK_B}')`);
  }, { commit: true });
}

beforeAll(async () => {
  db = await createEphemeralKalDb('w4rlsj');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
  try {
    await applyExerciseCatalogSeed(seedClient);
  } finally {
    await seedClient.$disconnect();
  }
  await seedJournalTree();
}, 240_000);

afterAll(async () => {
  // CANARY — supervisor amendment 1 ordering: drop FIRST (unconditionally),
  // then the cluster-global zero-leftover assert via the maintenance-DB
  // catalog connection (adminQuery targets the now-dropped scratch DB and
  // cannot serve post-drop checks).
  const mine = db.name;
  await db.drop();
  const leftovers = await adminCatalogQuery(`SELECT datname FROM pg_database WHERE datname LIKE 'kal_it_%' AND datname <> $1`, [mine]);
  expect(leftovers.rows, 'zero leftover kal_it_* databases').toEqual([]);
}, 60_000);

// ===========================================================================
// Structural + decline posture pins
// ===========================================================================

describe('structural posture of the seven adopted tables', () => {
  it('every adopted table is ENABLE + FORCE row-level security (the simulated-bug precondition)', async () => {
    const result = await adminQuery(
      db,
      `SELECT c.relname, c.relrowsecurity AS enable, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [[...ADOPTED]],
    );
    expect(result.rows).toHaveLength(ADOPTED.length);
    for (const row of result.rows as { relname: string; enable: boolean; force: boolean }[]) {
      expect(row.enable, row.relname).toBe(true);
      expect(row.force, row.relname).toBe(true);
    }
  });

  it('the DECLINE postures match the contract note §5 exactly (exercises + counters: no RLS, documented grants)', async () => {
    const result = await adminQuery(
      db,
      `SELECT c.relname, c.relrowsecurity AS enable FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('exercises', 'journal_session_create_counters')`,
    );
    for (const row of result.rows as { relname: string; enable: boolean }[]) {
      expect(row.enable, `${row.relname} declined RLS`).toBe(false);
    }
    // No kal_platform policy exists on any adopted table (no platform bypass this wave).
    const policies = await adminQuery(db, `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND policyname LIKE '%platform%'`, [[...ADOPTED]]);
    expect(policies.rows).toEqual([]);
  });
});

// ===========================================================================
// The simulated-bug matrix — reads
// ===========================================================================

describe('simulated application bug — reads (fail-closed, I2)', () => {
  it('context-less kal_app session ⇒ ZERO rows on every adopted table', async () => {
    await asUserlessApp(db, async (q) => {
      for (const table of ADOPTED) {
        const result = await q(`SELECT count(*)::int AS n FROM ${table}`);
        expect(result.rows[0]?.n, table).toBe(0);
      }
    });
  });

  it('wrong GUC (B context) ⇒ zero A rows on every adopted table; B still sees B own rows (not a blanket blind)', async () => {
    await asUser(db, USER_B, async (q) => {
      expect((await q(`SELECT count(*)::int AS n FROM journal_sessions WHERE id = '${SESSION_A}'`)).rows[0]?.n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM journal_session_exercises WHERE id = '${SESSION_EX_A}'`)).rows[0]?.n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM journal_exercise_sets WHERE id = '${SET_A_1}'`)).rows[0]?.n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM journal_routines WHERE id = '${ROUTINE_A}'`)).rows[0]?.n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM journal_routine_exercises WHERE id = '${ROUTINE_EX_A}'`)).rows[0]?.n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM journal_routine_sets WHERE id = '${ROUTINE_SET_A}'`)).rows[0]?.n).toBe(0);
      expect(
        (await q(`SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = '${USER_A}'`)).rows[0]?.n,
      ).toBe(0);
      // The clamp is a scope, not a blackout: B's own rows are visible.
      expect((await q(`SELECT count(*)::int AS n FROM journal_sessions WHERE id = '${SESSION_B}'`)).rows[0]?.n).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = '${USER_B}'`)).rows[0]?.n).toBe(1);
    });
  });

  it('predicate-less UPDATE under B clamps to B own rows only — A byte-untouched on every mutable table', async () => {
    await asUser(db, USER_B, async (q) => {
      // The six UPDATE-granted tables: B's own rows updated, A's untouched.
      expect((await q(`UPDATE journal_sessions SET title = title`)).rowCount).toBe(1);
      expect((await q(`UPDATE journal_session_exercises SET updated_at = updated_at`)).rowCount).toBe(0); // B has no child rows
      expect((await q(`UPDATE journal_exercise_sets SET updated_at = updated_at`)).rowCount).toBe(0);
      expect((await q(`UPDATE journal_routines SET name = name`)).rowCount).toBe(0); // B has no routine
      expect((await q(`UPDATE journal_routine_exercises SET updated_at = updated_at`)).rowCount).toBe(0);
      expect((await q(`UPDATE journal_routine_sets SET updated_at = updated_at`)).rowCount).toBe(0);
      // training_days carries NO UPDATE grant at all — even B's own row refuses.
      const denied = await capturePgError(() => q(`UPDATE journal_training_days SET marked_at = marked_at`));
      expect(denied?.code).toBe('42501');
    });
    const aSession = await adminQuery(db, `SELECT title FROM journal_sessions WHERE id = '${SESSION_A}'`);
    expect((aSession.rows[0] as { title: string }).title).toBe('A rls session');
  });
});

// ===========================================================================
// WITH CHECK — the full 7/7 battery (the s1 F4 completion)
// ===========================================================================

describe('WITH CHECK refuses foreign writes on ALL SEVEN adopted tables (42501) — the F4 completion', () => {
  it('INSERT-as-B carrying A user_id is refused on every adopted table, including both routine children', async () => {
    const probes: readonly (readonly [table: string, insert: string])[] = [
      ['journal_sessions', `INSERT INTO journal_sessions (id, user_id, local_date) VALUES ('44444444-4444-4444-8444-c00000000001', '${USER_A}', '${DAY}')`],
      ['journal_session_exercises', `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, name_snapshot_en, position) VALUES ('44444444-4444-4444-8444-c00000000002', '${SESSION_A}', '${USER_A}', '${EX_SQUAT}', 'X', 0)`],
      ['journal_exercise_sets', `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps) VALUES ('44444444-4444-4444-8444-c00000000003', '${SESSION_EX_A}', '${USER_A}', 0, 'weighted', 60, 8)`],
      ['journal_routines', `INSERT INTO journal_routines (id, user_id, name) VALUES ('44444444-4444-4444-8444-c00000000004', '${USER_A}', 'X')`],
      ['journal_routine_exercises', `INSERT INTO journal_routine_exercises (id, routine_id, user_id, exercise_id, name_snapshot_en, position) VALUES ('44444444-4444-4444-8444-c00000000005', '${ROUTINE_A}', '${USER_A}', '${EX_SQUAT}', 'X', 0)`],
      ['journal_routine_sets', `INSERT INTO journal_routine_sets (id, routine_exercise_id, user_id, position, format, weight_kg, reps) VALUES ('44444444-4444-4444-8444-c00000000006', '${ROUTINE_EX_A}', '${USER_A}', 0, 'weighted', 60, 8)`],
      ['journal_training_days', `INSERT INTO journal_training_days (user_id, local_date) VALUES ('${USER_A}', '${DAY}')`],
    ];
    for (const [table, insert] of probes) {
      let error: CapturedPgErrorShape | undefined;
      await asUser(db, USER_B, async (q) => {
        error = await capturePgError(() => q(insert));
      });
      expect(error, `${table}: WITH CHECK must refuse`).toBeDefined();
      expect(error!.code, table).toBe('42501');
    }
  });
});

// ===========================================================================
// Compound user references (I3) — BOTH children trees, through the grandchild
// ===========================================================================

describe('compound-FK cross-account references are structurally impossible (23503)', () => {
  it('session children: B cannot hang an exercise/set off A session or A session-exercise (own user_id, foreign parent)', async () => {
    let child: CapturedPgErrorShape | undefined;
    await asUser(db, USER_B, async (q) => {
      child = await capturePgError(() =>
        q(
          `INSERT INTO journal_session_exercises (id, session_id, user_id, exercise_id, name_snapshot_en, position)
           VALUES ('44444444-4444-4444-8444-c00000000007', '${SESSION_A}', '${USER_B}', '${EX_SQUAT}', 'B sneaky', 0)`,
        ),
      );
    });
    expect(child?.code).toBe('23503');

    let grandchild: CapturedPgErrorShape | undefined;
    await asUser(db, USER_B, async (q) => {
      grandchild = await capturePgError(() =>
        q(
          `INSERT INTO journal_exercise_sets (id, session_exercise_id, user_id, position, format, weight_kg, reps)
           VALUES ('44444444-4444-4444-8444-c00000000008', '${SESSION_EX_A}', '${USER_B}', 0, 'weighted', 60, 8)`,
        ),
      );
    });
    expect(grandchild?.code).toBe('23503');
  });

  it('routine children (the structural completion): B cannot hang a routine-exercise/set off A routine tree', async () => {
    let child: CapturedPgErrorShape | undefined;
    await asUser(db, USER_B, async (q) => {
      child = await capturePgError(() =>
        q(
          `INSERT INTO journal_routine_exercises (id, routine_id, user_id, exercise_id, name_snapshot_en, position)
           VALUES ('44444444-4444-4444-8444-c00000000009', '${ROUTINE_A}', '${USER_B}', '${EX_SQUAT}', 'B sneaky', 0)`,
        ),
      );
    });
    expect(child?.code).toBe('23503');

    let grandchild: CapturedPgErrorShape | undefined;
    await asUser(db, USER_B, async (q) => {
      grandchild = await capturePgError(() =>
        q(
          `INSERT INTO journal_routine_sets (id, routine_exercise_id, user_id, position, format, weight_kg, reps)
           VALUES ('44444444-4444-4444-8444-c0000000000a', '${ROUTINE_EX_A}', '${USER_B}', 0, 'weighted', 60, 8)`,
        ),
      );
    });
    expect(grandchild?.code).toBe('23503');

    // And nothing was written anywhere (every probe aborted its own transaction).
    const leftovers = await adminQuery(
      db,
      `SELECT
         (SELECT count(*)::int FROM journal_session_exercises WHERE id::text LIKE '44444444-4444-4444-8444-c%') +
         (SELECT count(*)::int FROM journal_exercise_sets WHERE id::text LIKE '44444444-4444-4444-8444-c%') +
         (SELECT count(*)::int FROM journal_routine_exercises WHERE id::text LIKE '44444444-4444-4444-8444-c%') +
         (SELECT count(*)::int FROM journal_routine_sets WHERE id::text LIKE '44444444-4444-4444-8444-c%') AS n`,
    );
    expect((leftovers.rows[0] as { n: number }).n).toBe(0);
  });
});

// ===========================================================================
// History honesty under direct SQL — tombstones and the DELETE exception
// ===========================================================================

describe('tombstone path + the training-days DELETE exception', () => {
  it('no DELETE grant on the history tables — even the owner context cannot raw-DELETE a row (42501)', async () => {
    for (const table of ['journal_sessions', 'journal_routines']) {
      let denied: CapturedPgErrorShape | undefined;
      await asUser(db, USER_A, async (q) => {
        denied = await capturePgError(() => q(`DELETE FROM ${table} WHERE user_id = '${USER_A}'`));
      });
      expect(denied?.code, table).toBe('42501');
    }
    // A's rows all still there.
    expect((await adminQuery(db, `SELECT count(*)::int AS n FROM journal_sessions WHERE user_id = '${USER_A}'`)).rows[0]?.n).toBe(1);
  });

  it('training-days predicate-less DELETE under B clamps to B own row — both A marks survive', async () => {
    // COMMITTED: the clamp must persist to prove the scope, not just the
    // in-transaction rowCount (the default asUser transaction rolls back).
    await asUser(db, USER_B, async (q) => {
      const result = await q(`DELETE FROM journal_training_days`);
      expect(result.rowCount).toBe(1); // B's own mark only
    }, { commit: true });
    const aMarks = await adminQuery(db, `SELECT local_date::text AS d FROM journal_training_days WHERE user_id = '${USER_A}' ORDER BY local_date`);
    expect(aMarks.rows.map((row) => (row as { d: string }).d)).toEqual([DAY, DAY_2]);
    const bMarks = await adminQuery(db, `SELECT count(*)::int AS n FROM journal_training_days WHERE user_id = '${USER_B}'`);
    expect((bMarks.rows[0] as { n: number }).n).toBe(0);
  });

  it('C-context parity: a control user reads exactly its own (empty) scope — denials are authorization-driven', async () => {
    await asUser(db, USER_C, async (q) => {
      for (const table of ADOPTED) {
        expect((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, table).toBe(0);
      }
    });
  });
});
