/**
 * Sync delta pull — integration itspec (wave-03 contract note §1.6/§4/§5).
 *
 * The e2e suite (test/sync-pull.e2e-spec.ts) owns the HTTP semantics; this
 * suite pins what only a real database proves about the pull path:
 *
 *   1. THE PER-TRANSACTION POSTURE: during a real HTTP pull, the provider
 *      runs inside `SET LOCAL ROLE kal_app` + the `app.user_id` GUC of the
 *      authenticated account + `TimeZone` UTC — the identity inAppRoleTx
 *      pattern (never session-level GUCs on pooled clients). Evidence is
 *      captured by the TEST-ONLY provider's transaction probe (see
 *      test/support/sync-test-provider.ts — real providers land via
 *      s2a/s2c; combined proof at s4/integration).
 *   2. COMPOSITION SCOPING: A's and B's rows coexist; every A pull returns
 *      only A's entities and every B pull only B's — the explicit user
 *      predicate and RLS agree (two independent layers, I1/I2).
 *   3. THE SIMULATED-BUG PROPERTY on the exact table the feed composes: a
 *      predicate-less SELECT under B's context yields ZERO of A's rows —
 *      the database blocks what application code forgets (ADR-0002).
 *   4. Denial-byte parity on the DB-backed app: A's cursor under B is the
 *      same 400 body as garbage — no existence oracle survives a real
 *      RLS-backed stack (X-Request-Id pinned for byte equality).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { hash as rawArgon2Hash } from '@node-rs/argon2';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { DiaryDeltaProvider } from '../../src/tracking/diary/diary-delta.service.js';
import { seedDiaryEntry } from '../support/sync-test-provider.js';
import type { DeltaChange, DeltaCursorState, SyncOpContext } from '../../src/tracking/sync-seams.js';
import type { Prisma } from '../../generated/prisma/client.ts';
import { asUser, asUserlessApp, USER_A, USER_B } from './helpers/acting-user.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';
import { fixtureUserUuid } from '../../src/request-context/user-context.js';

/** Synthetic fixture secret (placeholder-free, I15-safe). */
const SIGNING_KEY = 'itspec4sync4pull4lane4fixed4key4material4with4enough4entropy4ch';
const PASSWORD = 'sync-pull-itspec-password';
const DEVICE = 'sync-pull-itspec-device';

const T = (minutes: number): Date => new Date(Date.UTC(2026, 9, 8, 7, 0, 0, 0) + minutes * 60_000);

/** Posture evidence captured from inside the provider's transaction. */
interface TxPostureProbe {
  readonly currentUser: string;
  readonly appUserId: string | null;
  readonly timeZone: string;
}

/**
 * TEST-ONLY observation subclass of the REAL s2c diary provider: identical
 * SQL and semantics (super.changesSince), plus a probe of the transaction
 * posture captured from INSIDE the provider call. Registered through
 * `.overrideProvider(DiaryDeltaProvider).useValue(...)` so SyncModule's
 * production registration path registers THIS instance — no seam change.
 */
class ProbedDiaryDeltaProvider extends DiaryDeltaProvider {
  private readonly onCall: (posture: TxPostureProbe) => Promise<void>;

  constructor(onCall: (posture: TxPostureProbe) => Promise<void>) {
    super();
    this.onCall = onCall;
  }

  override async changesSince(
    cursor: DeltaCursorState | null,
    limit: number,
    ctx: SyncOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<{ changes: DeltaChange[]; exhausted: boolean }> {
    const row = await tx.$queryRaw<{ current_user: string; app_user_id: string | null; time_zone: string }[]>`
      SELECT current_user,
             CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE current_setting('app.user_id', true) END AS app_user_id,
             current_setting('TimeZone') AS time_zone`;
    const posture = row[0];
    if (posture !== undefined) {
      await this.onCall({
        currentUser: posture.current_user,
        appUserId: posture.app_user_id,
        timeZone: posture.time_zone,
      });
    }
    return super.changesSince(cursor, limit, ctx, tx);
  }
}

let app: INestApplication<App>;
let db: EphemeralKalDb;
let tokenA = '';
let tokenB = '';

const A_ROWS = [fixtureUserUuid('a1'), fixtureUserUuid('a2'), fixtureUserUuid('a3')];
const B_ROWS = [fixtureUserUuid('b1'), fixtureUserUuid('b2')];

/** Posture evidence captured from inside the provider's transaction. */
const postureLog: TxPostureProbe[] = [];

async function pull(token: string, query: Record<string, string>): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await request(app.getHttpServer())
    .get('/sync/changes')
    .set('Authorization', `Bearer ${token}`)
    .query(query);
  return { status: response.status, text: response.text, body: response.body as Record<string, unknown> };
}

interface PullChange {
  entityId: string;
  change: string;
}

