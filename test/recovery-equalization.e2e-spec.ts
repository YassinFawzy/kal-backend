/**
 * Recovery issuance-mirror e2e — F-S4-1b fix lane (w02-eq-fix).
 *
 * The real AppModule against a real, fully-migrated, EPHEMERAL PostgreSQL
 * database (the `kal_it_*` harness pattern; the dev database is never
 * touched). This suite owns the F-S4-1b fix verification ONLY — the general
 * recovery semantics remain owned by test/recovery.e2e-spec.ts (s2b) and the
 * adversarial/timing strengthening is s4's; those files are not touched here.
 *
 * Covered required cases (supervisor-directed fix task, frozen contract §3
 * "Recovery request, unknown identifier … byte-identical … equalized work"):
 *
 *   - Byte-identity of the response preserved on BOTH paths (raw bytes) —
 *     the mirror must never change the observable.
 *   - Zero per-request row growth on unknown requests: recovery_tickets,
 *     users, and audit_events counts are stable across N unknown requests
 *     after pool warmup (the mirror appends no audit event and creates no
 *     rows — it re-stamps one pool row it already owns).
 *   - Sentinel/pool idempotency across multiple app boots: the same
 *     deployment state converges on ONE sentinel user and EXACTLY K = 256
 *     pool rows — deterministically derived ids + ON CONFLICT DO NOTHING,
 *     no duplicate pools (the production note: raw INSERT, never
 *     create()+catch(P2002), so no duplicate-key log noise per boot).
 *   - Pool tickets are uncompletable and unenumerable: born consumed, random
 *     never-revealed 64-hex digests; presenting a pool id with a guessed
 *     secret collapses into the ONE generic 401, byte-identical (modulo the
 *     correlation id) to any other ticket failure.
 *   - Username-squatter immunity: an ACTIVE account holding the canonical
 *     `kal_eq_sentinel` username is NEVER picked — eligibility is guarded by
 *     status = 'closed' AND password IS NULL, and the resolver falls
 *     back to a randomized name, reused idempotently across re-boots.
 *   - Compact timing sanity: interleaved medians of known vs unknown
 *     recovery requests, asserting the delta within a GENEROUS ceiling set
 *     from this lane's own measured margins (the s4 adversarial lane
 *     re-measures with its stricter methodology afterwards — deliberately
 *     not over-tightened here).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { DevMailAdapter } from '../src/identity/mail/dev-mail.adapter.js';
import { KAL_MAIL_PORT } from '../src/identity/mail/mail.port.js';
import {
  deriveEqualizerPoolRowId,
  EQUALIZER_POOL_SIZE,
  EQUALIZER_SENTINEL_FALLBACK_PREFIX,
  EQUALIZER_SENTINEL_USERNAME,
} from '../src/identity/recovery/recovery.service.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4equalizer4lane4fixed4key4material4with4enough4entropy';

const USER_SAMI = { email: ['sami', 'example.com'].join('@'), phone: '+201200000001', username: 'sami' };

interface SentinelSnapshot {
  id: string;
  username: string;
  poolIds: string[];
}

let app: INestApplication<App>;
let db: EphemeralKalDb;
let databaseUrl: string;

type ProviderOverride = { provide: symbol | (new (...args: never[]) => unknown); useValue: unknown };

/** The recovery.e2e-spec boot pattern, self-contained for this lane's two suites. */
async function bootApp(env: Record<string, string>, overrides: readonly ProviderOverride[] = []): Promise<INestApplication<App>> {
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
    // Configuration is captured at module construction (I15) — restore the
    // process environment for the rest of the suite.
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key] as string;
      }
    }
  }
}

function mailSink(application: INestApplication<App>): DevMailAdapter {
  return application.get<DevMailAdapter>(KAL_MAIL_PORT);
}

function signup(application: INestApplication<App>, user: { email: string; phone: string; username: string }): request.Test {
  return request(application.getHttpServer()).post('/identity/signup').send({ ...user, password: 'equalizer-e2e-password' });
}

function requestRecovery(application: INestApplication<App>, identifier: string, deviceId = 'equalizer-device'): request.Test {
  return request(application.getHttpServer()).post('/identity/recovery/request').set('X-Device-Id', deviceId).send({ identifier });
}

function completeRecovery(application: INestApplication<App>, ticket: string): request.Test {
  return request(application.getHttpServer()).post('/identity/recovery/complete').set('Authorization', `Bearer ${ticket}`).send({ newPassword: 'rotated-e2e-password' });
}

/** Deletes the per-response correlation id so two bodies compare byte-level. */
function withoutRequestId(body: Record<string, unknown>): string {
  const clone = { ...body };
  delete clone['requestId'];
  return JSON.stringify(clone);
}

