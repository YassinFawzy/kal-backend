/**
 * Kal — journal session day-boundary utilities (w4 contract §1.1/§1.8).
 *
 * The DAY-BOUNDARY RULE is inherited verbatim from wave-03 (§1.8): the
 * session day is the client-local date CARRIED IN THE OP (`YYYY-MM-DD`);
 * the server never re-derives it from receive/sync time — validation is
 * shape-only (calendar-valid `YYYY-MM-DD`, leap years included). A session
 * finished 23:59 and synced 00:01 belongs to the original local day by
 * construction, because the stored `local_date` IS the carried value.
 * Training-day marks key on exactly this stored date.
 *
 * This journal-owned module transcribes the minimal pure calendar helpers
 * from the diary domain's `diary-day.ts` (the W3 two-copies precedent for
 * frozen pure helpers — `foods/lww.ts` vs `diary/diary-lww.ts`): the journal
 * module must stay extractable behind its seam, so it never source-imports
 * tracking's internals. The semantics are the frozen w3 helpers, byte for
 * byte; only the Cairo wall-clock window machinery is omitted (marks key on
 * the stored DATE — no rollup bucketing exists in the journal).
 */

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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
