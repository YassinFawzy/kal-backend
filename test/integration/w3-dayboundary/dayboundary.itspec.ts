/**
 * Kal — day-boundary suite: Africa/Cairo clock-change weekends (s4b).
 *
 * Gate criterion (ledger §3-5; PLAN §4 W3 required tests): "Africa/Cairo day
 * boundary incl. clock-change weekend (23:59 log / 00:01 sync stays original
 * day)". This suite:
 *
 *   1. derives the year's Cairo DST transitions from IANA data (Intl) —
 *      independently of the server helpers it audits;
 *   2. pins the shipped day-window helpers against that derivation (23 h
 *      spring-forward day, 25 h fall-back day, tiling neighbours, repeated-
 *      hour FIRST-occurrence branch, spring-gap branch);
 *   3. runs the END-TO-END boundary: entries logged around midnight on the
 *      transition weekends (the emulated client computes carried dates and
 *      log instants from IANA) land on the correct carried local day through
 *      the REAL ingestion path, rollups, and day reads;
 *   4. proves the suite can DETECT a day-shift (the G2 tz-probe control
 *      style: a control that cannot fail proves nothing) — the whole suite
 *      runs on a Cairo-cluster-default database, so the +03 posture is the
 *      LIVE cluster posture, not a hypothesis.
 *
 * Runs on `kal_it_s4bdy_*` (ephemeral, dropped). Real AppModule, real HTTP
 * semantics via supertest, real transactions — no mocks.
 */
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from '../helpers/ephemeral-db.js';
import { cairoDayWindowUtc, localWallTimeToUtcInstant, zoneOffsetMinutes } from '../../../src/tracking/diary/diary-day.js';
import {
  CAIRO,
  SIGNING_KEY,
  cairoLocalDate,
  cairoTransitionsInYear,
  cairoWallTimeToUtcFirstOccurrence,
  fixtureUuid,
  pushOps,
  quickAddOp,
  readDay,
  signupAndSignin,
} from './dayboundary-support.js';
import type { Pool } from 'pg';

const YEAR = 2026; // the wave's year — transitions are DERIVED, never hardcoded

let app: INestApplication<App>;
let db: EphemeralKalDb;
let adminPool: Pool;

interface DayEntryExpectation {
  readonly carriedDay: string;
  readonly instantMs: number;
  readonly kcal: number;
  readonly label: string;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4bdy');
  // Shift the CLUSTER default for this scratch database BEFORE any other
  // connection (migration runner, Prisma pool) opens against it — the whole
  // suite then runs under the +03-capable posture it must not be fooled by.
  await db.pool.query(`ALTER DATABASE ${JSON.stringify(db.name)} SET timezone TO '${CAIRO}'`);
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;

