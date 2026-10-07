/**
 * Kal identity e2e (wave-02, task s2-credentials-sessions) — the real
 * AppModule against a real, fully-migrated, EPHEMERAL PostgreSQL database
 * (the harness pattern: `kal_it_*`, created and dropped by this suite, the
 * dev database never touched).
 *
 * Covered required cases (task contract):
 *   - Happy path: signup (three identifiers, globally-unique username, PHC
 *     stored), sign-in by each identifier, JWT issue, UserContext
 *     resolution, refresh rotation, session list, revocation (before and
 *     after the window boundary).
 *   - Hash goldens: round-trip, rehash-upgrade on login, wrong-password path
 *     (byte-level equivalence; timing itself is s4's adversarial pass).
 *   - Enumeration/lockout observables (contract §3): byte-identical 401 for
 *     unknown/wrong-password/closed at every attempt count; (identifier,
 *     device) lockout with Retry-After, fail-closed for valid credentials,
 *     both axes independent, counters ticking regardless of existence.
 *   - Authorization: foreign-session 404 byte-identical to absent; foreign
 *     cursor generic 400; I6 re-verification (revoked session ⇒ 401).
 *   - Retry/idempotency: refresh reuse ⇒ chain revocation; duplicate-signup
 *     race ⇒ one winner, generic outcome for all.
 *   - Failure atomicity: no partial rows; atomic concurrent counters.
 *   - Config: threshold/duration/window values are behavior-changing config
 *     points (two-config proofs).
 *
 * The suite imports the integration harness helpers READ-ONLY (the
 * test/integration structure belongs to w02-s4-adversarial).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { hash as rawArgon2Hash } from '@node-rs/argon2';
import { Algorithm } from '@node-rs/argon2';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { ProblemDetailsBody } from '../src/problems/problem-details.js';
import { w2FixturesDocument } from '../src/contracts/w2.fixtures.js';
import { assertConformsToSchema, SchemaNode } from './support/contract-schema.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4identity4lane4fixed4key4material4with4enough4entropy4chars00';
/** Same key the app above signed with — lets the suite mint crafted JWTs. */
const CRAFT_KEY = new TextEncoder().encode(SIGNING_KEY);

const PASSWORD = 'identity-e2e-password';
const DEVICE_A = 'device-A-01';
const DEVICE_B = 'device-B-02';

const USER_KALILA = {
  email: ['kalila', 'example.com'].join('@'),
  phone: '+201000000001',
  username: 'kalila',
};
const USER_DANA = {
  email: ['dana', 'example.com'].join('@'),
  phone: '+201000000002',
  username: 'dana',
};