/** The one closed + credential-less sentinel row and its EXACT pool composition. */
async function sentinelSnapshot(): Promise<SentinelSnapshot> {
  const sentinels = await adminQuery(
    db,
    "SELECT id, username FROM users WHERE status = 'closed' AND password IS NULL ORDER BY created_at",
  );
  expect(sentinels.rowCount).toBe(1);
  const row = sentinels.rows[0] as { id: string; username: string };
  const pool = await adminQuery(
    db,
    'SELECT id, token_hash, consumed_at, created_at, expires_at FROM recovery_tickets WHERE user_id = $1',
    [row.id],
  );
  expect(pool.rowCount).toBe(EQUALIZER_POOL_SIZE);
  const derived = Array.from({ length: EQUALIZER_POOL_SIZE }, (_unused, index) => deriveEqualizerPoolRowId(row.id, index));
  const observed = pool.rows.map((entry) => (entry as { id: string }).id).sort();
  expect(observed).toEqual([...derived].sort()); // deterministic ids — ON CONFLICT DO NOTHING kept the originals
  for (const entry of pool.rows as unknown as { token_hash: string; consumed_at: Date; created_at: Date; expires_at: Date }[]) {
    expect(entry.token_hash).toMatch(/^[0-9a-f]{64}$/u); // random never-revealed digest shape
    expect(entry.consumed_at).not.toBeNull(); // born consumed — uncompletable
    expect(entry.expires_at.getTime()).toBeGreaterThan(entry.created_at.getTime()); // CHECK-shaped
  }
  return { id: row.id, username: row.username, poolIds: observed };
}

/** Table counts for the growth assertion (users / recovery_tickets / audit_events). */
async function tableCounts(): Promise<{ users: number; tickets: number; audits: number }> {
  const result = await adminQuery(
    db,
    'SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM recovery_tickets) AS tickets, (SELECT COUNT(*)::int FROM audit_events) AS audits',
  );
  const row = result.rows[0] as { users: number; tickets: number; audits: number };
  return { users: row.users, tickets: row.tickets, audits: row.audits };
}

async function dropApp(): Promise<void> {
  await app?.close();
  await db?.drop();
}

// ---------------------------------------------------------------------------

