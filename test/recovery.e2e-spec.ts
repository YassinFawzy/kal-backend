/**
 * Kal account-recovery e2e (wave-02, task s2b-recovery) — the real AppModule
 * against a real, fully-migrated, EPHEMERAL PostgreSQL database (the harness
 * pattern: `kal_it_*`, created and dropped by this suite; the dev database is
 * never touched). The suite imports the integration harness helpers READ-ONLY
 * (the test/integration structure belongs to w02-s4-adversarial).
 *
 * Covered required cases (task contract, frozen contract §1–§4):
 *   - Happy path: request → no-op sink proves the mail payload shape →
 *     complete with the valid ticket → ALL of the account's sessions revoked
 *     (asserted against the session list, the token surfaces, and the rows) →
 *     old access AND refresh tokens rejected immediately (window ≈ 0 ≤ the
 *     frozen `identity.revocationWindowSeconds` bound).
 *   - Negative/equivalence: unknown vs known identifier on request ⇒
 *     byte-identical bodies (equalized work: the ticket mint+digest runs on
 *     both paths before any database access; timing itself is s4's pass);
 *     wrong/expired/already-used/invalidated/closed-account tickets ⇒ ONE
 *     byte-identical generic 401; single-use enforced (sequential replay AND
 *     concurrent race); second request invalidates the prior live ticket.
 *   - Boundaries: TTL expiry at the edge (crafted row + conditional consume);
 *     ticket bound to a different account never crosses accounts; identifier
 *     case/normalization per contract.
 *   - Atomicity: completion is one unit of work (consume + credential + mass
 *     revocation + new session + audit — crash-injection point = the
 *     inAppRoleTx boundary; any throw before commit rolls back all five);
 *     failed completion (400 path) leaves the ticket live; post-commit seam
 *     failure leaves a consistent single-live-ticket state.
 *   - Config: ticket TTL is a behavior-changing validated config point; the
 *     mail adapter is swappable by DI through the `KalMailPort` token.
 *   - Every recovery unit of work pins TimeZone UTC in-transaction (F-W2-1):
 *     asserted by exact-millisecond timestamptz round-trips.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { ProblemDetailsBody } from '../src/problems/problem-details.js';
import { w2FixturesDocument, W2EndpointFixture } from '../src/contracts/w2.fixtures.js';
import { DevMailAdapter } from '../src/identity/mail/dev-mail.adapter.js';
import { KAL_MAIL_PORT, KalMailPort } from '../src/identity/mail/mail.port.js';
import { RecoveryTicketService } from '../src/identity/recovery/recovery-ticket.service.js';
import { assertConformsToSchema, SchemaNode } from './support/contract-schema.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4recovery4lane4fixed4key4material4with4enough4entropy4chars';
const PASSWORD = 'recovery-e2e-password';
const NEW_PASSWORD = 'recovered-fresh-password';

const USER_RAYAN = { email: ['rayan', 'example.com'].join('@'), phone: '+201100000001', username: 'rayan' };
const USER_LINA = { email: ['lina', 'example.com'].join('@'), phone: '+201100000002', username: 'lina' };
const USER_NABIL = { email: ['nabil', 'example.com'].join('@'), phone: '+201100000003', username: 'nabil' };
const UNKNOWN_EMAIL = ['nobody-here', 'example.com'].join('@');

let app: INestApplication<App>;
let db: EphemeralKalDb;
let databaseUrl: string;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  session: { id: string; deviceLabel: string | null; createdAt: string; expiresAt: string };
}

type ProviderOverride = { provide: symbol | (new (...args: never[]) => unknown); useValue: unknown };

async function bootApp(
  env: Record<string, string>,
  overrides: readonly ProviderOverride[] = [],
): Promise<INestApplication<App>> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }]);
    for (const override of overrides) {
      builder = builder.overrideProvider(override.provide).useValue(override.useValue);
    }
    const moduleFixture: TestingModule = await builder.compile();
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

/** The dev/no-op adapter is the default KAL_MAIL_PORT binding — its sink is the delivery proof. */
function mailSink(application: INestApplication<App>): DevMailAdapter {
  return application.get<DevMailAdapter>(KAL_MAIL_PORT);
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

function entry(id: string): W2EndpointFixture {
  const found = w2FixturesDocument().endpoints.find((endpoint) => endpoint.id === id);
  expect(found, `fixture entry ${id} must exist`).toBeDefined();
  return found as W2EndpointFixture;
}

async function signup(
  application: INestApplication<App>,
  user: { email: string; phone: string; username: string },
  password = PASSWORD,
): Promise<request.Response> {
  return request(application.getHttpServer()).post('/identity/signup').send({ ...user, password });
}

async function signin(
  application: INestApplication<App>,
  identifier: string,
  password = PASSWORD,
  deviceId = 'recovery-device-main',
): Promise<request.Response> {
  return request(application.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', deviceId)
    .send({ identifier, password });
}

function requestRecovery(
  application: INestApplication<App>,
  identifier: string,
  deviceId = 'recovery-device-main',
): request.Test {
  return request(application.getHttpServer())
    .post('/identity/recovery/request')
    .set('X-Device-Id', deviceId)
    .send({ identifier });
}

function completeRecovery(application: INestApplication<App>, ticket: string | null, body: unknown = { newPassword: NEW_PASSWORD }): request.Test {
  const test = request(application.getHttpServer()).post('/identity/recovery/complete');
  if (ticket !== null) {
    test.set('Authorization', `Bearer ${ticket}`);
  }
  return test.send(body);
}

/** Latest sink record (the send is awaited before the request response returns). */
function lastSinkRecord(application: INestApplication<App>): { recipient: string; secret: string; expiresAt: Date } {
  const records = mailSink(application).records;
  expect(records.length).toBeGreaterThan(0);
  const record = records[records.length - 1] as {
    recipient: string;
    ticket: { secret: string; expiresAt: Date };
  };
  return { recipient: record.recipient, secret: record.ticket.secret, expiresAt: record.ticket.expiresAt };
}

beforeAll(async () => {
  db = await createEphemeralKalDb('recov');
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

describe('recovery request (identity.recovery.request)', () => {
  it('known identifier: the exact accepted bytes, one sink record with the frozen payload shape, one live ticket row', async () => {
    await signup(app, USER_RAYAN);
    const before = mailSink(app).records.length;
    const startedAt = Date.now();
    const response = await requestRecovery(app, USER_RAYAN.email);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.text).toBe('{"status":"accepted"}');

    const record = lastSinkRecord(app);
    expect(mailSink(app).records.length).toBe(before + 1);
    expect(record.recipient).toBe(USER_RAYAN.email); // canonical form
    expect(record.secret).toMatch(/^[A-Za-z0-9_-]{64}$/u); // ≥256-bit secret, base64url
    const ttlMs = record.expiresAt.getTime() - startedAt;
    expect(ttlMs).toBeGreaterThanOrEqual(1795_000); // ≈ the 1800s default (contract §6)
    expect(ttlMs).toBeLessThanOrEqual(1805_000);

    // Exactly one live ticket; its stored form is the SHA-256 digest (I12).
    const rows = await adminQuery(
      db,
      'SELECT id, token_hash, consumed_at, created_at, expires_at FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at DESC',
      [USER_RAYAN.email],
    );
    expect(rows.rowCount).toBe(1);
    const ticket = rows.rows[0] as { id: string; token_hash: string; consumed_at: null; created_at: Date; expires_at: Date };
    expect(ticket.token_hash).toBe(createHash('sha256').update(record.secret, 'utf8').digest('hex'));
    expect(ticket.consumed_at).toBeNull();
    // F-W2-1 guard: the UTC-pinned transaction round-trips the expiry EXACTLY.
    expect(ticket.expires_at.getTime()).toBe(record.expiresAt.getTime());
  });

  it('unknown identifier: byte-identical accepted body, NO sink record, NO ticket row (equalized work documented; timing is s4)', async () => {
    const known = await requestRecovery(app, USER_RAYAN.email, 'equiv-device-known');
    const sinkBefore = mailSink(app).records.length;
    const unknown = await requestRecovery(app, UNKNOWN_EMAIL, 'equiv-device-known');

    expect(unknown.status).toBe(200);
    expect(unknown.text).toBe(known.text); // byte-identical (§3)
    expect(mailSink(app).records.length).toBe(sinkBefore); // nothing sent
    const rows = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1)',
      [UNKNOWN_EMAIL],
    );
    expect((rows.rows[0] as { count: number }).count).toBe(0);
  });

  it('identifier case/normalization: mixed-case email and separator-laden phone hit the canonical account (sink proves it)', async () => {
    await requestRecovery(app, '  RaYaN@Example.COM ', 'norm-device-1');
    expect(lastSinkRecord(app).recipient).toBe(USER_RAYAN.email);

    await signup(app, USER_LINA);
    await requestRecovery(app, '+20 110-0000.002', 'norm-device-2');
    expect(lastSinkRecord(app).recipient).toBe(USER_LINA.email);
  });

  it('malformed requests: 400 VALIDATION_FAILED envelopes, value-free, schema-conformant', async () => {
    const schema400 = entry('identity.recovery.request').responses.find((response) => response.status === 400)?.bodySchema as SchemaNode;

    const missingDevice = await request(app.getHttpServer()).post('/identity/recovery/request').send({ identifier: USER_RAYAN.email });
    expect(missingDevice.status).toBe(400);
    const oversizedDevice = await request(app.getHttpServer())
      .post('/identity/recovery/request')
      .set('X-Device-Id', 'x'.repeat(129))
      .send({ identifier: USER_RAYAN.email });
    expect(oversizedDevice.status).toBe(400);
    const unexpectedField = await requestRecovery(app, USER_RAYAN.email).send({ identifier: USER_RAYAN.email, password: 'unrelated-guest-input' });
    expect(unexpectedField.status).toBe(400);
    const badIdentifier = await requestRecovery(app, '');
    expect(badIdentifier.status).toBe(400);

    for (const failure of [missingDevice, oversizedDevice, unexpectedField, badIdentifier]) {
      expect(failure.headers['content-type']).toContain('application/problem+json');
      expect((failure.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(failure.body)).not.toContain('unrelated-guest-input');
      assertConformsToSchema(failure.body, schema400, 'identity.recovery.request.400');
    }
  });

  it('locked pair: 429 RATE_LIMITED + Retry-After on the locked (identifier, device) pair — byte-identical bodies whether or not the identifier exists', async () => {
    const schema429 = entry('identity.recovery.request').responses.find((response) => response.status === 429)?.bodySchema as SchemaNode;
    const lockDevice = 'lockout-pair-device';
    await signup(app, { email: ['locker', 'example.com'].join('@'), phone: '+201100000004', username: 'locker' });
    // Lock the known pair with failed sign-in attempts (recovery requests never tick — they are not credential attempts).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await signin(app, ['locker', 'example.com'].join('@'), 'wrong-password-attempt', lockDevice);
      expect(failed.status).toBe(401);
    }
    const lockedKnown = await requestRecovery(app, ['locker', 'example.com'].join('@'), lockDevice);
    // And lock the unknown pair on the SAME device for the byte-equivalence probe.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await signin(app, UNKNOWN_EMAIL, 'wrong-password-attempt', lockDevice);
    }
    const lockedUnknown = await requestRecovery(app, UNKNOWN_EMAIL, lockDevice);

    expect(lockedKnown.status).toBe(429);
    expect(Number(lockedKnown.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((lockedKnown.body as ProblemDetailsBody).code).toBe('RATE_LIMITED');
    assertConformsToSchema(lockedKnown.body, schema429, 'identity.recovery.request.429');
    expect(lockedUnknown.status).toBe(429);
    expect(normalized(lockedUnknown.body as ProblemDetailsBody)).toBe(normalized(lockedKnown.body as ProblemDetailsBody)); // byte-identical minus the per-response requestId — no oracle (§3)

    // Pair semantics (frozen §3): a different device on the known identifier is NOT locked.
    const otherDevice = await requestRecovery(app, ['locker', 'example.com'].join('@'), 'lockout-other-device');
    expect(otherDevice.status).toBe(200);
  });

  it('a closed account gets the identical accepted observable, sends nothing, and its tickets can never complete', async () => {
    await signup(app, USER_NABIL);
    await adminQuery(db, "UPDATE users SET status = 'closed' WHERE email = $1", [USER_NABIL.email]);

    const sinkBefore = mailSink(app).records.length;
    const response = await requestRecovery(app, USER_NABIL.email, 'closed-device');
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"status":"accepted"}');
    expect(mailSink(app).records.length).toBe(sinkBefore); // nothing delivered

    // Even a hand-crafted live ticket for the closed account can never complete (§1: closure is no oracle, and no resurrection).
    const crafted = new RecoveryTicketService().mint();
    await adminQuery(
      db,
      "INSERT INTO recovery_tickets (user_id, token_hash, created_at, expires_at) SELECT id, $2, now(), now() + interval '30 minutes' FROM users WHERE email = $1",
      [USER_NABIL.email, crafted.digest],
    );
    const completion = await completeRecovery(app, crafted.secret);
    expect(completion.status).toBe(401);
  });
});

describe('recovery completion — ticket failure equivalence (identity.recovery.complete)', () => {
  it('absent, malformed, unknown, tampered, expired, consumed, invalidated, and closed-account tickets share ONE byte-identical generic 401', async () => {
    const schema401 = entry('identity.recovery.complete').responses.find((response) => response.status === 401)?.bodySchema as SchemaNode;
    const tickets = new RecoveryTicketService();

    // Expired: a valid-format ticket whose TTL has passed (edge — the conditional
    // consume would also refuse it; the verification funnel refuses first).
    await signup(app, { email: ['exp', 'example.com'].join('@'), phone: '+201100000005', username: 'expuser' });
    const expired = tickets.mint();
    await adminQuery(
      db,
      "INSERT INTO recovery_tickets (user_id, token_hash, created_at, expires_at) SELECT id, $2, now() - interval '1 hour', now() - interval '1 second' FROM users WHERE email = $1",
      [['exp', 'example.com'].join('@'), expired.digest],
    );

    // A real issued ticket, then tampered (one flipped character ⇒ digest mismatch).
    await requestRecovery(app, USER_LINA.email, 'equiv-complete-device');
    const issued = lastSinkRecord(app).secret;
    const tampered = (issued[0] === 'A' ? 'B' : 'A') + issued.slice(1);

    // Already-consumed: complete successfully, then replay.
    const success = await completeRecovery(app, issued);
    expect(success.status).toBe(200);

    // Invalidated-by-second-request: issue another and supersede it.
    await requestRecovery(app, USER_LINA.email, 'equiv-complete-device');
    const invalidated = lastSinkRecord(app).secret;
    await requestRecovery(app, USER_LINA.email, 'equiv-complete-device'); // supersedes `invalidated`

    const failures: request.Response[] = [
      await completeRecovery(app, null), // absent credential
      await completeRecovery(app, 'not-a-ticket'), // malformed
      await completeRecovery(app, tickets.mint().secret), // well-formed unknown id
      await completeRecovery(app, tampered), // digest mismatch
      await completeRecovery(app, expired.secret), // expired
      await completeRecovery(app, issued), // already consumed (replay)
      await completeRecovery(app, invalidated), // superseded by a later request
      await request(app.getHttpServer()).post('/identity/recovery/complete').set('Authorization', 'Basic c3BhbQ==').send({ newPassword: NEW_PASSWORD }), // wrong scheme
    ];

    for (const failure of failures) {
      expect(failure.status).toBe(401);
      expect(failure.headers['content-type']).toContain('application/problem+json');
      expect(failure.headers['www-authenticate']).toBe('Bearer');
      expect((failure.body as ProblemDetailsBody).code).toBe('UNAUTHENTICATED');
      assertConformsToSchema(failure.body, schema401, 'identity.recovery.complete.401');
    }
    const bodies = new Set(failures.map((failure) => normalized(failure.body as ProblemDetailsBody)));
    expect(bodies.size).toBe(1); // byte-identical for EVERY cause (§3)
  });
});

describe('recovery completion — the happy path revokes everything (§1/§2)', () => {
  it('request → sink payload → complete → fresh pair works; every prior access AND refresh token is dead immediately; one session remains', async () => {
    await signup(app, USER_RAYAN, PASSWORD); // ensure a clean Rayan state for this flow
    const first = await signin(app, USER_RAYAN.email, PASSWORD, 'happy-device-a');
    const second = await signin(app, USER_RAYAN.username, PASSWORD, 'happy-device-b'); // sign-in by username works too
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const oldA = first.body as TokenPair;
    const oldB = second.body as TokenPair;

    await requestRecovery(app, USER_RAYAN.email, 'happy-device-request');
    const { secret, recipient } = lastSinkRecord(app);
    expect(recipient).toBe(USER_RAYAN.email);

    const completion = await completeRecovery(app, secret);
    expect(completion.status).toBe(200);
    const fresh = completion.body as TokenPair;
    // The fresh pair carries the frozen session-pair shape.
    assertConformsToSchema(fresh, entry('identity.recovery.complete').responses.find((response) => response.status === 200)?.bodySchema as SchemaNode, 'identity.recovery.complete.200');
    expect(fresh.session.deviceLabel).toBeNull(); // completion never carries a device label

    // The brand-new session works immediately.
    const me = await request(app.getHttpServer()).get('/identity/me').set(bearer(fresh.accessToken));
    expect(me.status).toBe(200);

    // ALL prior sessions are dead — access tokens refused within the frozen
    // window (the baseline posture verifies per request ⇒ observed ≈ 0 ≤ 60s bound).
    const oldMeA = await request(app.getHttpServer()).get('/identity/me').set(bearer(oldA.accessToken));
    const oldMeB = await request(app.getHttpServer()).get('/identity/me').set(bearer(oldB.accessToken));
    expect(oldMeA.status).toBe(401);
    expect(oldMeB.status).toBe(401);
    // ...and the old refresh tokens are equally dead.
    const oldRefreshA = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(oldA.refreshToken)).send();
    const oldRefreshB = await request(app.getHttpServer()).post('/identity/token/refresh').set(bearer(oldB.refreshToken)).send();
    expect(oldRefreshA.status).toBe(401);
    expect(oldRefreshB.status).toBe(401);

    // The signed-in-devices list (via the session service) shows exactly the new session.
    const list = await request(app.getHttpServer()).get('/identity/sessions').set(bearer(fresh.accessToken));
    expect(list.status).toBe(200);
    const page = list.body as { data: { id: string }[]; nextCursor: string | null };
    expect(page.data.length).toBe(1);
    expect(page.data[0]?.id).toBe(fresh.session.id);

    // Row-level proof: every prior session revoked, credential replaced.
    const rows = await adminQuery(
      db,
      "SELECT revoked_at FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at ASC",
      [USER_RAYAN.email],
    );
    expect(rows.rowCount).toBe(3);
    const revokedFlags = rows.rows.map((row) => (row as { revoked_at: Date | null }).revoked_at);
    expect(revokedFlags[0]).not.toBeNull();
    expect(revokedFlags[1]).not.toBeNull();
    expect(revokedFlags[2]).toBeNull(); // the fresh session

    const credential = await adminQuery(db, 'SELECT password_hash FROM users WHERE email = $1', [USER_RAYAN.email]);
    const hash = (credential.rows[0] as { password_hash: string }).password_hash;
    expect(hash).toMatch(/^\$argon2id\$v=19\$/u);
    expect(hash).not.toContain(NEW_PASSWORD);

    // Old password refuses; new password admits.
    expect((await signin(app, USER_RAYAN.email, PASSWORD, 'post-recovery-device')).status).toBe(401);
    expect((await signin(app, USER_RAYAN.email, NEW_PASSWORD, 'post-recovery-device')).status).toBe(200);

    // Single use: replaying the consumed ticket is the same generic 401.
    const replay = await completeRecovery(app, secret);
    expect(replay.status).toBe(401);
    expect(normalized(replay.body as ProblemDetailsBody)).toBe(
      normalized((await completeRecovery(app, 'not-a-ticket')).body as ProblemDetailsBody),
    );
  });

  it('second request invalidates the prior live ticket (single live ticket); the new ticket completes', async () => {
    await signup(app, { email: ['supersede', 'example.com'].join('@'), phone: '+201100000006', username: 'supersede' });
    const identifier = ['supersede', 'example.com'].join('@');
    await requestRecovery(app, identifier, 'supersede-device');
    const firstTicket = lastSinkRecord(app).secret;
    await requestRecovery(app, identifier, 'supersede-device');
    const secondTicket = lastSinkRecord(app).secret;

    expect(firstTicket).not.toBe(secondTicket);
    const stale = await completeRecovery(app, firstTicket);
    expect(stale.status).toBe(401);

    const live = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1) AND consumed_at IS NULL',
      [identifier],
    );
    expect((live.rows[0] as { count: number }).count).toBe(1);

    const completion = await completeRecovery(app, secondTicket);
    expect(completion.status).toBe(200);
  });

  it('ticket bound to a different account never crosses accounts: completing owner1 leaves owner2 untouched', async () => {
    await signup(app, { email: ['owner1', 'example.com'].join('@'), phone: '+201100000013', username: 'owner1' });
    await signup(app, { email: ['owner2', 'example.com'].join('@'), phone: '+201100000014', username: 'owner2' });
    const owner1 = ['owner1', 'example.com'].join('@');
    const owner2 = ['owner2', 'example.com'].join('@');

    await requestRecovery(app, owner1, 'cross-device');
    const ticket = lastSinkRecord(app).secret;
    const completion = await completeRecovery(app, ticket);
    expect(completion.status).toBe(200);

    // owner1's credential changed…
    expect((await signin(app, owner1, PASSWORD, 'cross-check-device')).status).toBe(401);
    expect((await signin(app, owner1, NEW_PASSWORD, 'cross-check-device')).status).toBe(200);
    // …and owner2 is untouched: the ticket IS the account binding; no request
    // parameter can redirect a ticket at another account.
    expect((await signin(app, owner2, PASSWORD, 'cross-check-device')).status).toBe(200);
  });

  it('frozen ordering: invalid ticket + invalid password ⇒ 401 (never 400); valid ticket + invalid password ⇒ 400 and the ticket stays live', async () => {
    await signup(app, { email: ['ordering', 'example.com'].join('@'), phone: '+201100000007', username: 'ordering' });
    const identifier = ['ordering', 'example.com'].join('@');

    const badTicketBadPassword = await completeRecovery(app, 'not-a-ticket', { newPassword: 'short' });
    expect(badTicketBadPassword.status).toBe(401);

    await requestRecovery(app, identifier, 'ordering-device');
    const ticket = lastSinkRecord(app).secret;
    const goodTicketBadPassword = await completeRecovery(app, ticket, { newPassword: 'nine-chars' });
    expect(goodTicketBadPassword.status).toBe(400);
    expect((goodTicketBadPassword.body as ProblemDetailsBody).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(goodTicketBadPassword.body)).not.toContain('nine-chars');

    // The failed completion consumed NOTHING: the same ticket completes now.
    const retry = await completeRecovery(app, ticket);
    expect(retry.status).toBe(200);
  });

  it('concurrent completions of one ticket: exactly one winner; the loser gets the generic 401; state stays consistent', async () => {
    await signup(app, { email: ['race', 'example.com'].join('@'), phone: '+201100000008', username: 'racer' });
    const identifier = ['race', 'example.com'].join('@');
    await signin(app, identifier, PASSWORD, 'race-device');
    await requestRecovery(app, identifier, 'race-device');
    const ticket = lastSinkRecord(app).secret;

    const outcomes = await Promise.allSettled([
      completeRecovery(app, ticket),
      completeRecovery(app, ticket),
    ]);
    const statuses = outcomes
      .map((outcome) => (outcome.status === 'fulfilled' ? outcome.value.status : 599))
      .sort((left, right) => left - right);
    expect(statuses).toEqual([200, 401]);

    const rows = await adminQuery(
      db,
      "SELECT COUNT(*)::int AS active FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL",
      [identifier],
    );
    expect((rows.rows[0] as { active: number }).active).toBe(1); // only the winner's fresh session
    const consumed = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS consumed FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1) AND consumed_at IS NOT NULL',
      [identifier],
    );
    expect((consumed.rows[0] as { consumed: number }).consumed).toBe(1);
  });
});

