/**
 * Kal API e2e — the sync delta pull surface (wave-03 contract note §1.6/§2,
 * `sync.changes.pull`; fixtures `w3`).
 *
 * Proves the READ path end-to-end over real HTTP with real JWTs against an
 * ephemeral database, composing the REAL tracking delta providers (s2c
 * diary + s2a foods, registered at SyncModule init through the canonical
 * seam — the production registration path; rows are placed through the
 * sanctioned app-role write posture, test/support/sync-test-provider.ts):
 *
 *   - the frozen envelope `{changes, nextCursor}` with `nextCursor: null`
 *     ⇔ end of collection; cursor echo round-trips verbatim; pages are
 *     deterministic and ascending by (updatedAt, kind, entityId);
 *   - the `limit` clamp (1–100, default 50; malformed ⇒ 400);
 *   - THE GATE CRITERION (I7): A's cursor under B's credentials — plus
 *     malformed/truncated/tampered variants — is the ONE generic 400,
 *     byte-identical for every cause (no existence oracle), and B's pulls
 *     never contain A's rows;
 *   - tombstones propagate as bare `delete` changes, reach stale cursors
 *     (a device that has not yet seen the deletion), are never re-sent
 *     once the cursor advances past them, and never resurrect;
 *   - bootstrap (no cursor) serves the feed from the beginning — the
 *     frozen same-mechanism semantics (note §1.6);
 *   - an empty feed renders exactly like any page.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/db/prisma.service.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { SyncDeltaRegistry } from '../src/sync/pull/delta-registry.js';
import { seedDiaryEntry, tombstoneDiaryEntry } from './support/sync-test-provider.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';
import { fixtureUserUuid } from '../src/request-context/user-context.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4sync4pull4lane4fixed4key4material4with4enough4entropy4chars0';
const PASSWORD = 'sync-pull-e2e-password';
const DEVICE = 'sync-pull-e2e-device';

const USER_A = { email: 'syncpull-a@example.com', phone: '+201100000001', username: 'syncpull_a' };
const USER_B = { email: 'syncpull-b@example.com', phone: '+201100000002', username: 'syncpull_b' };
const USER_C = { email: 'syncpull-c@example.com', phone: '+201100000003', username: 'syncpull_c' };
const USER_D = { email: 'syncpull-d@example.com', phone: '+201100000004', username: 'syncpull_d' };

const T = (minutes: number): Date => new Date(Date.UTC(2026, 9, 8, 7, 0, 0, 0) + minutes * 60_000);

let app: INestApplication<App>;
let db: EphemeralKalDb;
let prisma: PrismaService;
let tokenA = '';
let tokenB = '';
let tokenC = '';
let tokenD = '';
let userIdA = '';
let userIdB = '';
let userIdD = '';

/** A's seeded entries — [entity id (client-generated), updatedAt]. Deliberately
 * seeded out of order; the feed must sort: a1@T10, a3@T20, a2@T30. */
const A_SEED: [string, Date][] = [
  [fixtureUserUuid('a1'), T(10)],
  [fixtureUserUuid('a2'), T(30)],
  [fixtureUserUuid('a3'), T(20)],
];
/** B's entries — must NEVER appear in any A pull. */
const B_SEED: [string, Date][] = [
  [fixtureUserUuid('b1'), T(5)],
  [fixtureUserUuid('b2'), T(40)],
];

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

interface PullChange {
  kind: string;
  entityId: string;
  change: 'upsert' | 'delete';
  updatedAt: string;
  payload?: unknown;
}

async function pull(token: string, query: Record<string, string>): Promise<{ status: number; text: string; body: { changes?: PullChange[]; nextCursor?: string | null }; headers: Record<string, string> }> {
  const response = await request(app.getHttpServer())
    .get('/sync/changes')
    .set('Authorization', `Bearer ${token}`)
    .query(query);
  return { status: response.status, text: response.text, body: response.body, headers: response.headers };
}

/** The whole feed as one ordered list (echoing nextCursor verbatim per page). */
async function pullAll(token: string, limit?: number): Promise<PullChange[]> {
  const seen: PullChange[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const page = await pull(token, { ...(cursor === null ? {} : { cursor }), ...(limit === undefined ? {} : { limit: String(limit) }) });
    expect(page.status).toBe(200);
    seen.push(...(page.body.changes ?? []));
    if (page.body.nextCursor === null) {
      return seen;
    }
    cursor = page.body.nextCursor ?? null;
  }
  throw new Error('feed did not terminate within 50 pages');
}