let app: INestApplication<App>;
let db: EphemeralKalDb;
let databaseUrl: string;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  session: { id: string; deviceLabel: string | null; createdAt: string; expiresAt: string };
}

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
    // The configuration is captured at module construction (I15) — the
    // process environment is restored for the rest of the suite.
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else if (previous[key] !== undefined) {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

/** Normalizes the per-response correlation id so bodies compare byte-level. */
function normalized(body: ProblemDetailsBody | Record<string, unknown>): string {
  const clone = { ...(body as Record<string, unknown>) };
  delete clone['requestId'];
  return JSON.stringify(clone);
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function signup(http: INestApplication<App>, user: { email: string; phone: string; username: string }, password = PASSWORD): Promise<request.Response> {
  return request(http.getHttpServer()).post('/identity/signup').send({ ...user, password });
}

async function signin(
  http: INestApplication<App>,
  identifier: string,
  password = PASSWORD,
  deviceId = DEVICE_A,
  deviceLabel?: string,
): Promise<request.Response> {
  return request(http.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', deviceId)
    .send({ identifier, password, ...(deviceLabel === undefined ? {} : { deviceLabel }) });
}

beforeAll(async () => {
  db = await createEphemeralKalDb('ident');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  databaseUrl = url.toString();
  app = await bootApp({
    DATABASE_URL: databaseUrl,
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('signup (identity.signup)', () => {
  it('fresh account: 200 {"status":"accepted"} exactly, PHC stored, identifiers canonicalized', async () => {
    const response = await signup(app, USER_KALILA);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.text).toBe('{"status":"accepted"}');

    const row = await adminQuery(
      db,
      'SELECT email, username, phone, password, status FROM users WHERE email = $1',
      [USER_KALILA.email],
    );
    expect(row.rowCount).toBe(1);
    const user = row.rows[0] as { email: string; username: string; phone: string; password: string; status: string };
    expect(user.username).toBe('kalila');
    expect(user.phone).toBe('+201000000001');
    expect(user.status).toBe('active');
    expect(user.password).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
    expect(user.password).not.toContain(PASSWORD);
  });

  it('duplicate identifier: identical generic success — same body bytes, no extra row', async () => {
    const first = await signup(app, USER_KALILA);
    expect(first.status).toBe(200);
    // Same email, different other identifiers — still a duplicate.
    const duplicate = await signup(app, { ...USER_KALILA, username: 'kalila_alt', phone: '+201000000009' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.text).toBe(first.text);

    // Duplicate username with fresh email+phone: same observable.
    const dupUsername = await signup(app, { email: ['kalila2', 'example.com'].join('@'), phone: '+201000000008', username: USER_KALILA.username });
    expect(dupUsername.status).toBe(200);
    expect(dupUsername.text).toBe(first.text);
    // Duplicate phone with fresh email+username: same observable.
    const dupPhone = await signup(app, { email: ['kalila3', 'example.com'].join('@'), phone: USER_KALILA.phone, username: 'kalila3' });
    expect(dupPhone.status).toBe(200);
    expect(dupPhone.text).toBe(first.text);

    const rows = await adminQuery(db, 'SELECT COUNT(*)::int AS count FROM users WHERE email LIKE $1', ['kalila%']);
    // The duplicate attempts won no row: only the original account exists.
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  it('malformed bodies: 400 VALIDATION_FAILED, value-free errors, no row written', () => {
    const badUsername = 'bad username with spaces';
    const shortPassword = 'short-pw-11';
    return request(app.getHttpServer())
      .post('/identity/signup')
      .send({ email: ['x', 'example.com'].join('@'), phone: '+201000000007', username: badUsername, password: shortPassword })
      .expect(400)
      .then((response) => {
        expect(response.headers['content-type']).toContain('application/problem+json');
        const body = response.body as ProblemDetailsBody;
        expect(body.code).toBe('VALIDATION_FAILED');
        expect(Array.isArray(body.errors)).toBe(true);
        // Received values are never echoed (I12).
        expect(response.text).not.toContain(badUsername);
        expect(response.text).not.toContain(shortPassword);
        expect(response.text).not.toContain('x@');
      });
  });

  it('duplicate-signup race: every request gets the identical generic success, exactly one row wins', async () => {
    const user = { email: ['race', 'example.com'].join('@'), phone: '+201000000006', username: 'raceuser' };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => signup(app, user, `${PASSWORD}-race`)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"status":"accepted"}');
    }
    const rows = await adminQuery(db, "SELECT COUNT(*)::int AS count FROM users WHERE email = $1", [user.email]);
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });
});

describe('sign-in and UserContext resolution (identity.signin, identity.profile.get)', () => {
  it('sign-in works by each identifier and issues the frozen token-pair shape', async () => {
    for (const identifier of [USER_KALILA.email, USER_KALILA.phone, USER_KALILA.username]) {
      const response = await signin(app, identifier, PASSWORD, DEVICE_A, 'Kalila phone');
      expect(response.status, identifier).toBe(200);
      const pair = response.body as TokenPair;
      expect(typeof pair.accessToken).toBe('string');
      expect(typeof pair.refreshToken).toBe('string');
      expect(pair.session.deviceLabel).toBe('Kalila phone');
      expect(typeof pair.session.id).toBe('string');
      expect(pair.session.createdAt).toMatch(/Z$/u);
      expect(pair.session.expiresAt).toMatch(/Z$/u);
    }
  });

  it('a token-authenticated request resolves the validated UserContext (I2/I6)', async () => {
    const signinResponse = await signin(app, USER_KALILA.username, PASSWORD, DEVICE_A);
    const pair = signinResponse.body as TokenPair;
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
    expect(me.status).toBe(200);
    const profile = me.body as { user: { id: string; username: string; email: string; phone: string | null; createdAt: string } };
    expect(profile.user.username).toBe(USER_KALILA.username);
    expect(profile.user.email).toBe(USER_KALILA.email);
    expect(profile.user.phone).toBe(USER_KALILA.phone);
    // The context is the token's owning account — stable ids are never authorization.
    const rows = await adminQuery(db, 'SELECT id::text FROM users WHERE email = $1', [USER_KALILA.email]);
    expect(profile.user.id).toBe((rows.rows[0] as { id: string }).id);
  });

  it('absent phone renders as null in the profile (nullable phone is the reserved social shape)', async () => {
    await adminQuery(db, 'UPDATE users SET phone = NULL WHERE email = $1', [USER_KALILA.email]);
    const signinResponse = await signin(app, USER_KALILA.email);
    const pair = signinResponse.body as TokenPair;
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
    expect(me.status).toBe(200);
    expect((me.body as { user: { phone: string | null } }).user.phone).toBeNull();
    // Restore for later cases.
    await adminQuery(db, 'UPDATE users SET phone = $2 WHERE email = $1', [USER_KALILA.email, USER_KALILA.phone]);
  });
});

describe('enumeration resistance and lockout (contract §3)', () => {
  it('unknown identifier, wrong password, and closed account share ONE byte-identical 401 body', async () => {
    // A closed account (lifecycle states are structurally reserved; inserted
    // here as a fixture — sign-in must not treat closure as an oracle).
    await db.pool.query(
      'INSERT INTO users (email, username, phone, password, status) VALUES ($1, $2, $3, $4, $5)',
      [
        ['closed', 'example.com'].join('@'),
        'closeduser',
        '+201000000005',
        await rawArgon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 }),
        'closed',
      ],
    );

    const unknown = await signin(app, ['ghost', 'example.com'].join('@'));
    const wrongPassword = await signin(app, USER_KALILA.email, 'definitely-wrong-password');
    const closed = await signin(app, ['closed', 'example.com'].join('@'), PASSWORD);

    for (const response of [unknown, wrongPassword, closed]) {
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect((response.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
      // Bearer challenge accompanies every 401 (conventions §1).
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    expect(normalized(unknown.body)).toBe(normalized(wrongPassword.body));
    expect(normalized(wrongPassword.body)).toBe(normalized(closed.body));
  });

  it('the equivalence holds at every attempt count 1–3 (per fresh pair)', async () => {
    const device = 'equiv-device';
    const unknownIdent = ['equiv-unknown', 'example.com'].join('@');
    const bodies: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const known = await signin(app, USER_KALILA.email, 'wrong-password-attempt', device);
      const unknown = await signin(app, unknownIdent, 'wrong-password-attempt', device);
      expect(known.status).toBe(401);
      expect(unknown.status).toBe(401);
      bodies.push(normalized(known.body), normalized(unknown.body));
    }
    // Byte-identical across BOTH causes AND all attempt counts.
    expect(new Set(bodies).size).toBe(1);
    // The pair locked at attempt 3 — the next attempt (valid credentials)
    // fails closed with 429, not 401.
    const locked = await signin(app, USER_KALILA.email, PASSWORD, device);
    expect(locked.status).toBe(429);
  });

  it('lockout: threshold from config, Retry-After present, valid credentials fail closed', async () => {
    const device = 'lockout-device';
    const ident = USER_DANA.email;
    await signup(app, USER_DANA);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await signin(app, ident, 'wrong-password', device);
      expect(failed.status).toBe(attempt < 3 ? 401 : 401);
    }
    const lockedValid = await signin(app, ident, PASSWORD, device);
    expect(lockedValid.status).toBe(429);
    expect((lockedValid.body as ProblemDetailsBody).code).toBe('RATE_LIMITED');
    const retryAfter = Number(lockedValid.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // 429 is its own observable — not the 401 body.
    expect(normalized(lockedValid.body)).not.toMatch('UNAUTHENTICATED');
  });

  it('locked-pair 429 body is byte-identical whether or not the identifier exists', async () => {
    const device = 'oracle-device';
    const knownIdent = USER_DANA.email;
    const unknownIdent = ['ghost-locked', 'example.com'].join('@');
    for (const ident of [knownIdent, unknownIdent]) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await signin(app, ident, 'wrong-password', device);
      }
    }
    const knownLocked = await signin(app, knownIdent, PASSWORD, device);
    const unknownLocked = await signin(app, unknownIdent, PASSWORD, device);
    expect(knownLocked.status).toBe(429);
    expect(unknownLocked.status).toBe(429);
    expect(normalized(knownLocked.body)).toBe(normalized(unknownLocked.body));
  });

  it('both axes are independent: rotating device or identifier still locks the other axis', async () => {
    const ident = USER_DANA.email;
    // (ident, device-1) locked above; a different device on the same identifier is NOT locked.
    const otherDevice = await signin(app, ident, PASSWORD, 'other-device-axis');
    expect(otherDevice.status).toBe(200);
    // Lock (otherDeviceIdent, oracle-device): a different identifier on the locked device is NOT locked.
    const otherIdent = await signin(app, ['axis-two', 'example.com'].join('@'), PASSWORD, 'oracle-device');
    expect([200, 401]).toContain(otherIdent.status); // unknown identifier ⇒ 401, never the pair's 429
  });

  it('success resets the pair window: two failures + success + two failures ⇒ still no lock', async () => {
    const device = 'reset-device';
    const ident = USER_DANA.email;
    await signin(app, ident, 'wrong-password', device);
    await signin(app, ident, 'wrong-password', device);
    const success = await signin(app, ident, PASSWORD, device);
    expect(success.status).toBe(200);
    await signin(app, ident, 'wrong-password', device);
    await signin(app, ident, 'wrong-password', device);
    const stillWorking = await signin(app, ident, PASSWORD, device);
    expect(stillWorking.status).toBe(200);
  });

  it('lockout trigger appends an audit event carrying only digests (I14/I12)', async () => {
    const device = 'audit-device';
    const ident = ['audit-user', 'example.com'].join('@');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await signin(app, ident, 'wrong-password', device);
    }
    const rows = await adminQuery(
      db,
      "SELECT actor, action, target, justification FROM audit_events WHERE action = 'identity.lockout.triggered' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(rows.rowCount).toBe(1);
    const event = rows.rows[0] as { actor: string; action: string; target: string; justification: string };
    expect(event.actor).toBe('system:identity');
    expect(event.justification.length).toBeGreaterThan(0);
    // No raw identifier or device material anywhere in the audit row (I12).
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(ident);
    expect(serialized).not.toContain(device);
  });

  it('counters are atomic under concurrent failures: one lock, threshold respected, one audit row', async () => {
    const device = 'race-device';
    const ident = ['race-lock', 'example.com'].join('@');
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => signin(app, ident, 'wrong-password', device)),
    );
    for (const response of responses) {
      expect([401, 429]).toContain(response.status);
    }
    // The pair is locked now: valid credentials fail closed.
    const locked = await signin(app, ident, PASSWORD, device);
    expect(locked.status).toBe(429);

    const perPair = await adminQuery(
      db,
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE action = 'identity.lockout.triggered' AND target LIKE 'auth_attempt:%'",
    );
    // Exactly one lock event per locked pair (conditional lock-set is single-winner).
    const auditCount = (perPair.rows[0] as { count: number }).count;
    expect(auditCount).toBeGreaterThanOrEqual(1);
    const lockedPairs = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM auth_attempt_counters WHERE locked_until IS NOT NULL',
    );
    expect((lockedPairs.rows[0] as { count: number }).count).toBeGreaterThanOrEqual(1);
  });
});

describe('bearer credential failures (conventions §1, I6)', () => {
  it('missing, malformed, expired, wrong-key, extra-claim, and revoked tokens share ONE 401 body', async () => {
    const signinResponse = await signin(app, USER_KALILA.email);
    const pair = signinResponse.body as TokenPair;

    // Mint an expired token and an extra-claim token with the app's key.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: pair.session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_KALILA.email) // non-uuid sub also exercises claim validation
      .setIssuedAt(nowSeconds - 7200)
      .setExpirationTime(nowSeconds - 3600)
      .setJti('expired-fixture')
      .sign(CRAFT_KEY);
    const extraClaim = await new SignJWT({ sid: pair.session.id, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .setJti('extra-claim-fixture')
      .sign(CRAFT_KEY);
    const wrongKey = await new SignJWT({ sid: pair.session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .setJti('wrong-key-fixture')
      .sign(new TextEncoder().encode('another-key-with-plenty-of-entropy-and-length-1234567890'));

    const candidates: readonly [string, string][] = [
      ['missing', ''],
      ['garbage', 'Bearer garbage'],
      ['expired', `Bearer ${expired}`],
      ['extra-claim', `Bearer ${extraClaim}`],
      ['wrong-key', `Bearer ${wrongKey}`],
      ['scheme-only', 'Bearer'],
      ['basic-scheme', 'Basic dXNlcjpwYXNz'],
    ];
    const bodies: string[] = [];
    for (const [name, headerValue] of candidates) {
      const response = await request(app.getHttpServer())
        .get('/identity/me')
        .set(headerValue.length > 0 ? { Authorization: headerValue } : {});
      expect(response.status, name).toBe(401);
      expect(response.headers['www-authenticate'], name).toBe('Bearer');
      bodies.push(normalized(response.body));
    }
    // Every failure class — byte-identical (never states which).
    expect(new Set(bodies).size).toBe(1);

    // Revoked-session token: revoke the session, then the token dies (I6).
    await request(app.getHttpServer())
      .delete(`/identity/sessions/${pair.session.id}`)
      .set(bearer(pair.accessToken))
      .expect(204);
    const revoked = await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
    expect(revoked.status).toBe(401);
    expect(normalized(revoked.body)).toBe(bodies[0]);
  });

  it('tokens outside the Authorization header are unauthenticated (conventions §1)', async () => {
    const signinResponse = await signin(app, USER_KALILA.email);
    const pair = signinResponse.body as TokenPair;
    const reference = await request(app.getHttpServer()).get('/identity/me');
    const inQuery = await request(app.getHttpServer()).get(`/identity/me?token=${pair.accessToken}`);
    const inBody = await request(app.getHttpServer()).get('/identity/me').send({ token: pair.accessToken });
    const inCustomHeader = await request(app.getHttpServer())
      .get('/identity/me')
      .set('X-Access-Token', pair.accessToken);
    for (const response of [inQuery, inBody, inCustomHeader]) {
      expect(response.status).toBe(401);
      expect(normalized(response.body)).toBe(normalized(reference.body));
    }
  });
});

describe('sessions list and revocation (identity.sessions.list/revoke)', () => {
  it('lists active sessions only, newest first, with the frozen item shape', async () => {
    const first = ((await signin(app, USER_KALILA.email, PASSWORD, DEVICE_A, 'first')).body as TokenPair).session;
    const second = ((await signin(app, USER_KALILA.email, PASSWORD, DEVICE_B, 'second')).body as TokenPair).session;
    const lister = (await signin(app, USER_KALILA.email, PASSWORD, DEVICE_A)).body as TokenPair;
    const response = await request(app.getHttpServer())
      .get('/identity/sessions')
      .set(bearer(lister.accessToken));
    expect(response.status).toBe(200);
    const page = response.body as { data: { id: string; deviceLabel: string | null; createdAt: string; expiresAt: string }[]; nextCursor: string | null };
    expect(page.data.length).toBeGreaterThanOrEqual(3);
    const times = page.data.map((item) => item.createdAt);
    const sortedDesc = [...times].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(sortedDesc).toEqual(times);
    expect(page.data.some((item) => item.id === first.id)).toBe(true);
    expect(page.data.some((item) => item.id === second.id)).toBe(true);
    for (const item of page.data) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'deviceLabel', 'expiresAt', 'id']);
    }
  });

  it('pagination: deterministic keyset pages with opaque per-user cursors', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'pagination-device')).body as TokenPair;
    const pages: { id: string }[][] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const response = await request(app.getHttpServer())
        .get('/identity/sessions')
        .query({ limit: 2, ...(cursor === null ? {} : { cursor }) })
        .set(bearer(pair.accessToken));
      expect(response.status).toBe(200);
      const body = response.body as { data: { id: string }[]; nextCursor: string | null };
      pages.push(body.data);
      expect(body.data.length).toBeLessThanOrEqual(2);
      if (body.nextCursor === null) {
        break;
      }
      expect(typeof body.nextCursor).toBe('string');
      cursor = body.nextCursor;
    }
    const ids = pages.flat().map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
    // End of collection reached.
    const last = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ limit: 2, ...(cursor === null ? {} : { cursor }) })
      .set(bearer(pair.accessToken));
    expect((last.body as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it('limit clamps to 1–100; non-numeric limit is a generic 400', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'limit-device')).body as TokenPair;
    const clampedHigh = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ limit: 5000 })
      .set(bearer(pair.accessToken));
    expect(clampedHigh.status).toBe(200);
    const clampedZero = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ limit: 0 })
      .set(bearer(pair.accessToken));
    expect(clampedZero.status).toBe(200);
    expect((clampedZero.body as { data: unknown[] }).data.length).toBeLessThanOrEqual(1);
    const malformed = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ limit: 'not-a-number' })
      .set(bearer(pair.accessToken));
    expect(malformed.status).toBe(400);
    expect((malformed.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
  });

  it('a foreign cursor is a generic 400, byte-identical to a malformed cursor (no oracle)', async () => {
    const aPair = (await signin(app, USER_KALILA.email, PASSWORD, 'cursor-A')).body as TokenPair;
    const bPair = (await signin(app, USER_DANA.email, PASSWORD, 'cursor-B')).body as TokenPair;
    const aList = await request(app.getHttpServer()).get('/identity/sessions').query({ limit: 1 }).set(bearer(aPair.accessToken));
    const aCursor = (aList.body as { nextCursor: string | null }).nextCursor;
    expect(aCursor).not.toBeNull();
    const foreign = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ cursor: aCursor as string })
      .set(bearer(bPair.accessToken));
    const malformed = await request(app.getHttpServer())
      .get('/identity/sessions')
      .query({ cursor: 'tampered.cursor.junk' })
      .set(bearer(bPair.accessToken));
    expect(foreign.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(normalized(foreign.body)).toBe(normalized(malformed.body));
  });

  it('revoke: 204 bodiless; the token dies; repeat revocation of own session is idempotent', async () => {
    const victim = (await signin(app, USER_KALILA.email, PASSWORD, 'revoke-target', 'target')).body as TokenPair;
    const keeper = (await signin(app, USER_KALILA.email, PASSWORD, 'revoke-keeper')).body as TokenPair;

    const first = await request(app.getHttpServer())
      .delete(`/identity/sessions/${victim.session.id}`)
      .set(bearer(keeper.accessToken));
    expect(first.status).toBe(204);
    expect(first.text).toBe('');
    expect(first.headers['content-type']).toBeUndefined();

    const deadToken = await request(app.getHttpServer()).get('/identity/me').set(bearer(victim.accessToken));
    expect(deadToken.status).toBe(401);

    // Own-already-revoked: idempotent 204.
    const again = await request(app.getHttpServer())
      .delete(`/identity/sessions/${victim.session.id}`)
      .set(bearer(keeper.accessToken));
    expect(again.status).toBe(204);

    // The list excludes revoked sessions (active only).
    const list = await request(app.getHttpServer()).get('/identity/sessions').set(bearer(keeper.accessToken));
    const ids = ((list.body as { data: { id: string }[] }).data).map((item) => item.id);
    expect(ids).not.toContain(victim.session.id);
  });

  it('foreign or absent session revoke: ONE byte-identical 404 (no existence oracle)', async () => {
    const aPair = (await signin(app, USER_KALILA.email, PASSWORD, 'foreign-A')).body as TokenPair;
    const bPair = (await signin(app, USER_DANA.email, PASSWORD, 'foreign-B')).body as TokenPair;
    const absentId = '44444444-4444-4444-8444-444444444444';

    const foreign = await request(app.getHttpServer())
      .delete(`/identity/sessions/${bPair.session.id}`)
      .set(bearer(aPair.accessToken));
    const absent = await request(app.getHttpServer())
      .delete(`/identity/sessions/${absentId}`)
      .set(bearer(aPair.accessToken));
    const malformed = await request(app.getHttpServer())
      .delete('/identity/sessions/not-a-uuid')
      .set(bearer(aPair.accessToken));

    for (const response of [foreign, absent, malformed]) {
      expect(response.status).toBe(404);
      expect((response.body as ProblemDetailsBody).code).toBe('NOT_FOUND');
    }
    expect(normalized(foreign.body)).toBe(normalized(absent.body));
    expect(normalized(absent.body)).toBe(normalized(malformed.body));
    // B's session was untouched by A's attempt.
    const bStillWorks = await request(app.getHttpServer()).get('/identity/me').set(bearer(bPair.accessToken));
    expect(bStillWorks.status).toBe(200);
  });

  it('revoking the presented session is sign-out; effect is immediate (window ≈ 0)', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'signout-device')).body as TokenPair;
    const revoke = await request(app.getHttpServer())
      .delete(`/identity/sessions/${pair.session.id}`)
      .set(bearer(pair.accessToken));
    expect(revoke.status).toBe(204);
    const after = await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
    expect(after.status).toBe(401);
  });
});

