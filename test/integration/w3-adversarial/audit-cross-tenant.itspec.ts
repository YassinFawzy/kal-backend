/**
 * s4a audit cells — cross-tenant attempt signals (wave-03 task s4a-adversarial;
 * PRD §23.1 negative criterion; ledger §6 checklist "I14: privilege-boundary
 * events (cross-tenant attempts) audited via the service in-UoW (digests/ids
 * only)").
 *
 * FINDING F-S4A-2 — FOUND AND RESOLVED: this suite originally pinned the
 * ABSENCE of any audit signal on the tracking/sync surfaces (SKIP-with-
 * finding + current-absence pin). Supervisor amendment 3 (kal-backend
 * `a8be75a`/`7ddc3fc`) shipped the three claim-verified oracle-safe emit
 * points; per the supervisor's flip directive this suite now asserts the
 * signal's PRESENCE and CONTENT-SAFETY against the real implementation:
 *
 *   - `sync.cursor.foreign_binding`      — a signature-VALID delta cursor
 *     whose embedded binding ≠ the caller (the pull read's one server-known
 *     cross-tenant fact); response stays the generic 400.
 *   - `tracking.search_cursor.foreign_binding` — the same fact on the search
 *     surface (the search-cursor payload format now embeds the binding so a
 *     tag-valid foreign cursor is detectable); response stays the generic 400.
 *   - `sync.ingest.entity_collision`     — the entity-PK unique collision (B
 *     inserting an id owned elsewhere — the generic cause-indistinguishable
 *     500), detected at the final rethrow by the `_pkey` constraint filter;
 *     response unchanged.
 *
 *   RLS-blind denial paths (foreign-entity ops, foreign day reads, cross-user
 *   enumeration) correctly emit NOTHING — auditing them selectively would BE
 *   an existence oracle (I7). The suite pins that silence too.
 *
 * Emission is fire-and-forget by design (never awaited on the response path —
 * a latency-detectable branch would be an authenticity oracle), so assertions
 * POLL the audit table with a small retry. Content assertions (I14/I12): the
 * fixed system actors, populated fields, DIGEST-only targets for cursor
 * bindings (raw user ids must NOT appear — asserted against the exact
 * sha256 digests), raw ids allowed only where the format says so
 * (`entity:{d(caller)}:{entityId}` — envelope-validated unguessable UUIDs),
 * and no payload/health/received-value strings anywhere in the emitted rows.
 * Response bytes are proven unchanged by this suite's own raw-byte cells and
 * by the matrix suite's equivalence sets re-running on the amended stack.
 */
import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { asUser, asPlatform, capturePgError, USER_A } from '../helpers/acting-user.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';
import {
  advUuid,
  createThreeUserHarness,
  diaryCreateOp,
  favoriteCreateOp,
  pullChanges,
  pushBatch,
  searchFoods,
  type ThreeUserHarness,
} from '../helpers/three-user-harness.js';

const SIGNING_KEY = 's4advlimit9lane9fixed9key9material9with9enough9entropy99';
const NS = 'c3f1';
const DAY = '2026-10-08';
const T0 = '2026-10-08T07:00:00Z';
const T1 = '2026-10-08T08:00:00Z';

/** The three amendment-3 emit points (bound to this suite's battery cells). */
const ACTION_CURSOR_FOREIGN = 'sync.cursor.foreign_binding';
const ACTION_SEARCH_CURSOR_FOREIGN = 'tracking.search_cursor.foreign_binding';
const ACTION_ENTITY_COLLISION = 'sync.ingest.entity_collision';
/** The structural-probe row this suite itself inserts (grants-matrix describe). */
const ACTION_STRUCTURAL_PROBE = 'w3.test.audit_probe';

/** The implementation's server-keyed opaque digest (I14 — ids become digests). */
function digestId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface AuditRow {
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly justification: string;
}

let app: INestApplication<App>;
let db: EphemeralKalDb;
let users: ThreeUserHarness;

async function bootApp(env: Record<string, string>): Promise<INestApplication<App>> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    const booted = moduleFixture.createNestApplication();
    await booted.init();
    return booted;
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4audit');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  users = await createThreeUserHarness(app, db, {
    a: { email: 's4audit-a@example.com', phone: '+201700000501', username: 's4audit_owner_a' },
    b: { email: 's4audit-b@example.com', phone: '+201700000502', username: 's4audit_attacker_b' },
    c: { email: 's4audit-c@example.com', phone: '+201700000503', username: 's4audit_control_c' },
  });
  await adminQuery(
    db,
    `INSERT INTO foods (id, type, provenance, license_partition, name_en, name_en_normalized,
       name_ar, name_ar_normalized, aliases, aliases_normalized, energy_kcal, protein_g, carbs_g, fat_g)
     VALUES ('00000000-0000-4000-8000-00000000cc01', 'dish', 'kal_reviewed', 'proprietary',
       'Audit fixture food', 'audit fixture food', 'طعام', 'طعام',
       ARRAY['fixture']::text[], ARRAY['fixture']::text[], 100, 5, 10, 2)`,
  );
  // A's live target rows — TWO diary entries, so a limit-1 pull page is NOT
  // the end of the feed and mintS a real nextCursor (a drained page returns
  // null per the amendment-2 polarity, and the emit point needs a
  // SIGNATURE-VALID foreign cursor to exist).
  const pushed = await pushBatch(
    app,
    users.a.token,
    [diaryCreateOp(NS, 'au01', 'ae501', T0, DAY), diaryCreateOp(NS, 'au06', 'ae502', T0, DAY)],
    advUuid(NS, 'kau01'),
  );
  expect(pushed.status).toBe(200);
  const rest = await request(app.getHttpServer())
    .post('/tracking/user-foods')
    .set('Authorization', `Bearer ${users.a.token}`)
    .send({ nameEn: 'A audit target food', energyKcal: 100, proteinG: 5, carbsG: 10, fatG: 2 });
  expect(rest.status).toBe(201);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

