/**
 * Tracking + sync isolation — the W3 A/B/C matrix on the adopted health
 * tables (contract: docs/api/wave-03-contract.md §5; ledger criterion 1/8).
 *
 *   A owns the target rows (diary entry, user food + serving, favorite,
 *   sync op). B attacks every available read/mutate/reference/enumerate path
 *   with B's VALID context (the app role under B's own GUC). C is the
 *   control: C's rows behave exactly like A's, proving denials are
 *   authorization-driven, not availability noise.
 *
 * Required cases (task contract — "RLS fail-closed proofs on the adopted
 * health tables per the W1 pilot pattern"):
 *   - context-less query ⇒ ZERO rows on every adopted table (fail-closed, I2);
 *   - wrong GUC ⇒ zero foreign rows (row-count assertions — RLS hides, it
 *     does not raise);
 *   - simulated application bug: a query that "forgot" the user predicate
 *     returns zero foreign rows (the ADR-0002 headline test);
 *   - the pooled-session 22P02 caveat (GUC once set reads back '') — still
 *     fail-closed;
 *   - compound user references (I3): B cannot create a child row referencing
 *     A's user food — the composite FK makes it structurally impossible;
 *   - user binding immutability: no UPDATE grant on id/user_id/created_at;
 *   - B replaying A's identifiers: lookups by A's entity/op ids return zero
 *     rows under B's context (stable IDs are never authorization — I6);
 *   - platform scope: NO grants on adopted tables this wave (ledger §6 — no
 *     cross-account job exists; grant-without-policy would be inert noise);
 *     the declined catalog is readable per its documented posture;
 *   - the weight_log retroactive FK (W3 carryover b) live-enforces
 *     ON DELETE RESTRICT with children present;
 *   - grants matrix: least-privilege column scoping pinned behaviorally.
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
} from './helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';

let db: EphemeralKalDb;
let foodId = '';
let entryA = '';
let userFoodA = '';
let favoriteA = '';

/** Fixture-shape inserts used verbatim across users (values are neutral). */
const FOOD_COLUMNS = `(
  '00000000-0000-4000-8000-00000000aa01', 'dish', 'kal_reviewed', 'proprietary',
  'Fixture food', 'fixture food', 'طعام تجريبي', 'طعام تجريبي',
  ARRAY['fixture']::text[], ARRAY['fixture']::text[],
  100, 5, 10, 2
)`;

