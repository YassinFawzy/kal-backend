/**
 * s4a harness — the three-user A/B/C tracking/sync attack harness (wave-03
 * task s4a-adversarial; ADDITIVE extension of `helpers/`, wave-02 pattern:
 * a NEW file, existing helpers untouched).
 *
 * What it adds over the existing primitives:
 *   - `createThreeUserHarness`: signs up + signs in three synthetic consumers
 *     (A owner / B attacker / C control) against a booted AppModule over the
 *     suite's ephemeral database, resolving each verified `userId` from the
 *     database (never from a token parse — the binding is server truth, I6).
 *   - Op-envelope builders for the three frozen kinds (§1.1 shapes), with a
 *     suite-namespaced fixture-uuid helper so concurrent suites never share
 *     ids.
 *   - `pushBatch`: the sync push request with a PINNED `X-Request-Id` (the
 *     W2 raw-byte equivalence method — the server echoes safe client values
 *     into the body's `requestId`, so responses compare byte-for-byte).
 *   - `expectRawIdentical`: the raw-byte assertion (body text, status,
 *     content-type, www-authenticate) — zero normalization, key order and
 *     spacing included (STRICTER than JSON.stringify comparison).
 *   - Admin-connection row counters for the atomicity cells (diary rows,
 *     ledger rows, idempotency-key rows, limiter counters) — catalog/state
 *     introspection only, never behavioral row-security assertions.
 *
 * Fixture discipline (task contract): synthetic users only; neutral numeric
 * placeholders for macros; no real identities, secrets, or health content.
 */
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { EphemeralKalDb } from './ephemeral-db.js';
import { adminQuery } from './ephemeral-db.js';

/** One matrix account: verified server-side identity + its bearer token. */
export interface HarnessUser {
  readonly account: { email: string; phone: string; username: string };
  /** The verified database binding (server truth — never parsed from the JWT). */
  readonly userId: string;
  readonly token: string;
}

export interface ThreeUserHarness {
  /** A owns the attack-target rows. */
  readonly a: HarnessUser;
  /** B attacks every path with valid credentials. */
  readonly b: HarnessUser;
  /** C is the control: C's own-data parity proves denials are authorization-driven. */
  readonly c: HarnessUser;
}

export interface HarnessAccountSpec {
  readonly email: string;
  readonly phone: string;
  readonly username: string;
}

const HARNESS_PASSWORD = 's4a-harness-password-01';

/**
 * Creates the A/B/C triad on an already-booted app + ephemeral database.
 * Idempotent per (unique) account spec — suites own their account specs.
 */
export async function createThreeUserHarness(
  app: INestApplication<App>,
  db: EphemeralKalDb,
  accounts: { a: HarnessAccountSpec; b: HarnessAccountSpec; c: HarnessAccountSpec },
): Promise<ThreeUserHarness> {
  const made: HarnessUser[] = [];
  for (const account of [accounts.a, accounts.b, accounts.c]) {
    await request(app.getHttpServer()).post('/identity/signup').send({ ...account, password: HARNESS_PASSWORD });
    const signin = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', `s4a-${account.username}`)
      .send({ identifier: account.username, password: HARNESS_PASSWORD });
    expect(signin.status, `signin ${account.username}`).toBe(200);
    const token = (signin.body as { accessToken: string }).accessToken;
    const rows = await adminQuery(db, 'SELECT id FROM users WHERE username = $1', [account.username]);
    const userId = (rows.rows[0] as { id: string } | undefined)?.id ?? '';
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    made.push({ account, userId, token });
  }
  return { a: made[0] as HarnessUser, b: made[1] as HarnessUser, c: made[2] as HarnessUser };
}

// ---------------------------------------------------------------------------
// fixture ids + op envelopes (contract §1.1 shapes)
// ---------------------------------------------------------------------------

/**
 * Suite-namespaced fixture UUIDs. `namespace` is 4 hex chars unique per
 * suite; `tail` is ANY label (op names, entity names, keys) hashed into the
 * trailing 12 hex chars — deterministic (same label ⇒ same id across
 * tests/describes) and collision-free for distinct labels (fail-loud guard
 * below). Shape: `<ns>e000-0000-4000-8000-<12 hex>` (the fixture range —
 * never a real entity; version/variant nibbles stay 4/8).
 */