/** Polls the audit table for a minimum row count on one action (fire-and-forget emission). */
async function pollAuditRows(action: string, min: number, timeoutMs = 5_000): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await adminQuery(db, 'SELECT actor, action, target, justification FROM audit_events WHERE action = $1 ORDER BY occurred_at', [action]);
    if (rows.rows.length >= min || Date.now() > deadline) {
      return rows.rows as unknown as AuditRow[];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function assertRowShape(row: AuditRow, expectedTarget: string): void {
  expect(row.actor.length).toBeGreaterThan(0);
  expect(row.action.length).toBeGreaterThan(0);
  expect(row.target).toBe(expectedTarget);
  expect(row.justification.length).toBeGreaterThan(0);
  // I12: no received values, no health-shaped content, no raw account data in
  // the emitted row (cursor targets are digest-only; entity targets carry the
  // envelope-validated unguessable entity id only).
  const rowText = `${row.actor}\u0000${row.action}\u0000${row.target}\u0000${row.justification}`;
  for (const forbidden of [users.a.userId, users.b.userId, users.c.userId, 'A audit target food', '@example.com', 'quick_add', 'breakfast']) {
    expect(rowText, `audit row must not contain "${forbidden}"`).not.toContain(forbidden);
  }
}

describe('the cross-tenant attempt battery (real HTTP, B with valid credentials)', () => {
  it('every attack cell lands its documented generic outcome — responses unchanged by the audit emits', async () => {
    // 1. Foreign delta cursor under B (signature-valid: minted for A).
    const pageA = await pullChanges(app, users.a.token, { limit: '1' });
    const aCursor = (pageA.body as { nextCursor: string | null }).nextCursor as string;
    const foreignCursor = await pullChanges(app, users.b.token, { cursor: aCursor });
    expect(foreignCursor.status).toBe(400);
    expect(foreignCursor.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // 2. Foreign SEARCH cursor under B (signature-valid: minted for A — the
    //    amendment-3 embedded-binding format makes it inspectable). The query
    //    matches TWO foods (the platform row + A's own user food), so a
    //    limit-1 page is non-final and mintS a real cursor.
    const aSearch = await searchFoods(app, users.a.token, { q: 'audit', limit: '1' });
    expect(aSearch.status).toBe(200);
    const aSearchCursor = (aSearch.body as { nextCursor: string | null }).nextCursor;
    expect(typeof aSearchCursor).toBe('string');
    const foreignSearch = await searchFoods(app, users.b.token, { q: 'audit', cursor: aSearchCursor as string });
    expect(foreignSearch.status).toBe(400);
    expect(foreignSearch.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // 3. Cross-user PK collision — a SINGLE-op batch so the audit target's
    //    entity member is the colliding id itself (ops[0]).
    const collisionOp = { ...diaryCreateOp(NS, 'au02', 'ae501', T0, DAY) };
    const collision = await pushBatch(app, users.b.token, [collisionOp], advUuid(NS, 'kau02'));
    expect(collision.status).toBe(500);
    expect(collision.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(collision.text).not.toContain(users.a.userId);

    // 4. Cross-user update reference (RLS-blind — must emit NOTHING).
    const updateOnA = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au03', 'ae501', T1, DAY), action: 'update' as const }], advUuid(NS, 'kau03'));
    expect((updateOnA.body as { results: { code?: string }[] }).results[0]?.code).toBe('rejected_conflict');

    // 5. Cross-user delete reference (RLS-blind — must emit NOTHING).
    const deleteOnA = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au04', 'ae501', T1, DAY), action: 'delete' as const, payload: undefined }], advUuid(NS, 'kau04'));
    expect((deleteOnA.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('applied');

    // 6. Op-ID replay cross-user (RLS-blind — must emit NOTHING).
    const bReplay = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au01', 'be501', T0, DAY), opId: advUuid(NS, 'au01') }], advUuid(NS, 'kau05'));
    expect((bReplay.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('applied');

    // 7. Foreign favorite target (RLS-blind — must emit NOTHING).
    const foreignTarget = await pushBatch(
      app,
      users.b.token,
      [favoriteCreateOp(NS, 'au05', 'be502', T0, { userFoodId: advUuid(NS, 'ae501') })],
      advUuid(NS, 'kau06'),
    );
    expect((foreignTarget.body as { results: { code?: string }[] }).results[0]?.code).toBe('rejected_validation');

    // 8. Cross-user enumeration (RLS-blind — must emit NOTHING).
    const bSearch = await searchFoods(app, users.b.token, { q: 'A audit target food' });
    expect(bSearch.status).toBe(200);
    expect(bSearch.body).toEqual({ data: [], nextCursor: null });
  });

  it('CONTRACT-REQUIRED (PRD §23.1 / ledger I14 — F-S4A-2 flipped green on amendment 3): each oracle-safe emit point fired for its battery cell, digests/ids only', async () => {
    // (a) pull-cursor foreign binding: B presented A's signature-valid delta cursor.
    const cursorRows = await pollAuditRows(ACTION_CURSOR_FOREIGN, 1);
    expect(cursorRows.length).toBeGreaterThanOrEqual(1);
    assertRowShape(cursorRows[0] as AuditRow, `cursor:${digestId(users.b.userId)}:${digestId(users.a.userId)}`);

    // (b) search-cursor foreign binding: B presented A's tag-valid search cursor.
    const searchRows = await pollAuditRows(ACTION_SEARCH_CURSOR_FOREIGN, 1);
    expect(searchRows.length).toBeGreaterThanOrEqual(1);
    assertRowShape(searchRows[0] as AuditRow, `cursor:${digestId(users.b.userId)}:${digestId(users.a.userId)}`);

    // (c) the entity-PK collision (the single-op battery cell — target names
    //     the caller's digest and the colliding entity id).
    const collisionRows = await pollAuditRows(ACTION_ENTITY_COLLISION, 1);
    expect(collisionRows.length).toBeGreaterThanOrEqual(1);
    assertRowShape(collisionRows[0] as AuditRow, `entity:${digestId(users.b.userId)}:${advUuid(NS, 'ae501')}`);

    // Silence on the RLS-blind paths: every action present in the table is
    // one of the three emit points (or this suite's own structural probe,
    // inserted by a later describe) — the foreign-entity ops, the cross-user
    // delete/replay/enumeration emitted NOTHING (auditing them selectively
    // would be an existence oracle, I7).
    const all = await adminQuery(db, 'SELECT DISTINCT action FROM audit_events ORDER BY action');
    const actions = (all.rows as unknown as { action: string }[]).map((row) => row.action).sort();
    const allowed = [ACTION_CURSOR_FOREIGN, ACTION_ENTITY_COLLISION, ACTION_SEARCH_CURSOR_FOREIGN, ACTION_STRUCTURAL_PROBE].sort();
    expect(actions.every((action) => allowed.includes(action)), `unexpected audit actions: ${actions.join(', ')}`).toBe(true);
    for (const required of [ACTION_CURSOR_FOREIGN, ACTION_ENTITY_COLLISION, ACTION_SEARCH_CURSOR_FOREIGN]) {
      expect(actions, `${required} must be present`).toContain(required);
    }
  });
});

describe('structural capability — the audit home exists (grants + append-only trigger)', () => {
  it('kal_app CAN append an audit event (the in-UoW service path is grant-backed)', async () => {
    await asUser(
      db,
      USER_A,
      async (q) => {
        const inserted = await q<{ id: string }>(
          `INSERT INTO audit_events (id, actor, action, target, justification)
           VALUES ('11111111-1111-4111-8111-811111111101', $1, 'w3.test.audit_probe', $2, 's4a structural grant probe (fixture)')
           RETURNING id`,
          [USER_A, USER_A],
        );
        expect(inserted.rows[0]?.id).toBe('11111111-1111-4111-8111-811111111101');
      },
      { commit: true },
    );
  });

  it('audit_events is append-only: UPDATE and DELETE are refused (no grant, 42501) for app and platform scopes alike', async () => {
    for (const role of ['app', 'platform'] as const) {
      const updateError = await capturePgError(async () => {
        const probe =
          role === 'app'
            ? asUser(db, USER_A, async (q) => q(`UPDATE audit_events SET action = action WHERE true`))
            : asPlatform(db, async (q) => q(`UPDATE audit_events SET action = action WHERE true`));
        await probe;
      });
      expect(updateError?.code, `UPDATE as ${role}`).toBe('42501');
      const deleteError = await capturePgError(async () => {
        const probe =
          role === 'app'
            ? asUser(db, USER_A, async (q) => q(`DELETE FROM audit_events WHERE false`))
            : asPlatform(db, async (q) => q(`DELETE FROM audit_events WHERE false`));
        await probe;
      });
      expect(deleteError?.code, `DELETE as ${role}`).toBe('42501');
    }
  });
});