async function seedUser(userId: string, email: string, username: string): Promise<void> {
  // Through the app role, the way the signup service writes (users is not an
  // RLS table; the INSERT grant is the signup path's grant).
  await asUserlessApp(db, async (q) => {
    await q(
      `INSERT INTO users (id, email, username, status) VALUES ($1, $2, $3, 'active')`,
      [userId, email, username],
    );
  }, { commit: true });
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('tracking-rls');
    db.applyMigrations();

    await seedUser(USER_A, 'a@tracking-rls.invalid', 'tracking_rls_a');
    await seedUser(USER_B, 'b@tracking-rls.invalid', 'tracking_rls_b');
    await seedUser(USER_C, 'c@tracking-rls.invalid', 'tracking_rls_c');

    // A owns the attack-target rows; user-owned rows are created by their own
    // user under its own context (the harness never fabricates USER-OWNED rows
    // via admin authority). The platform CATALOG is different: it is
    // platform-authored (kal_app and kal_platform both hold SELECT-only — the
    // grant matrix below pins it), and in production catalog rows arrive via
    // the admin-run seed — so the fixture food is seeded the production-
    // faithful way, via the migration/admin connection.
    await adminQuery(
      db,
      `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
         name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
       VALUES ${FOOD_COLUMNS}`,
    );
    await asUser(db, USER_A, async (q) => {
      const food = await q<{ id: string }>(`SELECT id FROM foods LIMIT 1`);
      foodId = food.rows[0]!.id;
      await q(
        `INSERT INTO user_foods (id, user_id, name_en, name_en_normalized, energy_kcal, protein_g, carbs_g, fat_g,
           updated_at, last_op_id)
         VALUES ('11111111-1111-4111-8111-211111111111', $1, 'A own food', 'a own food', 200, 10, 20, 5, $2,
           '11111111-1111-4111-8111-211111111112')`,
        [USER_A, T0],
      );
      userFoodA = '11111111-1111-4111-8111-211111111111';
      await q(
        `INSERT INTO user_food_servings (user_food_id, user_id, label_en, grams, updated_at)
         VALUES ($1, $2, 'Bowl', 100, $3)`,
        [userFoodA, USER_A, T0],
      );
      await q(
        `INSERT INTO diary_entries (id, user_id, local_date, meal_slot, entry_method, food_id, quantity,
           serving_label_en, serving_gram_weight, energy_kcal, protein_g, carbs_g, fat_g, status, updated_at, last_op_id)
         VALUES ('11111111-1111-4111-8111-311111111111', $1, $2, 'breakfast', 'search', $3, 1.5,
           'Bowl', 100, 150, 7.5, 15, 3, 'confirmed', $4, '11111111-1111-4111-8111-311111111112')`,
        [USER_A, DAY, foodId, T0],
      );
      entryA = '11111111-1111-4111-8111-311111111111';
      await q(
        `INSERT INTO favorites (id, user_id, food_id, updated_at, last_op_id)
         VALUES ('11111111-1111-4111-8111-411111111111', $1, $2, $3, '11111111-1111-4111-8111-411111111112')`,
        [USER_A, foodId, T0],
      );
      favoriteA = '11111111-1111-4111-8111-411111111111';
      await q(
        `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
           local_date, client_updated_at, payload, outcome)
         VALUES ($1, '11111111-1111-4111-8111-511111111111', 'device-a', 'diary_entry', 'create',
           '11111111-1111-4111-8111-311111111111', $2, $3,
           '{"localDate":"2026-10-08","mealSlot":"breakfast"}'::jsonb, 'applied')`,
        [USER_A, DAY, T0],
      );
      await q(
        `INSERT INTO diary_days (user_id, local_date, energy_kcal, protein_g, carbs_g, fat_g, entry_count, updated_at)
         VALUES ($1, $2, 150, 7.5, 15, 3, 1, $3)`,
        [USER_A, DAY, T0],
      );
    }, { commit: true });

    // B and C seed their own rows (control parity).
    for (const [user, suffix] of [[USER_B, 'b'], [USER_C, 'c']] as const) {
      await asUser(db, user, async (q) => {
        await q(
          `INSERT INTO diary_entries (id, user_id, local_date, meal_slot, entry_method, quantity,
             serving_gram_weight, energy_kcal, protein_g, carbs_g, fat_g, status, updated_at)
           VALUES ('22222222-2222-4222-8222-${suffix}11111111111', $1, $2, 'lunch', 'quick_add', 1, NULL,
             300, 0, 75, 0, 'confirmed', $3)`,
          [user, DAY, T0],
        );
      }, { commit: true });
    }
  })();
});

afterAll(() => {
  return db.drop();
});

describe('A/B/C positive parity — own rows work for A and C alike', () => {
  it('A sees exactly A rows; C sees exactly C rows (diary)', async () => {
    for (const [user, own, foreign] of [
      [USER_A, entryA, '22222222-2222-4222-8222-b11111111111'],
      [USER_C, '22222222-2222-4222-8222-c11111111111', entryA],
    ] as const) {
      await asUser(db, user, async (q) => {
        const rows = await q<{ id: string }>(`SELECT id FROM diary_entries ORDER BY id`);
        expect(rows.rows.map((row) => row.id)).toEqual([own]);
        expect(rows.rows[0]?.id).not.toBe(foreign);
      });
    }
  });

  it('A can update its own mutable entry columns (LWW/tombstone grant scope)', async () => {
    await asUser(db, USER_A, async (q) => {
      const updated = await q<{ updated_at: Date }>(
        `UPDATE diary_entries SET quantity = 2, updated_at = $2, last_op_id = '11111111-1111-4111-8111-311111111113'
         WHERE id = $1 RETURNING updated_at`,
        [entryA, '2026-10-08T08:00:00Z'],
      );
      expect(updated.rows).toHaveLength(1);
    });
  });
});