const advUuidByPair = new Map<string, string>();
const advUuidOwner = new Map<string, string>();
export function advUuid(namespace: string, tail: string): string {
  if (!/^[0-9a-f]{4}$/u.test(namespace)) {
    throw new Error(`advUuid namespace must be 4 hex chars: ${namespace}`);
  }
  const pair = `${namespace}|${tail}`;
  const known = advUuidByPair.get(pair);
  if (known !== undefined) {
    return known;
  }
  const hex = createHash('sha256').update(pair, 'utf8').digest('hex').slice(0, 12);
  const id = `${namespace}e000-0000-4000-8000-${hex}`;
  const owner = advUuidOwner.get(id);
  if (owner !== undefined) {
    throw new Error(`advUuid collision: "${tail}" derives the id already owned by "${owner}" — label set must stay distinct`);
  }
  advUuidByPair.set(pair, id);
  advUuidOwner.set(id, tail);
  return id;
}

/** The frozen quick-add diary snapshot (the zero-dependency legal shape). */
export function quickAddSnapshot(localDate: string): Record<string, unknown> {
  return {
    localDate,
    mealSlot: 'breakfast',
    entryMethod: 'quick_add',
    status: 'confirmed',
    quantity: 1,
    energyKcal: 250,
    proteinG: 8,
    carbsG: 30,
    fatG: 7,
  };
}

/** The frozen user-food snapshot (the shared limiter's entity). */
export function userFoodSnapshot(nameEn: string): Record<string, unknown> {
  return { nameEn, energyKcal: 120, proteinG: 4, carbsG: 15, fatG: 3 };
}

export interface OpInput {
  readonly opId: string;
  readonly kind: 'diary_entry' | 'user_food' | 'favorite';
  readonly entityId: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly clientUpdatedAt: string;
  readonly localDate?: string;
  readonly payload?: Record<string, unknown>;
}

export function diaryCreateOp(namespace: string, op: string, entity: string, at: string, day: string): OpInput {
  return {
    opId: advUuid(namespace, op),
    kind: 'diary_entry',
    entityId: advUuid(namespace, entity),
    action: 'create',
    clientUpdatedAt: at,
    localDate: day,
    payload: quickAddSnapshot(day),
  };
}

export function userFoodCreateOp(namespace: string, op: string, entity: string, at: string, nameEn: string): OpInput {
  return {
    opId: advUuid(namespace, op),
    kind: 'user_food',
    entityId: advUuid(namespace, entity),
    action: 'create',
    clientUpdatedAt: at,
    payload: userFoodSnapshot(nameEn),
  };
}

export function favoriteCreateOp(
  namespace: string,
  op: string,
  entity: string,
  at: string,
  target: { foodId: string } | { userFoodId: string },
): OpInput {
  return {
    opId: advUuid(namespace, op),
    kind: 'favorite',
    entityId: advUuid(namespace, entity),
    action: 'create',
    clientUpdatedAt: at,
    payload: target,
  };
}

// ---------------------------------------------------------------------------
// requests — every equivalence-relevant call pins the same X-Request-Id
// ---------------------------------------------------------------------------

/** The correlation id pinned on BOTH sides of every equivalence pair (≤128 printable ASCII). */
export const PINNED_REQUEST_ID = 's4a raw-equivalence pinned request id 00';

function pin(test: request.Test): request.Test {
  return test.set('X-Request-Id', PINNED_REQUEST_ID);
}

export function pushBatch(
  app: INestApplication<App>,
  token: string,
  ops: readonly OpInput[],
  idempotencyKey: string,
  deviceId = 's4a-harness-device',
): request.Test {
  return pin(request(app.getHttpServer()).post('/sync/ops'))
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idempotencyKey)
    .send({ deviceId, ops });
}

export function pullChanges(
  app: INestApplication<App>,
  token: string,
  query: Record<string, string>,
): request.Test {
  return pin(request(app.getHttpServer()).get('/sync/changes')).set('Authorization', `Bearer ${token}`).query(query);
}

export function getDiaryDay(app: INestApplication<App>, token: string, localDate: string): request.Test {
  return pin(request(app.getHttpServer()).get(`/tracking/diary/days/${localDate}`)).set(
    'Authorization',
    `Bearer ${token}`,
  );
}

export function searchFoods(app: INestApplication<App>, token: string, query: Record<string, string>): request.Test {
  return pin(request(app.getHttpServer()).get('/tracking/foods')).set('Authorization', `Bearer ${token}`).query(query);
}

export function getFood(app: INestApplication<App>, token: string, foodId: string): request.Test {
  return pin(request(app.getHttpServer()).get(`/tracking/foods/${foodId}`)).set('Authorization', `Bearer ${token}`);
}