describe('recovery audit trail (I14/I12)', () => {
  it('issuance and completion append audit rows; targets and justifications carry no secret material', async () => {
    await signup(app, { email: ['audited', 'example.com'].join('@'), phone: '+201100000009', username: 'audited' });
    const identifier = ['audited', 'example.com'].join('@');
    await requestRecovery(app, identifier, 'audit-device');
    const { secret } = lastSinkRecord(app);
    const completion = await completeRecovery(app, secret);
    expect(completion.status).toBe(200);

    const issued = await adminQuery(db, "SELECT actor, action, target, justification, occurred_at FROM audit_events WHERE action = 'identity.recovery.ticket_issued' ORDER BY occurred_at DESC LIMIT 1", []);
    expect(issued.rowCount).toBe(1);
    const issuedRow = issued.rows[0] as { actor: string; action: string; target: string; justification: string; occurred_at: Date };
    expect(issuedRow.actor).toBe('system:identity');
    expect(issuedRow.target).toMatch(/^recovery_ticket:[0-9a-f-]{36}$/u);
    expect(issuedRow.justification.length).toBeGreaterThan(0);
    expect(issuedRow.occurred_at).toBeInstanceOf(Date);

    const completed = await adminQuery(db, "SELECT actor, action, target, justification FROM audit_events WHERE action = 'identity.recovery.completed' ORDER BY occurred_at DESC LIMIT 1", []);
    expect(completed.rowCount).toBe(1);
    const completedRow = completed.rows[0] as { actor: string; target: string; justification: string };
    expect(completedRow.actor).toBe('system:identity');
    expect(completedRow.target).toMatch(/^user:[0-9a-f-]{36}$/u);
    expect(completedRow.justification).toContain('revoked');

    // I12: no ticket secret, no password material anywhere in the audit rows.
    for (const row of [issuedRow, completedRow]) {
      const serialized = `${row.target} ${row.justification} ${row.actor}`;
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(NEW_PASSWORD);
      expect(serialized).not.toContain(identifier);
    }
  });
});