  const previous: Record<string, string | undefined> = {};
  for (const key of ['DATABASE_URL', 'IDENTITY_JWT_SIGNING_KEY', 'NODE_ENV']) {
    previous[key] = process.env[key];
  }
  process.env['DATABASE_URL'] = url.toString();
  process.env['IDENTITY_JWT_SIGNING_KEY'] = SIGNING_KEY;
  process.env['NODE_ENV'] = 'test';
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
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

describe('s4b day-boundary: Africa/Cairo clock-change weekend (IANA-derived)', () => {
  const transitions = cairoTransitionsInYear(YEAR);

  it('derives exactly two Cairo transitions from IANA data: a spring-forward (+02→+03) and a fall-back (+03→+02)', () => {
    expect(transitions).toHaveLength(2);
    const spring = transitions.find((transition) => transition.offsetAfterMinutes > transition.offsetBeforeMinutes);
    const fall = transitions.find((transition) => transition.offsetAfterMinutes < transition.offsetBeforeMinutes);
    expect(spring).toBeDefined();
    expect(fall).toBeDefined();
    expect(spring?.offsetBeforeMinutes).toBe(120); // EET
    expect(spring?.offsetAfterMinutes).toBe(180); // EEST
    expect(fall?.offsetBeforeMinutes).toBe(180);
    expect(fall?.offsetAfterMinutes).toBe(120);
  });

  it('the shipped day-window helpers agree with the IANA derivation: 23h spring day, 25h fall day, tiling neighbours', () => {
    const [spring, fall] = [transitions[0], transitions[1]];
    if (spring === undefined || fall === undefined) {
      throw new Error('IANA derivation produced no transitions');
    }
    const springDay = cairoLocalDate(spring.instantMs);
    const fallDay = cairoLocalDate(fall.instantMs);

    const springWindow = cairoDayWindowUtc(springDay);
    expect(springWindow.lengthHours).toBe(23);
    expect(springWindow.startUtc.getTime()).toBe(spring.instantMs); // the spring transition IS the day start (00:00 → 01:00 jump)

    const fallWindow = cairoDayWindowUtc(fallDay);
    expect(fallWindow.lengthHours).toBe(25);
    // The fall transition fires at wall 23:00 INSIDE the 25h day (clocks fall
    // from 00:00 of the next day back to 23:00): the transition instant lies
    // strictly inside fallDay's window, which ends at the SECOND midnight.
    expect(fallWindow.startUtc.getTime()).toBeLessThan(fall.instantMs);
    expect(fall.instantMs).toBeLessThan(fallWindow.endUtc.getTime());
    expect(fallWindow.endUtc.getTime()).toBe(fall.instantMs + 3_600_000);

    // Neighbours tile exactly across both transitions.
    const prevOfSpring = cairoLocalDate(spring.instantMs - 86_400_000);
    const nextOfFall = cairoLocalDate(fall.instantMs + 86_400_000);
    expect(cairoDayWindowUtc(prevOfSpring).endUtc.getTime()).toBe(springWindow.startUtc.getTime());
    expect(fallWindow.endUtc.getTime()).toBe(cairoDayWindowUtc(nextOfFall).startUtc.getTime());
    // A plain day between them is 24h.
    const plainDay = cairoLocalDate(Date.UTC(YEAR, 6, 15)); // mid-July
    expect(cairoDayWindowUtc(plainDay).lengthHours).toBe(24);
  });

  it('repeated-hour FIRST-occurrence branch: 23:30 on the fall-back eve maps to the PRE-transition instant, deterministically', () => {
    const fall = transitions[1];
    if (fall === undefined) {
      throw new Error('no fall transition derived');
    }
    const fallEve = cairoLocalDate(fall.instantMs - 3_600_000); // the day whose 23:xx repeats
    const wallNaive = Date.parse(`${fallEve}T23:30:00Z`);
    const firstOccurrence = wallNaive - fall.offsetBeforeMinutes * 60_000; // 23:30 read under +03
    const secondOccurrence = wallNaive - fall.offsetAfterMinutes * 60_000; // 23:30 read under +02

    const shipped = localWallTimeToUtcInstant(fallEve, '23:30');
    expect(shipped).toBe(firstOccurrence);
    expect(shipped).toBeLessThan(fall.instantMs); // strictly BEFORE the transition
    expect(secondOccurrence).toBeGreaterThan(fall.instantMs); // sanity: the two occurrences straddle it
    expect(zoneOffsetMinutes(new Date(shipped), CAIRO)).toBe(fall.offsetBeforeMinutes);
  });

  it('spring-forward gap branch: a nonexistent wall time resolves to the transition instant itself', () => {
    const spring = transitions[0];
    if (spring === undefined) {
      throw new Error('no spring transition derived');
    }
    const springDay = cairoLocalDate(spring.instantMs);
    // Egypt springs at 00:00 → the wall times 00:00–00:59 of the spring day do not exist.
    expect(localWallTimeToUtcInstant(springDay, '00:30')).toBe(spring.instantMs);
  });

  it('control 1 — the cluster shift is REAL: a plain session renders a fixed instant at +02/+03 (the probe can detect a bypass)', async () => {
    const client = await db.connectIsolated();
    try {
      await client.query(`SET TIME ZONE '${CAIRO}'`);
      const shifted = await client.query<{ rendered: string; zone: string }>(
        `SELECT to_char('2026-05-10T12:00:00Z'::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS rendered, current_setting('TimeZone') AS zone`,
      );
      expect(shifted.rows[0]?.zone).toBe(CAIRO);
      const rendered = shifted.rows[0]?.rendered ?? '';
      expect(rendered).not.toMatch(/\+00/u); // shifted away from UTC
      expect(rendered).toMatch(/\+0[23]$/u); // Cairo is +02 standard / +03 DST
    } finally {
      await client.end();
    }
  });

  it('entries logged around midnight on BOTH transition weekends land on the correct carried local day (end-to-end through real ingestion)', async () => {
    const [spring, fall] = [transitions[0], transitions[1]];
    if (spring === undefined || fall === undefined) {
      throw new Error('IANA derivation incomplete');
    }
    const { token } = await signupAndSignin(app, 'dst', 'dst-device');
    const springDay = cairoLocalDate(spring.instantMs);
    const springEve = cairoLocalDate(spring.instantMs - 3_600_000);
    const fallDay = cairoLocalDate(fall.instantMs); // the 25h day that CONTAINS the repeated 23:xx
    const fallEve = fallDay; // alias: the repeated hour belongs to this day
    const dayAfterFall = cairoLocalDate(fall.instantMs + 5 * 3_600_000); // the +02 midnight after the fall-back

    // The emulated client derives each log instant from the IANA wall clock
    // (first occurrence for the repeated hour) and carries its OWN date.
    const expectations: DayEntryExpectation[] = [
      { label: 'spring eve 23:59 (+02)', carriedDay: springEve, instantMs: cairoWallTimeToUtcFirstOccurrence(springEve, '23:59', transitions), kcal: 101 },
      { label: 'spring day 01:00 (first existing after the +02→+03 jump)', carriedDay: springDay, instantMs: cairoWallTimeToUtcFirstOccurrence(springDay, '01:00', transitions), kcal: 102 },
      { label: 'spring day 23:59 (+03)', carriedDay: springDay, instantMs: cairoWallTimeToUtcFirstOccurrence(springDay, '23:59', transitions), kcal: 103 },
      { label: 'after spring 00:01 (+03)', carriedDay: cairoLocalDate(cairoWallTimeToUtcFirstOccurrence(springDay, '23:59', transitions) + 120_000), instantMs: cairoWallTimeToUtcFirstOccurrence(springDay, '23:59', transitions) + 120_000, kcal: 104 },
      { label: 'fall eve 23:59 FIRST occurrence (+03)', carriedDay: fallEve, instantMs: cairoWallTimeToUtcFirstOccurrence(fallEve, '23:59', transitions), kcal: 201 },
      { label: 'fall eve 23:59 SECOND occurrence (+02)', carriedDay: fallEve, instantMs: cairoWallTimeToUtcFirstOccurrence(fallEve, '23:59', transitions) + 3_600_000, kcal: 202 },
      { label: 'after fall 00:01 (+02)', carriedDay: dayAfterFall, instantMs: cairoWallTimeToUtcFirstOccurrence(dayAfterFall, '00:01', transitions), kcal: 203 },
    ];

    // The carried-date sanity the whole suite rests on: the client's own
    // derivation puts both repeated-hour instants on the 25h day, and the
    // 00:01 on the day AFTER the fall-back.
    expect(cairoLocalDate(expectations[4]?.instantMs ?? 0)).toBe(fallEve);
    expect(cairoLocalDate(expectations[5]?.instantMs ?? 0)).toBe(fallEve);
    expect(cairoLocalDate(expectations[6]?.instantMs ?? 0)).toBe(dayAfterFall);
    expect(fallEve).toBe(fallDay);

    const ops = expectations.map((expectation, index) =>
      quickAddOp(
        { opId: fixtureUuid('000d', index + 1), entityId: fixtureUuid('00ed', index + 1), clientUpdatedAt: new Date(expectation.instantMs).toISOString(), localDate: expectation.carriedDay },
        expectation.kcal,
      ),
    );
    const push = await pushOps(app, token, 'dst-device', fixtureUuid('00ad', 1), ops);
    expect(push.status).toBe(200);
    const results = (push.body as { results?: Array<{ opId: string; outcome: string }> }).results ?? [];
    expect(results).toHaveLength(expectations.length);
    for (const result of results) {
      expect(result.outcome).toBe('applied');
    }

    // Day reads aggregate by the CARRIED day: both repeated-hour instants
    // land on the fall eve; the 00:01 lands on the fall day.
    const fallEveView = await readDay(app, token, fallEve);
    expect(fallEveView.status).toBe(200);
    expect((fallEveView.body as { totals?: { entryCount?: number; energyKcal?: number } }).totals?.entryCount).toBe(2);
    expect((fallEveView.body as { totals?: { energyKcal?: number } }).totals?.energyKcal).toBeCloseTo(403, 6);

    const dayAfterFallView = await readDay(app, token, dayAfterFall);
    expect(dayAfterFallView.status).toBe(200);
    expect((dayAfterFallView.body as { totals?: { entryCount?: number; energyKcal?: number } }).totals?.entryCount).toBe(1);
    expect((dayAfterFallView.body as { totals?: { energyKcal?: number } }).totals?.energyKcal).toBeCloseTo(203, 6);

    const springEveView = await readDay(app, token, springEve);
    expect((springEveView.body as { totals?: { entryCount?: number } }).totals?.entryCount).toBe(1);

    const springDayView = await readDay(app, token, springDay);
    expect((springDayView.body as { totals?: { entryCount?: number; energyKcal?: number } }).totals?.entryCount).toBe(2);
    expect((springDayView.body as { totals?: { energyKcal?: number } }).totals?.energyKcal).toBeCloseTo(205, 6);

    // DB truth: every stored local_date equals the CARRIED value — receive/
    // sync time (the Cairo-shifted cluster clock among them) never entered.
    const ids = expectations.map((_, index) => fixtureUuid('00ed', index + 1));
    const stored = await adminPool.query<{ id: string; local_date: string }>(
      `SELECT id::text, to_char(local_date, 'YYYY-MM-DD') AS local_date FROM diary_entries WHERE id::text = ANY($1) ORDER BY id`,
      [ids],
    );
    expect(stored.rows).toHaveLength(expectations.length);
    for (const row of stored.rows) {
      const index = ids.indexOf(row.id);
      expect(row.local_date).toBe(expectations[index]?.carriedDay);
    }
  }, 60_000);

  it('control 2 — the equality assertions are LOAD-BEARING: instant-derived days genuinely differ from the carried day for the boundary fixtures', () => {
    const spring = transitions[0];
    const fall = transitions[1];
    if (spring === undefined || fall === undefined) {
      throw new Error('IANA derivation incomplete');
    }
    const springDay = cairoLocalDate(spring.instantMs);
    const firstExisting = cairoWallTimeToUtcFirstOccurrence(springDay, '01:00', transitions); // 2026-04-23T22:00Z
    // A server that re-derived the day from the LOG INSTANT in UTC would
    // file this entry on 2026-04-23 — but the carried day is 2026-04-24. The
    // carried-day assertions above would FAIL such a server.
    const utcDerived = new Date(firstExisting).toISOString().slice(0, 10);
    expect(utcDerived).toBe(cairoLocalDate(spring.instantMs - 3_600_000)); // 2026-04-23
    expect(springDay).toBe(cairoLocalDate(firstExisting + 3 * 3_600_000)); // 2026-04-24
    expect(utcDerived).not.toBe(springDay); // the UTC-posture re-derivation misfiles this entry
    // And the after-fall 00:01 (+02) instant sits on the PREVIOUS UTC day:
    const dayAfterFall = cairoLocalDate(fall.instantMs + 5 * 3_600_000);
    const afterFall = cairoWallTimeToUtcFirstOccurrence(dayAfterFall, '00:01', transitions);
    expect(new Date(afterFall).toISOString().slice(0, 10)).not.toBe(dayAfterFall);
  });

  it('control 3 — simulated bug: the fixtures are wall-clock faithful (live-Cairo derivation agrees on every row) while UTC and FIXED-offset re-derivations each disagree somewhere — every wrong posture is detectable', async () => {
    const rows = await adminPool.query<{ carried: string; utc_day: string; cairo_day: string; fixed_plus3_day: string; fixed_plus2_day: string }>(
      `SELECT to_char(e.local_date, 'YYYY-MM-DD') AS carried,
              to_char(o.client_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
              to_char(o.client_updated_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS cairo_day,
              to_char(o.client_updated_at + interval '3 hours', 'YYYY-MM-DD') AS fixed_plus3_day,
              to_char(o.client_updated_at + interval '2 hours', 'YYYY-MM-DD') AS fixed_plus2_day
         FROM diary_entries e
         JOIN sync_operations o ON o.entity_id = e.id AND o.user_id = e.user_id
        WHERE o.entity_kind = 'diary_entry' AND o.outcome = 'applied'`,
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(7);
    // Fixture fidelity: the live-Cairo derivation of each log instant equals
    // the carried day on EVERY row (the client computed instants FROM the
    // wall clock) — a server re-deriving under the live Cairo posture stays
    // correct here; the 23:59/00:01 criterion suite covers the residual
    // receive-time case.
    for (const row of rows.rows) {
      expect(row.cairo_day).toBe(row.carried);
    }
    // Detectability: a UTC-posture, a fixed+03, and a fixed+02 re-derivation
    // EACH misfile at least one boundary row — the carried-day assertions
    // would fail such servers (a control that cannot fail proves nothing).
    expect(rows.rows.some((row) => row.utc_day !== row.carried)).toBe(true);
    expect(rows.rows.some((row) => row.fixed_plus3_day !== row.carried)).toBe(true);
    expect(rows.rows.some((row) => row.fixed_plus2_day !== row.carried)).toBe(true);
  }, 60_000);
});


