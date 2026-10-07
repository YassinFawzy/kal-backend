/**
 * Kal identity TIMING-equivalence e2e (wave-02, task s4-adversarial) — the
 * measured half of the enumeration-equivalence requirement (contract §3:
 * "byte-identical and timing-equalized"; PRD §8: "Enumeration via error
 * differentiation, timing, … is treated as a defect").
 *
 * Methodology (justified in the MR with the measured margins):
 *   - Warmup: the unknown path lazily mints its dummy argon2id hash on FIRST
 *     use (~one full hash cost); the dummy hash + JIT/allocator effects are
 *     warmed with discarded attempts before any sample is taken.
 *   - Interleaving: samples alternate unknown/known within one loop, so CPU
 *     frequency drift, background suites (e2e files run in parallel), and
 *     allocator state hit both sides symmetrically.
 *   - Fresh (identifier, device) pairs per sample: a repeated pair would lock
 *     at 3 failures, and LOCKED pairs skip the argon2 work entirely — the
 *     samples must all measure the pre-lock equalized path.
 *   - Statistic: per-side MEDIAN of R samples (odd R, robust to scheduler
 *     outliers); assertions compare median deltas against tolerances set
 *     from measured margins with ≥2× headroom (recorded in the MR). Raw
 *     samples are printed for the evidence pack.
 *   - The recovery REQUEST path is asserted within tolerance like the rest
 *     (round-2 strengthening): pre-fix it measured a stable ~1.8–2.3× gap
 *     (F-S4-1b, routed); the eq-fix lane's issuance mirror (fba321d, merged
 *     b31f15c) equalized it — s4 re-measured |median delta| ≤ 1.20 ms across
 *     five fresh runs (direction flips between runs — no oracle side) and
 *     now ASSERTS the equalized invariant. History note retained for
 *     provenance: this case originally measured-and-reported, never blessed.
 *
 * Every response in a measured pair is ALSO raw-byte-compared (pinned
 * X-Request-Id) — timing is never asserted on bodies that differ.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from './integration/helpers/ephemeral-db.js';

const SIGNING_KEY = 's4e4timing9lane4fixed4key4material4with4enough4entropy00';
const PIN_ID = 's4 timing-equivalence pinned request id';

const PASSWORD = 's4-timing-e2e-password';
const KNOWN_EMAIL = 's4-timing-known@example.com';
const KNOWN_PHONE = '+201800000001';
const KNOWN_USERNAME = 's4_timing_known';
const UNKNOWN_EMAIL = 's4-timing-ghost@example.com';
const UNKNOWN_USERNAME = 's4_timing_ghost';
const UNKNOWN_PHONE = '+201800000099';

/** Tolerances — set from the measured margins of this suite's evidence runs (see MR). */
const TOLERANCES = {
  /** sign-in unknown vs wrong-password: equalized argon2id work. */
  signinMedianDeltaMs: 30,
  /** locked-pair 429s: both sides skip argon2 — tight bound. */
  lockedMedianDeltaMs: 10,
  /** signup fresh vs duplicate: same hash-then-transaction shape. */
  signupMedianDeltaMs: 30,
  /** recovery request known vs unknown post-equalization (F-S4-1b fixed by
   *  fba321d): fresh margins |median delta| ≤ 1.20 ms over 5 runs — ceiling
   *  = 3 ms (2.5× the worst observed, still below the worst pre-fix median). */
  recoveryMedianDeltaMs: 3,
} as const;

const ROUNDS_SIGNIN = 11;
const ROUNDS_LOCKED = 7;
const ROUNDS_SIGNUP = 9;
const ROUNDS_RECOVERY = 15;

let app: INestApplication<App>;
let db: EphemeralKalDb;
let deviceCounter = 0;

function freshDevice(tag: string): string {
  deviceCounter += 1;
  return `s4t-${tag}-${deviceCounter}`;
}