describe('fail-closed proofs (I2/I4 — zero rows, never errors)', () => {
  it('context-less app role sees ZERO rows on every adopted table (fresh session, GUC never set)', async () => {
    await asUserlessApp(db, async (q) => {
      for (const table of ['diary_entries', 'diary_days', 'favorites', 'user_foods', 'user_food_servings', 'sync_operations']) {
        const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
        expect(Number(rows.rows[0]?.count), `${table} fails closed with no context`).toBe(0);
      }
    });
  });

  it('wrong GUC (B context) yields zero A rows on every adopted table', async () => {
    await asUser(db, USER_B, async (q) => {
      // Probe OWNED-BY-A rows specifically: RLS under B's context must yield
      // none of them, on every adopted table (row-count assertions — RLS
      // hides, it does not raise).
      for (const table of ['diary_entries', 'diary_days', 'favorites', 'user_foods', 'user_food_servings', 'sync_operations']) {
        const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`, [USER_A]);
        expect(Number(rows.rows[0]?.count), `${table} hides A's rows from B`).toBe(0);
      }
    });
  });

  it('simulated bug: an unscoped query "forgot" the predicate and still returns zero foreign rows', async () => {
    // The ADR-0002 headline test: the application forgot the user-scoped
    // predicate; the DATABASE blocks the leak. A row-count assertion — RLS
    // hides rows, it does not raise.
    await asUserlessApp(db, async (q) => {
      const rows = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM diary_entries WHERE local_date = $1`,
        [DAY],
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  });

  it('pooled-session caveat: a GUC set once reads back as empty string — 22P02, still fail-closed', async () => {
    const session = await openRoleSession(db, false);
    try {
      await inRoleTx(session, 'kal_app', USER_A, async (q) => {
        const own = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries`);
        expect(Number(own.rows[0]?.count)).toBe(1);
      });
      // Same pooled session, a NEW transaction with NO context: the GUC
      // reads back '' (not NULL) — the cast fails with 22P02. No rows move.
      const error = await capturePgError(async () => {
        await inRoleTx(session, 'kal_app', null, async (q) => {
          await q(`SELECT id FROM diary_entries`);
        });
      });
      expect(error?.code).toBe('22P02');
    } finally {
      await session.finish();
    }
  });
});

