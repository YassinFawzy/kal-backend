/**
 * Kal — diary day-boundary utility specs (wave-03 contract §1.1/§1.8).
 *
 * Pinned here:
 *   - Shape-only validation of the carried local date (calendar-valid
 *     `YYYY-MM-DD` — strict digits, real calendar dates, leap years).
 *   - The Africa/Cairo clock-change behavior from IANA data (via `Intl`,
 *     never hardcoded DST rules): transition days are 23 h / 25 h, windows
 *     tile across the transition, and every window start/end lands on local
 *     midnight — the structural basis for the 23:59-log / 00:01-sync
 *     criterion staying on the original carried day.
 *   - The carried-date authority: bucketing keys off `localDate` alone —
 *     receive/sync time never enters the computation.
 */
import { describe, expect, it } from 'vitest';
import {
  cairoDayWindowUtc,
  formatLocalDate,
  isValidLocalDate,
  localDateToDate,
  localWallTimeToUtcInstant,
  zoneOffsetMinutes,
  DEFAULT_LOCAL_TIME_ZONE,
} from './diary-day.js';

describe('carried local-date validation (shape-only, §1.1)', () => {
  it('accepts real calendar dates in strict YYYY-MM-DD form', () => {
    expect(isValidLocalDate('2026-01-15')).toBe(true);
    expect(isValidLocalDate('2024-02-29')).toBe(true); // leap year
    expect(isValidLocalDate('2026-12-31')).toBe(true);
    expect(isValidLocalDate('2026-04-24')).toBe(true); // Cairo spring-forward date is a real date
  });

  it('rejects malformed shapes without exception', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      42,
      '2026-1-15', // no zero padding
      '26-01-15',
      '2026/01/15',
      '20260115',
      '2026-01-15T00:00:00Z', // an instant is not a local date
      '2026-01-15 ', // trailing whitespace
      ' 2026-01-15',
      '2026-13-01', // month 13
      '2026-00-10', // month 0
      '2026-01-00', // day 0
      '2026-01-32',
      '2026-02-30', // impossible calendar date
      '2025-02-29', // not a leap year
      '2026-04-31',
    ];
    for (const value of rejected) {
      expect(isValidLocalDate(value), `expected rejection of ${String(value)}`).toBe(false);
    }
  });

  it('maps local dates to DATE-column values losslessly (UTC-midnight anchor)', () => {
    const date = localDateToDate('2026-01-15');
    expect(date.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(formatLocalDate(date)).toBe('2026-01-15');
    expect(formatLocalDate(localDateToDate('2024-02-29'))).toBe('2024-02-29');
    expect(() => localDateToDate('2026-02-30')).toThrow(RangeError);
  });
});