describe('recovery issuance mirror — F-S4-1b (clean deployment, canonical sentinel)', () => {
  beforeAll(async () => {
    db = await createEphemeralKalDb('eqfix');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    databaseUrl = url.toString();
    app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test', // W3 F-S4-1: this suite measures the 200-path timing envelope — the recovery-request
       // throttle is orthogonal here and its default threshold would trip mid-measurement.
IDENTITY_RECOVERY_REQUEST_THRESHOLD: '100' });
  }, 180_000);

  afterAll(async () => {
    await dropApp();
  }, 60_000);

  it('unknown and known identifiers return byte-identical raw bodies (§3) — the mirror preserves the observable', async () => {
    await signup(app, USER_SAMI);
    const sinkBefore = mailSink(app).records.length;

    const known = await requestRecovery(app, USER_SAMI.email, 'byte-identity-known');
    const unknown = await requestRecovery(app, 'no-such-identifier@example.com', 'byte-identity-unknown');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    // Raw bytes: the exact accepted literal on BOTH paths, byte-for-byte equal.
    const expectedBody = '{"status":"accepted"}';
    expect(Buffer.from(known.text, 'utf8').equals(Buffer.from(expectedBody, 'utf8'))).toBe(true);
    expect(Buffer.from(unknown.text, 'utf8').equals(Buffer.from(expectedBody, 'utf8'))).toBe(true);
    expect(known.headers['content-type']).toBe(unknown.headers['content-type']);
    // No mail on the unknown path — the mirror issues no deliverable secret.
    expect(mailSink(app).records.length).toBe(sinkBefore + 1);
  });

  it('unknown requests add ZERO rows: recovery_tickets, users, and audit_events are all stable after warmup', async () => {
    await requestRecovery(app, 'warmup-unknown@example.com', 'growth-warmup'); // pool warmup (first request per process)
    const before = await tableCounts();
    const auditsBefore = await adminQuery(
      db,
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE action LIKE 'identity.recovery%'",
    );

    const unknowns = 25;
    for (let index = 0; index < unknowns; index++) {
      const response = await requestRecovery(app, `unknown-${index}@example.com`, `growth-device-${index}`);
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"status":"accepted"}');
    }

    const after = await tableCounts();
    expect(after.users).toBe(before.users); // no sentinel duplicates, no per-request users
    expect(after.tickets).toBe(before.tickets); // pool re-stamps one existing row — never grows
    expect(after.audits).toBe(before.audits); // no audit events on the mirror path
    const auditsAfter = await adminQuery(
      db,
      "SELECT COUNT(*)::int AS count FROM audit_events WHERE action LIKE 'identity.recovery%'",
    );
    expect((auditsAfter.rows[0] as { count: number }).count).toBe((auditsBefore.rows[0] as { count: number }).count);
  });

  it('sentinel pool composition: exactly one closed credential-less sentinel and K born-consumed derived-id rows', async () => {
    const snapshot = await sentinelSnapshot();
    expect(snapshot.username).toBe(EQUALIZER_SENTINEL_USERNAME); // clean deployment → canonical name

    const sentinels = await adminQuery(
      db,
      "SELECT COUNT(*)::int AS count FROM users WHERE username = $1 OR username LIKE $2",
      [EQUALIZER_SENTINEL_USERNAME, `${EQUALIZER_SENTINEL_FALLBACK_PREFIX}%`],
    );
    expect((sentinels.rows[0] as { count: number }).count).toBe(1); // ONE sentinel — no namespace litter
  });

  it('a pool ticket id presented for completion collapses into the ONE generic 401 (uncompletable, unenumerable)', async () => {
    const snapshot = await sentinelSnapshot();
    // Forge a well-formed ticket bearing a REAL pool id and a guessed secret.
    const poolId = snapshot.poolIds[0];
    const forged = Buffer.concat([
      Buffer.from(poolId.replace(/-/gu, ''), 'hex'),
      randomBytes(32),
    ]).toString('base64url');
    const forgedAttempt = await completeRecovery(app, forged);
    // Control: a ticket id that does not exist at all.
    const unknownAttempt = await completeRecovery(app, Buffer.concat([Buffer.from(randomBytes(16)), Buffer.from(randomBytes(32))]).toString('base64url'));

    expect(forgedAttempt.status).toBe(401);
    expect(unknownAttempt.status).toBe(401);
    expect(withoutRequestId(forgedAttempt.body as Record<string, unknown>)).toBe(withoutRequestId(unknownAttempt.body as Record<string, unknown>));
    // The forged attempt consumed nothing and grew nothing.
    expect((await sentinelSnapshot()).poolIds).toEqual(snapshot.poolIds);
  });

  it('sentinel/pool idempotent across app re-boots: same deployment state, ONE sentinel, no duplicate pools', async () => {
    const first = await sentinelSnapshot();

    for (let boot = 2; boot <= 3; boot++) {
      await app.close();
      app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test', // W3 F-S4-1: this suite measures the 200-path timing envelope — the recovery-request
       // throttle is orthogonal here and its default threshold would trip mid-measurement.
IDENTITY_RECOVERY_REQUEST_THRESHOLD: '100' });
      // Each boot is a fresh DI container — a fresh lazy bootstrap runs here.
      const response = await requestRecovery(app, `post-boot-${boot}@example.com`, `reboot-device-${boot}`);
      expect(response.status).toBe(200);

      const next = await sentinelSnapshot();
      expect(next.id).toBe(first.id); // same sentinel row re-recognized
      expect(next.username).toBe(first.username);
      expect(next.poolIds).toEqual(first.poolIds); // EXACTLY K rows — determinism + ON CONFLICT DO NOTHING
    }
  });

  it('timing sanity: interleaved medians of known vs unknown sit inside the measured-equalized envelope', async () => {
    // Warmup — first-request bootstrap, connection pooling, JIT'd code paths.
    for (let index = 0; index < 6; index++) {
      await requestRecovery(app, USER_SAMI.email, 'timing-warmup-known');
      await requestRecovery(app, `timing-warmup-${index}@example.com`, 'timing-warmup-unknown');
    }

    const knownMs: number[] = [];
    const unknownMs: number[] = [];
    const pairs = 40;
    for (let index = 0; index < pairs; index++) {
      // Alternate the within-pair order so systematic drift cannot bias one side.
      const firstIsKnown = index % 2 === 0;
      const first = firstIsKnown ? USER_SAMI.email : `timing-unknown-${index}@example.com`;
      const second = firstIsKnown ? `timing-unknown-${index}@example.com` : USER_SAMI.email;
      const firstStarted = process.hrtime.bigint();
      const firstResponse = await requestRecovery(app, first, 'timing-device-first');
      const firstElapsed = Number(process.hrtime.bigint() - firstStarted) / 1e6;
      const secondStarted = process.hrtime.bigint();
      const secondResponse = await requestRecovery(app, second, 'timing-device-second');
      const secondElapsed = Number(process.hrtime.bigint() - secondStarted) / 1e6;
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      (firstIsKnown ? knownMs : unknownMs).push(firstElapsed);
      (!firstIsKnown ? knownMs : unknownMs).push(secondElapsed);
    }

    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const knownMedian = median(knownMs);
    const unknownMedian = median(unknownMs);
    const ratio = unknownMedian / knownMedian;
    // Evidence for the MR (measured on this machine; s4 re-measures strictly).
    console.log(`[eqfix-timing] known median ${knownMedian.toFixed(3)} ms, unknown median ${unknownMedian.toFixed(3)} ms, ratio ${ratio.toFixed(3)} (n=${pairs} interleaved pairs)`);

    // GENEROUS envelope from this lane's own margins — the mirror pays the
    // same INSERT shape + a committed 1-row UPDATE + the real COMMIT WAL
    // flush, so unknown sits at-or-near known; the ceiling tolerates machine
    // noise and the known path's extra audit INSERT + mail seam. The s4 lane
    // re-asserts with its stricter methodology afterwards.
    expect(unknownMedian).toBeGreaterThanOrEqual(knownMedian * 0.5); // not a REVERSE oracle either
    expect(unknownMedian).toBeLessThanOrEqual(knownMedian * 2.0);
    expect(Math.abs(unknownMedian - knownMedian)).toBeLessThanOrEqual(15); // absolute ms headroom for scheduler noise
  }, 120_000);
});