describe('B attacks A — mutations, references, and replayed identifiers', () => {
  it('B cannot update A rows (row count assertions; RLS hides them)', async () => {
    await asUser(db, USER_B, async (q) => {
      const updated = await q<{ count: string }>(
        `UPDATE diary_entries SET quantity = 99 WHERE id = $1`,
        [entryA],
      );
      expect(updated.rowCount ?? 0).toBe(0);
    });
    // A's row is untouched (compared against the SEEDED value — B changed
    // nothing; the parity case above proves updates work in-transaction via
    // rollback harness semantics).
    await asUser(db, USER_A, async (q) => {
      const row = await q<{ quantity: string }>(`SELECT quantity::text AS quantity FROM diary_entries WHERE id = $1`, [entryA]);
      expect(row.rows[0]?.quantity).toBe('1.500');
    });
  });

  it('B cannot delete A rows (no DELETE grant and no visibility)', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_B, async (q) => {
        await q(`DELETE FROM diary_entries WHERE id = $1`, [entryA]);
      });
    });
    // The no-DELETE-grant structural posture fires before RLS even matters.
    expect(error?.code).toBe('42501');
  });

  it('B cannot move A row ownership: user_id carries no UPDATE grant (42501)', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_B, async (q) => {
        await q(`UPDATE diary_entries SET user_id = $1 WHERE id = $2`, [USER_B, entryA]);
      });
    });
    expect(error?.code).toBe('42501');
  });

  it('compound user reference (I3): B cannot reference A user food — composite FK blocks', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_B, async (q) => {
        await q(
          `INSERT INTO user_food_servings (user_food_id, user_id, label_en, grams, updated_at)
           VALUES ($1, $2, 'Hijack', 100, $3)`,
          [userFoodA, USER_B, T0],
        );
      });
    });
    // The attack insert is refused. The composite FK (I3) independently
    // proves itself on diary_entries (next case — no competing index there);
    // here PostgreSQL may fire the partial unique index first (23505):
    // unique indexes ignore RLS, so B's attack on A's food id collides with
    // A's active serving set BEFORE the FK is probed. Either refusal blocks
    // the write; no row is created either way.
    expect(['23503', '23505']).toContain(error?.code);
  });

  it('compound user reference (I3): B diary entry cannot point at A user food (23503)', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_B, async (q) => {
        await q(
          `INSERT INTO diary_entries (id, user_id, local_date, meal_slot, entry_method, user_food_id, quantity,
             serving_gram_weight, energy_kcal, protein_g, carbs_g, fat_g, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'dinner', 'search', $3, 1, 100, 200, 10, 20, 5, 'confirmed', $4)`,
          [USER_B, DAY, userFoodA, T0],
        );
      });
    });
    expect(error?.code).toBe('23503');
  });

  it('B replaying A entity/op identifiers gets zero rows (I6 — stable IDs are never authorization)', async () => {
    await asUser(db, USER_B, async (q) => {
      const byEntity = await q<{ count: string }>(`SELECT count(*)::text AS count FROM diary_entries WHERE id = $1`, [entryA]);
      expect(Number(byEntity.rows[0]?.count)).toBe(0);
      const byOp = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM sync_operations WHERE client_op_id = '11111111-1111-4111-8111-511111111111'`,
      );
      expect(Number(byOp.rows[0]?.count)).toBe(0);
      const byFavorite = await q<{ count: string }>(`SELECT count(*)::text AS count FROM favorites WHERE id = $1`, [favoriteA]);
      expect(Number(byFavorite.rows[0]?.count)).toBe(0);
    });
  });

  it('dedupe key is (user, client op id): the same op id under B is a different key — and stays invisible', async () => {
    await asUser(db, USER_B, async (q) => {
      // Structurally legal (uniqueness is per-user) — B's ledger row. COMMIT:
      // this row must survive for the visibility probes below.
      await q(
        `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
           local_date, client_updated_at, payload, outcome)
         VALUES ($1, '11111111-1111-4111-8111-511111111111', 'device-b', 'diary_entry', 'create',
           '22222222-2222-4222-8222-b11111111111', $2, $3, '{}'::jsonb, 'applied')`,
        [USER_B, DAY, T0],
      );
    }, { commit: true });
    // B's replayed-op lookup still finds ZERO A rows — dedupe never matches
    // across users (the schema-level fact the ingestion layer relies on).
    await asUser(db, USER_B, async (q) => {
      const rows = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM sync_operations WHERE client_op_id = '11111111-1111-4111-8111-511111111111'`,
      );
      expect(Number(rows.rows[0]?.count)).toBe(1); // only B's own
    });
    await asUser(db, USER_A, async (q) => {
      const rows = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM sync_operations WHERE client_op_id = '11111111-1111-4111-8111-511111111111'`,
      );
      expect(Number(rows.rows[0]?.count)).toBe(1); // only A's own
    });
  });

  it('same (user, client op id) twice is rejected (23505 — the dedupe uniqueness)', async () => {
    const error = await capturePgError(async () => {
      await asUser(db, USER_A, async (q) => {
        await q(
          `INSERT INTO sync_operations (user_id, client_op_id, device_id, entity_kind, entity_action, entity_id,
             local_date, client_updated_at, payload, outcome)
           VALUES ($1, '11111111-1111-4111-8111-511111111111', 'device-a', 'diary_entry', 'create',
             '11111111-1111-4111-8111-311111111111', $2, $3, '{}'::jsonb, 'applied')`,
          [USER_A, DAY, T0],
        );
      });
    });
    expect(error?.code).toBe('23505');
  });
});

describe('grants matrix (least privilege, behaviorally pinned)', () => {
  it('kal_app cannot UPDATE immutable columns on owned tables (id/user_id/created_at)', async () => {
    for (const [table, column] of [
      ['diary_entries', 'user_id'],
      ['diary_entries', 'id'],
      ['diary_entries', 'created_at'],
      ['user_foods', 'user_id'],
      ['favorites', 'created_at'],
      ['sync_operations', 'client_op_id'],
      ['sync_idempotency_keys', 'idempotency_key'],
    ] as const) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_A, async (q) => {
          await q(`UPDATE ${table} SET ${column} = ${column} WHERE true`);
        });
      });
      expect(error?.code, `${table}.${column} must not be updatable by kal_app`).toBe('42501');
    }
  });

  it('kal_app cannot DELETE from tombstone-only tables', async () => {
    for (const table of ['diary_entries', 'user_foods', 'favorites', 'sync_operations']) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_A, async (q) => {
          await q(`DELETE FROM ${table} WHERE false`);
        });
      });
      expect(error?.code, `${table} must not carry a DELETE grant`).toBe('42501');
    }
  });

  it('kal_app cannot author the platform catalog (foods/serving_variants INSERT)', async () => {
    for (const table of ['foods', 'serving_variants']) {
      const error = await capturePgError(async () => {
        await asUser(db, USER_A, async (q) => {
          await q(`INSERT INTO ${table} (${table === 'foods' ? 'type, provenance, license_partition, name_en, name_en_normalized, energy_kcal, protein_g, carbs_g, fat_g' : 'food_id, label_en, grams'}) VALUES (${table === 'foods' ? "'dish', 'kal_reviewed', 'proprietary', 'x', 'x', 1, 0, 0, 0" : gen_random_uuid_ref() + ", 'x', 1"})`);
        });
      });
      expect(error?.code, `${table} INSERT must be platform-authored`).toBe('42501');
    }
  });

  it('kal_app CAN append barcode cache rows (the resolution path) — no UPDATE, no DELETE', async () => {
    await asUser(db, USER_A, async (q) => {
      await q(
        `INSERT INTO barcode_product_cache (barcode, source, payload)
         VALUES ('6221031490012', 'open_food_facts', '{"attribution":"Open Food Facts"}'::jsonb)
         ON CONFLICT (barcode) DO NOTHING`,
      );
      const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM barcode_product_cache`);
      expect(Number(rows.rows[0]?.count)).toBe(1);
    });
    const noUpdate = await capturePgError(async () => {
      await asUser(db, USER_A, async (q) => {
        await q(`UPDATE barcode_product_cache SET source = 'platform'`);
      });
    });
    expect(noUpdate?.code).toBe('42501');
  });

  it('platform scope: NO grants on adopted health tables this wave (ledger §6)', async () => {
    for (const table of ['diary_entries', 'diary_days', 'favorites', 'user_foods', 'user_food_servings', 'sync_operations', 'sync_idempotency_keys', 'user_food_create_counters']) {
      const error = await capturePgError(async () => {
        await asPlatform(db, async (q) => {
          await q(`SELECT count(*) FROM ${table}`);
        });
      });
      expect(error?.code, `${table} must carry no platform grant without an enumerated job`).toBe('42501');
    }
  });

  it('platform scope: the declined catalog IS readable (documented posture)', async () => {
    await asPlatform(db, async (q) => {
      const rows = await q<{ count: string }>(`SELECT count(*)::text AS count FROM foods`);
      expect(Number(rows.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });
  });

  it('RLS adopt/decline shipped structurally: policies exist exactly on the adopted tables', async () => {
    const policies = await adminQuery<{ tablename: string; policyname: string }>(
      db,
      `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'weight_log'
        ORDER BY tablename, policyname`,
    );
    expect(policies.rows).toEqual([
      { tablename: 'diary_days', policyname: 'diary_days_user_context' },
      { tablename: 'diary_entries', policyname: 'diary_entries_user_context' },
      { tablename: 'favorites', policyname: 'favorites_user_context' },
      { tablename: 'sync_operations', policyname: 'sync_operations_user_context' },
      { tablename: 'user_food_servings', policyname: 'user_food_servings_user_context' },
      { tablename: 'user_foods', policyname: 'user_foods_user_context' },
    ]);
    const declined = await adminQuery<{ relname: string; relrowsecurity: boolean }>(
      db,
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
          AND relname IN ('foods', 'serving_variants', 'barcode_product_cache', 'sync_idempotency_keys', 'user_food_create_counters', 'recovery_request_counters')
        ORDER BY relname`,
    );
    expect(declined.rows.every((row) => row.relrowsecurity === false)).toBe(true);
  });
});

describe('W3 carryover b: weight_log user FK live-enforces RESTRICT', () => {
  it('deleting a user with children is refused (23503) — account deletion is an explicit job', async () => {
    // A real weight row through A's context, then the platform-shaped user
    // deletion attempt (users carries the platform SELECT/DELETE grant).
    await asUser(db, USER_A, async (q) => {
      await q(
        `INSERT INTO weight_log (id, user_id, recorded_at, weight_kg)
         VALUES ('11111111-1111-4111-8111-611111111111', $1, $2, 70.00)`,
        [USER_A, T0],
      );
    }, { commit: true });
    const error = await capturePgError(async () => {
      await asPlatform(db, async (q) => {
        await q(`DELETE FROM users WHERE id = $1`, [USER_A]);
      });
    });
    // A has several child kinds (diary, favorites, sync ops, weight) — the
    // FK checked first names itself; the invariant under test is RESTRICT.
    expect(error?.code).toBe('23503');
  });

  it('the weight_log FK specifically fires for a user whose ONLY children are weigh-ins (23503, names weight_log)', async () => {
    // Isolate the carryover's own constraint: a fixture user whose only
    // child rows are weigh-ins.
    const userD = '44444444-4444-4444-8444-444444444444';
    await seedUser(userD, 'd@tracking-rls.invalid', 'tracking_rls_d');
    await asUser(db, userD, async (q) => {
      await q(
        `INSERT INTO weight_log (id, user_id, recorded_at, weight_kg)
         VALUES ('11111111-1111-4111-8111-611111111112', $1, $2, 71.50)`,
        [userD, T0],
      );
    }, { commit: true });
    const error = await capturePgError(async () => {
      await asPlatform(db, async (q) => {
        await q(`DELETE FROM users WHERE id = $1`, [userD]);
      });
    });
    expect(error?.code).toBe('23503');
    expect(error?.message).toContain('weight_log');
  });

  it('the compound-FK pattern remains documented-but-unpinned for weight_log (root table, no children)', async () => {
    // Structural documentation: weight_log's FK is the plain shape (no
    // (id, user_id) unique pair needed — nothing references weight logs).
    const fks = await adminQuery<{ conname: string }>(
      db,
      `SELECT conname FROM pg_constraint WHERE conrelid = 'weight_log'::regclass AND contype = 'f'`,
    );
    expect(fks.rows.map((row) => row.conname)).toEqual(['weight_log_user_id_fkey']);
  });
});

function gen_random_uuid_ref(): string {
  return 'gen_random_uuid()';
}
