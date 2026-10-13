/**
 * Kal — wave-4 s4 adversarial: the LOCAL-DATE rule for `journal_session`
 * (additive day-boundary cells; the diary proof lives in the w3 suites —
 * this file ADDS the session-kind proof, it does not edit theirs).
 *
 * The frozen day rule (w3 §1.8 inherited by w4 §1.1): the CLIENT-LOCAL
 * session date is authoritative; the server NEVER re-derives the day from
 * receive/sync time; training-day marks key on the STORED date. Everything
 * Cairo-DST here is derived from IANA data through `Intl` at run time via
 * `dayboundary-support.ts` (never hardcoded instants).
 *
 * Cells: the 23:59-finished / next-day-stamped session keeps its carried
 * day; the same wall instant carried on two different days lands on each;
 * the clock-change window (spring-forward + fall-back instants, IANA-derived)
 * carries pre-transition days; marks follow the carried day; and the
 * load-bearing control proves a re-deriving server would misfile.
 */
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../../generated/prisma/client.ts';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { applyExerciseCatalogSeed } from '../../../prisma/seed-apply.js';
import {
  cairoLocalDate,
  cairoTransitionsInYear,
  SIGNING_KEY,
  fixtureUuid,
  pushOps,
  signupAndSignin,
} from './dayboundary-support.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';

const EX_SQUAT = '00000000-0000-4000-8000-00000000f201';
const DATA_YEAR = 2026; // the test-data year (instants are IANA-derived for this year at run time)

/** Hex fixture seeds (fixtureUuid splices them into the reserved 5bef range). */
const SEED = {
  c1: '4a6cb001',
  c2: '4a6cb002',
  c3: '4a6cb003',
  t0: '4a6bc010',
  t1: '4a6bc011',
  keys: '4a6bde00',
} as const;

let app: INestApplication<App>;
let db: EphemeralKalDb;
let token = '';
let userId = '';

function sessionOp(parts: { seed: string; localDate: string; clientUpdatedAt: string; title: string }): object {
  return {
    opId: fixtureUuid(parts.seed, 1),
    kind: 'journal_session',
    entityId: fixtureUuid(parts.seed, 2),
    action: 'create',
    clientUpdatedAt: parts.clientUpdatedAt,
    localDate: parts.localDate,
    payload: {
      localDate: parts.localDate,
      title: parts.title,
      exercises: [{ exerciseId: EX_SQUAT, position: 0, sets: [{ format: 'weighted', weightKg: 60, reps: 8 }] }],
    },
  };
}

function deleteOp(parts: { seed: string; entityId: string; clientUpdatedAt: string; localDate: string }): object {
  return {
    opId: fixtureUuid(parts.seed, 3),
    kind: 'journal_session',
    entityId: parts.entityId,
    action: 'delete',
    clientUpdatedAt: parts.clientUpdatedAt,
    localDate: parts.localDate,
  };
}

async function journalDayRead(localDate: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await request(app.getHttpServer()).get(`/journal/sessions/days/${localDate}`).set('Authorization', `Bearer ${token}`);
  return { status: result.status, body: result.body as Record<string, unknown> };
}

async function storedDays(): Promise<Map<string, string>> {
  const result = await adminQuery(db, `SELECT id::text AS id, local_date::text AS day FROM journal_sessions WHERE user_id = $1`, [userId]);
  return new Map((result.rows as { id: string; day: string }[]).map((row) => [row.id, row.day]));
}

async function marks(): Promise<string[]> {
  const result = await adminQuery(db, `SELECT local_date::text AS day FROM journal_training_days WHERE user_id = $1 ORDER BY local_date`, [userId]);
  return (result.rows as { day: string }[]).map((row) => row.day);
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return fixtureUuid(SEED.keys, keySeq);
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
  db = await createEphemeralKalDb('w4bdyj');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const seedClient = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url.toString(), max: 2 }), { disposeExternalPool: true }) });
  try {
    await applyExerciseCatalogSeed(seedClient);
  } finally {
    await seedClient.$disconnect();
  }
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });
  const user = await signupAndSignin(app, 'j4', 'primary');
  token = user.token;
  userId = user.userId;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ===========================================================================
// The 23:59/00:01 criterion for sessions
// ===========================================================================

