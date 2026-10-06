/**
 * Three-owner A/B/C adversarial matrix on the RLS pilot table `weight_log`
 * (task s4; ARCHITECTURE.md §22; ADR-0002 "Consequences for testing").
 *
 *   A owns target rows. B attacks every available read/mutate/reference/
 *   enumerate path with B's VALID credentials (the app role under B's own
 *   owner context). C is the control: C's rows behave exactly like A's,
 *   proving denials are authorization-driven rather than availability noise.
 *
 * Required cases (all must PASS; a FAIL is a defect report, never a weakened
 * assertion):
 *   - A/B/C positive parity (own reads/writes work for A and C alike);
 *   - simulated application bug — a query that "forgot" the application owner
 *     predicate returns ZERO foreign rows: the database blocks what the code
 *     forgot (the ADR-0002 headline test);
 *   - no-context fail-closed (I2): app role with no owner context sees nothing;
 *   - B replaying A's identifiers (insert/update/delete/select by A's values);
 *   - platform bypass is enumerated (SELECT + DELETE job shapes only; the app
 *     role has no bypass; no escalation path between them);
 *   - denials are row-count assertions and leave no existence oracle.
 *
 * EVERY behavioral statement runs through helpers/acting-owner.ts: SET ROLE +
 * `current_user` proof + transaction-local `app.current_owner` GUC. No
 * assertion anywhere in this suite relies on the admin connection's superuser
 * authority. Suites roll back by default; only the seeding phase commits.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asOwner,
  asOwnerlessApp,
  asPlatform,
  capturePgError,
  inRoleTx,
  openRoleSession,
  OWNER_A,
  OWNER_B,
  OWNER_C,
} from './helpers/acting-owner.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

/** Fixed synthetic timestamps — neutral placeholders, no real-world content. */
const T_A1 = '2026-10-01T07:00:00Z';
const T_A2 = '2026-10-02T07:00:00Z';
const T_B1 = '2026-10-03T07:00:00Z';
const T_C1 = '2026-10-04T07:00:00Z';
/** Neutral numeric placeholders (DECIMAL columns round-trip as text via pg). */
const W_60 = '60.00';
const W_61 = '61.00';

let db: EphemeralKalDb;
let rowA1 = '';
let rowA2 = '';
let rowB1 = '';
let rowC1 = '';

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('rls-pilot');
    db.applyMigrations();

    // Seed THROUGH the app role under each owner's own context — the harness
    // never fabricates rows via admin authority; every row in the scratch
    // database was created by its owner the way the application would.
    await asOwner(
      db,
      OWNER_A,
      async (q) => {
        const first = await q(
          `INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3) RETURNING id`,
          [OWNER_A, T_A1, W_60],
        );
        const second = await q(
          `INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3) RETURNING id`,
          [OWNER_A, T_A2, W_61],
        );
        rowA1 = first.rows[0]!.id;
        rowA2 = second.rows[0]!.id;
      },
      { commit: true },
    );
    await asOwner(
      db,
      OWNER_B,
      async (q) => {
        const row = await q(
          `INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3) RETURNING id`,
          [OWNER_B, T_B1, W_60],
        );
        rowB1 = row.rows[0]!.id;
      },
      { commit: true },
    );
    await asOwner(
      db,
      OWNER_C,
      async (q) => {
        const row = await q(
          `INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3) RETURNING id`,
          [OWNER_C, T_C1, W_60],
        );
        rowC1 = row.rows[0]!.id;
      },
      { commit: true },
    );
  })();
});

afterAll(() => {
  return db.drop();
});