export function resolveBarcode(app: INestApplication<App>, token: string, barcode: string): request.Test {
  return pin(request(app.getHttpServer()).get(`/tracking/barcode/${barcode}`)).set('Authorization', `Bearer ${token}`);
}

export function createUserFoodRest(app: INestApplication<App>, token: string, body: Record<string, unknown>): request.Test {
  return pin(request(app.getHttpServer()).post('/tracking/user-foods'))
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** The raw-byte equivalence assertion (the W2 method): body text, status, observable headers. */
export function expectRawIdentical(actual: request.Response, expected: request.Response, label: string): void {
  expect(actual.status, `${label}: status`).toBe(expected.status);
  expect(actual.text, `${label}: raw body bytes`).toBe(expected.text);
  expect(actual.headers['content-type'], `${label}: content-type`).toBe(expected.headers['content-type']);
  if (expected.headers['www-authenticate'] !== undefined) {
    expect(actual.headers['www-authenticate'], `${label}: www-authenticate`).toBe(expected.headers['www-authenticate']);
  }
}

/** One ack result projected to its disclosure-relevant fields (the caller's own opId is the correlation handle it authored — contract §1.2 — and is compared by position, not value). */
export interface AckOutcomeShape {
  readonly outcome: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

/**
 * Per-op outcome equivalence for acks from DIFFERENT ops (each body echoes
 * its own opId by contract, so raw bytes differ by construction): the two
 * acks must carry the same result COUNT and the same (outcome, code,
 * retryable) per position — nothing else may differ.
 */
export function expectAckOutcomesIdentical(actual: request.Response, expected: request.Response, label: string): void {
  const shape = (response: request.Response): AckOutcomeShape[] =>
    ((response.body as { results?: { outcome: string; code?: string; retryable?: boolean }[] }).results ?? []).map(
      ({ outcome, code, retryable }) => ({ outcome, code, retryable }),
    );
  expect(shape(actual), `${label}: per-op outcomes`).toEqual(shape(expected));
}

// ---------------------------------------------------------------------------
// admin-connection state probes (introspection + atomicity cells only)
// ---------------------------------------------------------------------------

export async function countRows(db: EphemeralKalDb, table: string, where: string, params: readonly unknown[] = []): Promise<number> {
  const rows = await adminQuery(db, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return (rows.rows[0] as { n: number }).n;
}

export async function diaryRowCount(db: EphemeralKalDb, userId: string): Promise<number> {
  return countRows(db, 'diary_entries', 'user_id = $1', [userId]);
}

export async function ledgerRowCount(db: EphemeralKalDb, userId: string, clientOpId?: string): Promise<number> {
  return clientOpId === undefined
    ? countRows(db, 'sync_operations', 'user_id = $1', [userId])
    : countRows(db, 'sync_operations', 'user_id = $1 AND client_op_id = $2', [userId, clientOpId]);
}

export async function idempotencyKeyCount(db: EphemeralKalDb, userId: string): Promise<number> {
  return countRows(db, 'sync_idempotency_keys', 'user_id = $1', [userId]);
}

export interface LimiterCounters {
  readonly hourCount: number;
  readonly dayCount: number;
}

export async function limiterCounters(db: EphemeralKalDb, userId: string): Promise<LimiterCounters | null> {
  const rows = await adminQuery(
    db,
    'SELECT hour_count, day_count FROM user_food_create_counters WHERE user_id = $1',
    [userId],
  );
  const row = rows.rows[0] as { hour_count: number; day_count: number } | undefined;
  return row === undefined ? null : { hourCount: row.hour_count, dayCount: row.day_count };
}

/** Lapses BOTH limiter windows for the user (harness clock — the app role holds no such grant). */
export async function lapseLimiterWindows(db: EphemeralKalDb, userId: string): Promise<void> {
  await adminQuery(
    db,
    `UPDATE user_food_create_counters
     SET hour_window_start = now() - interval '2 hours',
         day_window_start  = now() - interval '25 hours'
     WHERE user_id = $1`,
    [userId],
  );
}

/** Forces both windows into their over-limit state (counter row upserted when absent). */
export async function saturateLimiter(db: EphemeralKalDb, userId: string): Promise<void> {
  await adminQuery(
    db,
    `INSERT INTO user_food_create_counters (user_id, hour_window_start, hour_count, day_window_start, day_count)
     VALUES ($1, now(), 1000000, now(), 1000000)
     ON CONFLICT (user_id) DO UPDATE SET hour_count = 1000000, hour_window_start = now(),
                                        day_count = 1000000, day_window_start = now()`,
    [userId],
  );
}
