/**
 * Kal identity ADVERSARIAL e2e (wave-02, task s4-adversarial) — the wave's
 * independent attack surface, run against the real AppModule on a real,
 * fully-migrated, EPHEMERAL PostgreSQL database (the harness pattern:
 * `kal_it_s4adv_*`, created and dropped by this suite; the dev database is
 * never touched). This lane VERIFIES the merged s2/s2b implementation against
 * the frozen contract (`docs/api/wave-02-contract.md`) — it never fixes it:
 * a verified defect is pinned here as a failing test and routed.
 *
 * Equivalence method — STRICTER than the implementing lanes' suites: the
 * earlier suites compare JSON.stringify-minus-requestId (lossy of key order
 * and formatting). This suite pins the SAME `X-Request-Id` on both sides of
 * every equivalence pair (conventions §0: the server echoes safe client
 * values into the body's `requestId`), so the comparison is the RAW response
 * text byte-for-byte with ZERO normalization — key order, spacing, and
 * member set included. Status, Content-Type, and WWW-Authenticate are
 * compared alongside the body.
 *
 * Required cases (task contract): enumeration equivalence (raw bytes here;
 * measured timing in identity-timing.e2e-spec.ts), lockout (3, per
 * (identifier, device), both axes, counters ticking on unknown identifiers,
 * expiry window, Retry-After config coupling, two-config threshold), the
 * full A/B/C matrix on sessions/profile/stable-IDs/cursors, token lifecycle
 * (issue/expiry/revocation-latency/rotation-chain/reuse/recovery-kills-all/
 * transport), rate-limit config respect, audit presence (I14) — with
 * supervisor-probe pins for the recovery pair-lock reading (findings routed
 * in the MR, never fixed here).
 *
 * Fixture discipline: synthetic users only (hyphenated local parts exercise
 * the supervisor-routed RFC 5321 atext fix); every lockout-sensitive case
 * uses its own (identifier, device) namespace so cases never interfere.
 * Accounts whose password a case replaces (recovery completions) are
 * single-purpose so no later case depends on the original credential.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { hash as rawArgon2Hash, Algorithm } from '@node-rs/argon2';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { DevMailAdapter } from '../src/identity/mail/dev-mail.adapter.js';
import { KAL_MAIL_PORT } from '../src/identity/mail/mail.port.js';
import { ProblemDetailsBody } from '../src/problems/problem-details.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 's4e4adv6rsarial9lane4fixed4key4material4with4enough4entropy';
/** The correlation id pinned on BOTH sides of every equivalence pair (≤128 printable ASCII). */
const PIN_ID = 's4 raw-equivalence pinned request id 00';

const PASSWORD = 's4-adversarial-password';
/** Wrong-password fixture — long enough to clear the 12-char policy (a short one is a 400, not a credential failure). */
const WRONG_PASSWORD = 's4-wrong-password-01';

const ACC_A = { email: 's4-owner-a@example.com', phone: '+201700000001', username: 's4_owner_a' };
const ACC_B = { email: 's4-attacker-b@example.com', phone: '+201700000002', username: 's4_attacker_b' };
const ACC_C = { email: 's4-control-c@example.com', phone: '+201700000003', username: 's4_control_c' };
const ACC_REC = { email: 's4-recoverable@example.com', phone: '+201700000005', username: 's4_recoverable' };
const ACC_LOCK = { email: 's4-lockable@example.com', phone: '+201700000006', username: 's4_lockable' };
/** Single-purpose: this account's password is replaced by the completion-equivalence case. */
const ACC_REC_FLOW = { email: 's4-recflow@example.com', phone: '+201700000007', username: 's4_recflow' };
const UNKNOWN_EMAIL = 's4-ghost@example.com';
const CLOSED_EMAIL = 's4-closed@example.com';
const ABSENT_SESSION_ID = '44444444-4444-4444-8444-444444444444';

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
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Pins the equivalence correlation id on a request (echoed into the body). */
function pin(test: request.Test): request.Test {
  return test.set('X-Request-Id', PIN_ID);
}

/** The raw-byte equivalence assertion: body text, status, and observable headers. */
function expectRawIdentical(actual: request.Response, expected: request.Response, label: string): void {
  expect(actual.status, `${label}: status`).toBe(expected.status);
  expect(actual.text, `${label}: raw body bytes`).toBe(expected.text);
  expect(actual.headers['content-type'], `${label}: content-type`).toBe(expected.headers['content-type']);
  if (expected.headers['www-authenticate'] !== undefined) {
    expect(actual.headers['www-authenticate'], `${label}: www-authenticate`).toBe(expected.headers['www-authenticate']);
  }
}

let deviceCounter = 0;
/** Fresh device per call — keeps every (identifier, device) counter pair independent. */
function freshDevice(caseTag: string): string {
  deviceCounter += 1;
  return `s4-${caseTag}-dev-${deviceCounter}`;
}

async function signup(
  application: INestApplication<App>,
  user: { email: string; phone: string; username: string },
  password = PASSWORD,
): Promise<request.Response> {
  return pin(request(application.getHttpServer()).post('/identity/signup')).send({ ...user, password });
}

function postSignin(
  application: INestApplication<App>,
  identifier: string,
  password: string,
  deviceId: string,
): request.Test {
  return pin(request(application.getHttpServer()).post('/identity/signin'))
    .set('X-Device-Id', deviceId)
    .send({ identifier, password });
}

function recoveryRequest(application: INestApplication<App>, identifier: string, deviceId: string): request.Test {
  return pin(request(application.getHttpServer()).post('/identity/recovery/request'))
    .set('X-Device-Id', deviceId)
    .send({ identifier });
}

function recoveryComplete(application: INestApplication<App>, ticket: string | null, newPassword = PASSWORD): request.Test {
  const test = pin(request(application.getHttpServer()).post('/identity/recovery/complete'));
  if (ticket !== null) {
    test.set('Authorization', `Bearer ${ticket}`);
  }
  return test.send({ newPassword });
}

async function signinPair(
  application: INestApplication<App>,
  identifier: string,
  deviceId: string,
  password = PASSWORD,
): Promise<TokenPair> {
  const response = await postSignin(application, identifier, password, deviceId);
  expect(response.status, `signin ${identifier} (${deviceId})`).toBe(200);
  return response.body as TokenPair;
}