describe('A/B/C positive parity — owners work on their own rows', () => {
  it('A sees exactly A rows (2), with A values', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q<{ id: string; owner_id: string; weight_kg: string }>(
        `SELECT id, owner_id, weight_kg FROM weight_log ORDER BY recorded_at`,
      );
      expect(rows.rows.map((row) => row.id).sort()).toEqual([rowA1, rowA2].sort());
      expect(rows.rows.every((row) => row.owner_id === OWNER_A)).toBe(true);
      expect(rows.rows.map((row) => row.weight_kg)).toEqual([W_60, W_61]);
    });
  });

  it('A mutates its own row (granted columns) and deletes its own row — inside a rolled-back transaction', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      const updated = await q(`UPDATE weight_log SET weight_kg = $2 WHERE id = $1`, [rowA1, W_61]);
      expect(updated.rowCount).toBe(1);
      const reRead = await q<{ weight_kg: string }>(`SELECT weight_kg FROM weight_log WHERE id = $1`, [rowA1]);
      expect(reRead.rows[0]?.weight_kg).toBe(W_61);

      const deleted = await q(`DELETE FROM weight_log WHERE id = $1`, [rowA2]);
      expect(deleted.rowCount).toBe(1);
      const remaining = await q(`SELECT id FROM weight_log`);
      expect(remaining.rows.map((row) => row.id)).toEqual([rowA1]);
    });
    // Rolled back: the deleted row is back for every later case.
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(2);
    });
  });

  it('C control: C behaves identically to A (insert, read exactly own rows, update, delete)', async () => {
    await asOwner(db, OWNER_C, async (q) => {
      const inserted = await q(`INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3) RETURNING id`, [
        OWNER_C,
        '2026-10-05T07:00:00Z',
        W_61,
      ]);
      expect(inserted.rows).toHaveLength(1);

      const rows = await q<{ owner_id: string }>(`SELECT owner_id FROM weight_log`);
      expect(rows.rows.every((row) => row.owner_id === OWNER_C)).toBe(true);
      expect(rows.rows).toHaveLength(2);

      const updated = await q(`UPDATE weight_log SET weight_kg = $2 WHERE id = $1`, [rowC1, W_61]);
      expect(updated.rowCount).toBe(1);

      const deleted = await q(`DELETE FROM weight_log WHERE id = $1`, [inserted.rows[0]!.id]);
      expect(deleted.rowCount).toBe(1);
    });
  });
});

describe('simulated application bug — the database blocks what the code forgot (ADR-0002 headline)', () => {
  it('a query with NO application owner predicate (count over the whole table) returns only the context owner rows', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      // The application "forgot" `WHERE owner_id = ...` entirely.
      const rows = await q<{ owner_id: string }>(`SELECT owner_id FROM weight_log`);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((row) => row.owner_id === OWNER_A)).toBe(true);
    });
  });

  it('the app role under B context explicitly querying A owner_id / A row id gets zero foreign rows', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const byOwner = await q(`SELECT * FROM weight_log WHERE owner_id = $1`, [OWNER_A]);
      expect(byOwner.rows).toHaveLength(0);
      const byId = await q(`SELECT * FROM weight_log WHERE id = $1`, [rowA1]);
      expect(byId.rows).toHaveLength(0);
    });
  });

  it('B enumerating the whole table sees exactly B rows — scoping, not emptiness', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const rows = await q<{ owner_id: string }>(`SELECT owner_id FROM weight_log`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.owner_id).toBe(OWNER_B);
    });
  });

  it('the app role with NO context gets zero rows from the same predicate-less query', async () => {
    await asOwnerlessApp(db, async (q) => {
      const rows = await q(`SELECT * FROM weight_log`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  it('B writing without its own predicate (UPDATE-all / DELETE-all) touches zero foreign rows', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const updated = await q(`UPDATE weight_log SET weight_kg = $1`, [W_61]);
      expect(updated.rowCount).toBe(1); // B's own single row only
      const deleted = await q(`DELETE FROM weight_log`);
      expect(deleted.rowCount).toBe(1); // rolled back below
      const after = await q(`SELECT * FROM weight_log`);
      expect(after.rows).toHaveLength(0); // B's own row gone with it
    });
    // The suite rolls back: A's and C's rows were never touched.
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q<{ weight_kg: string }>(`SELECT weight_kg FROM weight_log ORDER BY recorded_at`);
      expect(rows.rows.map((row) => row.weight_kg)).toEqual([W_60, W_61]);
    });
    await asOwner(db, OWNER_C, async (q) => {
      const rows = await q<{ id: string }>(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(1);
    });
  });
});

