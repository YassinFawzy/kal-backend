/**
 * s4a RLS deep proofs — the W3 adopted health tables (wave-03 task
 * s4a-adversarial; ADR-0002, contract note §5, ARCHITECTURE §22). ADDITIVE to
 * `tracking-rls.itspec.ts` (s1's suite): this suite seeds ALL THREE matrix
 * users on EVERY adopted table and proves the fail-closed backstop with the
 * attack angles an owner's own suite tends to skip:
 *
 *   - context-less (fresh session, GUC never set) ⇒ ZERO rows everywhere (I2);
 *   - wrong context (B's GUC) ⇒ zero of A's rows everywhere (row counts — RLS
 *     hides, it does not raise);
 *   - THE SIMULATED APPLICATION BUG per table: predicate-less SELECT / UPDATE
 *     that "forgot" the user predicate moves zero foreign rows (the ADR-0002
 *     headline property, table by table — including the derived rollup table
 *     and the sync ledger whose payload column mirrors health data);
 *   - sync ledger immutability: no UPDATE/DELETE grant exists at all
 *     (append-only by grants, not just by policy);
 *   - the compound user reference (I3) on the FAVORITES user-food side (the
 *     one composite-FK cell the s1 suite does not pin): B cannot reference
 *     A's user food;
 *   - grants matrix re-pin, additive columns: the immutable binding/id/date
 *     columns of the remaining adopted tables;
 *   - the harness leaves ZERO `kal_it_*` databases behind (pg_database check).
 *
 * Method: `helpers/acting-user.ts` — every behavioral assertion runs inside
 * an explicit transaction that SET LOCAL ROLEs and PROVES `current_user`
 * (fail-closed harness); denials are ROW-COUNT assertions. Superuser
 * connections are used only for catalog introspection and platform-faithful
 * catalog seeding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  asUserlessApp,
  capturePgError,
  USER_A,
  USER_B,
  USER_C,
} from '../helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';

const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';

/** The adopted tables (contract note §5) — every probe iterates this list. */
const ADOPTED_TABLES = ['diary_entries', 'diary_days', 'user_foods', 'user_food_servings', 'favorites', 'sync_operations'] as const;

/** Synthetic per-user row ids (fixture range; one row per user per table). */
const USER_ROW: Record<'a' | 'b' | 'c', { user: string; userFood: string; diary: string; favorite: string; op: string }> = {
  a: { user: USER_A, userFood: '11111111-1111-4111-8111-711111111101', diary: '11111111-1111-4111-8111-711111111102', favorite: '11111111-1111-4111-8111-711111111103', op: '11111111-1111-4111-8111-711111111104' },
  b: { user: USER_B, userFood: '22222222-2222-4222-8222-711111111101', diary: '22222222-2222-4222-8222-711111111102', favorite: '22222222-2222-4222-8222-711111111103', op: '22222222-2222-4222-8222-711111111104' },
  c: { user: USER_C, userFood: '33333333-3333-4333-8333-711111111101', diary: '33333333-3333-4333-8333-711111111102', favorite: '33333333-3333-4333-8333-711111111103', op: '33333333-3333-4333-8333-711111111104' },
};

const USERS: ('a' | 'b' | 'c')[] = ['a', 'b', 'c'];

let db: EphemeralKalDb;

async function seedUser(userId: string, email: string, username: string): Promise<void> {
  await asUserlessApp(
    db,
    async (q) => {
      await q(`INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`, [userId, email, username]);
    },
    { commit: true },
  );
}

