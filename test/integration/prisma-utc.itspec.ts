/**
 * F-W2-1 behavioral regression (G2 carryover, required case: "timestamptz
 * round-trip exact on this +03 cluster — mirror the G2 tz-probe method").
 *
 * The G2 empirical finding: `@prisma/adapter-pg` parses timestamptz with its
 * own text parser, which REWRITES the trailing offset to `+00:00` without
 * converting wall-clock time — so on a session whose TimeZone is not UTC,
 * every read through Prisma came back shifted (+3 h on this dev cluster,
 * whose default zone is Africa/Cairo). Identity worked around it with
 * per-transaction `set_config('TimeZone', 'UTC', true)` pins; the systemic
 * fix (this wave) pins `-c timezone=UTC` as a POOL startup option in
 * `PrismaService`, so EVERY pooled connection renders timestamptz as UTC and
 * the adapter's rewrite is a no-op.
 *
 * Method (mirrors the G2 tz-probe — every claim has a detectability control):
 *   1. Control: a deliberately SHIFTED session really renders +03 — the
 *      probe can detect the hazard (a probe that cannot fail proves nothing).
 *   2. Mechanism: a pooled connection from PrismaService's pool reports
 *      `current_setting('TimeZone') === 'UTC'`.
 *   3. Round-trip: values written with explicit NON-UTC-offset instants
 *      surface through the Prisma client millisecond-exact — the sharp edge
 *      a shifted session would blunt.
 *   4. Adversarial: the same instants read through a deliberately shifted
 *      RAW session yield the +3 h signature (what the fix prevents), pinned
 *      as documentation-by-assertion of the hazard's mechanism.
 *
 * The suite runs against its own ephemeral database (`kal_it_*`, harness
 * pattern) whose default timezone is set to Africa/Cairo — reproducing the
 * cluster shape that exposed the finding.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/db/prisma.service.js';
import { READINESS_CHECKS } from '../../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './helpers/ephemeral-db.js';

let app: INestApplication;
let db: EphemeralKalDb;
let prisma: PrismaService;

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('prisma-utc');
    db.applyMigrations();
    // Reproduce the hazard cluster: non-UTC database default (the dev
    // cluster's own shape — Africa/Cairo, +03).
    await db.pool.query(`ALTER DATABASE ${JSON.stringify(db.name)} SET timezone TO 'Africa/Cairo'`);

    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    Object.assign(process.env, { DATABASE_URL: url.toString() });

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(READINESS_CHECKS)
      .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

describe('F-W2-1: timestamptz reads are UTC-correct at the adapter/pool level', () => {
  it('control: a deliberately shifted session really renders +03 (detectability)', async () => {
    const shifted = await db.connectIsolated();
    try {
      await shifted.query("SET TIME ZONE 'Africa/Cairo'");
      const rows = await shifted.query<{ rendered: string; zone: string }>(
        `SELECT ('2026-10-07T09:00:00.123Z'::timestamptz)::text AS rendered, current_setting('TimeZone') AS zone`,
      );
      expect(rows.rows[0]?.zone).toBe('Africa/Cairo');
      // 09:00Z renders as 12:00+03 — the shifted rendering exists to detect.
      expect(rows.rows[0]?.rendered).toBe('2026-10-07 12:00:00.123+03');
    } finally {
      await shifted.end();
    }
  });

  it('mechanism: PrismaService pool connections run with session TimeZone UTC', async () => {
    const rows = (await prisma.client.$queryRaw<{ zone: string }[]>`SELECT current_setting('TimeZone') AS zone`) as {
      zone: string;
    }[];
    expect(rows[0]?.zone).toBe('UTC');
  });

  it('round-trip: explicit non-UTC-offset instants written and read through the client are millisecond-exact', async () => {
    // Crafted +03:00 / +02:00 literals (the G2 probe shape) — instants that
    // only round-trip when parsing honors the offset instead of dropping it.
    const instants = [
      { stored: '2026-10-07T12:00:00.123+03:00', expected: '2026-10-07T09:00:00.123Z' },
      { stored: '2026-10-07T12:00:00.123+02:00', expected: '2026-10-07T10:00:00.123Z' },
      { stored: '2026-10-07T09:00:00.123Z', expected: '2026-10-07T09:00:00.123Z' },
      { stored: '2026-10-07T00:30:00.000+03:00', expected: '2026-10-06T21:30:00.000Z' },
    ];
    for (const [index, instant] of instants.entries()) {
      const written = await prisma.client.$queryRaw<{ ts: Date }[]>`
        SELECT ${instant.stored}::timestamptz AS ts`;
      const throughAdapter = await prisma.client.$queryRaw<{ ts: Date }[]>`
        SELECT ${written[0]?.ts}::timestamptz AS ts`;
      expect(throughAdapter[0]?.ts.toISOString(), `instant #${index} round-trips exactly`).toBe(instant.expected);
    }
  });

  it('persistence: a session row written with a non-UTC-offset literal reads back the same instant through the client', async () => {
    const userId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    // A real user row (the sessions FK needs it), then a session whose
    // instants carry an explicit +03:00 offset — exactly the storage shape
    // the shifted-cluster finding blunted.
    await prisma.client.$executeRaw`
      INSERT INTO users (id, email, username, phone, password, status)
      VALUES (${userId}, ${'utc-probe@example.invalid'}, ${'utc_probe'}, NULL, NULL, 'active')`;
    await prisma.client.$executeRaw`
      INSERT INTO sessions (id, user_id, expires_at, refresh_token_hash, created_at)
      VALUES (
        gen_random_uuid(), ${userId},
        ('2026-11-07T12:00:00.123+03:00'::timestamptz),
        ${'b5d4045c5f00794f9b2c1c0d6040b47cac9232b5a3f4d95f0f8b5a1cd6e3c9f0'},
        ('2026-10-07T12:00:00.123+03:00'::timestamptz)
      )`;
    const rows = (await prisma.client.$queryRaw<{ created_at: Date; expires_at: Date }[]>`
      SELECT created_at, expires_at FROM sessions WHERE user_id = ${userId} ORDER BY created_at LIMIT 1`) as {
      created_at: Date;
      expires_at: Date;
    }[];
    expect(rows[0]?.created_at.toISOString()).toBe('2026-10-07T09:00:00.123Z');
    expect(rows[0]?.expires_at.toISOString()).toBe('2026-11-07T09:00:00.123Z');

    // Adversarial control (the hazard's mechanism, pinned): the SAME column
    // read through a deliberately +03-shifted RAW session renders +03, and a
    // naive offset-rewrite of that rendering would read 3 h late. The pool
    // pins prevent exactly this path for application reads.
    const shifted = await db.connectIsolated();
    try {
      await shifted.query("SET TIME ZONE 'Africa/Cairo'");
      const rendered = await shifted.query<{ rendered: string }>(
        `SELECT expires_at::text AS rendered FROM sessions WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
        [userId],
      );
      expect(rendered.rows[0]?.rendered).toBe('2026-11-07 11:00:00.123+02');
    } finally {
      await shifted.end();
    }
  });
});