describe('the local-date rule for journal_session (client-carried day is authoritative)', () => {
  it('a session finished 23:59 local and stamped 00:01 next-day local keeps its ORIGINAL carried day', async () => {
    const carriedDay = '2026-10-08';
    const nextDay = '2026-10-09';
    // Finish instant: 23:59 Cairo (+03) == 20:59Z on the carried day.
    const finishInstant = '2026-10-08T20:59:00.000Z';
    // The op substrate (client clock) rolled past local midnight: 00:01 on
    // the NEXT Cairo day == 21:01Z (still the carried UTC evening).
    const nextDayStamp = '2026-10-08T21:01:00.000Z';
    expect(cairoLocalDate(Date.parse(finishInstant))).toBe(carriedDay);
    expect(cairoLocalDate(Date.parse(nextDayStamp))).toBe(nextDay);

    const push = await pushOps(app, token, 'dayboundary-j4', nextKey(), [
      sessionOp({ seed: SEED.c1, localDate: carriedDay, clientUpdatedAt: nextDayStamp, title: 'late-night finish' }),
    ]);
    expect(push.status).toBe(200);
    expect(((push.body as { results: { outcome: string }[] }).results ?? []).map((result) => result.outcome)).toEqual(['applied']);

    // The journal day read: the session sits on the CARRIED day; the next
    // day is an empty 200.
    const carried = await journalDayRead(carriedDay);
    expect(carried.status).toBe(200);
    const ids = ((carried.body as { sessions: { id: string; localDate: string }[] }).sessions ?? []).map((row) => row.localDate);
    expect(ids).toEqual([carriedDay]);
    const next = await journalDayRead(nextDay);
    expect(next.status).toBe(200);
    expect((next.body as { sessions: unknown[] }).sessions).toEqual([]);

    // DB truth + the detail read agree.
    const stored = await storedDays();
    expect([...stored.values()]).toEqual([carriedDay]);
    expect(await marks()).toEqual([carriedDay]);
  });

  it('the SAME wall instant carried on two different local days lands on each — the server never re-derives', async () => {
    const sameInstant = '2026-10-09T21:30:00.000Z'; // 00:30 Cairo on 2026-10-10
    const dayA = '2026-10-09';
    const dayB = '2026-10-10';
    expect(cairoLocalDate(Date.parse(sameInstant))).toBe(dayB); // the "natural" day
    const push = await pushOps(app, token, 'dayboundary-j4', nextKey(), [
      sessionOp({ seed: SEED.c2, localDate: dayA, clientUpdatedAt: sameInstant, title: 'carried earlier' }),
      sessionOp({ seed: SEED.c3, localDate: dayB, clientUpdatedAt: sameInstant, title: 'carried naturally' }),
    ]);
    expect(push.status).toBe(200);
    expect(((push.body as { results: { outcome: string }[] }).results ?? []).map((result) => result.outcome)).toEqual(['applied', 'applied']);
    const dayARead = await journalDayRead(dayA);
    const dayBRead = await journalDayRead(dayB);
    expect(((dayARead.body as { sessions: { title: string }[] }).sessions ?? []).map((row) => row.title)).toEqual(['carried earlier']);
    expect(((dayBRead.body as { sessions: { title: string }[] }).sessions ?? []).map((row) => row.title)).toEqual(['carried naturally']);
    expect(await marks()).toEqual(['2026-10-08', dayA, dayB].sort()); // cell 1's mark persists too
  });
});

// ===========================================================================
// The clock-change window (IANA-derived)
// ===========================================================================

describe('the Cairo clock-change weekend (IANA-derived, never hardcoded)', () => {
  it('sessions at BOTH transition instants carry their pre-transition local day; marks follow the carried day', async () => {
    const transitions = cairoTransitionsInYear(DATA_YEAR);
    expect(transitions.length).toBe(2);
    const transitionSeeds = [SEED.t0, SEED.t1];
    for (const [index, transition] of transitions.entries()) {
      const seed = transitionSeeds[index] as string;
      const carriedDay = cairoLocalDate(transition.instantMs - 3_600_000); // an hour before the shift
      const push = await pushOps(app, token, 'dayboundary-j4', nextKey(), [
        sessionOp({ seed, localDate: carriedDay, clientUpdatedAt: new Date(transition.instantMs).toISOString(), title: `transition ${index} session` }),
      ]);
      expect(push.status).toBe(200);
      expect(((push.body as { results: { outcome: string }[] }).results ?? []).map((result) => result.outcome)).toEqual(['applied']);
      expect([...(await storedDays()).values()]).toContain(carriedDay);
      expect(await marks()).toContain(carriedDay);
      const dayRead = await journalDayRead(carriedDay);
      expect(((dayRead.body as { sessions: { localDate: string }[] }).sessions ?? []).some((row) => row.localDate === carriedDay)).toBe(true);

      // Deleting it un-marks exactly the carried day.
      const entityId = fixtureUuid(seed, 2);
      const del = await pushOps(app, token, 'dayboundary-j4', nextKey(), [
        deleteOp({ seed: `${seed.slice(0, 6)}d${index}`, entityId, clientUpdatedAt: new Date(transition.instantMs + 3_600_000).toISOString(), localDate: carriedDay }),
      ]);
      expect(((del.body as { results: { outcome: string }[] }).results ?? []).map((result) => result.outcome)).toEqual(['applied']);
      expect(await marks()).not.toContain(carriedDay);
    }
  });

  it('control: the engineered instants genuinely discriminate — EVERY re-derivation posture would misfile somewhere', async () => {
    const result = await adminQuery(
      db,
      `SELECT s.local_date::text AS carried,
              to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
              to_char(s.updated_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS cairo_day,
              to_char(s.updated_at AT TIME ZONE '+02:00', 'YYYY-MM-DD') AS fixed_plus2_day
         FROM journal_sessions s WHERE s.user_id = $1`,
      [userId],
    );
    const rows = result.rows as { carried: string; utc_day: string; cairo_day: string; fixed_plus2_day: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2); // the criterion cells' rows are still there
    // The carried day is NOT a function of the substrate instant in ANY
    // zone: the 00:01-stamped row's Cairo-wall day IS the next day (by
    // design), and both the UTC and fixed-offset postures misfile at least
    // one row. Re-deriving the day — in any zone — would misfile.
    expect(rows.some((row) => row.cairo_day !== row.carried)).toBe(true);
    expect(rows.some((row) => row.utc_day !== row.carried)).toBe(true);
    expect(rows.some((row) => row.fixed_plus2_day !== row.carried)).toBe(true);
  });
});