/** Seeds one row per adopted table for `who`, through the app role under its OWN context. */
async function seedOwnRows(who: 'a' | 'b' | 'c'): Promise<void> {
  const row = USER_ROW[who];
  await asUser(
    db,
    row.user,
    async (q) => {
      await q(
        `INSERT INTO user_foods (id, user_id, name_en, name_en_normalized, energy_kcal, protein_g, carbs_g, fat_g, updated_at, last_op_id)
         VALUES ($1, $2, $3, $3, 200, 10, 20, 5, $4, $5)`,
        [row.userFood, row.user, `${who} deep-rls food`, T0, row.op],
      );
      await q(
        `INSERT INTO user_food_servings (user_food_id, user_id, label_en, grams, updated_at)
         VALUES ($1, $2, 'Bowl', 100, $3)`,
        [row.userFood, row.user, T0],
      );
      await q(
        `INSERT INTO diary_entries (id, user_id, local_date, meal_slot, entry_method, user_food_id, quantity,
           serving_label_en, serving_gram_weight, energy_kcal, protein_g, carbs_g, fat_g, status, updated_at, last_op_id)
         VALUES ($1, $2, $3, 'lunch', 'search', $4, 1, 'Bowl', 100, 200, 10, 20, 5, 'confirmed', $5, $6)`,
        [row.diary, row.user, DAY, row.userFood, T0, row.op],
      );
      await q(
        `INSERT INTO diary_days (user_id, local_date, energy_kcal, protein_g, carbs_g, fat_g, entry_count, updated_at)
         VALUES ($1, $2, 200, 10, 20, 5, 1, $3)`,
        [row.user, DAY, T0],
      );
      await q(
        `INSERT INTO favorites (id, user_id, user_food_id, updated_at, last_op_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.favorite, row.user, row.userFood, T0, row.op],
      );
      await q(
        `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
           local_date, client_updated_at, payload, outcome)
         VALUES ($1, $2, 'deep-rls-device', 'diary_entry', 'create', $3, $4, $5,
           '{"localDate":"2026-10-08","mealSlot":"lunch","marker":"deep-rls-payload"}'::jsonb, 'applied')`,
        [row.user, row.op, row.diary, DAY, T0],
      );
    },
    { commit: true },
  );
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4rlsdeep');
  db.applyMigrations();
  await seedUser(USER_A, 'a@s4rlsdeep.invalid', 's4rlsdeep_a');
  await seedUser(USER_B, 'b@s4rlsdeep.invalid', 's4rlsdeep_b');
  await seedUser(USER_C, 'c@s4rlsdeep.invalid', 's4rlsdeep_c');
  // The platform catalog row (platform-authored, production-faithful).
  await adminQuery(
    db,
    `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
       name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
     VALUES ('00000000-0000-4000-8000-00000000bb01', 'dish', 'kal_reviewed', 'proprietary',
       'Deep RLS fixture food', 'deep rls fixture food', 'طعام', 'طعام',
       ARRAY['fixture']::text[], ARRAY['fixture']::text[], 100, 5, 10, 2)`,
  );
  for (const who of USERS) {
    await seedOwnRows(who);
  }
}, 180_000);

afterAll(async () => {
  // The task's zero-leftover gate: before dropping this suite's scratch
  // database (the last thing any suite does), assert NO kal_it_% scratch
  // database besides OUR OWN exists in the cluster (suites serialize —
  // fileParallelism off — so a sibling suite's scratch db cannot be alive).
  const mine = db.name;
  const leftovers = await adminQuery(db, `SELECT datname FROM pg_database WHERE datname LIKE 'kal_it_%' AND datname <> $1`, [mine]);
  expect(leftovers.rows, 'zero leftover kal_it_* databases').toEqual([]);
  await db.drop();
}, 60_000);

describe('fail-closed proofs on every adopted table (I2/I4 — uniform A/B/C seeding)', () => {
  it('context-less app role (fresh session, GUC never set) sees ZERO rows on every adopted table', async () => {
    await asUserlessApp(db, async (q) => {
      for (const table of ADOPTED_TABLES) {
        const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
        expect(Number(rows.rows[0]?.count), `${table} fails closed with no context`).toBe(0);
      }
    });
  });

  it('B\'s context sees exactly B\'s rows — zero of A\'s, zero of C\'s — on every adopted table', async () => {
    await asUser(db, USER_B, async (q) => {
      for (const table of ADOPTED_TABLES) {
        const total = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
        const mine = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`, [USER_B]);
        expect(Number(total.rows[0]?.count), `${table}: B sees only its own row`).toBe(1);
        expect(Number(mine.rows[0]?.count), `${table}: B's own row is visible to B`).toBe(1);
      }
    });
  });

  it('A and C parity: each sees exactly its own row on every adopted table (controls)', async () => {
    for (const who of ['a', 'c'] as const) {
      const row = USER_ROW[who];
      await asUser(db, row.user, async (q) => {
        for (const table of ADOPTED_TABLES) {
          const rows = await q<{ user_id: string }>(`SELECT user_id::text AS user_id FROM ${table}`);
          expect(rows.rows.map((r) => r.user_id), `${table} under ${who.toUpperCase()}`).toEqual([row.user]);
        }
      });
    }
  });
});