function pin(test: request.Test): request.Test {
  return test.set('X-Request-Id', PIN_ID);
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

async function timedRequest(run: () => Promise<request.Response>): Promise<{ response: request.Response; elapsedMs: number }> {
  const started = performance.now();
  const response = await run();
  return { response, elapsedMs: performance.now() - started };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function spread(samples: readonly number[]): { min: number; max: number; p25: number; p75: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] as number;
  return { min: sorted[0] as number, max: sorted[sorted.length - 1] as number, p25: at(0.25), p75: at(0.75) };
}

function reportMargins(label: string, a: readonly number[], b: readonly number[], nameA: string, nameB: string): {
  medianA: number;
  medianB: number;
  delta: number;
} {
  const medianA = median(a);
  const medianB = median(b);
  const marginA = spread(a);
  const marginB = spread(b);
  const lines = [
    `[timing] ${label}`,
    `  ${nameA}: median=${medianA.toFixed(2)}ms p25=${marginA.p25.toFixed(2)} p75=${marginA.p75.toFixed(2)} min=${marginA.min.toFixed(2)} max=${marginA.max.toFixed(2)}`,
    `  ${nameB}: median=${medianB.toFixed(2)}ms p25=${marginB.p25.toFixed(2)} p75=${marginB.p75.toFixed(2)} min=${marginB.min.toFixed(2)} max=${marginB.max.toFixed(2)}`,
    `  median delta=${Math.abs(medianA - medianB).toFixed(2)}ms`,
  ];
  // process.stdout (not console): vitest intercepts console and hides
  // passing-test logs — the margins ARE the evidence and must always print.
  process.stdout.write(`${lines.join('\n')}\n`);
  return { medianA, medianB, delta: Math.abs(medianA - medianB) };
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4time');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  app = await bootApp({ DATABASE_URL: url.toString(), IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY, NODE_ENV: 'test' });

  // Fixture account for the "known" side.
  const signup_ = await pin(request(app.getHttpServer()).post('/identity/signup')).send({
    email: KNOWN_EMAIL,
    phone: KNOWN_PHONE,
    username: KNOWN_USERNAME,
    password: PASSWORD,
  });
  expect(signup_.status).toBe(200);

  // WARMUP (discarded): one known-path failure, one unknown-path failure —
  // the unknown attempt lazily mints the dummy argon2id hash, which must NOT
  // land inside a measured sample — and one signup, to stabilize allocator/JIT.
  const warmWrong = await pin(request(app.getHttpServer()).post('/identity/signin'))
    .set('X-Device-Id', freshDevice('warm'))
    .send({ identifier: KNOWN_EMAIL, password: 'warmup-wrong-password' });
  const warmUnknown = await pin(request(app.getHttpServer()).post('/identity/signin'))
    .set('X-Device-Id', freshDevice('warm'))
    .send({ identifier: UNKNOWN_EMAIL, password: 'warmup-wrong-password' });
  const warmSignup = await pin(request(app.getHttpServer()).post('/identity/signup')).send({
    email: 's4-timing-warmup@example.com',
    phone: '+201800000002',
    username: 's4_timing_warmup',
    password: PASSWORD,
  });
  expect(warmWrong.status).toBe(401);
  expect(warmUnknown.status).toBe(401);
  expect(warmSignup.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

// ---------------------------------------------------------------------------

describe('timing-equalized enumeration observables (contract §3)', () => {
  it('sign-in: unknown identifier vs wrong password — interleaved medians within tolerance; bodies raw-identical throughout', async () => {
    const unknownSamples: number[] = [];
    const knownSamples: number[] = [];
    let reference401Text: string | null = null;

    for (let round = 0; round < ROUNDS_SIGNIN; round += 1) {
      const password = `s4-wrong-password-round-${round}`;
      // Interleave: unknown first, known second — alternation nulls drift.
      const unknown = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signin'))
          .set('X-Device-Id', freshDevice('t-unknown'))
          .send({ identifier: round % 2 === 0 ? UNKNOWN_EMAIL : UNKNOWN_USERNAME, password }),
      );
      const known = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signin'))
          .set('X-Device-Id', freshDevice('t-known'))
          .send({ identifier: round % 2 === 0 ? KNOWN_EMAIL : KNOWN_USERNAME, password }),
      );
      expect(unknown.response.status).toBe(401);
      expect(known.response.status).toBe(401);
      // Raw-byte equivalence travels WITH the timing assertion.
      if (reference401Text === null) {
        reference401Text = unknown.response.text;
      }
      expect(known.response.text).toBe(reference401Text);
      expect(unknown.response.text).toBe(reference401Text);
      unknownSamples.push(unknown.elapsedMs);
      knownSamples.push(known.elapsedMs);
    }

    const { delta } = reportMargins('sign-in unknown vs wrong-password', unknownSamples, knownSamples, 'unknown', 'wrong-pw');
    expect(delta, `median delta ${delta.toFixed(2)}ms must be ≤ ${TOLERANCES.signinMedianDeltaMs}ms (equalized argon2id work)`).toBeLessThanOrEqual(
      TOLERANCES.signinMedianDeltaMs,
    );
    // Distribution guard: a catastrophic scheduling anomaly on one side shows
    // up as an implausible interquartile spread — flagged, never hidden.
    for (const [name, samples] of [
      ['unknown', unknownSamples],
      ['wrong-pw', knownSamples],
    ] as const) {
      const margins = spread(samples);
      expect(margins.max - margins.min, `${name} sample spread sanity (scheduler anomaly guard)`).toBeLessThan(2000);
    }
  });

  it('locked pairs (429 path): unknown vs known — both skip argon2; medians within the tight tolerance; bodies raw-identical', async () => {
    // Lock one known-identifier pair and one unknown-identifier pair.
    const knownDevice = `s4t-locked-known-${deviceCounter + 1}`;
    const unknownDevice = `s4t-locked-unknown-${deviceCounter + 1}`;
    deviceCounter += 2;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const known = await pin(request(app.getHttpServer()).post('/identity/signin'))
        .set('X-Device-Id', knownDevice)
        .send({ identifier: KNOWN_EMAIL, password: 's4-lock-it-now-01' });
      const unknown = await pin(request(app.getHttpServer()).post('/identity/signin'))
        .set('X-Device-Id', unknownDevice)
        .send({ identifier: UNKNOWN_EMAIL, password: 's4-lock-it-now-01' });
      expect(known.status).toBe(401);
      expect(unknown.status).toBe(401);
    }

    const unknownSamples: number[] = [];
    const knownSamples: number[] = [];
    let reference429Text: string | null = null;
    for (let round = 0; round < ROUNDS_LOCKED; round += 1) {
      const unknown = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signin'))
          .set('X-Device-Id', unknownDevice)
          .send({ identifier: UNKNOWN_EMAIL, password: PASSWORD }),
      );
      const known = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signin'))
          .set('X-Device-Id', knownDevice)
          .send({ identifier: KNOWN_EMAIL, password: PASSWORD }),
      );
      expect(unknown.response.status).toBe(429);
      expect(known.response.status).toBe(429);
      if (reference429Text === null) {
        reference429Text = known.response.text;
      }
      expect(unknown.response.text).toBe(reference429Text);
      expect(known.response.text).toBe(reference429Text);
      unknownSamples.push(unknown.elapsedMs);
      knownSamples.push(known.elapsedMs);
    }

    const { delta } = reportMargins('locked-pair 429 unknown vs known', unknownSamples, knownSamples, 'unknown-locked', 'known-locked');
    expect(delta, `locked-path median delta ${delta.toFixed(2)}ms must be ≤ ${TOLERANCES.lockedMedianDeltaMs}ms`).toBeLessThanOrEqual(
      TOLERANCES.lockedMedianDeltaMs,
    );
  });

  it('signup: fresh account vs duplicate identifier — the duplicate observable costs the same hash-then-transaction work', async () => {
    const freshSamples: number[] = [];
    const duplicateSamples: number[] = [];
    const acceptedText = '{"status":"accepted"}';

    for (let round = 0; round < ROUNDS_SIGNUP; round += 1) {
      const fresh = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signup')).send({
          email: `s4-timing-fresh-${round}@example.com`,
          phone: `+2018100${String(round).padStart(5, '0')}`,
          username: `s4_timing_fresh_${round}`,
          password: PASSWORD,
        }),
      );
      const duplicate = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/signup')).send({
          email: KNOWN_EMAIL, // duplicate email — generic success, no row
          phone: `+2018200${String(round).padStart(5, '0')}`,
          username: `s4_timing_dup_${round}`,
          password: PASSWORD,
        }),
      );
      expect(fresh.response.status).toBe(200);
      expect(duplicate.response.status).toBe(200);
      expect(fresh.response.text).toBe(acceptedText);
      expect(duplicate.response.text).toBe(acceptedText);
      freshSamples.push(fresh.elapsedMs);
      duplicateSamples.push(duplicate.elapsedMs);
    }

    const { delta } = reportMargins('signup fresh vs duplicate', freshSamples, duplicateSamples, 'fresh', 'duplicate');
    expect(delta, `signup median delta ${delta.toFixed(2)}ms must be ≤ ${TOLERANCES.signupMedianDeltaMs}ms`).toBeLessThanOrEqual(
      TOLERANCES.signupMedianDeltaMs,
    );
  });

  it('F-S4-1b (post-fix, ASSERTED): recovery request known vs unknown — equalized medians within tolerance; bodies raw-identical', async () => {
    // Pre-fix this case measured-and-reported a ~1.8–2.3× gap (F-S4-1b,
    // routed — never blessed here). The eq-fix lane's issuance mirror
    // (fba321d, merged b31f15c) gives the unknown path the known path's
    // INSERT shape + a committed 1-row pool UPDATE + the real COMMIT WAL
    // flush; s4 re-measured on the fixed tree and now ASSERTS the equalized
    // invariant. The frozen observable stays the byte-identical
    // `{"status":"accepted"}` — asserted below alongside the timing bound.
    // Discarded warmup pair first: the mirror's supporting state (sentinel
    // user + 256-row pool) is bootstrapped lazily on the FIRST unknown
    // request of a process — that one-time cost must not land in a sample.
    const warmRecUnknown = await pin(request(app.getHttpServer()).post('/identity/recovery/request'))
      .set('X-Device-Id', freshDevice('warm-rec-unknown'))
      .send({ identifier: UNKNOWN_EMAIL });
    const warmRecKnown = await pin(request(app.getHttpServer()).post('/identity/recovery/request'))
      .set('X-Device-Id', freshDevice('warm-rec-known'))
      .send({ identifier: KNOWN_EMAIL });
    expect(warmRecUnknown.status).toBe(200);
    expect(warmRecKnown.status).toBe(200);

    const unknownSamples: number[] = [];
    const knownSamples: number[] = [];
    const acceptedText = '{"status":"accepted"}';

    for (let round = 0; round < ROUNDS_RECOVERY; round += 1) {
      const unknown = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/recovery/request'))
          .set('X-Device-Id', freshDevice('t-rec-unknown'))
          .send({ identifier: round % 2 === 0 ? UNKNOWN_EMAIL : UNKNOWN_PHONE }),
      );
      const known = await timedRequest(() =>
        pin(request(app.getHttpServer()).post('/identity/recovery/request'))
          .set('X-Device-Id', freshDevice('t-rec-known'))
          .send({ identifier: round % 2 === 0 ? KNOWN_EMAIL : KNOWN_PHONE }),
      );
      expect(unknown.response.status).toBe(200);
      expect(known.response.status).toBe(200);
      expect(unknown.response.text).toBe(acceptedText);
      expect(known.response.text).toBe(acceptedText);
      unknownSamples.push(unknown.elapsedMs);
      knownSamples.push(known.elapsedMs);
    }

    const { medianA, medianB, delta } = reportMargins(
      'recovery request known vs unknown (F-S4-1b, post-fix asserted)',
      knownSamples,
      unknownSamples,
      'known',
      'unknown',
    );
    expect(
      delta,
      `recovery-request median delta ${delta.toFixed(2)}ms must be ≤ ${TOLERANCES.recoveryMedianDeltaMs}ms (equalized by the fba321d issuance mirror)`,
    ).toBeLessThanOrEqual(TOLERANCES.recoveryMedianDeltaMs);
    process.stdout.write(
      `[timing] F-S4-1b summary: known median ${medianA.toFixed(2)}ms vs unknown ${medianB.toFixed(2)}ms — delta ${delta.toFixed(2)}ms (asserted ≤ ${TOLERANCES.recoveryMedianDeltaMs}ms)\n`,
    );
  });
});
