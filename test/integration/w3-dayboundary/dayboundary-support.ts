/**
 * Kal — day-boundary suite shared support (test/integration/w3-dayboundary/**).
 *
 * The suite pins the FROZEN day-boundary rule (wave-03 contract §1.1/§1.8;
 * PRD §23.1 boundary criterion; ARCHITECTURE §16): the client-local diary
 * date CARRIED IN THE OP is authoritative — the server never re-derives the
 * day from receive/sync time; validation is shape-only.
 *
 * Everything Cairo-DST here is derived from IANA data through `Intl` at run
 * time (never hardcoded DST rules), independently of the server helpers the
 * suite audits: the emulated client computes its carried dates and log
 * instants with THIS module; the server is then asked to agree.
 */
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const CAIRO = 'Africa/Cairo';

/** Cairo offset from UTC in minutes at an instant, straight from IANA via `Intl`. */
export function cairoOffsetMinutes(instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CAIRO, timeZoneName: 'longOffset' }).formatToParts(new Date(instantMs));
  const rendered = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  if (rendered === 'GMT') {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(rendered);
  if (match === null) {
    throw new Error(`unrecognized offset rendering: ${rendered}`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** The carried local date a Cairo client derives for an instant (`en-CA` ⇒ YYYY-MM-DD). */
export function cairoLocalDate(instantMs: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instantMs));
}

/** HH:mm a Cairo wall clock reads at an instant. */
export function cairoWallClock(instantMs: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: CAIRO, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instantMs));
}

export interface CairoTransition {
  /** The exact UTC instant (ms) at which the new offset first applies. */
  readonly instantMs: number;
  readonly offsetBeforeMinutes: number;
  readonly offsetAfterMinutes: number;
}

/** All Cairo offset transitions in a calendar year, derived from IANA by hourly scan + bisection to the millisecond. */
export function cairoTransitionsInYear(year: number): CairoTransition[] {
  const transitions: CairoTransition[] = [];
  const yearStart = Date.UTC(year, 0, 1);
  let offset = cairoOffsetMinutes(yearStart);
  for (let probe = yearStart + 3_600_000; probe < Date.UTC(year + 1, 0, 1); probe += 3_600_000) {
    const current = cairoOffsetMinutes(probe);
    if (current !== offset) {
      let lo = probe - 3_600_000;
      let hi = probe;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (cairoOffsetMinutes(mid) === offset) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      transitions.push({ instantMs: hi, offsetBeforeMinutes: offset, offsetAfterMinutes: current });
      offset = current;
    }
  }
  return transitions;
}

/**
 * The UTC instant at which a Cairo wall-clock date-time begins, preferring
 * the FIRST occurrence when the wall time repeats (fall-back) — derived
 * independently of the server helper by round-trip verification over the
 * pre/post-transition offset candidates.
 */
export function cairoWallTimeToUtcFirstOccurrence(localDate: string, hhmm: string, _transitions: readonly CairoTransition[]): number {
  const naive = Date.parse(`${localDate}T${hhmm}:00Z`);
  if (Number.isNaN(naive)) {
    throw new Error(`bad wall time ${localDate} ${hhmm}`);
  }
  const candidates: number[] = [];
  for (const offsetMinutes of new Set([cairoOffsetMinutes(naive - 86_400_000), cairoOffsetMinutes(naive + 86_400_000), cairoOffsetMinutes(naive)])) {
    const candidate = naive - offsetMinutes * 60_000;
    if (cairoLocalDate(candidate) === localDate && cairoWallClock(candidate) === hhmm) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    throw new Error(`wall time ${localDate} ${hhmm} does not exist in ${CAIRO} (spring-forward gap)`);
  }
  return Math.min(...candidates); // FIRST occurrence
}

// ---------------------------------------------------------------------------
// Real-HTTP helpers (mirrors the serialized integration-suite posture)
// ---------------------------------------------------------------------------

export const SIGNING_KEY = 's4b4daybound7ary9fixed4key4material4with4enough4entropy';
export const PASSWORD = 's4b-dayboundary-password';

export async function signupAndSignin(app: INestApplication<App>, tag: string, _deviceLabel: string): Promise<{ token: string; userId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const username = `s4bdy${tag}${suffix}`.replace(/[^a-z0-9_]/g, '').slice(0, 30);
  const signup = await request(app.getHttpServer())
    .post('/identity/signup')
    .send({ email: `${username}@dayboundary.example.net`, phone: `+2019${suffix.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`, username, password: PASSWORD });
  if (signup.status !== 200) {
    throw new Error(`signup failed: ${String(signup.status)} ${JSON.stringify(signup.body)}`);
  }
  const signin = await request(app.getHttpServer())
    .post('/identity/signin')
    .set('X-Device-Id', `dayboundary-${tag}`)
    .send({ identifier: username, password: PASSWORD });
  if (signin.status !== 200) {
    throw new Error(`signin failed: ${String(signup.status)}`);
  }
  const token = (signin.body as { accessToken?: string }).accessToken;
  if (typeof token !== 'string') {
    throw new Error('signin returned no accessToken');
  }
  const me = await request(app.getHttpServer()).get('/identity/me').set('Authorization', `Bearer ${token}`);
  const userId = (me.body as { user?: { id?: string } }).user?.id;
  if (typeof userId !== 'string') {
    throw new Error('/identity/me returned no user id');
  }
  return { token, userId };
}

export interface PushResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly bodyText: string;
}

export async function pushOps(app: INestApplication<App>, token: string, deviceId: string, idempotencyKey: string, ops: ReadonlyArray<object>, requestId?: string): Promise<PushResult> {
  let result = request(app.getHttpServer())
    .post('/sync/ops')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idempotencyKey)
    .set('Content-Type', 'application/json');
  if (requestId !== undefined) {
    result = result.set('X-Request-Id', requestId);
  }
  const response = await result.send({ deviceId, ops: [...ops] });
  return { status: response.status, body: response.body as Record<string, unknown>, bodyText: response.text };
}

export async function readDay(app: INestApplication<App>, token: string, localDate: string): Promise<{ status: number; body: Record<string, unknown>; bodyText: string }> {
  const result = await request(app.getHttpServer()).get(`/tracking/diary/days/${localDate}`).set('Authorization', `Bearer ${token}`);
  return { status: result.status, body: result.body as Record<string, unknown>, bodyText: result.text };
}

/** Deterministic fixture uuid (v4-shaped, fixture range). */
export function fixtureUuid(seed: string, index: number): string {
  return `5bef0000-0000-4000-8000-${seed.slice(0, 8).padEnd(8, '0')}${(index % 0xffff).toString(16).padStart(4, '0')}`;
}

/** Quick-add diary op (the bare legal snapshot shape under the source XOR). */
export function quickAddOp(input: { opId: string; entityId: string; clientUpdatedAt: string; localDate: string }, kcal: number): object {
  return {
    opId: input.opId,
    kind: 'diary_entry',
    entityId: input.entityId,
    action: 'create',
    clientUpdatedAt: input.clientUpdatedAt,
    localDate: input.localDate,
    payload: {
      localDate: input.localDate,
      mealSlot: 'snack',
      entryMethod: 'quick_add',
      quantity: 1,
      energyKcal: kcal,
      proteinG: Math.round(kcal * 0.1 * 10) / 10,
      carbsG: Math.round(kcal * 0.5 * 10) / 10,
      fatG: Math.round(kcal * 0.2 * 10) / 10,
      status: 'confirmed',
    },
  };
}