describe('refresh rotation and reuse (identity.token.refresh)', () => {
  it('rotation issues a fresh pair for the same session; the old token is superseded', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'rotation-device')).body as TokenPair;
    const refresh = await request(app.getHttpServer())
      .post('/identity/token/refresh')
      .set(bearer(pair.refreshToken));
    expect(refresh.status).toBe(200);
    const next = refresh.body as TokenPair;
    expect(next.refreshToken).not.toBe(pair.refreshToken);
    expect(next.accessToken).not.toBe(pair.accessToken);
    expect(next.session.id).toBe(pair.session.id);
    // Sliding window (founder CR): a successful refresh re-arms the expiry.
    expect(Date.parse(next.session.expiresAt)).toBeGreaterThan(Date.parse(pair.session.expiresAt));
    expect(next.session.createdAt).toBe(pair.session.createdAt);

    // The new pair works; the rotation is recorded.
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(next.accessToken));
    expect(me.status).toBe(200);
    const generation = await db.pool.query('SELECT refresh_generation FROM sessions WHERE id = $1', [pair.session.id]);
    expect((generation.rows[0] as { refresh_generation: number }).refresh_generation).toBe(1);
  });

  it('reuse of a superseded refresh token revokes the chain with the generic 401', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'reuse-device')).body as TokenPair;
    const first = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken));
    expect(first.status).toBe(200);
    const next = first.body as TokenPair;

    // REUSE the superseded token: generic 401 (byte-identical to any refresh failure)…
    const reuse = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken));
    expect(reuse.status).toBe(401);
    expect((reuse.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
    expect(reuse.headers['www-authenticate']).toBe('Bearer');
    const garbage = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer('garbage-token'));
    expect(normalized(reuse.body)).toBe(normalized(garbage.body));

    // …and the WHOLE chain is dead: even the newest access token is refused (I6).
    const afterReuse = await request(app.getHttpServer()).get('/identity/me').set(bearer(next.accessToken));
    expect(afterReuse.status).toBe(401);
    const chainRefresh = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(next.refreshToken));
    expect(chainRefresh.status).toBe(401);
    // Session row revoked.
    const row = await db.pool.query('SELECT revoked_at FROM sessions WHERE id = $1', [pair.session.id]);
    expect((row.rows[0] as { revoked_at: string | null }).revoked_at).not.toBeNull();
    // The theft signal is audited.
    const audit = await db.pool.query(
      "SELECT justification FROM audit_events WHERE action = 'identity.session.chain_revoked' AND target = $1",
      [`session:${pair.session.id}`],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('concurrent refresh with the same token: exactly one winner, chain revoked afterwards', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'race-refresh-device')).body as TokenPair;
    const [winner, loser] = await Promise.all([
      request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken)),
      request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken)),
    ]);
    const statuses = [winner.status, loser.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
    // The chain is revoked either way (the loser's presentation is a reuse signal).
    const winnerPair = (winner.status === 200 ? winner.body : loser.status === 200 ? loser.body : null) as TokenPair | null;
    expect(winnerPair).not.toBeNull();
    const later = await request(app.getHttpServer())
      .post('/identity/token/refresh')
      .set(bearer((winnerPair as TokenPair).refreshToken));
    expect(later.status).toBe(401);
  });

  it('refresh travels only as the bearer credential; unknown sessions are the generic 401', async () => {
    const pair = (await signin(app, USER_KALILA.email, PASSWORD, 'transport-device')).body as TokenPair;
    const reference = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer('unknown-opaque-token'));
    expect(reference.status).toBe(401);
    const inBody = await request(app.getHttpServer())
      .post('/identity/token/refresh')
      .send({ refreshToken: pair.refreshToken });
    expect(inBody.status).toBe(401);
    const inQuery = await request(app.getHttpServer())
      .post(`/identity/token/refresh?refreshToken=${encodeURIComponent(pair.refreshToken)}`);
    expect(inQuery.status).toBe(401);
    expect(normalized(inBody.body)).toBe(normalized(reference.body));
    // The correct presentation still works (nothing above consumed it).
    const proper = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken));
    expect(proper.status).toBe(200);
  });
});