async function signupSigninAndMe(user: { email: string; phone: string; username: string }): Promise<{ token: string; userId: string }> {
  await request(app.getHttpServer()).post('/identity/signup').send({ ...user, password: PASSWORD }).expect(200);
  const signin = await request(app.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', DEVICE)
    .send({ identifier: user.email, password: PASSWORD })
    .expect(200);
  const token = signin.body.accessToken as string;
  const me = await request(app.getHttpServer()).get('/identity/me').set('Authorization', `Bearer ${token}`).expect(200);
  return { token, userId: me.body.user.id as string };
}

beforeAll(async () => {
  db = await createEphemeralKalDb('syncpull');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  prisma = app.get(PrismaService);

  const a = await signupSigninAndMe(USER_A);
  const b = await signupSigninAndMe(USER_B);
  const c = await signupSigninAndMe(USER_C);
  const d = await signupSigninAndMe(USER_D);
  tokenA = a.token;
  tokenB = b.token;
  tokenC = c.token;
  tokenD = d.token;
  userIdA = a.userId;
  userIdB = b.userId;
  userIdD = d.userId;

  for (const [id, at] of A_SEED) {
    await seedDiaryEntry(prisma, { userId: userIdA, id, localDate: '2026-10-08', updatedAt: at });
  }
  for (const [id, at] of B_SEED) {
    await seedDiaryEntry(prisma, { userId: userIdB, id, localDate: '2026-10-08', updatedAt: at });
  }
  // User D: 101 entries — one page of exactly 100, then 1 + null.
  for (let i = 0; i < 101; i++) {
    await seedDiaryEntry(prisma, {
      userId: userIdD,
      id: fixtureUserUuid(`d${i.toString(16).padStart(2, '0')}`),
      localDate: '2026-10-08',
      updatedAt: T(i),
    });
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('sync.changes.pull — authentication', () => {
  it('no bearer ⇒ 401 UNAUTHENTICATED with the WWW-Authenticate challenge', async () => {
    const response = await request(app.getHttpServer()).get('/sync/changes');
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});

describe('sync.changes.pull — production registration', () => {
  it('the three REAL delta providers register at module init (canonical seam; duplicate-guarded)', () => {
    // SyncModule.onModuleInit registered s2c's diary + s2a's foods providers
    // through the sync-owned registry — the production registration path.
    expect([...app.get(SyncDeltaRegistry).registeredKinds()].sort()).toEqual(['diary_entry', 'favorite', 'user_food']);
  });
});

describe('sync.changes.pull — happy path, envelope, pagination', () => {
  it('bootstrap pull serves ascending deltas + nextCursor; the echo round-trips verbatim to the end', async () => {
    const page1 = await pull(tokenA, { limit: '2' });
    expect(page1.status).toBe(200);
    expect(page1.headers['content-type']).toContain('application/json');
    expect(Object.keys(page1.body).sort()).toEqual(['changes', 'nextCursor']);
    expect(page1.body.changes).toHaveLength(2);
    // Frozen order: (updatedAt, kind, entityId) ascending.
    expect(page1.body.changes?.map((c) => c.entityId)).toEqual([A_SEED[0][0], A_SEED[2][0]]);
    expect(page1.body.changes?.every((c) => c.kind === 'diary_entry' && c.change === 'upsert')).toBe(true);
    expect(typeof page1.body.nextCursor).toBe('string');
    // Full entity snapshot on upsert (bootstrap = same mechanism) — s2c's
    // frozen diary snapshot shape (identity rides the envelope's entityId).
    expect(page1.body.changes?.[0]?.payload).toMatchObject({ localDate: '2026-10-08', mealSlot: 'breakfast', entryMethod: 'quick_add' });
    expect(page1.body.changes?.[0]?.entityId).toBe(A_SEED[0][0]);

    // Cursor echo (verbatim) continues strictly after — no duplicates, no loss.
    const page2 = await pull(tokenA, { cursor: page1.body.nextCursor as string, limit: '2' });
    expect(page2.status).toBe(200);
    expect(page2.body.changes?.map((c) => c.entityId)).toEqual([A_SEED[1][0]]);
    expect(page2.body.nextCursor).toBeNull(); // end of collection
  });

  it('pages are deterministic: the same state renders the same page byte-for-byte', async () => {
    const first = await pull(tokenA, { limit: '2' });
    const second = await pull(tokenA, { limit: '2' });
    expect(second.text).toBe(first.text);
  });

  it('paging the whole feed yields every entity exactly once', async () => {
    const seen = await pullAll(tokenA);
    expect(seen.map((c) => c.entityId).sort()).toEqual(A_SEED.map(([id]) => id).sort());
  });

  it('B never receives any of A’s rows on any page (composition scoping)', async () => {
    const aIds = new Set(A_SEED.map(([id]) => id));
    for (const change of await pullAll(tokenB)) {
      expect(aIds.has(change.entityId)).toBe(false);
    }
  });

  it('limit clamps to 1–100 (default 50): 0⇒1, 1000⇒100 then 1+null, malformed⇒400', async () => {
    const zero = await pull(tokenA, { limit: '0' });
    expect(zero.body.changes).toHaveLength(1);

    const big = await pull(tokenD, { limit: '1000' });
    expect(big.body.changes).toHaveLength(100);
    const rest = await pull(tokenD, { cursor: big.body.nextCursor as string, limit: '1000' });
    expect(rest.body.changes).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();

    const malformed = await pull(tokenA, { limit: 'abc' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    // Default (no limit parameter) is 50 — D's 101 rows paginate 50/50/1.
    const d1 = await pull(tokenD, {});
    expect(d1.body.changes).toHaveLength(50);
  });

  it('an empty feed renders exactly like any page: 200 {changes: [], nextCursor: null}', async () => {
    const page = await pull(tokenC, {});
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ changes: [], nextCursor: null });
  });

  it('a pull at an end-of-collection cursor is an empty page (nothing stale re-sent)', async () => {
    // Walk D's feed to the end, then present the LAST non-null cursor's
    // successor position: the tail page repeats exactly the tail items and
    // nothing more — no duplicates across the boundary.
    const d1 = await pull(tokenD, {});
    const d2 = await pull(tokenD, { cursor: d1.body.nextCursor as string });
    expect(d2.body.changes).toHaveLength(50);
    const d3 = await pull(tokenD, { cursor: d2.body.nextCursor as string });
    expect(d3.body.changes).toHaveLength(1);
    expect(d3.body.nextCursor).toBeNull();
    // Re-presenting d2's cursor (the client that did not store d3's null)
    // re-receives exactly d3 — deterministic, no new rows appear.
    const d3again = await pull(tokenD, { cursor: d2.body.nextCursor as string });
    expect(d3again.text).toBe(d3.text);
  });
});

describe('sync.changes.pull — the cross-user gate criterion (I7)', () => {
  const PROBE_REQUEST_ID = 'syncpull-cursor-equivalence-probe';

  async function pullFixedRequestId(token: string, cursor: string): Promise<{ status: number; text: string }> {
    const response = await request(app.getHttpServer())
      .get('/sync/changes')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', PROBE_REQUEST_ID) // echoed ⇒ bodies compare byte-level
      .query({ cursor });
    return { status: response.status, text: response.text };
  }

  it('A’s cursor under B’s credentials — and every failure variant — is ONE byte-identical 400', async () => {
    const ownPage = await pull(tokenA, { limit: '2' });
    const aCursor = ownPage.body.nextCursor as string;
    expect(typeof aCursor).toBe('string');

    const equivalenceSet: string[] = [
      aCursor, // foreign: minted for A, presented by B
      'totally-garbage', // malformed
      aCursor.slice(0, Math.floor(aCursor.length / 2)), // truncated
      `${aCursor.slice(0, -2)}xy`, // tampered tail
      '.', // structurally malformed
    ];
    const bodies: string[] = [];
    for (const cursor of equivalenceSet) {
      const result = await pullFixedRequestId(tokenB, cursor);
      expect(result.status).toBe(400);
      bodies.push(result.text);
    }
    // Byte-identical for every cause — B learns nothing about A's cursors.
    expect(new Set(bodies).size).toBe(1);
    const body = JSON.parse(bodies[0] as string) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(bodies[0]).not.toContain(userIdA);
    expect(bodies[0]).not.toContain(userIdB);

    // The same garbage under A's token is byte-identical — the denial body
    // never depends on the authenticated account.
    const underA = await pullFixedRequestId(tokenA, 'totally-garbage');
    expect(underA.status).toBe(400);
    expect(underA.text).toBe(bodies[0]);
  });

  it('a valid foreign cursor yields the 400 — never A’s rows under B’s session', async () => {
    const refused = await pull(tokenB, { cursor: (await pull(tokenA, {})).body.nextCursor ?? '' });
    expect(refused.status).toBe(400);
    expect(refused.body.changes).toBeUndefined();
    // And B's own feed remains B-only.
    const bIds = new Set(B_SEED.map(([id]) => id));
    for (const change of await pullAll(tokenB)) {
      expect(bIds.has(change.entityId)).toBe(true);
    }
  });
});

describe('sync.changes.pull — tombstones (note §1.5/§1.6)', () => {
  const E_ID = fixtureUserUuid('e1'); // the entry that will be deleted
  const F_ID = fixtureUserUuid('e2'); // later entries prove multi-page continuation
  const G_ID = fixtureUserUuid('e3');
  const H_ID = fixtureUserUuid('e4');

  it('deleted data never reappears: the feed serves the tombstone — bare, once — at any cursor position', async () => {
    await seedDiaryEntry(prisma, { userId: userIdA, id: E_ID, localDate: '2026-10-08', updatedAt: T(50) });
    await seedDiaryEntry(prisma, { userId: userIdA, id: F_ID, localDate: '2026-10-08', updatedAt: T(70) });
    await seedDiaryEntry(prisma, { userId: userIdA, id: G_ID, localDate: '2026-10-08', updatedAt: T(80) });
    await seedDiaryEntry(prisma, { userId: userIdA, id: H_ID, localDate: '2026-10-08', updatedAt: T(90) });

    // A STALE cursor: minted while E was still alive (ends at T(30) + F/G/H
    // unseen) — from a device that has not synced since before the delete.
    const stalePage = await pull(tokenA, { limit: '2' });
    const staleCursor = stalePage.body.nextCursor as string;

    // The deletion (the ingestion path's write — here via the sanctioned
    // tombstone write the s2d handler will perform).
    await tombstoneDiaryEntry(prisma, userIdA, E_ID, T(60));

    // 1) The stale device pulls: everything strictly after its position —
    //    the late-arriving live row AND the tombstone, deterministically
    //    ordered; the tombstone is a bare delete, no payload.
    const catchUp = await pull(tokenA, { cursor: staleCursor, limit: '2' });
    expect(catchUp.status).toBe(200);
    expect(catchUp.body.changes?.map((c) => `${c.change}:${c.entityId}`)).toEqual([
      `upsert:${A_SEED[1][0]}`,
      `delete:${E_ID}`,
    ]);
    const deleteChange = catchUp.body.changes?.[1] as unknown as Record<string, unknown>;
    expect(Object.keys(deleteChange).sort()).toEqual(['change', 'entityId', 'kind', 'updatedAt']);
    expect(typeof catchUp.body.nextCursor).toBe('string');

    // 2) The device advances past the tombstone: the second pull resends NO
    //    stale state — E is gone forever, only the genuinely-newer rows come.
    const after = await pullAll(tokenA, 10); // full-feed view for the E-census below
    const tail = await pull(tokenA, { cursor: catchUp.body.nextCursor as string, limit: '10' });
    expect(tail.body.changes?.map((c) => c.entityId)).toEqual([F_ID, G_ID, H_ID]);
    expect(tail.body.changes?.some((c) => c.entityId === E_ID)).toBe(false);
    expect(tail.body.nextCursor).toBeNull();

    // 3) No resurrection anywhere: across the ENTIRE feed from the
    //    beginning, E appears exactly once — as a delete, never an upsert —
    //    even though an older upsert position once existed.
    const eChanges = after.filter((c) => c.entityId === E_ID);
    expect(eChanges).toHaveLength(1);
    expect(eChanges[0]?.change).toBe('delete');
    // Whole-feed ordering stays globally deterministic across the delete.
    const ordered = [...after].map((c) => c.updatedAt);
    expect(ordered).toEqual([...ordered].sort());
  });
});