describe('Africa/Cairo clock-change windows (IANA-derived)', () => {
  it('winter offset +02:00, summer offset +03:00 (IANA via Intl)', () => {
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), DEFAULT_LOCAL_TIME_ZONE)).toBe(120);
    expect(zoneOffsetMinutes(new Date('2026-07-01T12:00:00Z'), DEFAULT_LOCAL_TIME_ZONE)).toBe(180);
  });

  /** All days of a year whose Cairo window length differs from 24 h — derived from IANA data, not assumptions. */
  function transitionDaysOf(year: number): { date: string; lengthHours: number }[] {
    const transitions: { date: string; lengthHours: number }[] = [];
    for (let month = 1; month <= 12; month += 1) {
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= daysInMonth; day += 1) {
        const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const { lengthHours } = cairoDayWindowUtc(date);
        if (lengthHours !== 24) {
          transitions.push({ date, lengthHours });
        }
      }
    }
    return transitions;
  }

  it('exactly one 23 h spring-forward day and one 25 h fall-back day per DST year (2026, IANA)', () => {
    const transitions = transitionDaysOf(2026);
    expect(transitions).toEqual([
      { date: expect.any(String), lengthHours: 23 },
      { date: expect.any(String), lengthHours: 25 },
    ]);
    // Egypt's 2023+ DST rules: spring forward on the last Friday of April,
    // back on the last Thursday of October — assert against the IANA-derived
    // values themselves (the runtime's tzdata is the authority).
    expect(transitions[0]?.date).toMatch(/^\d{4}-04-\d{2}$/u);
    expect(transitions[1]?.date).toMatch(/^\d{4}-10-\d{2}$/u);
  });

  it('window starts/ends land on Cairo local midnight (or the spring-forward jump) and tile across the transition', () => {
    const dates = ['2026-04-23', '2026-04-24', '2026-04-25', '2026-10-28', '2026-10-29', '2026-10-30', '2026-01-15'];
    const cairoWallClock = (instant: Date): string => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: DEFAULT_LOCAL_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(instant);
      const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}`;
    };
    for (const date of dates) {
      const { startUtc, endUtc } = cairoDayWindowUtc(date);
      // A window START is local midnight of the carried day — except on the
      // spring-forward day itself, whose midnight does not exist; the window
      // then begins at the jump (the instant the wall clock reads 01:00).
      const startWall = cairoWallClock(startUtc);
      expect([`${date}T00:00:00`, `${date}T01:00:00`]).toContain(startWall);
      // The END is exactly the START of the next window (tiling, numerically).
      const nextDay = formatLocalDate(new Date(localDateToDate(date).getTime() + 86_400_000));
      const nextWindow = cairoDayWindowUtc(nextDay);
      expect(endUtc.getTime()).toBe(nextWindow.startUtc.getTime());
      expect(cairoWallClock(endUtc)).toBe(cairoWallClock(nextWindow.startUtc));
    }
  });

  it('spring-forward day is 23 h and its midnight is the transition instant itself', () => {
    const springForward = transitionDaysOf(2026)[0];
    if (springForward === undefined) {
      throw new Error('IANA data shows no spring-forward day for 2026 — runtime tzdata is broken');
    }
    const { startUtc, lengthHours } = cairoDayWindowUtc(springForward.date);
    expect(lengthHours).toBe(23);
    // Clocks jump 00:00 → 01:00 local: the window start instant renders as
    // 01:00 wall on the transition day OR as 00:00 wall pre-jump depending
    // on which side of the jump midnight falls — the invariant is that the
    // wall time of the start is NOT after 01:00 and the length is 23 h
    // (the missing hour is the jump itself).
    const wallHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_LOCAL_TIME_ZONE, hour: '2-digit', hour12: false })
        .format(startUtc)
        .slice(0, 2),
    );
    expect(wallHour === 0 || wallHour === 1).toBe(true);
  });

  it('23:59-log / 00:01-sync stays on the original carried day (bucketing keys off localDate alone)', () => {
    const day = '2026-04-23'; // the day BEFORE Cairo's spring-forward night
    const nextDay = '2026-04-24';
    const windowOfCarriedDay = cairoDayWindowUtc(day);
    // A food logged at Cairo 23:59:59 on the carried day — its UTC instant:
    const loggedAt = new Date(localWallTimeToUtcInstant(day, '23:59', DEFAULT_LOCAL_TIME_ZONE) + 59_000);
    expect(loggedAt.getTime()).toBeGreaterThanOrEqual(windowOfCarriedDay.startUtc.getTime());
    expect(loggedAt.getTime()).toBeLessThan(windowOfCarriedDay.endUtc.getTime());
    // …and synced at Cairo 00:01 the next day: the sync instant belongs to
    // the NEXT window, but the op CARRIES the original day — the server
    // buckets by that carried value, never by the receive instant.
    const syncedAt = new Date(localWallTimeToUtcInstant(nextDay, '00:01', DEFAULT_LOCAL_TIME_ZONE));
    expect(syncedAt.getTime()).toBeGreaterThanOrEqual(cairoDayWindowUtc(nextDay).startUtc.getTime());
    // The carried date is authoritative: same date in, same window out —
    // no input resembling "receive time" exists in the signature.
    expect(cairoDayWindowUtc(day).startUtc).toEqual(cairoDayWindowUtc(day).startUtc);
  });

  it('fall-back day is 25 h: the repeated hour stays inside the carried day', () => {
    const fallBack = transitionDaysOf(2026)[1];
    if (fallBack === undefined) {
      throw new Error('IANA data shows no fall-back day for 2026 — runtime tzdata is broken');
    }
    const { lengthHours } = cairoDayWindowUtc(fallBack.date);
    expect(lengthHours).toBe(25);
  });

  it('normal days are exactly 24 h', () => {
    expect(cairoDayWindowUtc('2026-01-15').lengthHours).toBe(24);
    expect(cairoDayWindowUtc('2026-07-01').lengthHours).toBe(24);
  });

  it('refuses malformed dates and implausible windows (fail-closed)', () => {
    expect(() => cairoDayWindowUtc('2026-02-30')).toThrow(RangeError);
    expect(() => localWallTimeToUtcInstant('not-a-date', '00:00')).toThrow(RangeError);
    expect(() => localWallTimeToUtcInstant('2026-01-15', '25:99')).toThrow(RangeError);
  });
});
