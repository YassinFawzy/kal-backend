/**
 * Kal — day-boundary suite: the 23:59/00:01 criterion + carried-date
 * validation outcomes (s4b).
 *
 * Gate criterion (PRD §23.1 boundary): "a food logged at 23:59 and synced at
 * 00:01 belongs to the original local day" — structurally, because the
 * server stores the CARRIED `localDate` and never re-derives the day from
 * receive/sync time (wave-03 contract §1.1/§1.8). This suite pins:
 *
 *   - the criterion end-to-end (op logged at 23:59 local, its clientUpdatedAt
 *     and its server arrival both on the NEXT day → the entry stays on the
 *     original carried day: day read, rollups, feed, and DB column all agree);
 *   - the server NEVER re-derives: the same wall-clock instant carried on two
 *     different localDays lands on those two different days;
 *   - malformed/absent carried-date REJECTION per contract §1.2 (batch-shape,
 *     database-free, whole-batch 400): missing localDate on a diary op,
 *     non-calendar dates, short/long forms, localDate PRESENT on a non-diary
 *     op, envelope↔payload localDate mismatch — byte-identical 400s, nothing
 *     recorded;
 *   - the read surface's shape-only gate (byte-identical 400s for every
 *     malformed cause; generic 404 for a non-matching route; empty day = 200).
 *
 * Runs on `kal_it_s4bdyc_*` (ephemeral, dropped; standard UTC cluster).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';
import {
  SIGNING_KEY,
  fixtureUuid,
  pushOps,
  quickAddOp,
  readDay,
  signupAndSignin,
} from './dayboundary-support.js';
import type { Pool } from 'pg';

const FIXED_REQUEST_ID = 's4b-dayboundary-criterion-probe';

let app: INestApplication<App>;
let db: EphemeralKalDb;
let adminPool: Pool;
let token = '';
let userId = '';

async function bootApp(): Promise<void> {
  db = await createEphemeralKalDb('s4bdyc');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;

  const env: Record<string, string> = {
    DATABASE_URL: url.toString(),
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
  };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
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
  adminPool = db.pool;
}

beforeAll(async () => {
  await bootApp();
  const user = await signupAndSignin(app, 'crit', 'criterion-device');
  token = user.token;
  userId = user.userId;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

describe('s4b day-boundary: the 23:59/00:01 criterion (client-carried day is authoritative)', () => {
  it('23:59 log / 00:01 sync: clientUpdatedAt AND server arrival on the next day — the entry stays on the ORIGINAL carried day', async () => {
    const day = '2026-05-10';
    const nextDay = '2026-05-11';
    const entityId = fixtureUuid('00ec', 1);
    // Logged at 23:59 Cairo (21:59Z); the client-authored instant and the
    // server's receive time are both on the NEXT day.
    const push = await pushOps(
      app,
      token,
      'criterion-device',
      fixtureUuid('00ac', 1),
      [quickAddOp({ opId: fixtureUuid('000c', 1), entityId, clientUpdatedAt: `${nextDay}T00:01:00.000Z`, localDate: day }, 500)],
    );
    expect(push.status).toBe(200);
    expect((push.body as { results?: Array<{ outcome?: string }> }).results?.[0]?.outcome).toBe('applied');

    // Day read: the ORIGINAL day has the entry; the next day is EMPTY 200.
    const dayView = await readDay(app, token, day);
    expect(dayView.status).toBe(200);
    expect((dayView.body as { totals?: { entryCount?: number; energyKcal?: number } }).totals?.entryCount).toBe(1);
    expect((dayView.body as { totals?: { energyKcal?: number } }).totals?.energyKcal).toBeCloseTo(500, 6);
    const nextDayView = await readDay(app, token, nextDay);
    expect(nextDayView.status).toBe(200);
    expect((nextDayView.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(0);

    // DB truth: the stored local_date IS the carried value.
    const stored = await adminPool.query<{ local_date: string }>(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS local_date FROM diary_entries WHERE id::text = $1`,
      [entityId],
    );
    expect(stored.rows[0]?.local_date).toBe(day);

    // The delta feed serves it at the carried day's snapshot (payload echoes
    // the carried localDate), never re-dated.
    const feedBody = (await pullAll(token)).map((change) => (change.payload as { localDate?: string } | undefined)?.localDate);
    expect(feedBody).toContain(day);
    expect(feedBody).not.toContain(nextDay);
  }, 60_000);

  it('the server never re-derives: the SAME wall-clock instant carried on two different localDays lands on those two days', async () => {
    const instant = '2026-06-15T12:00:00.000Z'; // identical clientUpdatedAt for both ops
    const entityIdA = fixtureUuid('00ec', 2);
    const entityIdB = fixtureUuid('00ec', 3);
    const push = await pushOps(
      app,
      token,
      'criterion-device',
      fixtureUuid('00ac', 2),
      [
        quickAddOp({ opId: fixtureUuid('000c', 2), entityId: entityIdA, clientUpdatedAt: instant, localDate: '2026-06-14' }, 60),
        quickAddOp({ opId: fixtureUuid('000c', 3), entityId: entityIdB, clientUpdatedAt: instant, localDate: '2026-06-16' }, 70),
      ],
    );
    expect(push.status).toBe(200);
    const results = (push.body as { results?: Array<{ outcome?: string }> }).results ?? [];
    expect(results.map((result) => result.outcome)).toEqual(['applied', 'applied']);

    const dayBefore = await readDay(app, token, '2026-06-14');
    expect((dayBefore.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(1);
    const dayAfter = await readDay(app, token, '2026-06-16');
    expect((dayAfter.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(1);
    // The day the instant itself falls on holds NEITHER.
    const instantDay = await readDay(app, token, '2026-06-15');
    expect((instantDay.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(0);
  }, 60_000);

  it('malformed/absent carried dates are WHOLE-BATCH 400 VALIDATION_FAILED, byte-identical for every cause, with NOTHING recorded', async () => {
    const batchShapes: Array<{ readonly label: string; readonly op: object }> = [
      {
        label: 'missing localDate on a diary op',
        op: {
          opId: fixtureUuid('000c', 10),
          kind: 'diary_entry',
          entityId: fixtureUuid('00ec', 10),
          action: 'create',
          clientUpdatedAt: '2026-05-10T12:00:00.000Z',
          payload: { localDate: '2026-05-10', mealSlot: 'snack', entryMethod: 'quick_add', quantity: 1, energyKcal: 10, proteinG: 1, carbsG: 5, fatG: 2, status: 'confirmed' },
        },
      },
      { label: 'not-a-date', op: badDiaryCreate('not-a-date') },
      { label: 'impossible calendar date', op: badDiaryCreate('2026-02-30') },
      { label: 'short month form', op: badDiaryCreate('2026-1-15') },
      { label: 'compact form', op: badDiaryCreate('20260510') },
      { label: 'non-diary op carrying localDate', op: { opId: fixtureUuid('000c', 11), kind: 'user_food', entityId: fixtureUuid('00fc', 11), action: 'create', clientUpdatedAt: '2026-05-10T12:00:00.000Z', localDate: '2026-05-10', payload: { nameEn: 'Boundary food', energyKcal: 100, proteinG: 5, carbsG: 10, fatG: 3, servings: [{ labelEn: 'Serving', grams: 50 }] } } },
      { label: 'envelope↔payload localDate mismatch', op: { ...badDiaryCreate('2026-05-10'), payload: { localDate: '2026-05-11', mealSlot: 'snack', entryMethod: 'quick_add', quantity: 1, energyKcal: 10, proteinG: 1, carbsG: 5, fatG: 2, status: 'confirmed' } } },
    ];

    const reference = await pushOps(app, token, 'criterion-device', fixtureUuid('00ac', 10), [batchShapes[0]?.op ?? {}], FIXED_REQUEST_ID);
    expect(reference.status).toBe(400);

    const before = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sync_operations WHERE user_id = $1`, [userId]);

    for (const [index, shape] of batchShapes.entries()) {
      const result = await pushOps(app, token, 'criterion-device', fixtureUuid('00ac', 20 + index), [shape.op], FIXED_REQUEST_ID);
      expect(result.status, shape.label).toBe(400);
      // Byte-identical for every malformed cause (fixed X-Request-Id; I7/I12).
      expect(result.bodyText, shape.label).toBe(reference.bodyText);
    }

    const after = await adminPool.query<{ count: string }>(`SELECT count(*)::text AS count FROM sync_operations WHERE user_id = $1`, [userId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count); // nothing recorded for any rejected batch
    const diaryRows = await adminPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM diary_entries WHERE id::text LIKE '5bef0000-0000-4000-8000-00ec0000001%'`,
    );
    expect(diaryRows.rows[0]?.count).toBe('0');
  }, 60_000);

  it('read surface: shape-only gate — byte-identical 400 for every malformed cause (value-free), shape-valid dates give EMPTY 200', async () => {
    const malformed = ['not-a-date', '2026-02-30', '2026-1-15', '20260510'];
    const reference = await readDay(app, token, 'not-a-date');
    expect(reference.status).toBe(400);
    for (const candidate of malformed) {
      const result = await readDay(app, token, candidate);
      expect(result.status, candidate).toBe(400);
      expect(stripRequestId(result.bodyText), candidate).toBe(stripRequestId(reference.bodyText));
    }
    const leapValid = await readDay(app, token, '2024-02-29'); // shape-valid (calendar-valid leap day) → EMPTY 200
    expect(leapValid.status).toBe(200);
    expect((leapValid.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(0);
  }, 60_000);
});

function badDiaryCreate(localDate: string): object {
  return {
    opId: fixtureUuid('000c', 12),
    kind: 'diary_entry',
    entityId: fixtureUuid('00ec', 12),
    action: 'create',
    clientUpdatedAt: '2026-05-10T12:00:00.000Z',
    localDate,
    payload: { localDate, mealSlot: 'snack', entryMethod: 'quick_add', quantity: 1, energyKcal: 10, proteinG: 1, carbsG: 5, fatG: 2, status: 'confirmed' },
  };
}

function stripRequestId(bodyText: string): string {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const clone = { ...body };
    delete clone['requestId'];
    return JSON.stringify(clone);
  } catch {
    return bodyText;
  }
}

/** Cursor-echo pagination walker: collects every upsert payload's localDate. */
async function pullAll(bearer: string): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const query = new URLSearchParams({ limit: '50' });
    if (cursor !== null) {
      query.set('cursor', cursor);
    }
    const response = await request(app.getHttpServer()).get(`/sync/changes?${query.toString()}`).set('Authorization', `Bearer ${bearer}`);
    expect(response.status).toBe(200);
    const page = response.body as { changes?: Array<Record<string, unknown>>; nextCursor?: string | null };
    collected.push(...(page.changes ?? []));
    if (page.nextCursor === null || page.nextCursor === undefined) {
      return collected;
    }
    cursor = page.nextCursor;
  }
  throw new Error('feed did not drain');
}
