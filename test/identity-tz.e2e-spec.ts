/**
 * Kal identity TIMEZONE-pin probe e2e (wave-02, task s4-adversarial; ledger
 * F-W2-1) — runs the ENTIRE identity flow against an ephemeral database whose
 * cluster default timezone is deliberately NON-UTC (`Africa/Cairo`), proving
 * that every client-serialized timestamptz still round-trips the exact stored
 * instant. Any identity/recovery/auth database path that bypassed the
 * per-transaction `set_config('TimeZone', 'UTC', true)` pin would shift its
 * reads by the zone offset and fail these exact-equality assertions — that
 * failure is a FINDING (routed), never fixed in this lane.
 *
 * Probe design:
 *   - `ALTER DATABASE … SET timezone` is applied immediately after the
 *     scratch database is created, so every later connection (migration
 *     runner, Prisma/adapter-pg pool, this suite's own pool) inherits the
 *     non-UTC default.
 *   - Control 1 (SQL): a fixed timestamptz rendered as TEXT on such a session
 *     carries a non-zero offset — proving the probe can actually detect a
 *     bypass (a control that cannot fail proves nothing).
 *   - Control 2 (SQL): the UTC-pinned transaction form renders '+00' — the
 *     exact posture the application code must hold.
 *   - Exact round-trip: a session row inserted with explicit non-UTC-offset
 *     literals must surface through `GET /identity/sessions` as the SAME
 *     instants (millisecond-exact, `Z`-suffixed) — the sharp edge a timezone
 *     shift cannot survive.
 *   - Live flow: sign-in and recovery request under the non-UTC default —
 *     session `expiresAt` ≈ +30 days exactly, and the recovery ticket row's
 *     `expires_at` equals the mail-payload `expiresAt` to the millisecond
 *     (the s2b F-W2-1 regression guard, re-proven on a shifted cluster).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { DevMailAdapter } from '../src/identity/mail/dev-mail.adapter.js';
import { KAL_MAIL_PORT } from '../src/identity/mail/mail.port.js';
import { TokenService } from '../src/identity/token.service.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

const SIGNING_KEY = 's4e4tz5probe9lane4fixed4key4material4with4enough4entropy';
const PASSWORD = 's4-timezone-e2e-password';
const ACC_TZ = { email: 's4-tz-flow@example.com', phone: '+201900000001', username: 's4_tz_flow' };

let app: INestApplication<App>;
let db: EphemeralKalDb;

beforeAll(async () => {
  db = await createEphemeralKalDb('s4tz');
  // Shift the CLUSTER default for this scratch database BEFORE any other
  // connection (migration runner, Prisma pool) is opened against it.
  await db.pool.query(`ALTER DATABASE ${JSON.stringify(db.name)} SET timezone TO 'Africa/Cairo'`);
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;

  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' })) {
    previous[key] = process.env[key];
  }
  process.env['DATABASE_URL'] = url.toString();
  process.env['IDENTITY_JWT_SIGNING_KEY'] = SIGNING_KEY;
  process.env['NODE_ENV'] = 'test';
  try {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
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
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

describe('F-W2-1 probe: non-UTC cluster default, identity surfaces stay exact', () => {
  it('control 1: the cluster shift is real — a plain session renders a fixed instant with a non-zero offset (the probe can detect a bypass)', async () => {
    const shifted = await adminQuery<{ rendered: string; zone: string }>(
      db,
      `SELECT ('2026-10-07T09:00:00.123Z'::timestamptz)::text AS rendered, current_setting('TimeZone') AS zone`,
    );
    expect(shifted.rows[0]?.zone).toBe('Africa/Cairo');
    expect(shifted.rows[0]?.rendered).not.toMatch(/\+00(?:$|:)/u); // shifted away from UTC
    expect(shifted.rows[0]?.rendered).toMatch(/\+0[23]$/u); // Cairo is +02 standard / +03 DST
  });

  it('control 2: the UTC-pinned transaction form renders +00 — the posture every application path must hold', async () => {
    const client = await db.connectIsolated();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('TimeZone', 'UTC', true)`);
      const pinned = await client.query<{ rendered: string }>(
        `SELECT ('2026-10-07T09:00:00.123Z'::timestamptz)::text AS rendered`,
      );
      await client.query('ROLLBACK');
      expect(pinned.rows[0]?.rendered).toBe('2026-10-07 09:00:00.123+00');
    } finally {
      await client.end();
    }
  });

  it('exact round-trip: a session row stored with NON-UTC-offset literals surfaces through the API as the same instants, Z-suffixed, millisecond-exact', async () => {
    // Create the account through the API (the sanctioned path).
    const signup = await request(app.getHttpServer()).post('/identity/signup').send({ ...ACC_TZ, password: PASSWORD });
    expect(signup.status).toBe(200);
    const user = await adminQuery<{ id: string }>(db, 'SELECT id FROM users WHERE email = $1', [ACC_TZ.email]);
    const aId = (user.rows[0] as { id: string }).id;

    // Craft a session row whose instants carry explicit NON-UTC offsets.
    const sessionId = '77777777-7777-4777-8777-777777777777';
    await db.pool.query(
      `INSERT INTO sessions (id, user_id, device_label, created_at, expires_at, refresh_token_hash)
       VALUES ($1, $2, $3, '2026-10-07T09:00:00.123+02:00', '2026-11-06T12:34:56.789+03:00', $4)`,
      [sessionId, aId, 'tz-probe-device', '0'.repeat(64)], // digest-shaped fixture (never a live secret)
    );

    // Mint an access token for the crafted session with the app's own service
    // (the refresh digest is unused here — the probe exercises the access path).
    const tokens = app.get(TokenService);
    const access = await tokens.issueAccessToken(aId, sessionId, 900, new Date());

    const list = await request(app.getHttpServer())
      .get('/identity/sessions')
      .set('Authorization', `Bearer ${access.token}`);
    expect(list.status).toBe(200);
    const item = (list.body as { data: { id: string; createdAt: string; expiresAt: string }[] }).data.find(
      (entry) => entry.id === sessionId,
    );
    expect(item, 'the crafted session is listed').toBeDefined();
    // The stored instants — +02:00 and +03:00 literals — must surface as the
    // SAME instants in UTC. A path that read them through a shifted session
    // would be off by 2–3 hours here.
    expect(item?.createdAt).toBe('2026-10-07T07:00:00.123Z');
    expect(item?.expiresAt).toBe('2026-11-06T09:34:56.789Z');

    // Cross-check against the database read back through the pinned form.
    const row = await adminQuery<{ created_at: Date; expires_at: Date }>(
      db,
      'SELECT created_at, expires_at FROM sessions WHERE id = $1',
      [sessionId],
    );
    expect(row.rows[0]?.created_at.toISOString()).toBe('2026-10-07T07:00:00.123Z');
    expect(row.rows[0]?.expires_at.toISOString()).toBe('2026-11-06T09:34:56.789Z');
  });

  it('live flow under the shifted cluster: sign-in instants are Z-suffixed and exact (+30d session); the recovery ticket row equals the mail payload to the millisecond', async () => {
    const signin = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', 's4-tz-flow-device')
      .send({ identifier: ACC_TZ.email, password: PASSWORD });
    expect(signin.status).toBe(200);
    const pair = signin.body as { accessToken: string; session: { id: string; createdAt: string; expiresAt: string } };

    expect(pair.session.createdAt).toMatch(/Z$/u);
    expect(pair.session.expiresAt).toMatch(/Z$/u);
    const created = new Date(pair.session.createdAt).getTime();
    const expires = new Date(pair.session.expiresAt).getTime();
    // The frozen 30-day absolute lifetime. `expiresAt` is stamped from the
    // process clock while `createdAt` is the database's `now()` — the two
    // clocks legitimately differ by milliseconds of skew (the implementing
    // suites' established ±5 s bound; a TIMEZONE shift would be hours).
    expect(Math.abs(expires - created - 2_592_000_000)).toBeLessThanOrEqual(5_000);

    // The row agrees with the API to the millisecond (UTC-pinned read).
    const row = await adminQuery<{ created_at: Date; expires_at: Date }>(
      db,
      'SELECT created_at, expires_at FROM sessions WHERE id = $1',
      [pair.session.id],
    );
    expect(row.rows[0]?.created_at.toISOString()).toBe(pair.session.createdAt);
    expect(row.rows[0]?.expires_at.toISOString()).toBe(pair.session.expiresAt);

    // Recovery request: the ticket row's expiry equals the mail payload's —
    // exact-ms round-trip under the shifted cluster (the s2b F-W2-1 guard).
    const before = (app.get<DevMailAdapter>(KAL_MAIL_PORT)).records.length;
    const recovery = await request(app.getHttpServer())
      .post('/identity/recovery/request')
      .set('X-Device-Id', 's4-tz-recovery-device')
      .send({ identifier: ACC_TZ.email });
    expect(recovery.status).toBe(200);
    const record = (app.get<DevMailAdapter>(KAL_MAIL_PORT)).records[before] as
      | { recipient: string; ticket: { secret: string; expiresAt: Date } }
      | undefined;
    expect(record).toBeDefined();
    const ticketRow = await adminQuery<{ expires_at: Date }>(
      db,
      'SELECT expires_at FROM recovery_tickets WHERE token_hash = encode(sha256($1::bytea), \'hex\')',
      [Buffer.from(record?.ticket.secret ?? '', 'utf8')],
    );
    expect(ticketRow.rows[0]?.expires_at.getTime()).toBe(record?.ticket.expiresAt.getTime());
    expect(ticketRow.rows[0]?.expires_at.toISOString()).toMatch(/Z$|\+00:00$/u);
  });
});