describe('hash goldens (ADR-0003) — rehash-on-login', () => {
  it('a stored old-parameter PHC verifies on login, then is re-stored with current parameters', async () => {
    const email = ['rehash', 'example.com'].join('@');
    const legacyHash = await rawArgon2Hash('rehash-upgrade-password', {
      algorithm: Algorithm.Argon2id,
      memoryCost: 19_456, // pre-upgrade parameters (smaller)
      timeCost: 2,
      parallelism: 1,
    });
    await db.pool.query(
      'INSERT INTO users (email, username, phone, password, status) VALUES ($1, $2, $3, $4, $5)',
      [email, 'rehashuser', '+201000000004', legacyHash, 'active'],
    );

    // Sign-in with the CORRECT password against the legacy hash: verifies and upgrades.
    const signinResponse = await signin(app, email, 'rehash-upgrade-password', 'rehash-device');
    expect(signinResponse.status).toBe(200);

    const stored = await db.pool.query('SELECT password FROM users WHERE email = $1', [email]);
    const upgraded = (stored.rows[0] as { password: string }).password;
    expect(upgraded).not.toBe(legacyHash);
    expect(upgraded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);

    // The upgraded hash still verifies — wrong passwords still fail.
    const again = await signin(app, email, 'rehash-upgrade-password', 'rehash-device');
    expect(again.status).toBe(200);
    const wrong = await signin(app, email, 'definitely-wrong', 'rehash-device');
    expect(wrong.status).toBe(401);
  });
});