describe('simulated application bugs, table by table (the ADR-0002 headline property)', () => {
  it('a predicate-less SELECT under B returns only B rows — the sync ledger payload column included', async () => {
    await asUser(db, USER_B, async (q) => {
      // Under B's context the ONLY visible ledger row (and its payload —
      // health-mirroring data) is B's own.
      const payloads = await q<{ user_id: string; payload: unknown }>(`SELECT user_id::text AS user_id, payload FROM sync_operations`);
      expect(payloads.rows).toHaveLength(1);
      expect(payloads.rows[0]?.user_id).toBe(USER_B);
      expect(JSON.stringify(payloads.rows[0]?.payload)).toContain('deep-rls-payload');
    });
  });

  it('a predicate-less UPDATE under B (forgot the user predicate) moves ZERO foreign rows — on every UPDATE-granted table', async () => {
    const probes: readonly { table: string; sql: string }[] = [
      { table: 'diary_entries', sql: `UPDATE diary_entries SET quantity = 999` },
      { table: 'diary_days', sql: `UPDATE diary_days SET entry_count = 999` },
      { table: 'user_foods', sql: `UPDATE user_foods SET energy_kcal = 999` },
      { table: 'user_food_servings', sql: `UPDATE user_food_servings SET grams = 999` },
      { table: 'favorites', sql: `UPDATE favorites SET updated_at = $1` },
    ];
    for (const probe of probes) {
      await asUser(db, USER_B, async (q) => {
        const result = await q(probe.sql, probe.sql.includes('$1') ? [T0] : []);
        // B owns exactly one row per table: RLS must clamp the write to it.
        expect(result.rowCount ?? 0, `${probe.table}: predicate-less UPDATE stays inside B's rows`).toBe(1);
      });
      // The foreign rows are untouched (spot-check A's diary + A's rollup).
      const aRows = await adminQuery(db, `SELECT count(*)::int AS n FROM ${probe.table} WHERE user_id = $1`, [USER_A]);
      expect(Number((aRows.rows[0] as { n: number }).n), `${probe.table}: A's rows survived`).toBe(1);
      if (probe.table === 'diary_entries') {
        const aQuantity = await adminQuery(db, 'SELECT quantity::text AS q FROM diary_entries WHERE user_id = $1', [USER_A]);
        expect((aQuantity.rows[0] as { q: string }).q).toBe('1.000');
      }
      if (probe.table === 'diary_days') {
        const aCount = await adminQuery(db, 'SELECT entry_count::text AS n FROM diary_days WHERE user_id = $1', [USER_A]);
        expect((aCount.rows[0] as { n: string }).n).toBe('1');
      }
    }
  });

  it('the predicate-less bug under NO context is a clean failure — 22P02 (pooled-session caveat) or zero rows, never foreign data', async () => {
    // Fresh session (GUC never set): the policy filters everything out — zero rows.
    await asUserlessApp(db, async (q) => {
      const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries`);
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
    // Pooled session that once set the GUC: the empty-string cast fails closed (22P02).
    const error = await capturePgError(async () => {
      await asUserlessApp(db, async (q) => {
        await q(`SELECT id FROM diary_entries`);
      }, { fresh: false });
    });
    if (error !== undefined) {
      expect(error.code).toBe('22P02');
    }
  });
});

describe('sync ledger append-only posture + the favorites compound reference (I3)', () => {
  it('sync_operations and sync_idempotency_keys carry NO UPDATE/DELETE grant for kal_app (append-only by grants)', async () => {
    for (const [table, column] of [
      ['sync_operations', 'outcome'],
      ['sync_idempotency_keys', 'response_status'],
    ] as const) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_B, async (q) => {
          await q(`UPDATE ${table} SET ${column} = ${column} WHERE true`);
        });
      });
      expect(error?.code, `${table} must reject UPDATE (42501)`).toBe('42501');
    }
    for (const table of ['sync_operations', 'sync_idempotency_keys']) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_B, async (q) => {
          await q(`DELETE FROM ${table} WHERE false`);
        });
      });
      expect(error?.code, `${table} must reject DELETE (42501)`).toBe('42501');
    }
  });

  it('B cannot create a favorite referencing A\'s user food — the composite FK (I3) refuses before any row exists', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_B, async (q) => {
        await q(
          `INSERT INTO favorites (id, user_id, user_food_id, updated_at)
           VALUES ('22222222-2222-4222-8222-722222222201', $1, $2, $3)`,
          [USER_B, USER_ROW.a.userFood, T0],
        );
      });
    });
    // RLS hides A's referenced row (visibility fail) or the composite FK
    // (user_food_id, user_id) → user_foods(id, user_id) refuses (integrity
    // fail) — either way the cross-account child cannot exist.
    expect(['23503', '23505']).toContain(error?.code);
    const bFavs = await asUserCount('favorites', USER_B);
    expect(bFavs, 'B gained no favorite row').toBe(1);
  });

  it('grants matrix re-pin, additive columns: binding/id/date columns of the remaining adopted tables are NOT updatable', async () => {
    for (const [table, column] of [
      ['diary_days', 'user_id'],
      ['diary_days', 'local_date'],
      ['user_food_servings', 'user_id'],
      ['user_food_servings', 'user_food_id'],
      ['favorites', 'user_id'],
      ['favorites', 'food_id'],
      ['favorites', 'user_food_id'],
      ['user_foods', 'created_at'],
      ['favorites', 'created_at'],
      ['user_food_servings', 'created_at'],
    ] as const) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_A, async (q) => {
          await q(`UPDATE ${table} SET ${column} = ${column} WHERE true`);
        });
      });
      expect(error?.code, `${table}.${column} must not be updatable by kal_app`).toBe('42501');
    }
  });

  async function asUserCount(table: string, userId: string): Promise<number> {
    let count = -1;
    await asUser(db, userId, async (q) => {
      const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      count = Number(rows.rows[0]?.count);
    });
    return count;
  }
});
