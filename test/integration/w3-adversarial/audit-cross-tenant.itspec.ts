/**
 * s4a audit cells — cross-tenant attempt signals (wave-03 task s4a-adversarial;
 * PRD §23.1 negative criterion; ledger §6 checklist "I14: privilege-boundary
 * events (cross-tenant attempts) audited via the service in-UoW (digests/ids
 * only)").
 *
 * WHAT THIS SUITE FOUND (finding F-S4A-2, routed — never fixed in place):
 * the tracking/sync surfaces emit NO audit signal for cross-tenant attempts.
 * A full adversarial battery (foreign cursor, cross-user PK collision,
 * cross-user update/delete reference, op-ID replay, foreign favorite target,
 * cross-user enumeration) leaves `audit_events` EMPTY. PRD §23.1's negative
 * criterion ("wrong-user access ... returns a generic denial and logs an
 * audit signal") and the ledger's I14 checklist item are therefore unmet on
 * the W3 surfaces; the W3 realization also has no diary-by-guessed-ID read
 * (the read is per-authenticated-user by construction), so the criterion's
 * emit point needs a supervisor-routed design decision for the sync cells.
 *
 * The suite pins THREE things:
 *   1. (SKIP-with-finding — never deleted) the contract-required presence
 *      assertion, flipped on when the signal ships;
 *   2. the CURRENT absence, as an executable repro: the full battery runs and
 *      `audit_events` stays empty (this pin goes red the moment the signal
 *      ships — the fixer must then un-skip (1) and update (2));
 *   3. the structural capability: `audit_events` is writable by the app role
 *      (INSERT grant) and append-only (no UPDATE/DELETE grant + the W1
 *      trigger) — the signal has an in-UoW home; it is simply never called.
 *
 * Method: the attempt battery runs over REAL HTTP against the booted AppModule
 * on an ephemeral database (A owns, B attacks with valid credentials — the
 * matrix shape); audit-table probes use the harness app-role posture and the
 * admin connection for introspection only.
 */
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
  // A's live target rows.
  const pushed = await pushBatch(app, users.a.token, [diaryCreateOp(NS, 'au01', 'ae501', T0, DAY)], advUuid(NS, 'kau01'));
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

async function auditEventCount(): Promise<number> {
  const rows = await adminQuery(db, 'SELECT count(*)::int AS n FROM audit_events');
  return (rows.rows[0] as { n: number }).n;
}

describe('the cross-tenant attempt battery (real HTTP, B with valid credentials)', () => {
  it('every attack cell lands its documented generic outcome (the battery really ran)', async () => {
    // 1. Foreign cursor under B.
    const pageA = await pullChanges(app, users.a.token, { limit: '1' });
    const aCursor = (pageA.body as { nextCursor: string | null }).nextCursor as string;
    const foreignCursor = await pullChanges(app, users.b.token, { cursor: aCursor });
    expect(foreignCursor.status).toBe(400);

    // 2. Cross-user PK collision (B create with A's live entity id).
    const collision = await pushBatch(app, users.b.token, [diaryCreateOp(NS, 'au02', 'ae501', T0, DAY)], advUuid(NS, 'kau02'));
    expect(collision.status).toBe(500);

    // 3. Cross-user update reference.
    const updateOnA = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au03', 'ae501', T1, DAY), action: 'update' as const }], advUuid(NS, 'kau03'));
    expect((updateOnA.body as { results: { code?: string }[] }).results[0]?.code).toBe('rejected_conflict');

    // 4. Cross-user delete reference (idempotent applied, A untouched).
    const deleteOnA = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au04', 'ae501', T1, DAY), action: 'delete' as const, payload: undefined }], advUuid(NS, 'kau04'));
    expect((deleteOnA.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('applied');

    // 5. Op-ID replay cross-user (B reusing A's applied op id, own entity).
    const aOpId = advUuid(NS, 'au01');
    const bReplay = await pushBatch(app, users.b.token, [{ ...diaryCreateOp(NS, 'au01', 'be501', T0, DAY), opId: aOpId }], advUuid(NS, 'kau05'));
    expect((bReplay.body as { results: { outcome: string }[] }).results[0]?.outcome).toBe('applied');

    // 6. Foreign favorite target.
    const foreignTarget = await pushBatch(
      app,
      users.b.token,
      [favoriteCreateOp(NS, 'au05', 'be502', T0, { userFoodId: advUuid(NS, 'ae501') })],
      advUuid(NS, 'kau06'),
    );
    expect((foreignTarget.body as { results: { code?: string }[] }).results[0]?.code).toBe('rejected_validation');

    // 7. Cross-user enumeration (search for A's uniquely-named food).
    const bSearch = await searchFoods(app, users.b.token, { q: 'A audit target food' });
    expect(bSearch.status).toBe(200);
    expect(bSearch.body).toEqual({ data: [], nextCursor: null });
  });

  it('FINDING F-S4A-2 (current-behavior pin): the full battery left `audit_events` EMPTY — no cross-tenant signal exists on the W3 tracking/sync surfaces', async () => {
    expect(await auditEventCount()).toBe(0);
  });

  it.skip('CONTRACT-REQUIRED (PRD §23.1 / ledger I14) — un-skip when the audit signal ships: each cross-tenant attempt appends exactly one audit event with digest/id-only content', async () => {
    // The required case, executable once the owning lane lands the signal:
    //   - run the battery above;
    //   - expect audit_events rows ≥ the number of cross-tenant attempts;
    //   - each row carries (actor, action, target, justification) with ids or
    //     digests ONLY — no payloads, no health data (I12), no received values;
    //   - the append happened in the commanding unit of work (an audit failure
    //     must roll the command back — the AuditService contract).
    // Routed as finding F-S4A-2; see docs/development/wave-03/merge-requests/s4a-adversarial.md.
    expect.unimplemented('finding F-S4A-2 — the audit signal does not exist yet on tracking/sync');
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
    for (const [role, label] of [
      ['app', 'kal_app'],
      ['platform', 'kal_platform'],
    ] as const) {
      const updateError = await capturePgError(async () => {
        const probe = role === 'app' ? asUser(db, USER_A, async (q) => q(`UPDATE audit_events SET action = action WHERE true`)) : asPlatform(db, async (q) => q(`UPDATE audit_events SET action = action WHERE true`));
        await probe;
      });
      expect(updateError?.code, `UPDATE as ${label}`).toBe('42501');
      const deleteError = await capturePgError(async () => {
        const probe = role === 'app' ? asUser(db, USER_A, async (q) => q(`DELETE FROM audit_events WHERE false`)) : asPlatform(db, async (q) => q(`DELETE FROM audit_events WHERE false`));
        await probe;
      });
      expect(deleteError?.code, `DELETE as ${label}`).toBe('42501');
    }
  });
});