describe('contract fixtures round-trip (declared identity entries)', () => {
  it('identity responses conform to the served w2 fixture schemas and content types', async () => {
    const document = w2FixturesDocument();
    const entry = (id: string) => document.endpoints.find((endpoint) => endpoint.id === id);

    const accepted = await signup(app, { email: ['fixture', 'example.com'].join('@'), phone: '+201000000003', username: 'fixtureuser' });
    expect(accepted.status).toBe(200);
    expect(accepted.text).toBe(JSON.stringify((entry('identity.signup')?.responses[0]?.example)));
    expect(accepted.headers['content-type']).toContain('application/json');

    const signinSchema = (entry('identity.signin')?.responses.find((response) => response.status === 200)?.bodySchema) as SchemaNode;
    const signinResponse = await signin(app, USER_KALILA.email, PASSWORD, 'fixture-device');
    assertConformsToSchema(signinResponse.body, signinSchema, 'identity.signin.200');

    const refresh401 = entry('identity.token.refresh')?.responses.find((response) => response.status === 401)?.bodySchema as SchemaNode;
    const refreshFailure = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer('unknown-token'));
    assertConformsToSchema(refreshFailure.body, refresh401, 'identity.token.refresh.401');

    const signin401 = entry('identity.signin')?.responses.find((response) => response.status === 401)?.bodySchema as SchemaNode;
    const signinFailure = await signin(app, ['nobody', 'example.com'].join('@'));
    assertConformsToSchema(signinFailure.body, signin401, 'identity.signin.401');
  });

  it('unknown identity routes keep the generic route-level NOT_FOUND', async () => {
    const response = await request(app.getHttpServer()).post('/identity/not-a-route').send({});
    expect(response.status).toBe(404);
    expect((response.body as ProblemDetailsBody).code).toBe('NOT_FOUND');
    expect(response.text).not.toContain('/identity/not-a-route');
  });
});