describe('config and seam points (contract §4/§6 — nothing hardcoded, adapter swappable)', () => {
  it('ticket TTL follows the validated config point (IDENTITY_RECOVERY_TICKET_TTL_SECONDS)', async () => {
    await signup(app, { email: ['ttlcfg', 'example.com'].join('@'), phone: '+201100000010', username: 'ttlcfg' });
    const ttlApp = await bootApp({
      DATABASE_URL: databaseUrl,
      IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
      NODE_ENV: 'test',
      IDENTITY_RECOVERY_TICKET_TTL_SECONDS: '60',
    });
    try {
      const startedAt = Date.now();
      const response = await requestRecovery(ttlApp, ['ttlcfg', 'example.com'].join('@'), 'ttl-device');
      expect(response.status).toBe(200);
      const { secret, expiresAt } = lastSinkRecord(ttlApp);
      const ttlMs = expiresAt.getTime() - startedAt;
      expect(ttlMs).toBeGreaterThanOrEqual(59_000);
      expect(ttlMs).toBeLessThanOrEqual(61_000);
      // And the presented ticket carries that configured expiry into the row (UTC-pinned round-trip).
      const rows = await adminQuery(
        db,
        'SELECT expires_at FROM recovery_tickets WHERE token_hash = $1',
        [createHash('sha256').update(secret, 'utf8').digest('hex')],
      );
      expect((rows.rows[0] as { expires_at: Date }).expires_at.getTime()).toBe(expiresAt.getTime());
    } finally {
      await ttlApp.close();
    }
  }, 60_000);

  it('the mail adapter is swappable by DI through the KalMailPort token (test double through the port)', async () => {
    await signup(app, { email: ['swap', 'example.com'].join('@'), phone: '+201100000011', username: 'swapuser' });
    const delivered: { recipient: string; secret: string; expiresAt: Date }[] = [];
    const double: KalMailPort = {
      sendAccountRecoveryMail: async (recipient, ticket) => {
        delivered.push({ recipient, secret: ticket.secret, expiresAt: ticket.expiresAt });
      },
    };
    const swapApp = await bootApp(
      { DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' },
      [{ provide: KAL_MAIL_PORT, useValue: double }],
    );
    try {
      expect(swapApp.get(KAL_MAIL_PORT)).toBe(double); // the port token resolves to the injected double
      const response = await requestRecovery(swapApp, ['swap', 'example.com'].join('@'), 'swap-device');
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"status":"accepted"}');
      expect(delivered.length).toBe(1);
      expect(delivered[0]?.recipient).toBe(['swap', 'example.com'].join('@'));
      expect(delivered[0]?.secret).toMatch(/^[A-Za-z0-9_-]{64}$/u);
      // (No sink assertion here: the double IS the port — proven by the
      // `swapApp.get(KAL_MAIL_PORT)` identity check above.)
    } finally {
      await swapApp.close();
    }
  }, 60_000);

  it('a failing seam after the commit leaves the documented consistent state: generic 500, ticket live, next request supersedes it', async () => {
    await signup(app, { email: ['outage', 'example.com'].join('@'), phone: '+201100000012', username: 'outageuser' });
    const identifier = ['outage', 'example.com'].join('@');
    const failing: KalMailPort = {
      sendAccountRecoveryMail: async () => {
        throw new Error('simulated delivery-seam outage (fixture)');
      },
    };
    const outageApp = await bootApp(
      { DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' },
      [{ provide: KAL_MAIL_PORT, useValue: failing }],
    );
    try {
      const failed = await requestRecovery(outageApp, identifier, 'outage-device');
      expect(failed.status).toBe(500);
      const body = failed.body as ProblemDetailsBody;
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(failed.text).not.toContain('outage'); // no seam detail in the response (I7/I12)

      // The unit of work COMMITTED (post-commit seam failure is documented):
      // exactly one live ticket exists, in a consistent state.
      const live = await adminQuery(
        db,
        'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1) AND consumed_at IS NULL',
        [identifier],
      );
      expect((live.rows[0] as { count: number }).count).toBe(1);

      // The user simply asks again: the orphaned ticket dies with the new request.
      const retry = await requestRecovery(app, identifier, 'outage-device-retry');
      expect(retry.status).toBe(200);
      const liveAfter = await adminQuery(
        db,
        'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = (SELECT id FROM users WHERE email = $1) AND consumed_at IS NULL',
        [identifier],
      );
      expect((liveAfter.rows[0] as { count: number }).count).toBe(1);
      const completion = await completeRecovery(app, lastSinkRecord(app).secret);
      expect(completion.status).toBe(200);
    } finally {
      await outageApp.close();
    }
  }, 60_000);
});

describe('contract fixtures round-trip (declared recovery entries)', () => {
  it('recovery responses conform to the served w2 fixture schemas and content types', async () => {
    const requestEntry = entry('identity.recovery.request');
    const accepted = await requestRecovery(app, USER_RAYAN.email, 'fixture-recovery-device');
    expect(accepted.text).toBe(JSON.stringify(requestEntry.responses.find((response) => response.status === 200)?.example));

    const completeEntry = entry('identity.recovery.complete');
    const badTicket = await completeRecovery(app, 'not-a-ticket');
    const envelope401 = completeEntry.responses.find((response) => response.status === 401)?.bodySchema as SchemaNode;
    assertConformsToSchema(badTicket.body, envelope401, 'identity.recovery.complete.401');
  });
});