/** Requests a ticket for the account and reads the SECRET back from the dev sink. */
async function issueTicketViaSink(application: INestApplication<App>, identifier: string, deviceId: string): Promise<string> {
  const issued = await recoveryRequest(application, identifier, deviceId);
  expect(issued.status).toBe(200);
  const sink = application.get<DevMailAdapter>(KAL_MAIL_PORT);
  expect(sink.records.length).toBeGreaterThan(0);
  return (sink.records[sink.records.length - 1] as { ticket: { secret: string } }).ticket.secret;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4adv');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  databaseUrl = url.toString();
  app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });

  // Accounts used across the matrix. The closed account is seeded directly
  // (lifecycle states are structurally reserved; sign-in must treat closure
  // as the generic 401, never an oracle).
  for (const account of [ACC_A, ACC_B, ACC_C, ACC_REC, ACC_LOCK, ACC_REC_FLOW]) {
    const response = await signup(app, account);
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"status":"accepted"}');
  }
  await db.pool.query(
    'INSERT INTO users (email, username, phone, password_hash, status) VALUES ($1, $2, $3, $4, $5)',
    [
      CLOSED_EMAIL,
      's4_closed',
      '+201700000004',
      await rawArgon2Hash(PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 }),
      'closed',
    ],
  );
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('enumeration equivalence — raw bytes, pinned X-Request-Id (contract §3)', () => {
  it('sign-in 401: unknown identifier vs wrong password vs closed account — raw-identical at attempts 1, 2, and 3', async () => {
    const seen: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const device = `s4-equiv-dev-attempt-${attempt}`;
      const unknown = await postSignin(app, UNKNOWN_EMAIL, PASSWORD, device);
      const wrongPassword = await postSignin(app, ACC_A.email, 'definitely-the-wrong-password', device);
      const closed = await postSignin(app, CLOSED_EMAIL, PASSWORD, device);
      for (const [label, response] of [
        ['unknown', unknown],
        ['wrong-password', wrongPassword],
        ['closed', closed],
      ] as const) {
        expect(response.status, `${label} attempt ${attempt}`).toBe(401);
        expect(response.headers['content-type'], label).toContain('application/problem+json');
        expect(response.headers['www-authenticate'], label).toBe('Bearer');
        expect((response.body as ProblemDetailsBody).code, label).toBe('UNAUTHENTICATED');
        // The pinned id comes back — the body really is comparable raw.
        expect((response.body as ProblemDetailsBody).requestId, label).toBe(PIN_ID);
        seen.push(response.text);
      }
      expectRawIdentical(wrongPassword, unknown, `wrong-password vs unknown @ attempt ${attempt}`);
      expectRawIdentical(closed, unknown, `closed vs unknown @ attempt ${attempt}`);
    }
    // One identical body across ALL THREE causes at ALL THREE attempt counts.
    expect(new Set(seen).size, 'every 401 body byte-identical across causes × attempts 1–3').toBe(1);
  });

  it('attempt 4+ (locked pair): 429 RATE_LIMITED raw-identical for the known and the unknown identifier — counters tick on unknowns, no oracle via lock behavior', async () => {
    // Drive a known-identifier pair and an unknown-identifier pair to lockout,
    // then observe attempt 4 on each. The UNKNOWN pair reaching 429 proves its
    // counter ticked (had unknown identifiers not been counted, this would be
    // a 401 — a lock-behavior existence oracle).
    const knownLockedDevice = freshDevice('lock-known');
    const unknownLockedDevice = freshDevice('lock-unknown');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await postSignin(app, ACC_A.email, WRONG_PASSWORD, knownLockedDevice)).status).toBe(401);
      expect((await postSignin(app, UNKNOWN_EMAIL, WRONG_PASSWORD, unknownLockedDevice)).status).toBe(401);
    }
    const knownLockedValid = await postSignin(app, ACC_A.email, PASSWORD, knownLockedDevice); // valid credentials, fail closed
    const unknownLockedValid = await postSignin(app, UNKNOWN_EMAIL, PASSWORD, unknownLockedDevice);
    const knownLockedWrong = await postSignin(app, ACC_A.email, WRONG_PASSWORD, knownLockedDevice);

    for (const [label, response] of [
      ['known+valid', knownLockedValid],
      ['unknown+valid', unknownLockedValid],
      ['known+wrong', knownLockedWrong],
    ] as const) {
      expect(response.status, label).toBe(429);
      expect(response.headers['content-type'], label).toContain('application/problem+json');
      expect((response.body as ProblemDetailsBody).code, label).toBe('RATE_LIMITED');
      const retryAfter = Number(response.headers['retry-after']);
      expect(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After ${label}`).toBe(true);
    }
    expectRawIdentical(unknownLockedValid, knownLockedValid, 'locked unknown vs locked known (valid creds)');
    expectRawIdentical(knownLockedWrong, knownLockedValid, 'locked known wrong-pw vs locked known valid-pw');
  });

  it('signup duplicate-identifier: the duplicate observable is byte-identical to the fresh success, for every identifier class', async () => {
    const fresh = await signup(app, { email: 's4-fresh-signup@example.com', phone: '+201700000011', username: 's4_fresh_signup' });
    expect(fresh.status).toBe(200);
    expect(fresh.text).toBe('{"status":"accepted"}');

    const dupEmail = await signup(app, { email: ACC_A.email, phone: '+201700000012', username: 's4_dup_email' });
    const dupUsername = await signup(app, { email: 's4-dup-username@example.com', phone: '+201700000013', username: ACC_A.username });
    const dupPhone = await signup(app, { email: 's4-dup-phone@example.com', phone: ACC_A.phone, username: 's4_dup_phone' });
    for (const [label, response] of [
      ['dup-email', dupEmail],
      ['dup-username', dupUsername],
      ['dup-phone', dupPhone],
    ] as const) {
      expect(response.status, label).toBe(200);
      expectRawIdentical(response, fresh, `${label} vs fresh signup`);
    }
    // The duplicates won no rows: only the fresh account exists.
    const rows = await adminQuery(db, 'SELECT COUNT(*)::int AS count FROM users WHERE email = $1', [
      's4-fresh-signup@example.com',
    ]);
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  it('recovery request: known vs unknown vs closed — raw-identical accepted bytes (and nothing observable changes for the unknown)', async () => {
    const known = await recoveryRequest(app, ACC_REC.email, freshDevice('recreq-known'));
    expect(known.status).toBe(200);
    expect(known.text).toBe('{"status":"accepted"}');

    const unknown = await recoveryRequest(app, UNKNOWN_EMAIL, freshDevice('recreq-unknown'));
    const closed = await recoveryRequest(app, CLOSED_EMAIL, freshDevice('recreq-closed'));
    expectRawIdentical(unknown, known, 'recovery unknown vs known');
    expectRawIdentical(closed, known, 'recovery closed vs known');

    // The unknown/closed paths left no ticket rows (the known path is the only writer).
    const tickets = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id IN (SELECT id FROM users WHERE email = ANY($1))',
      [[UNKNOWN_EMAIL, CLOSED_EMAIL]],
    );
    expect((tickets.rows[0] as { count: number }).count).toBe(0);
  });

  it('recovery complete: absent, malformed, well-formed-unknown, tampered, expired, consumed, superseded, wrong-scheme, and closed-account tickets — ONE raw-identical 401', async () => {
    // Expired: a well-formed ticket whose TTL has passed (crafted row).
    const expiredSecret = 'E'.repeat(43) + 'x';
    await db.pool.query(
      `INSERT INTO recovery_tickets (id, user_id, token_hash, created_at, expires_at)
       SELECT $1, id, encode(sha256($2::bytea), 'hex'), now() - interval '1 hour', now() - interval '1 second'
       FROM users WHERE email = $3`,
      ['55555555-5555-4555-8555-555555555555', Buffer.from(expiredSecret, 'utf8'), ACC_REC_FLOW.email],
    );

    // Consumed (replay): a real issued ticket, consumed by a successful completion.
    const firstTicket = await issueTicketViaSink(app, ACC_REC_FLOW.email, freshDevice('reccomplete-1'));
    const consumed = await recoveryComplete(app, firstTicket, 's4-a-brand-new-password');
    expect(consumed.status).toBe(200);

    // Superseded: issued, then invalidated by a later request.
    const supersededTicket = await issueTicketViaSink(app, ACC_REC_FLOW.email, freshDevice('reccomplete-2'));
    await issueTicketViaSink(app, ACC_REC_FLOW.email, freshDevice('reccomplete-3')); // supersedes the ticket above

    // Closed account with a hand-crafted LIVE ticket (closure is no oracle,
    // and recovery never resurrects).
    const closedSecret = 'C'.repeat(43) + 'y';
    await db.pool.query(
      `INSERT INTO recovery_tickets (id, user_id, token_hash, created_at, expires_at)
       SELECT $1, id, encode(sha256($2::bytea), 'hex'), now(), now() + interval '30 minutes'
       FROM users WHERE email = $3`,
      ['66666666-6666-4666-8666-666666666666', Buffer.from(closedSecret, 'utf8'), CLOSED_EMAIL],
    );

    const failures: request.Response[] = [
      await pin(request(app.getHttpServer()).post('/identity/recovery/complete')).send({ newPassword: PASSWORD }), // absent credential
      await recoveryComplete(app, 'not-a-ticket-at-all'), // malformed
      await recoveryComplete(app, 'z'.repeat(44)), // well-formed, unknown ticket
      await recoveryComplete(app, `${firstTicket.slice(0, -1)}${firstTicket.slice(-1) === 'A' ? 'B' : 'A'}`), // tampered digest
      await recoveryComplete(app, expiredSecret), // expired
      await recoveryComplete(app, firstTicket), // already consumed (replay)
      await recoveryComplete(app, supersededTicket), // superseded by a later request
      await pin(request(app.getHttpServer()).post('/identity/recovery/complete'))
        .set('Authorization', 'Basic c3BhbQ==')
        .send({ newPassword: PASSWORD }), // wrong scheme
      await recoveryComplete(app, closedSecret), // live ticket, closed account
    ];
    for (const [index, failure] of failures.entries()) {
      expect(failure.status, `failure ${index}`).toBe(401);
      expect(failure.headers['content-type'], `failure ${index}`).toContain('application/problem+json');
      expect(failure.headers['www-authenticate'], `failure ${index}`).toBe('Bearer');
      expect((failure.body as ProblemDetailsBody).code, `failure ${index}`).toBe('UNAUTHENTICATED');
      expect((failure.body as ProblemDetailsBody).requestId, `failure ${index}`).toBe(PIN_ID);
    }
    const bodies = new Set(failures.map((failure) => failure.text));
    expect(bodies.size, 'every recovery-complete failure cause byte-identical (raw)').toBe(1);
  });
});

describe('lockout — (identifier, device), threshold, both axes, expiry (contract §3)', () => {
  it('exactly 3 failures lock: attempts 1–2 leave valid credentials working, attempt 3 is still the 401, attempt 4 (valid) is 429', async () => {
    const ident = ACC_LOCK.email;
    // Two failures on their own pairs: valid credentials still work (not locked).
    await postSignin(app, ident, WRONG_PASSWORD, freshDevice('thr-a'));
    await postSignin(app, ident, WRONG_PASSWORD, freshDevice('thr-b'));
    const stillOpen = await postSignin(app, ident, PASSWORD, freshDevice('thr-ok'));
    expect(stillOpen.status, '2 failures ≠ lock').toBe(200);

    // Three failures on ONE pair: the pair locks.
    const pairDevice = freshDevice('thr-lock');
    await postSignin(app, ident, WRONG_PASSWORD, pairDevice);
    await postSignin(app, ident, WRONG_PASSWORD, pairDevice);
    const third = await postSignin(app, ident, WRONG_PASSWORD, pairDevice);
    expect(third.status, 'attempt 3 itself is still the 401 observable').toBe(401);
    const lockedValid = await postSignin(app, ident, PASSWORD, pairDevice);
    expect(lockedValid.status, 'valid credentials on the locked pair fail closed').toBe(429);
  });

  it('success resets the window: 2 failures + success + 2 failures ⇒ still no lock', async () => {
    const ident = 's4-reset@example.com';
    await signup(app, { email: ident, phone: '+201700000021', username: 's4_reset' });
    const device = freshDevice('reset');
    await postSignin(app, ident, WRONG_PASSWORD, device);
    await postSignin(app, ident, WRONG_PASSWORD, device);
    expect((await postSignin(app, ident, PASSWORD, device)).status).toBe(200); // resets the pair
    await postSignin(app, ident, WRONG_PASSWORD, device);
    await postSignin(app, ident, WRONG_PASSWORD, device);
    expect((await postSignin(app, ident, PASSWORD, device)).status, 'reset window: 2+success+2 must not lock').toBe(200);
  });

  it('both axes independent: a locked (identifier, device) leaves (other-identifier, same-device) AND (same-identifier, other-device) unlocked', async () => {
    const lockDevice = freshDevice('axis');
    await signup(app, { email: 's4-axis-a@example.com', phone: '+201700000022', username: 's4_axis_a' });
    await signup(app, { email: 's4-axis-b@example.com', phone: '+201700000023', username: 's4_axis_b' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await postSignin(app, 's4-axis-a@example.com', WRONG_PASSWORD, lockDevice);
    }
    expect((await postSignin(app, 's4-axis-a@example.com', PASSWORD, lockDevice)).status).toBe(429); // pair locked
    // Same identifier, DIFFERENT device: unlocked.
    const otherDevice = await postSignin(app, 's4-axis-a@example.com', PASSWORD, freshDevice('axis-other-dev'));
    expect(otherDevice.status, 'rotating the device defeats the (pair) lock — per-device axis enforced').toBe(200);
    // Same (locked) device, DIFFERENT identifier: unlocked.
    const otherIdent = await postSignin(app, 's4-axis-b@example.com', PASSWORD, lockDevice);
    expect(otherIdent.status, 'rotating the identifier defeats the (pair) lock — per-identifier axis enforced').toBe(200);
  });

  it('lock expiry opens a FRESH window (duration=2 config): Retry-After ≤ duration; after expiry the count restarts from zero', async () => {
    const shortApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_LOCKOUT_DURATION_SECONDS: '2',
    });
    try {
      const ident = 's4-expiry@example.com';
      await signup(shortApp, { email: ident, phone: '+201700000024', username: 's4_expiry' });
      const device = freshDevice('expiry');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await postSignin(shortApp, ident, WRONG_PASSWORD, device)).status).toBe(401);
      }
      const locked = await postSignin(shortApp, ident, PASSWORD, device);
      expect(locked.status).toBe(429);
      const retryAfter = Number(locked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter, 'Retry-After is bounded by the configured lockout duration').toBeLessThanOrEqual(2);

      // After expiry: the fresh window opens — the observable is 401 (not 429).
      await new Promise((resolve) => setTimeout(resolve, 2300));
      const afterExpiry = await postSignin(shortApp, ident, WRONG_PASSWORD, device);
      expect(afterExpiry.status, 'expired lock no longer applies — fresh window').toBe(401);
      expect((afterExpiry.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
      // Fresh window means the count restarted: two more failures do NOT lock.
      await postSignin(shortApp, ident, WRONG_PASSWORD, device);
      expect((await postSignin(shortApp, ident, PASSWORD, device)).status, 'count restarted from zero after expiry').toBe(200);
    } finally {
      await shortApp.close();
    }
  }, 60_000);

  it('two-config threshold: the same three failures lock under threshold 3 but NOT under threshold 5 (config is behavior, not a constant)', async () => {
    const threshold5 = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_LOCKOUT_THRESHOLD_ATTEMPTS: '5',
    });
    try {
      // Pair P3 against the DEFAULT app (threshold 3): locks at 3.
      const p3Device = freshDevice('cfg3');
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await postSignin(app, 's4-axis-a@example.com', WRONG_PASSWORD, p3Device)).status).toBe(401);
      }
      expect((await postSignin(app, 's4-axis-a@example.com', PASSWORD, p3Device)).status, 'threshold-3 app locks at 3').toBe(429);

      // Pair P5 (distinct pair) against the threshold-5 app: failures stay the
      // plain 401 observable past the threshold-3 point — the discriminator
      // (a threshold-3 pair would 429 the NEXT valid-credentials attempt).
      // No valid credentials are presented until the end: a success RESETS the
      // pair counter, which would erase the very count under test.
      const p5Device = freshDevice('cfg5');
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect((await postSignin(threshold5, 's4-axis-b@example.com', WRONG_PASSWORD, p5Device)).status, `threshold-5 attempt ${attempt} not locked (threshold is 5)`).toBe(401);
      }
      // Fifth failure crosses the threshold: the lock is set (the observable
      // of the locking attempt itself stays 401 — locking binds the NEXT attempt).
      expect((await postSignin(threshold5, 's4-axis-b@example.com', WRONG_PASSWORD, p5Device)).status).toBe(401);
      expect((await postSignin(threshold5, 's4-axis-b@example.com', PASSWORD, p5Device)).status, 'threshold-5 app locks at 5').toBe(429);
    } finally {
      await threshold5.close();
    }
  }, 60_000);

  it('Retry-After: integer seconds ≥ 1 on EVERY RATE_LIMITED (sign-in AND recovery request), and the two 429 envelopes are raw-identical', async () => {
    const signinLockDevice = freshDevice('ra-signin');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await postSignin(app, ACC_LOCK.email, WRONG_PASSWORD, signinLockDevice);
    }
    const signin429 = await postSignin(app, ACC_LOCK.email, PASSWORD, signinLockDevice);
    expect(signin429.status).toBe(429);
    expect(Number.parseInt(signin429.headers['retry-after'] as string, 10)).toBeGreaterThanOrEqual(1);

    const recovery429 = await recoveryRequest(app, ACC_LOCK.email, signinLockDevice);
    expect(recovery429.status, 'recovery request on a locked pair fails closed (429)').toBe(429);
    expect((recovery429.body as ProblemDetailsBody).code).toBe('RATE_LIMITED');
    expect(Number.parseInt(recovery429.headers['retry-after'] as string, 10)).toBeGreaterThanOrEqual(1);
    // Same registry body class: the recovery-request 429 and the sign-in 429 share the envelope bytes.
    expectRawIdentical(recovery429, signin429, 'recovery 429 vs signin 429');
  });

  it('PROBE (supervisor §10-1, pinned reading): recovery requests never tick the pair counter — 2 failures + K recovery requests still leaves the 3rd sign-in failure at 401', async () => {
    const ident = 's4-recprobe@example.com';
    await signup(app, { email: ident, phone: '+201700000025', username: 's4_recprobe' });
    const device = freshDevice('recprobe');
    await postSignin(app, ident, WRONG_PASSWORD, device); // count 1
    await postSignin(app, ident, WRONG_PASSWORD, device); // count 2
    for (let k = 0; k < 6; k += 1) {
      const recovery = await recoveryRequest(app, ident, device);
      expect(recovery.status, `recovery request ${k + 1} on the half-counted pair`).toBe(200);
      expect(recovery.text).toBe('{"status":"accepted"}');
    }
    // If recovery ticked, this would be the 429 observable; it is the plain 401.
    const third = await postSignin(app, ident, WRONG_PASSWORD, device);
    expect(third.status, 'recovery requests did NOT tick the credential counter').toBe(401);
    // The 4th failure locks — exactly per the sign-in counter.
    await postSignin(app, ident, WRONG_PASSWORD, device);
    expect((await postSignin(app, ident, PASSWORD, device)).status).toBe(429);
  });

  it('PROBE (supervisor §10-1, F-S4-1 evidence): recovery requests are never throttled by ANY counter of their own — pinned as implemented, finding routed', async () => {
    // Characterization (NOT endorsement — see MR finding F-S4-1): a high
    // volume of recovery requests across one device and mixed identifiers
    // never produces anything but the identical accepted bytes. The pair-lock
    // pre-check fires only for pairs ALREADY locked by sign-in failures; no
    // recovery-specific counter exists to stop a request flood.
    const seen = new Set<string>();
    for (let k = 0; k < 12; k += 1) {
      const identifier = k % 3 === 0 ? ACC_REC.email : k % 3 === 1 ? UNKNOWN_EMAIL : 's4-axis-a@example.com';
      const response = await recoveryRequest(app, identifier, freshDevice('flood'));
      expect(response.status, `recovery flood ${k + 1}`).toBe(200);
      seen.add(response.text);
    }
    expect(seen.size).toBe(1);
  });

  it('audit (I14): lockout trigger and REPEATED lockouts append; rows carry digests only — no raw identifier or device material', async () => {
    const ident = 's4-audit@example.com';
    const device = freshDevice('audit');
    await signup(app, { email: ident, phone: '+201700000026', username: 's4_audit' });

    // Repeated lockout needs expiry between locks — a LOCKED pair fails closed
    // before credentials are considered (that is the contract), so a success
    // cannot reset it. Run the whole lock→expire→re-lock sequence in a
    // short-duration app sharing the SAME signing key (identical counter
    // digests ⇒ the same audit target for both lock events).
    const shortApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_LOCKOUT_DURATION_SECONDS: '1',
    });
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await postSignin(shortApp, ident, WRONG_PASSWORD, device)).status).toBe(401);
      }
      const lockedOnce = await postSignin(shortApp, ident, PASSWORD, device);
      expect(lockedOnce.status).toBe(429);
      // Expire, then re-lock the SAME pair.
      await new Promise((resolve) => setTimeout(resolve, 1300));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await postSignin(shortApp, ident, WRONG_PASSWORD, device)).status, 'fresh window after expiry').toBe(401);
      }
      expect((await postSignin(shortApp, ident, PASSWORD, device)).status, 're-locked').toBe(429);
    } finally {
      await shortApp.close();
    }

    const pairRow = await adminQuery<{ subject_key: string; device_key: string }>(
      db,
      'SELECT subject_key, device_key FROM auth_attempt_counters ORDER BY last_failed_at DESC LIMIT 1',
    );
    const target = `auth_attempt:${pairRow.rows[0]?.subject_key}:${pairRow.rows[0]?.device_key}`;
    const countForTarget = async (): Promise<number> => {
      const rows = await adminQuery<{ count: number }>(
        db,
        'SELECT COUNT(*)::int AS count FROM audit_events WHERE action = $1 AND target = $2',
        ['identity.lockout.triggered', target],
      );
      return (rows.rows[0] as { count: number }).count;
    };
    expect(await countForTarget(), 'repeated lockout appends AGAIN for the same pair target (I14)').toBe(2);

    // Presence + non-disclosure: the serialized rows carry no raw material.
    const event = await adminQuery<{ actor: string; action: string; target: string; justification: string }>(
      db,
      'SELECT actor, action, target, justification FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1',
      ['identity.lockout.triggered'],
    );
    expect(event.rows[0]?.actor).toBe('system:identity');
    const serialized = JSON.stringify(event.rows[0]);
    expect(serialized).not.toContain(ident);
    expect(serialized).not.toContain(device);
  });
});

describe('A/B/C matrix — sessions, profile, stable IDs, cursors (I6/I7, FR-008)', () => {
  let aPair1: TokenPair; // A, device A1 (attack target)
  let aPair2: TokenPair; // A, device A2
  let bPair: TokenPair;
  let cPair: TokenPair;
  let aCursor: string;

  beforeAll(async () => {
    aPair1 = await signinPair(app, ACC_A.email, freshDevice('abc-a1'), PASSWORD);
    aPair2 = await signinPair(app, ACC_A.email, freshDevice('abc-a2'), PASSWORD);
    bPair = await signinPair(app, ACC_B.email, freshDevice('abc-b'), PASSWORD);
    cPair = await signinPair(app, ACC_C.email, freshDevice('abc-c'), PASSWORD);
    const list = await request(app.getHttpServer()).get('/identity/sessions').query({ limit: 1 }).set(bearer(aPair1.accessToken));
    aCursor = (list.body as { nextCursor: string | null }).nextCursor as string;
    expect(aCursor).toBeTruthy();
  });

  it('C control: the control account acts on its own data with full parity (200 reads, 204 own-revoke)', async () => {
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(cPair.accessToken));
    expect(me.status).toBe(200);
    expect((me.body as { user: { username: string } }).user.username).toBe(ACC_C.username);
    const revoke = await request(app.getHttpServer())
      .delete(`/identity/sessions/${cPair.session.id}`)
      .set(bearer(cPair.accessToken));
    expect(revoke.status, 'C revokes own session — 204 parity').toBe(204);
  });

  it('B lists sessions: ONLY B’s own rows — A’s live sessions are invisible to the enumeration path (I1)', async () => {
    const list = await request(app.getHttpServer()).get('/identity/sessions').set(bearer(bPair.accessToken));
    expect(list.status).toBe(200);
    const ids = (list.body as { data: { id: string }[] }).data.map((item) => item.id);
    expect(ids).toContain(bPair.session.id);
    expect(ids).not.toContain(aPair1.session.id);
    expect(ids).not.toContain(aPair2.session.id);
  });

  it('B revokes A’s session ⇒ 404; absent id and malformed id ⇒ 404 — ALL raw-identical (I7: no existence oracle)', async () => {
    const foreign = await pin(request(app.getHttpServer()).delete(`/identity/sessions/${aPair1.session.id}`)).set(bearer(bPair.accessToken));
    const absent = await pin(request(app.getHttpServer()).delete(`/identity/sessions/${ABSENT_SESSION_ID}`)).set(bearer(bPair.accessToken));
    const malformed = await pin(request(app.getHttpServer()).delete('/identity/sessions/not-a-uuid')).set(bearer(bPair.accessToken));
    for (const [label, response] of [
      ['foreign', foreign],
      ['absent', absent],
      ['malformed', malformed],
    ] as const) {
      expect(response.status, label).toBe(404);
      expect((response.body as ProblemDetailsBody).code, label).toBe('NOT_FOUND');
      expect((response.body as ProblemDetailsBody).requestId, label).toBe(PIN_ID);
    }
    expectRawIdentical(absent, foreign, 'absent vs foreign session revoke');
    expectRawIdentical(malformed, foreign, 'malformed vs foreign session revoke');

    // Nobody's session was touched by the attack.
    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(aPair1.accessToken))).status, 'A untouched').toBe(200);
    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(bPair.accessToken))).status, 'B untouched').toBe(200);
  });

  it('B can never obtain A’s profile: /identity/me is the caller’s own account only; crafted sub/sid mixtures are the generic 401 (I6)', async () => {
    const bMe = await request(app.getHttpServer()).get('/identity/me').set(bearer(bPair.accessToken));
    expect(bMe.status).toBe(200);
    const bProfile = bMe.body as { user: { id: string; email: string; username: string } };
    expect(bProfile.user.email).toBe(ACC_B.email);
    expect(bProfile.user.username).toBe(ACC_B.username);
    expect(bProfile.user.email).not.toBe(ACC_A.email);

    const aMe = await request(app.getHttpServer()).get('/identity/me').set(bearer(aPair1.accessToken));
    const aId = (aMe.body as { user: { id: string } }).user.id;
    const bId = bProfile.user.id;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const craft = async (sub: string, sid: string, jti: string): Promise<string> =>
      new SignJWT({ sid })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 600)
        .setJti(jti)
        .sign(new TextEncoder().encode(SIGNING_KEY));

    // B's uuid bound to A's LIVE session — the session binding check must refuse.
    const bSubASid = await craft(bId, aPair1.session.id, 's4-mix-b-sub-a-sid');
    // A's uuid bound to B's LIVE session — symmetric refusal.
    const aSubBSid = await craft(aId, bPair.session.id, 's4-mix-a-sub-b-sid');

    const reference = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer('garbage-token'));
    expect(reference.status).toBe(401);
    for (const [label, token] of [
      ['B-sub/A-sid', bSubASid],
      ['A-sub/B-sid', aSubBSid],
    ] as const) {
      const response = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer(token));
      expect(response.status, label).toBe(401);
      expectRawIdentical(response, reference, `${label} vs generic unauthenticated`);
    }
  });

  it('cursors are user-bound and opaque: A’s cursor under B, a tampered cursor, and an empty cursor are ONE raw-identical 400; a foreign cursor never yields rows', async () => {
    const foreign = await pin(request(app.getHttpServer()).get('/identity/sessions').query({ cursor: aCursor, limit: 5 })).set(
      bearer(bPair.accessToken),
    );
    const tampered = await pin(request(app.getHttpServer()).get('/identity/sessions').query({ cursor: `${aCursor}x`, limit: 5 })).set(
      bearer(bPair.accessToken),
    );
    const empty = await pin(request(app.getHttpServer()).get('/identity/sessions').query({ cursor: '' })).set(bearer(bPair.accessToken));
    const ownFirstPage = await pin(request(app.getHttpServer()).get('/identity/sessions')).set(bearer(bPair.accessToken)); // control

    expect(ownFirstPage.status, 'control: B’s own first page reads fine').toBe(200);
    for (const [label, response] of [
      ['foreign', foreign],
      ['tampered', tampered],
      ['empty', empty],
    ] as const) {
      expect(response.status, label).toBe(400);
      expect((response.body as ProblemDetailsBody).code, label).toBe('VALIDATION_FAILED');
      expect((response.body as ProblemDetailsBody).requestId, label).toBe(PIN_ID);
    }
    expectRawIdentical(foreign, tampered, 'foreign vs tampered cursor');
    expectRawIdentical(empty, foreign, 'empty vs foreign cursor');

    // The denial carries no data: no A material anywhere in the body.
    const body = JSON.stringify(foreign.body);
    expect(body).not.toContain(ACC_A.username);
    expect(body).not.toContain(aPair1.session.id);
  });

  it('Idempotency-Key (reserved surface): no W2 identity endpoint consumes it — B replaying A’s key is inert (pinned; the real contract lands with sync ingestion)', async () => {
    const baseline = await pin(request(app.getHttpServer()).post('/identity/signup')).send({
      email: 's4-idem-base@example.com',
      phone: '+201700000031',
      username: 's4_idem_base',
      password: PASSWORD,
    });
    const replayed = await pin(request(app.getHttpServer()).post('/identity/signup'))
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({ email: 's4-idem-replay@example.com', phone: '+201700000032', username: 's4_idem_replay', password: PASSWORD });
    expect(replayed.status).toBe(200);
    expectRawIdentical(replayed, baseline, 'signup with a foreign Idempotency-Key vs without');
    // Both accounts exist: the key was ignored, not deduped (the W2 surface is
    // declared N/A for idempotency — sync ingestion owns the real contract).
    const rows = await adminQuery<{ count: number }>(db, 'SELECT COUNT(*)::int AS count FROM users WHERE email LIKE $1', ['s4-idem-%']);
    expect((rows.rows[0] as { count: number }).count).toBe(2);
  });
});

describe('token lifecycle (contract §1)', () => {
  it('issued pair authenticates; the access-token claim set is EXACTLY {sub, sid, iat, exp, jti} and jti is unique per issue (suite-side parse — clients never do this)', async () => {
    const pair = await signinPair(app, ACC_A.email, freshDevice('claims'), PASSWORD);
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
    expect(me.status).toBe(200);

    const payload = decodeJwtPayload(pair.accessToken) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sid', 'sub']);
    for (const key of ['sub', 'sid', 'jti']) {
      expect(typeof payload[key]).toBe('string');
    }
    expect(typeof payload['exp']).toBe('number');
    expect(typeof payload['iat']).toBe('number');
    expect(payload['sid']).toBe(pair.session.id);

    const second = await signinPair(app, ACC_A.email, freshDevice('claims-2'), PASSWORD);
    const payload2 = decodeJwtPayload(second.accessToken) as { jti: string };
    expect(payload2.jti).not.toBe(payload['jti']);
  });

  it('access-token expiry boundary (TTL=30 app, the validated minimum): live before, dead after — the 401 is the generic body, raw-identical to a never-valid token', async () => {
    const shortTtl = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_ACCESS_TOKEN_TTL_SECONDS: '30',
    });
    try {
      const pair = await signinPair(shortTtl, 's4-axis-a@example.com', freshDevice('ttl'), PASSWORD);
      const before = await request(shortTtl.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken));
      expect(before.status, 'inside the TTL').toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 31_200));
      const after = await pin(request(shortTtl.getHttpServer()).get('/identity/me')).set(bearer(pair.accessToken));
      expect(after.status, 'past the TTL').toBe(401);
      const neverValid = await pin(request(shortTtl.getHttpServer()).get('/identity/me')).set(bearer('garbage-token'));
      expectRawIdentical(after, neverValid, 'expired vs never-valid');
      // The session itself is NOT expired (30-day absolute lifetime): the refresh token still rotates.
      const refresh = await request(shortTtl.getHttpServer()).post('/identity/token/refresh').set(bearer(pair.refreshToken)).send();
      expect(refresh.status, 'expired ACCESS token ≠ expired SESSION — refresh still works').toBe(200);
    } finally {
      await shortTtl.close();
    }
  }, 60_000);

  it('revocation latency: revocation kills the token immediately (observed window ≈ 0 ≤ the 60s frozen bound); the revoked 401 is raw-identical to a never-valid 401', async () => {
    const victim = await signinPair(app, ACC_A.email, freshDevice('revocation-victim'), PASSWORD);
    const keeper = await signinPair(app, ACC_A.email, freshDevice('revocation-keeper'), PASSWORD);

    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(victim.accessToken))).status).toBe(200);

    const revoke = await request(app.getHttpServer())
      .delete(`/identity/sessions/${victim.session.id}`)
      .set(bearer(keeper.accessToken));
    expect(revoke.status).toBe(204);
    expect(revoke.text).toBe('');

    // IMMEDIATELY — the frozen window bounds any future caching; today's
    // per-request posture collapses the observed window to ≈ 0.
    const dead = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer(victim.accessToken));
    expect(dead.status).toBe(401);
    const garbage = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer('garbage-token'));
    expectRawIdentical(dead, garbage, 'revoked vs never-valid (raw)');
  });

  it('rotation chain A→B→C on one session: absolute expiresAt preserved; reusing the OLDEST token revokes the chain — every descendant dead; theft audited (I14)', async () => {
    const first = await signinPair(app, ACC_REC.email, freshDevice('chain'), PASSWORD);
    const secondResponse = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(first.refreshToken)).send();
    expect(secondResponse.status).toBe(200);
    const second = secondResponse.body as TokenPair;
    const thirdResponse = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(second.refreshToken)).send();
    expect(thirdResponse.status).toBe(200);
    const third = thirdResponse.body as TokenPair;

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(third.refreshToken).not.toBe(second.refreshToken);
    // Absolute session lifetime: the session bookkeeping never slides.
    expect(third.session.expiresAt).toBe(first.session.expiresAt);
    expect(third.session.id).toBe(first.session.id);

    // REUSE of the oldest (superseded) token: theft signal.
    const reuse = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer(first.refreshToken)).send();
    expect(reuse.status).toBe(401);
    expect(reuse.headers['www-authenticate']).toBe('Bearer');

    // Every descendant is dead: the newest access AND refresh tokens included.
    for (const [label, token, path] of [
      ['gen-1 access', second.accessToken, '/identity/me'],
      ['gen-2 access', third.accessToken, '/identity/me'],
      ['gen-2 refresh', third.refreshToken, '/identity/token/refresh'],
    ] as const) {
      const probe =
        path === '/identity/me'
          ? await request(app.getHttpServer()).get(path).set(bearer(token))
          : await request(app.getHttpServer()).post(path).set(bearer(token)).send();
      expect(probe.status, label).toBe(401);
    }
    // Row-level: revoked.
    const row = await adminQuery<{ revoked_at: Date | null }>(db, 'SELECT revoked_at FROM sessions WHERE id = $1', [first.session.id]);
    expect(row.rows[0]?.revoked_at).not.toBeNull();
    // Audited.
    const audit = await adminQuery<{ count: number }>(
      db,
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE action = 'identity.session.chain_revoked' AND target = $1",
      [`session:${first.session.id}`],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('PROBE (F-S4-2 observation): a WELL-FORMED refresh token with a valid embedded session id but a WRONG secret revokes the live session — a superset of the frozen reuse trigger', async () => {
    // Characterization pin (see MR finding F-S4-2): the contract freezes
    // "reuse ⇒ chain revocation"; the implementation additionally revokes on
    // ANY digest mismatch for a live session (fail-closed superset). Pinned
    // here so the behavior cannot drift silently; routed for awareness.
    const pair = await signinPair(app, ACC_A.email, freshDevice('wrong-suffix'), PASSWORD);
    // Same 16-byte session prefix, different 32-byte suffix — well-formed, wrong secret.
    const raw = Buffer.from(pair.refreshToken, 'base64url');
    const forged = Buffer.concat([raw.subarray(0, 16), Buffer.from('f'.repeat(32), 'utf8')]).toString('base64url');
    expect(forged).not.toBe(pair.refreshToken);

    const forged401 = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer(forged)).send();
    expect(forged401.status).toBe(401);
    const garbage = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer('short')).send();
    expectRawIdentical(forged401, garbage, 'wrong-suffix vs garbage refresh');

    // The superset behavior: the LIVE session is now revoked.
    const row = await adminQuery<{ revoked_at: Date | null }>(db, 'SELECT revoked_at FROM sessions WHERE id = $1', [pair.session.id]);
    expect(row.rows[0]?.revoked_at, 'wrong-secret presentation killed the live session (superset of the frozen trigger)').not.toBeNull();
    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken))).status).toBe(401);
  });

  it('token placement: credentials outside the Authorization bearer header are the generic 401, raw-identical — access token on the refresh endpoint included', async () => {
    const pair = await signinPair(app, ACC_A.email, freshDevice('placement'), PASSWORD);
    const reference = await pin(request(app.getHttpServer()).get('/identity/me')); // no header at all
    expect(reference.status).toBe(401);

    const inQuery = await pin(request(app.getHttpServer()).get(`/identity/me?token=${encodeURIComponent(pair.accessToken)}`));
    const inBody = await pin(request(app.getHttpServer()).get('/identity/me')).send({ token: pair.accessToken });
    const inCustomHeader = await pin(request(app.getHttpServer()).get('/identity/me')).set('X-Access-Token', pair.accessToken);
    const malformedBearer = await pin(request(app.getHttpServer()).get('/identity/me')).set('Authorization', `Bearer extra ${pair.accessToken}`);
    for (const [label, response] of [
      ['query', inQuery],
      ['body', inBody],
      ['custom-header', inCustomHeader],
      ['malformed-bearer', malformedBearer],
    ] as const) {
      expect(response.status, label).toBe(401);
      expectRawIdentical(response, reference, `${label} vs no-credentials`);
    }

    // Access token presented as the refresh credential: same generic 401.
    const refreshWithAccess = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer(pair.accessToken)).send();
    const refreshGarbage = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer('garbage')).send();
    expect(refreshWithAccess.status).toBe(401);
    expectRawIdentical(refreshWithAccess, refreshGarbage, 'access-as-refresh vs garbage refresh');

    // The correct pair still works (nothing above consumed anything).
    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(pair.accessToken))).status).toBe(200);
  });

  it('refresh from an EXPIRED session is the generic 401 (absolute lifetime; no sliding window)', async () => {
    const pair = await signinPair(app, ACC_A.email, freshDevice('expired-session'), PASSWORD);
    // The schema CHECK pins expires_at > created_at (absolute lifetime is
    // structural) — shift BOTH instants into the past (admin/fixture seeding).
    await db.pool.query(
      "UPDATE sessions SET created_at = now() - interval '40 days', expires_at = now() - interval '10 days' WHERE id = $1",
      [pair.session.id],
    );
    const refresh = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer(pair.refreshToken)).send();
    expect(refresh.status).toBe(401);
    const unknown = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer('unknown-opaque')).send();
    expectRawIdentical(refresh, unknown, 'expired-session refresh vs unknown refresh');
  });

  it('recovery ⇒ EVERY prior token is dead within the frozen window; the fresh pair works; the list shows exactly the new session', async () => {
    const identifier = 's4-axis-b@example.com';
    const sessionA = await signinPair(app, identifier, freshDevice('recovery-kill-a'), PASSWORD);
    const sessionB = await signinPair(app, 's4_axis_b', freshDevice('recovery-kill-b'), PASSWORD); // second device, SAME account

    const ticket = await issueTicketViaSink(app, identifier, freshDevice('recovery-kill-req'));
    const completion = await recoveryComplete(app, ticket, 's4-the-recovery-password');
    expect(completion.status).toBe(200);
    const fresh = completion.body as TokenPair;

    const deadReference = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer('garbage-token'));
    for (const [label, token] of [
      ['A access', sessionA.accessToken],
      ['B access', sessionB.accessToken],
    ] as const) {
      const probe = await pin(request(app.getHttpServer()).get('/identity/me')).set(bearer(token));
      expect(probe.status, label).toBe(401);
      expectRawIdentical(probe, deadReference, `recovery-killed ${label}`);
    }
    for (const [label, token] of [
      ['A refresh', sessionA.refreshToken],
      ['B refresh', sessionB.refreshToken],
    ] as const) {
      const probe = await pin(request(app.getHttpServer()).post('/identity/token/refresh')).set(bearer(token)).send();
      expect(probe.status, label).toBe(401);
    }

    expect((await request(app.getHttpServer()).get('/identity/me').set(bearer(fresh.accessToken))).status).toBe(200);
    const list = await request(app.getHttpServer()).get('/identity/sessions').set(bearer(fresh.accessToken));
    const page = list.body as { data: { id: string }[]; nextCursor: string | null };
    expect(page.data.length).toBe(1);
    expect(page.data[0]?.id).toBe(fresh.session.id);
  });
});

/** Suite-side JWT payload decode (assertion tooling only — clients never parse tokens). */
function decodeJwtPayload(token: string): unknown {
  const parts = token.split('.');
  expect(parts.length).toBe(3);
  return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
}