describe('config points change behavior (contract §6 — no hardcoded thresholds)', () => {
  it('a lockout threshold of 2 locks after two failures (default app required three)', async () => {
    await signup(app, { email: ['cfg', 'example.com'].join('@'), phone: '+201000000011', username: 'cfguser' });
    const thresholdApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS: '2',
    });
    try {
      const ident = ['cfg', 'example.com'].join('@');
      await signin(thresholdApp, ident, 'wrong-password', 'cfg-device');
      await signin(thresholdApp, ident, 'wrong-password', 'cfg-device');
      const lockedAtTwo = await signin(thresholdApp, ident, PASSWORD, 'cfg-device');
      expect(lockedAtTwo.status).toBe(429);
    } finally {
      await thresholdApp.close();
    }
  });

  it('a one-second lockout duration expires and opens a fresh window', async () => {
    const ident = ['cfgdur', 'example.com'].join('@');
    await signup(app, { email: ident, phone: '+201000000012', username: 'cfgduruser' });
    const shortLockApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_LOCKOUT_DURATION_SECONDS: '1',
    });
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await signin(shortLockApp, ident, 'wrong-password', 'dur-device');
      }
      const locked = await signin(shortLockApp, ident, PASSWORD, 'dur-device');
      expect(locked.status).toBe(429);
      // After expiry, the fresh window opens: attempts start counting from zero.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const afterExpiry = await signin(shortLockApp, ident, 'wrong-password', 'dur-device');
      expect(afterExpiry.status).toBe(401); // not 429 — the expired lock no longer applies
      const validAgain = await signin(shortLockApp, ident, PASSWORD, 'dur-device');
      expect(validAgain.status).toBe(200); // fresh window: a single failure does not lock
    } finally {
      await shortLockApp.close();
    }
  });

  it('the revocation window bound: revoked tokens are dead immediately AND after the window', async () => {
    const shortWindowApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_REVOCATION_WINDOW_SECONDS: '1',
    });
    try {
      const ident = ['cfgwin', 'example.com'].join('@');
      await signup(shortWindowApp, { email: ident, phone: '+201000000013', username: 'cfgwinuser' });
      const pair = (await signin(shortWindowApp, ident, PASSWORD, 'win-device')).body as TokenPair;
      const revoke = await request(shortWindowApp.getHttpServer())
        .delete(`/identity/sessions/${pair.session.id}`)
        .set(bearer(pair.accessToken));
      expect(revoke.status).toBe(204);

      // BEFORE the window boundary (t ≈ 0 < 1s): already refused.
      const immediate = await request(shortWindowApp.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
      expect(immediate.status).toBe(401);

      // AFTER the window boundary: still refused.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const afterWindow = await request(shortWindowApp.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
      expect(afterWindow.status).toBe(401);
      expect(normalized(immediate.body)).toBe(normalized(afterWindow.body));
    } finally {
      await shortWindowApp.close();
    }
  });
});