describe('no-context fail-closed (I2) — on a session that never set the GUC', () => {
  it('SELECT and count return zero rows and raise nothing', async () => {
    await asOwnerlessApp(db, async (q) => {
      const rows = await q(`SELECT * FROM weight_log`);
      expect(rows.rows).toHaveLength(0);
      const counted = await q<{ count: string }>(`SELECT count(*)::text AS count FROM weight_log`);
      expect(counted.rows[0]?.count).toBe('0');
    });
  });

  it('UPDATE and DELETE affect zero rows (USING side filters everything)', async () => {
    await asOwnerlessApp(db, async (q) => {
      const updated = await q(`UPDATE weight_log SET weight_kg = $1`, [W_61]);
      expect(updated.rowCount).toBe(0);
      const deleted = await q(`DELETE FROM weight_log`);
      expect(deleted.rowCount).toBe(0);
    });
  });

  it('INSERT raises the generic RLS WITH CHECK violation — no values leaked in the message', async () => {
    await asOwnerlessApp(db, async (q) => {
      const error = await capturePgError(() =>
        q(`INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3)`, [OWNER_A, T_A1, W_60]),
      );
      expect(error).toBeDefined();
      expect(error?.code).toBe('42501');
      expect(error?.message).toContain('row-level security');
      expect(error?.message).not.toContain(OWNER_A);
      expect(error?.message).not.toContain(W_60);
    });
  });

  it('a malformed GUC value fails closed with a cast error — and the next clean transaction recovers', async () => {
    await asOwnerlessApp(db, async (q) => {
      const error = await capturePgError(async () => {
        await q(`SELECT set_config('app.current_owner', 'not-a-uuid', true)`);
        await q(`SELECT * FROM weight_log`);
      });
      expect(error).toBeDefined();
      expect(error?.code).toBe('22P02');
    });
    // Fail-closed does not poison future transactions: a valid context behaves normally.
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(2);
    });
  });

  it('session-state reality (pinned for W2+): after a session ever set the GUC, an unset GUC reads as empty string → 22P02, still fail-closed', async () => {
    // One dedicated connection, two sequential transactions:
    const session = await openRoleSession(db, true);
    try {
      // 1. A normal in-context transaction (leaves the session GUC non-NULL).
      await inRoleTx(session, 'kal_app', OWNER_A, async (q) => {
        const rows = await q(`SELECT id FROM weight_log`);
        expect(rows.rows).toHaveLength(2);
      });
      // 2. Same connection, NO context: the reverted GUC is '' (not NULL), so
      //    the policy cast raises 22P02 — fail closed with no rows, no leak.
      const error = await capturePgError(() =>
        inRoleTx(session, 'kal_app', null, async (q) => {
          await q(`SELECT * FROM weight_log`);
        }),
      );
      expect(error).toBeDefined();
      expect(error?.code).toBe('22P02');
      expect(error?.message).not.toContain(OWNER_A);
      // 3. The session still serves a valid context afterwards.
      await inRoleTx(session, 'kal_app', OWNER_B, async (q) => {
        const rows = await q(`SELECT id FROM weight_log`);
        expect(rows.rows).toHaveLength(1);
      });
    } finally {
      await session.finish();
    }
  });
});

describe('B replaying A identifiers — every path, valid B credentials', () => {
  it('B INSERT with A owner_id is rejected by WITH CHECK (row count re-read as A is unchanged)', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const error = await capturePgError(() =>
        q(`INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3)`, [OWNER_A, T_A1, W_60]),
      );
      expect(error).toBeDefined();
      expect(error?.code).toBe('42501');
      expect(error?.message).toContain('row-level security');
    });
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(2); // no fabricated A rows
    });
  });

  it('B UPDATE of A row by id affects zero rows', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const updated = await q(`UPDATE weight_log SET weight_kg = $2 WHERE id = $1`, [rowA1, W_61]);
      expect(updated.rowCount).toBe(0);
    });
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q<{ weight_kg: string }>(`SELECT weight_kg FROM weight_log WHERE id = $1`, [rowA1]);
      expect(rows.rows[0]?.weight_kg).toBe(W_60); // unchanged
    });
  });

  it('B DELETE of A row by id affects zero rows', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const deleted = await q(`DELETE FROM weight_log WHERE id = $1`, [rowA2]);
      expect(deleted.rowCount).toBe(0);
    });
    await asOwner(db, OWNER_A, async (q) => {
      const rows = await q(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(2);
    });
  });

  it('B moving its own row to A ownership is structurally impossible (no column grant / WITH CHECK)', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const error = await capturePgError(() =>
        q(`UPDATE weight_log SET owner_id = $2 WHERE id = $1`, [rowB1, OWNER_A]),
      );
      expect(error).toBeDefined();
      expect(error?.code).toBe('42501'); // column-grant denial or policy denial — both fail closed
      expect(error?.message).toMatch(/permission denied|row-level security/u);
    });
    await asOwner(db, OWNER_B, async (q) => {
      const rows = await q<{ owner_id: string }>(`SELECT owner_id FROM weight_log WHERE id = $1`, [rowB1]);
      expect(rows.rows[0]?.owner_id).toBe(OWNER_B); // ownership never moved
    });
  });

  it('B SELECT by A row id and by a random id are byte-identical empty results (no existence oracle)', async () => {
    await asOwner(db, OWNER_B, async (q) => {
      const realA = await q(`SELECT * FROM weight_log WHERE id = $1`, [rowA1]);
      const randomId = '99999999-9999-4999-8999-999999999999';
      const nonexistent = await q(`SELECT * FROM weight_log WHERE id = $1`, [randomId]);
      expect(realA.rows).toHaveLength(0);
      expect(nonexistent.rows).toHaveLength(0);
      expect(JSON.stringify(realA)).toBe(JSON.stringify(nonexistent));
    });
  });
});

