/**
 * Kal recovery-request throttle e2e (W3 Stage-1 carryover F-S4-1; ledger
 * §7-E4, G2 evidence §6-B) — the real AppModule against a real, fully-
 * migrated, EPHEMERAL PostgreSQL database (the harness pattern).
 *
 * Required cases (task contract):
 *   - Threshold trips to `429 RATE_LIMITED` + `Retry-After` (server-computed
 *     remaining seconds, bounded by the lock duration).
 *   - Known vs unknown identifier: byte-identical 429 bodies (the s4 method:
 *     same X-Request-Id echo, raw byte compare — zero normalization) AND
 *     429-path timing parity (both paths throw at the same code point).
 *   - Counters tick regardless of identifier existence (both paths trip).
 *   - Window reset: an expired window opens a fresh count (two-config proof:
 *     the threshold and window values change behavior).
 *   - Lock expiry releases the pair.
 *   - Cross-domain independence: the recovery throttle's lock never touches
 *     sign-in semantics; the credential lockout still blocks recovery
 *     requests (the pre-existing `assertPairNotLocked` posture, unchanged).
 *   - The equalization posture is preserved: the 200-path byte equivalence
 *     holds with the throttle in place (the timing suite's T4 stays green in
 *     the full e2e run).
 *
 * DB-level window/lock manipulation (UPDATE of the counter row) is the
 * harness-sanctioned way to prove time semantics without sleeping through
 * real windows (identity-tz's ALTER DATABASE precedent). Bodies are compared
 * raw; `Retry-After` is a per-pair remaining-seconds value — asserted
 * bounded, never cross-pair equal.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { adminQuery, createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

/** Synthetic fixture secret (placeholder-free, I15-safe) — never a real credential. */
const SIGNING_KEY = 'e2e4recovery4throttle4fixed4key4material4with4enough4entropy000';

const PASSWORD = 'recovery-throttle-e2e-password';
const DEVICE_A = 'throttle-device-A-01';
const DEVICE_B = 'throttle-device-B-02';

const KNOWN = { email: ['throttle-known', 'example.com'].join('@'), phone: '+201000000011', username: 'throttle_known' };
const UNKNOWN_EMAIL = ['throttle-unknown', 'example.com'].join('@');

let app: INestApplication<App>;
let db: EphemeralKalDb;
let databaseUrl: string;

interface BootEnv {
  readonly threshold: string;
  readonly windowSeconds: string;
}

/** Boot against the ephemeral DB with the given throttle config (I15: captured at construction). */
async function bootApp(env: BootEnv): Promise<INestApplication<App>> {
  const overrides: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    IDENTITY_RECOVERY_REQUEST_THRESHOLD: env.threshold,
    IDENTITY_RECOVERY_REQUEST_WINDOW_SECONDS: env.windowSeconds,
  };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key] as string;
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

function recoveryRequest(identifier: string, deviceId: string, requestId: string) {
  return request(app.getHttpServer())
    .post('/identity/recovery/request')
    .set('X-Device-Id', deviceId)
    .set('X-Request-Id', requestId)
    .send({ identifier });
}

beforeAll(() => {
  return (async () => {
    db = await createEphemeralKalDb('rec-throttle');
    db.applyMigrations();
    const url = new URL(process.env['DATABASE_URL'] as string);
    url.pathname = `/${db.name}`;
    databaseUrl = url.toString();

    app = await bootApp({ threshold: '3', windowSeconds: '3600' });
    // One known account; the unknown identifier never signs up.
    await request(app.getHttpServer())
      .post('/identity/signup')
      .set('X-Device-Id', DEVICE_A)
      .send({ ...KNOWN, password: PASSWORD })
      .expect(200);
  })();
});

afterAll(() => {
  return (async () => {
    await app?.close();
    await db.drop();
  })();
});

