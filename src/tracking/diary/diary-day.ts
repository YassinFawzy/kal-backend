/**
 * Kal — diary day-boundary utilities (wave-03 contract §1.1/§1.8; ARCHITECTURE §16).
 *
 * The DAY-BOUNDARY RULE (frozen): the diary day is the client-local date
 * CARRIED IN THE OP (`YYYY-MM-DD`); the server never re-derives it from
 * sync/receive time — validation is shape-only (calendar-valid `YYYY-MM-DD`).
 * A food logged at 23:59 and synced at 00:01 belongs to the original local
 * day by construction, because the stored `local_date` IS the carried value.
 *
 * This module holds the pure server-side helpers that MUST treat the carried
 * date as authoritative:
 *   - `isValidLocalDate` — the shape-only gate (strict calendar validity,
 *     including leap years; no local-timezone dependence).
 *   - `localDateToDate` / `formatLocalDate` — the lossless `YYYY-MM-DD`
 *     ⇄ UTC-midnight `Date` mapping used for the DATE column.
 *   - `cairoDayWindowUtc` — the Africa/Cairo wall-clock window of a carried
 *     local day, computed from IANA data via `Intl` (never hardcoded DST
 *     rules): the [start, end) UTC instants whose Cairo wall time is
 *     `00:00:00` of that day (resp. the next). Spring-forward days are 23 h,
 *     fall-back days 25 h; Egypt's 2023+ DST rules come straight from the
 *     tzdata the runtime ships. Rollup bucketing keys off the carried date
 *     and is therefore clock-change-safe by construction.
 *
 * Rendering a day in Africa/Cairo is the CLIENT's concern; these windows
 * exist for server-side reasoning about a carried day (e.g. future
 * bucketed jobs) and for pinning the boundary semantics in tests.
 */

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Cairo is the default local zone (conventions §0; ARCHITECTURE §16). */
export const DEFAULT_LOCAL_TIME_ZONE = 'Africa/Cairo';

/**
 * Strict shape-only validation of a carried local date: exactly
 * `YYYY-MM-DD`, digits only, and a REAL calendar date (month 01–12, day
 * valid for that month/year — leap years included). No timezone or locale
 * is consulted: `2026-02-30` and `2026-2-15` are invalid, `2024-02-29` valid.
 */
export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= daysInCalendarMonth(year, month);
}

function daysInCalendarMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this month (Date arithmetic on a
  // UTC-anchored date; purely calendrical, no zone involvement).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A validated `YYYY-MM-DD` as the DATE-column value (UTC midnight). */
export function localDateToDate(localDate: string): Date {
  if (!isValidLocalDate(localDate)) {
    throw new RangeError(`localDate is not a calendar-valid YYYY-MM-DD date`);
  }
  return new Date(`${localDate}T00:00:00Z`);
}

/** The DATE-column value back to its `YYYY-MM-DD` string (lossless). */
export function formatLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Offset of `timeZone` from UTC, in minutes, at the given instant (positive
 * east of Greenwich) — derived from IANA data through `Intl`, so DST
 * transitions follow the runtime's tzdata exactly.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string = DEFAULT_LOCAL_TIME_ZONE): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const parts = formatter.formatToParts(instant);
  const zoneName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName);
  if (match === null) {
    // 'GMT' (zero offset) renders without a sign on some runtimes.
    if (zoneName === 'GMT') {
      return 0;
    }
    throw new Error(`unrecognized IANA offset rendering for ${timeZone}: ${zoneName}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The UTC instant at which the given local wall-clock date-time
 * (`localDate` + `HH:mm` in `timeZone`) begins.
 *
 * Algorithm (deterministic around DST transitions — no fixed-point
 * iteration, which can orbit or mis-land near a jump): the answer must lie
 * within ±15 h of the naive UTC reading for any real zone; offsets are
 * constant per segment, so each segment contributes the candidate
 * `W − offset_segment`, and the first segment whose candidate falls inside
 * it wins (first occurrence — deterministic in the repeated hour of a
 * fall-back). When NO segment contains its candidate, the wall time does
 * not exist (spring-forward gap): the transition instant itself is the
 * answer — the moment the wall clock jumps past the requested time.
 */
export function localWallTimeToUtcInstant(localDate: string, timeOfDay: string, timeZone: string = DEFAULT_LOCAL_TIME_ZONE): number {
  if (!isValidLocalDate(localDate)) {
    throw new RangeError('localDate is not a calendar-valid YYYY-MM-DD date');
  }
  const naive = Date.parse(`${localDate}T${timeOfDay}Z`);
  if (Number.isNaN(naive)) {
    throw new RangeError(`invalid time of day: ${timeOfDay}`);
  }
  const lo = naive - 15 * 3_600_000;
  const hi = naive + 15 * 3_600_000;
  const offsetLo = zoneOffsetMinutes(new Date(lo), timeZone);
  const offsetHi = zoneOffsetMinutes(new Date(hi), timeZone);
  if (offsetLo === offsetHi) {
    const candidate = naive - offsetLo * 60_000;
    if (candidate < lo || candidate > hi) {
      throw new Error(`implausible zone data for ${timeZone}: offset ${String(offsetLo)}min places wall time outside the search bracket`);
    }
    return candidate;
  }
  // An offset transition lies within the bracket — locate it exactly
  // (binary search on the smallest instant carrying the post-transition
  // offset; minute-granular zones converge in ~30 probes).
  let low = lo;
  let high = hi;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (zoneOffsetMinutes(new Date(mid), timeZone) === offsetLo) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const transition = high; // first instant with the new offset
  const candidateBefore = naive - offsetLo * 60_000;
  const candidateAfter = naive - offsetHi * 60_000;
  const inBefore = candidateBefore >= lo && candidateBefore < transition;
  const inAfter = candidateAfter >= transition && candidateAfter <= hi;
  if (inBefore && inAfter) {
    // Wall time occurs twice (repeated hour of a fall-back): first occurrence.
    return Math.min(candidateBefore, candidateAfter);
  }
  if (inBefore) {
    return candidateBefore;
  }
  if (inAfter) {
    return candidateAfter;
  }
  // Spring-forward gap: the wall time does not exist — the transition
  // instant is the answer (the moment the wall clock jumps past it).
  return transition;
}

export interface LocalDayWindowUtc {
  /** Inclusive start — the UTC instant whose local wall time is 00:00:00 of `localDate`. */
  readonly startUtc: Date;
  /** Exclusive end — the UTC instant whose local wall time is 00:00:00 of the NEXT day. */
  readonly endUtc: Date;
  /** Window length in hours (23 on spring-forward days, 25 on fall-back days, 24 otherwise). */
  readonly lengthHours: number;
}

/**
 * The Africa/Cairo (default zone) wall-clock window of one carried local
 * day. The carried date is the ONLY input that matters — receive/sync time
 * never enters the computation (day-boundary rule). Neighbouring windows
 * tile the timeline even across DST transitions (a 23 h day is followed by
 * 24 h days; a 25 h day absorbs the repeated hour).
 */
export function cairoDayWindowUtc(localDate: string, timeZone: string = DEFAULT_LOCAL_TIME_ZONE): LocalDayWindowUtc {
  const nextDay = formatLocalDate(new Date(localDateToDate(localDate).getTime() + 86_400_000));
  const startMs = localWallTimeToUtcInstant(localDate, '00:00', timeZone);
  const endMs = localWallTimeToUtcInstant(nextDay, '00:00', timeZone);
  const lengthHours = (endMs - startMs) / 3_600_000;
  if (!Number.isFinite(lengthHours) || lengthHours < 22 || lengthHours > 26) {
    // A nonsensical window means broken zone data — refuse rather than
    // bucket wrongly (fail closed).
    throw new Error(`implausible local-day window for ${localDate} in ${timeZone}: ${String(lengthHours)}h`);
  }
  return { startUtc: new Date(startMs), endUtc: new Date(endMs), lengthHours };
}