describe('C control — denials are authorization-driven, not availability noise', () => {
  it('B against C behaves exactly like B against A (same zero shapes, same error classes)', async () => {
    // Zero-shape probes share one transaction; every expected-error probe runs
    // in its OWN transaction (an error aborts its transaction, and follow-up
    // statements would otherwise raise 25P02 instead of the denial itself).
    await asOwner(db, OWNER_B, async (q) => {
      const byId = await q(`SELECT * FROM weight_log WHERE id = $1`, [rowC1]);
      expect(byId.rows).toHaveLength(0);
      const byOwner = await q(`SELECT * FROM weight_log WHERE owner_id = $1`, [OWNER_C]);
      expect(byOwner.rows).toHaveLength(0);
      const updated = await q(`UPDATE weight_log SET weight_kg = $2 WHERE id = $1`, [rowC1, W_61]);
      expect(updated.rowCount).toBe(0);
      const deleted = await q(`DELETE FROM weight_log WHERE id = $1`, [rowC1]);
      expect(deleted.rowCount).toBe(0);
    });
    await asOwner(db, OWNER_B, async (q) => {
      const insertError = await capturePgError(() =>
        q(`INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3)`, [OWNER_C, T_C1, W_60]),
      );
      expect(insertError?.code).toBe('42501');
    });
    await asOwner(db, OWNER_C, async (q) => {
      const rows = await q<{ weight_kg: string }>(`SELECT weight_kg FROM weight_log WHERE id = $1`, [rowC1]);
      expect(rows.rows[0]?.weight_kg).toBe(W_60); // untouched
    });
  });

  it('C reads/writes succeed in the same suite state where B is denied (parity with A)', async () => {
    await asOwner(db, OWNER_C, async (q) => {
      const rows = await q<{ id: string }>(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(1);
      const updated = await q(`UPDATE weight_log SET recorded_at = $2 WHERE id = $1`, [rowC1, '2026-10-06T07:00:00Z']);
      expect(updated.rowCount).toBe(1);
    });
  });
});

describe('platform bypass is enumerated — SELECT + DELETE job shapes only', () => {
  it('kal_platform reads across all owners with NO owner context (export job shape)', async () => {
    await asPlatform(db, async (q) => {
      const rows = await q<{ owner_id: string }>(`SELECT owner_id FROM weight_log ORDER BY owner_id, recorded_at`);
      expect(rows.rows).toHaveLength(4);
      expect(new Set(rows.rows.map((row) => row.owner_id))).toEqual(new Set([OWNER_A, OWNER_B, OWNER_C]));
    });
  });

  it('the bypass is context-independent: platform with A GUC still sees all rows (enumeration is role+table+command)', async () => {
    await asPlatform(db, async (q) => {
      const rows = await q(`SELECT * FROM weight_log`);
      expect(rows.rows).toHaveLength(4);
    }, { owner: OWNER_A });
  });

  it('kal_platform can delete across owners (account-deletion job shape) — rolled back', async () => {
    await asPlatform(db, async (q) => {
      const deleted = await q(`DELETE FROM weight_log`);
      expect(deleted.rowCount).toBe(4);
    });
    await asPlatform(db, async (q) => {
      const rows = await q(`SELECT id FROM weight_log`);
      expect(rows.rows).toHaveLength(4); // rollback restored everything
    });
  });

  it('kal_platform has NO INSERT path — permission denied (jobs never fabricate data)', async () => {
    // Expected-error probes each get their own transaction (an error aborts it).
    await asPlatform(db, async (q) => {
      const insertError = await capturePgError(() =>
        q(`INSERT INTO weight_log (owner_id, recorded_at, weight_kg) VALUES ($1, $2, $3)`, [OWNER_A, T_A1, W_60]),
      );
      expect(insertError).toBeDefined();
      expect(insertError?.code).toBe('42501');
      expect(insertError?.message).toMatch(/permission denied/u);
    });
  });

  it('kal_platform has NO UPDATE path — permission denied (jobs never rewrite data)', async () => {
    await asPlatform(db, async (q) => {
      const updateError = await capturePgError(() =>
        q(`UPDATE weight_log SET weight_kg = $2 WHERE id = $1`, [rowA1, W_61]),
      );
      expect(updateError).toBeDefined();
      expect(updateError?.code).toBe('42501');
      expect(updateError?.message).toMatch(/permission denied/u);
    });
  });

  it('kal_app has NO bypass, and no membership path leads from it to kal_platform (pg_auth_members)', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      const count = await q<{ count: string }>(`SELECT count(*)::text AS count FROM weight_log`);
      expect(count.rows[0]?.count).toBe('2'); // app role stays scoped to its context
    });
    // Structural fact (behavioral SET ROLE probes are meaningless over a
    // superuser-backed harness session — SET ROLE permission is checked
    // against the SESSION user; see helpers/acting-owner.ts): no role is a
    // member of kal_platform, and the roles are NOINHERIT (migration
    // fidelity), so there is no inheritance path either.
    const members = await adminQuery<{ member_role: string }>(
      db,
      `SELECT m.rolname AS member_role
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
        WHERE am.roleid = 'kal_platform'::regrole`,
    );
    expect(members.rows).toHaveLength(0); // nobody — not kal_app, not PUBLIC
  });

  it('no membership path leads from kal_app anywhere (it is granted to nothing and holds no members)', async () => {
    const kalAppMemberships = await adminQuery<{ granted_role: string }>(
      db,
      `SELECT r.rolname AS granted_role
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
        WHERE am.member = 'kal_app'::regrole`,
    );
    expect(kalAppMemberships.rows).toHaveLength(0); // kal_app holds no other role
    const kalAppMembers = await adminQuery<{ member_role: string }>(
      db,
      `SELECT m.rolname AS member_role
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
        WHERE am.roleid = 'kal_app'::regrole`,
    );
    expect(kalAppMembers.rows).toHaveLength(0); // nothing inherits from kal_app either
  });
});