async function signinToken(email: string): Promise<string> {
  const signin = await request(app.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', DEVICE)
    .send({ identifier: email, password: PASSWORD })
    .expect(200);
  return signin.body.accessToken as string;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('sync-pull');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;

  const previous: Record<string, string | undefined> = {};
  for (const key of ['DATABASE_URL', 'IDENTITY_JWT_SIGNING_KEY', 'NODE_ENV']) {
    previous[key] = process.env[key];
  }
  Object.assign(process.env, { DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      // The REAL s2c diary provider, observed: SyncModule's production
      // registration path registers this subclass instance (identical SQL).
      .overrideProvider(DiaryDeltaProvider)
      .useValue(new ProbedDiaryDeltaProvider(async (posture) => { postureLog.push(posture); }))
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }

  // Harness users at the fixed A/B/C matrix uuids, seeded through the app
  // role the way the signup path writes (users is not RLS) — with a REAL
  // argon2id hash so the JWT path (signin → bearer) drives every pull.
  const passwordHash = await rawArgon2Hash(PASSWORD);
  await asUserlessApp(db, async (q) => {
    await q(`INSERT INTO users (id, email, username, password, status) VALUES ($1, $2, $3, $4, 'active')`, [USER_A, 'a@sync-pull.invalid', 'sync_pull_a', passwordHash]);
    await q(`INSERT INTO users (id, email, username, password, status) VALUES ($1, $2, $3, $4, 'active')`, [USER_B, 'b@sync-pull.invalid', 'sync_pull_b', passwordHash]);
  }, { commit: true });

  const prisma = app.get(PrismaService);
  for (const [index, id] of A_ROWS.entries()) {
    await seedDiaryEntry(prisma, { userId: USER_A, id, localDate: '2026-10-08', updatedAt: T(10 + index) });
  }
  for (const [index, id] of B_ROWS.entries()) {
    await seedDiaryEntry(prisma, { userId: USER_B, id, localDate: '2026-10-08', updatedAt: T(10 + index) });
  }

  tokenA = await signinToken('a@sync-pull.invalid');
  tokenB = await signinToken('b@sync-pull.invalid');
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('sync pull — per-transaction posture inside the provider (the inAppRoleTx pattern)', () => {
  it('a real HTTP pull runs every provider statement as kal_app under the caller’s GUC in UTC', async () => {
    postureLog.length = 0;
    const page1 = await pull(tokenA, { limit: '2' });
    expect(page1.status).toBe(200);
    expect(postureLog.length).toBeGreaterThanOrEqual(1);
    for (const posture of postureLog) {
      expect(posture.currentUser).toBe('kal_app');
      expect(posture.appUserId).toBe(USER_A);
      expect(posture.timeZone).toBe('UTC');
    }

    // The cursor-echo pull re-establishes the posture per request — never a
    // session-level leftover on pooled clients.
    postureLog.length = 0;
    const page2 = await pull(tokenA, { cursor: page1.body['nextCursor'] as string });
    expect(page2.status).toBe(200);
    expect(postureLog.length).toBeGreaterThanOrEqual(1);
    for (const posture of postureLog) {
      expect(posture.currentUser).toBe('kal_app');
      expect(posture.appUserId).toBe(USER_A);
      expect(posture.timeZone).toBe('UTC');
    }
  });

  it('B’s pull re-binds the same posture to B — one mechanism, per-request user', async () => {
    postureLog.length = 0;
    const page = await pull(tokenB, {});
    expect(page.status).toBe(200);
    for (const posture of postureLog) {
      expect(posture.appUserId).toBe(USER_B);
    }
  });
});

describe('sync pull — composition scoping over coexisting rows', () => {
  it('A’s feed is A-only and B’s feed is B-only (explicit predicate + RLS agree)', async () => {
    const aIds = new Set(A_ROWS);
    const pageA = await pull(tokenA, {});
    for (const change of (pageA.body['changes'] as PullChange[]) ?? []) {
      expect(aIds.has(change.entityId)).toBe(true);
    }
    const bIds = new Set(B_ROWS);
    const pageB = await pull(tokenB, {});
    for (const change of (pageB.body['changes'] as PullChange[]) ?? []) {
      expect(bIds.has(change.entityId)).toBe(true);
    }
  });

  it('the simulated application bug (predicate-less SELECT) leaks ZERO foreign rows under B', async () => {
    // The exact table the pull composes, queried with NO user predicate —
    // the ADR-0002 headline property: the database blocks what the app
    // forgets. Under B's context a predicate-less SELECT still returns ONLY
    // B's rows — A's are invisible (row-count assertions; RLS hides, it
    // does not raise).
    await asUser(db, USER_B, async (q) => {
      const result = await q('SELECT id::text FROM diary_entries ORDER BY id');
      expect(result.rows.map((row) => row['id'])).toEqual([...B_ROWS].sort());
      expect(result.rows.some((row) => A_ROWS.includes(row['id'] as string))).toBe(false);
    });
    // Control: A's own context sees exactly A's rows — the split above is
    // authorization-driven, not availability noise.
    await asUser(db, USER_A, async (q) => {
      const result = await q('SELECT id::text FROM diary_entries ORDER BY id');
      expect(result.rows.map((row) => row['id'])).toEqual([...A_ROWS].sort());
    });
  });
});

describe('sync pull — denial parity on the DB-backed stack (I7)', () => {
  it('A’s cursor under B is byte-identical to garbage — no existence oracle', async () => {
    const ownPage = await pull(tokenA, { limit: '2' }); // short page ⇒ a non-null position
    const aCursor = ownPage.body['nextCursor'] as string;
    expect(typeof aCursor).toBe('string');
    const bodies: string[] = [];
    for (const cursor of [aCursor, 'garbage', aCursor.slice(0, 12)]) {
      const response = await request(app.getHttpServer())
        .get('/sync/changes')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('X-Request-Id', 'sync-pull-itspec-parity')
        .query({ cursor });
      expect(response.status).toBe(400);
      bodies.push(response.text);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(USER_A);
    expect(bodies[0]).not.toContain(USER_B);
  });
});