describe('recovery-request throttle (F-S4-1)', () => {
  it('accepts requests 1..threshold on a known identifier, then rejects with 429 + Retry-After', async () => {
    for (let i = 1; i <= 2; i += 1) {
      const res = await recoveryRequest(KNOWN.email, DEVICE_A, `thr-known-${i}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'accepted' });
    }
    // Third request crosses the threshold — STILL accepted (it arms the lock
    // for future requests; the sign-in lockout shape).
    const crossing = await recoveryRequest(KNOWN.email, DEVICE_A, 'thr-known-3');
    expect(crossing.status).toBe(200);

    const locked = await recoveryRequest(KNOWN.email, DEVICE_A, 'thr-known-4');
    expect(locked.status).toBe(429);
    expect(locked.headers['content-type']).toContain('application/problem+json');
    expect(locked.body['code']).toBe('RATE_LIMITED');
    expect(locked.body['status']).toBe(429);
    const retryAfter = Number(locked.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(900); // lockoutDurationSeconds default

    // Further requests stay locked (the lock, not new ticks, decides).
    expect((await recoveryRequest(KNOWN.email, DEVICE_A, 'thr-known-5')).status).toBe(429);
  });

  it('counters tick regardless of identifier existence: the unknown path trips identically', async () => {
    for (let i = 1; i <= 3; i += 1) {
      expect((await recoveryRequest(UNKNOWN_EMAIL, DEVICE_B, `thr-unknown-${i}`)).status).toBe(200);
    }
    const locked = await recoveryRequest(UNKNOWN_EMAIL, DEVICE_B, 'thr-unknown-4');
    expect(locked.status).toBe(429);
    expect(locked.body['code']).toBe('RATE_LIMITED');
  });

  it('429 bodies are byte-identical for known vs unknown identifiers (same X-Request-Id raw compare)', async () => {
    // Both pairs above are locked; fire one more request on each with the
    // SAME X-Request-Id so the echoed requestId matches and the raw bodies
    // must be identical (the s4 method — zero normalization).
    const knownRes = await recoveryRequest(KNOWN.email, DEVICE_A, 'thr-parity-probe');
    const unknownRes = await recoveryRequest(UNKNOWN_EMAIL, DEVICE_B, 'thr-parity-probe');
    expect(knownRes.status).toBe(429);
    expect(unknownRes.status).toBe(429);
    expect(knownRes.text).toBe(unknownRes.text);
  });

  it('429-path timing parity: known vs unknown locked requests diverge negligibly', async () => {
    const median = async (identifier: string, device: string): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const start = performance.now();
        await recoveryRequest(identifier, device, `thr-timing-${i}`);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)] as number;
    };
    const knownMedian = await median(KNOWN.email, DEVICE_A);
    const unknownMedian = await median(UNKNOWN_EMAIL, DEVICE_B);
    // Both paths throw at the SAME code point after identical work (one
    // counter SELECT) — the observed gap is noise-shaped, not a side.
    expect(Math.abs(knownMedian - unknownMedian)).toBeLessThanOrEqual(10);
  });

  it('window reset: an expired window opens a fresh count (two-config proof: threshold 2, window 60 s)', async () => {
    await app.close();
    app = await bootApp({ threshold: '2', windowSeconds: '60' });
    // Fresh pair (device C): 2 requests fill the window, 3rd is throttled.
    for (let i = 1; i <= 2; i += 1) {
      expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', `thr-reset-${i}`)).status).toBe(200);
    }
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-reset-3')).status).toBe(429);

    // Expire the WINDOW by back-dating its start beyond the 60 s window and
    // clear the lock — the next ticks must open a FRESH count: the (fresh)
    // threshold trips again after exactly two accepted requests. (Only this
    // suite's rows exist in the ephemeral database.)
    await adminQuery(
      db,
      `UPDATE recovery_request_counters
          SET window_started_at = now() - interval '2 hours', locked_until = NULL`,
    );
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-reset-4')).status).toBe(200);
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-reset-5')).status).toBe(200);
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-reset-6')).status).toBe(429);
  });

  it('lock expiry releases the pair (the Retry-After window is bounded, not permanent)', async () => {
    // Expire every lock; the windows were also expired by the previous case,
    // so counting restarts fresh: 200, 200, then the threshold trips again.
    await adminQuery(db, `UPDATE recovery_request_counters SET locked_until = now() - interval '1 second'`);
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-expiry-1')).status).toBe(200);
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-expiry-2')).status).toBe(200);
    expect((await recoveryRequest(KNOWN.email, 'throttle-device-C', 'thr-expiry-3')).status).toBe(429);
  });

  it('cross-domain independence: the recovery lock never touches sign-in; the credential lock still blocks recovery', async () => {
    await app.close();
    app = await bootApp({ threshold: '3', windowSeconds: '3600' });
    // Trip the RECOVERY throttle on (KNOWN.email, DEVICE_A).
    for (let i = 1; i <= 3; i += 1) {
      expect((await recoveryRequest(KNOWN.email, DEVICE_A, `thr-domain-${i}`)).status).toBe(200);
    }
    expect((await recoveryRequest(KNOWN.email, DEVICE_A, 'thr-domain-4')).status).toBe(429);

    // Sign-in on the SAME pair is untouched by the recovery throttle's rows —
    // wrong-password fails with the generic 401 (credential semantics), not
    // the throttle's 429.
    const signin = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', DEVICE_A)
      .send({ identifier: KNOWN.email, password: 'definitely-wrong-password' });
    expect(signin.status).toBe(401);
    expect(signin.body['code']).toBe('UNAUTHENTICATED');

    // Reverse direction (pre-existing posture, unchanged): trip the
    // CREDENTIAL lockout on a fresh pair, then a recovery request on that
    // pair is blocked by the credential lock with the same generic 429.
    const freshDevice = 'throttle-device-F';
    for (let i = 1; i <= 3; i += 1) {
      await request(app.getHttpServer())
        .post('/identity/signin')
        .set('X-Device-Id', freshDevice)
        .send({ identifier: KNOWN.email, password: 'definitely-wrong-password' })
        .expect(401);
    }
    const credentialLockedRecovery = await recoveryRequest(KNOWN.email, freshDevice, 'thr-domain-5');
    expect(credentialLockedRecovery.status).toBe(429);
    expect(credentialLockedRecovery.body['code']).toBe('RATE_LIMITED');

    // And with the pair credential-locked, sign-in with VALID credentials
    // still fails closed to 429 (the frozen lockout observable).
    const validCreds = await request(app.getHttpServer())
      .post('/identity/signin')
      .set('X-Device-Id', freshDevice)
      .send({ identifier: KNOWN.email, password: PASSWORD });
    expect(validCreds.status).toBe(429);
  });

  it('200-path equivalence holds with the throttle in place (equalization posture preserved)', async () => {
    await app.close();
    app = await bootApp({ threshold: '50', windowSeconds: '3600' });
    const freshDevice = 'throttle-device-EQ';
    const knownRes = await recoveryRequest(KNOWN.email, freshDevice, 'thr-eq-probe');
    const unknownRes = await recoveryRequest(UNKNOWN_EMAIL, freshDevice, 'thr-eq-probe');
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    expect(knownRes.text).toBe(unknownRes.text);
  });
});