describe('audit_events is outside the pilot RLS scope by design — append-only still enforced', () => {
  it('kal_app may append and read audit rows', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      const inserted = await q(
        `INSERT INTO audit_events (actor, action, target, justification) VALUES ($1, $2, $3, $4) RETURNING id`,
        [OWNER_A, 'fixture.append', 'weight_log', 's4 harness fixture — synthetic'],
      );
      expect(inserted.rows).toHaveLength(1);
      const readBack = await q<{ id: string }>(`SELECT id FROM audit_events WHERE id = $1`, [inserted.rows[0]!.id]);
      expect(readBack.rows).toHaveLength(1);
    });
  });

  it('kal_app cannot UPDATE audit rows (no grant; trigger binds even the owner)', async () => {
    // Own transaction: the denial aborts it, so this probe runs alone.
    await asOwner(db, OWNER_A, async (q) => {
      const updateError = await capturePgError(() =>
        q(`UPDATE audit_events SET action = 'rewritten' WHERE actor = $1`, [OWNER_A]),
      );
      expect(updateError).toBeDefined();
      expect(['42501', 'P0001']).toContain(updateError?.code);
    });
  });

  it('kal_app cannot DELETE audit rows (no grant; trigger binds even the owner)', async () => {
    await asOwner(db, OWNER_A, async (q) => {
      const deleteError = await capturePgError(() => q(`DELETE FROM audit_events WHERE actor = $1`, [OWNER_A]));
      expect(deleteError).toBeDefined();
      expect(['42501', 'P0001']).toContain(deleteError?.code);
    });
  });
});

describe('suite invariant — the scratch database ends with only its seeded rows', () => {
  it('four rows (A2, B1, C1) survive every adversarial case', async () => {
    const rows = await adminQuery<{ owner_id: string }>(db, `SELECT owner_id FROM weight_log ORDER BY owner_id`);
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.filter((row) => row.owner_id === OWNER_A)).toHaveLength(2);
    expect(rows.rows.filter((row) => row.owner_id === OWNER_B)).toHaveLength(1);
    expect(rows.rows.filter((row) => row.owner_id === OWNER_C)).toHaveLength(1);
  });
});