describe('issuance-mirror sentinel — username-squatter immunity (fallback resolution)', () => {
  beforeAll(async () => {
    db = await createEphemeralKalDb('eqsquat');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    databaseUrl = url.toString();
    app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test', // W3 F-S4-1: this suite measures the 200-path timing envelope — the recovery-request
       // throttle is orthogonal here and its default threshold would trip mid-measurement.
IDENTITY_RECOVERY_REQUEST_THRESHOLD: '100' });
  }, 180_000);

  afterAll(async () => {
    await dropApp();
  }, 60_000);

  it('an ACTIVE squatter holding the canonical name is NEVER picked; a randomized fallback sentinel is created instead', async () => {
    // The squatter: a perfectly ordinary ACTIVE account holding the canonical sentinel username.
    const squatter = { email: ['kal-eq-sentinel', 'example.com'].join('@'), phone: '+201200000999', username: EQUALIZER_SENTINEL_USERNAME };
    const signupResponse = await signup(app, squatter);
    expect(signupResponse.status).toBe(200);

    // Bootstrap runs on the first unknown-identifier request.
    const response = await requestRecovery(app, 'squatter-probe@example.com', 'squatter-device');
    expect(response.status).toBe(200);
    expect(response.text).toBe('{"status":"accepted"}');

    // The squatter row is untouched by the mirror.
    const squatterRows = await adminQuery(
      db,
      'SELECT id, status, password FROM users WHERE username = $1',
      [EQUALIZER_SENTINEL_USERNAME],
    );
    expect(squatterRows.rowCount).toBe(1);
    const squatterRow = squatterRows.rows[0] as { id: string; status: string; password: string | null };
    expect(squatterRow.status).toBe('active'); // still active — eligibility guard refused it
    expect(squatterRow.password).not.toBeNull(); // still credentialed
    const squatterTickets = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = $1',
      [squatterRow.id],
    );
    expect((squatterTickets.rows[0] as { count: number }).count).toBe(0); // no pool under the squatter

    // The mirror's sentinel: exactly one closed + credential-less user, in the fallback namespace.
    const sentinels = await adminQuery(
      db,
      "SELECT id, username FROM users WHERE status = 'closed' AND password IS NULL",
    );
    expect(sentinels.rowCount).toBe(1);
    const sentinelRow = sentinels.rows[0] as { id: string; username: string };
    expect(sentinelRow.id).not.toBe(squatterRow.id);
    expect(sentinelRow.username).toMatch(/^kal_eq_sentinel_[0-9a-f]{12}$/u); // randomized fallback shape
    expect(sentinelRow.username).not.toBe(EQUALIZER_SENTINEL_USERNAME);

    // …with its full bounded pool.
    const pool = await adminQuery(
      db,
      'SELECT COUNT(*)::int AS count FROM recovery_tickets WHERE user_id = $1',
      [sentinelRow.id],
    );
    expect((pool.rows[0] as { count: number }).count).toBe(EQUALIZER_POOL_SIZE);
  });

  it('the fallback sentinel is REUSED across a re-boot (idempotent — never one sentinel per boot)', async () => {
    const before = await sentinelSnapshot();
    expect(before.username).toMatch(/^kal_eq_sentinel_[0-9a-f]{12}$/u);

    await app.close();
    app = await bootApp({ DATABASE_URL: databaseUrl, IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test', // W3 F-S4-1: this suite measures the 200-path timing envelope — the recovery-request
       // throttle is orthogonal here and its default threshold would trip mid-measurement.
IDENTITY_RECOVERY_REQUEST_THRESHOLD: '100' });
    const response = await requestRecovery(app, 'post-squatter-boot@example.com', 'squatter-reboot-device');
    expect(response.status).toBe(200);

    const after = await sentinelSnapshot();
    expect(after.id).toBe(before.id); // re-recognized, not re-minted
    expect(after.poolIds).toEqual(before.poolIds); // pool unchanged — exactly K rows
  });
});
