/**
 * Kal — w3 soak harness RUNNER (test/e2e/w3-soak/**).
 *
 * The release-gate replay/soak: boots the REAL AppModule on an ephemeral
 * PostgreSQL database behind a real HTTP listener, emulates sync clients
 * over the wire through the fault-injection proxy, and runs the six
 * release-gate profiles to the zero-duplicates/zero-losses/convergence
 * invariants. Headless; bounded (minutes); deterministic; rerunnable — the
 * GR gate re-runs this exact invocation (see the MR for the command).
 *
 * INVOCATION (from repositories/kal-backend):
 *   pnpm vitest run --config test/e2e/w3-soak/vitest.w3-soak.config.ts
 *
 * The harness audits the live system; it imports NOTHING from src/sync or
 * src/tracking for its expectations — the oracle transcribes the frozen
 * contract (`docs/api/wave-03-contract.md`) independently.
 */
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types.js';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AppModule } from '../../../src/app.module.js';
import { READINESS_CHECKS } from '../../../src/health/readiness.js';
import { createEphemeralKalDb, type EphemeralKalDb } from '../../integration/helpers/ephemeral-db.js';
import { applyFoodCatalogSeed } from '../../../prisma/seed-apply.ts';
import { PrismaClient } from '../../../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { EmulatedDevice } from './harness/device.js';
import { FaultProxy } from './harness/faults.js';
import { InvariantChecker, ObserverClient, SyncOracle, type DatabaseProbe, type ExpectedRejection, type ProfileReportRow, type SoakUserProfile } from './harness/invariants.js';
import { printHeader, printProfileChecks, printProfileTable, printVerdict } from './harness/report.js';
import { PROFILE_DEFINITIONS, proxiedNetwork, type ProfileRunContext, type UserHandle } from './profiles.js';
import { makeRng, makeUserCredentials, type SoakUserCredentials } from './harness/support.js';

const SIGNING_KEY = 's4b4soak7harness9fixed4key4material4with4enough4entropy';
const RUN_SEED = 0x5be7; // the seed that makes every profile rerunnable

let db: EphemeralKalDb;
let app: INestApplication<App>;
let appBaseUrl = '';
let observer: ObserverClient;
let dbProbe: DatabaseProbe;
let reportRows: ProfileReportRow[] = [];
let totalViolations = 0;

async function bootApp(env: Record<string, string>): Promise<INestApplication<App>> {
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
    const booted = moduleFixture.createNestApplication();
    await booted.init();
    // The soak drives REAL http (fetch through the fault proxy), so unlike
    // the supertest suites this app binds an ephemeral loopback listener.
    await booted.listen(0, '127.0.0.1');
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

interface DirectHttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function directJson(method: 'POST' | 'GET', path: string, body?: unknown, headers?: Record<string, string>): Promise<DirectHttpResult> {
  const response = await fetch(`${appBaseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed: unknown = response.headers.get('content-type')?.includes('json') === true ? await response.json() : {};
  return { status: response.status, body: (parsed ?? {}) as Record<string, unknown> };
}

async function signup(credentials: SoakUserCredentials): Promise<void> {
  const result = await directJson('POST', '/identity/signup', {
    email: credentials.email,
    phone: credentials.phone,
    username: credentials.username,
    password: credentials.password,
  });
  expect(result.status).toBe(200);
}

async function signin(credentials: SoakUserCredentials, deviceLabel: string): Promise<string> {
  const result = await directJson('POST', '/identity/signin', { identifier: credentials.username, password: credentials.password }, { 'X-Device-Id': `soak-${deviceLabel}` });
  expect(result.status).toBe(200);
  const accessToken = result.body['accessToken'];
  if (typeof accessToken !== 'string') {
    throw new Error('signin returned no accessToken');
  }
  return accessToken;
}

async function userIdFor(token: string): Promise<string> {
  const result = await directJson('GET', '/identity/me', undefined, { Authorization: `Bearer ${token}` });
  expect(result.status).toBe(200);
  const user = result.body['user'] as { id?: string } | undefined;
  const id = user?.id;
  if (typeof id !== 'string') {
    throw new Error('/identity/me returned no user id');
  }
  return id;
}

interface RunnerState {
  readonly proxy: FaultProxy;
  readonly rng: () => number;
  readonly userCounter: { value: number };
  readonly users: UserHandle[];
}

let runnerState: RunnerState | null = null;

async function provisionUser(tag: string, deviceLabels: string[], tuning?: Partial<{ maxOpsPerBatch: number; pullLimit: number; clientTimeoutMs: number }>): Promise<UserHandle> {
  const state = runnerState;
  if (state === null) {
    throw new Error('provisionUser called outside a profile run');
  }
  const credentials = makeUserCredentials(state.rng, `${tag}${String((state.userCounter.value += 1))}`);
  await signup(credentials);
  const devices: Record<string, EmulatedDevice> = {};
  const deviceTokens: Array<{ label: string; token: string }> = [];
  for (const label of deviceLabels) {
    const token = await signin(credentials, `${tag}-${label}`);
    deviceTokens.push({ label, token });
  }
  const userToken = deviceTokens[0]?.token ?? '';
  const userId = await userIdFor(userToken);
  for (const { label, token } of deviceTokens) {
    devices[label] = new EmulatedDevice(
      {
        label,
        deviceId: `soak-${tag}-${label}`,
        token,
        network: proxiedNetwork(state.proxy.baseUrl),
        maxOpsPerBatch: tuning?.maxOpsPerBatch ?? 30,
        clientTimeoutMs: tuning?.clientTimeoutMs ?? 4000,
        backoffBaseMs: 10,
        backoffCapMs: 160,
        maxAttempts: 8,
        pullLimit: tuning?.pullLimit ?? 50,
        maxPullPages: 200,
      },
      state.rng,
    );
  }
  const profile: SoakUserProfile = {
    label: tag,
    userId,
    token: userToken,
    devices: Object.values(devices),
    oracle: new SyncOracle(),
    expectedRejections: [],
  };
  const handle: UserHandle = {
    profile,
    devices,
    ops: new Map(),
    datesTouched: new Set<string>(),
    datesEmptied: new Set<string>(),
    expectedRejectionsExtra: [],
  };
  state.users.push(handle);
  return handle;
}

/** Replays the ORACLE over the proxy's recorded server-arrival order and collects the declared per-op outcomes. */
async function replayOracle(proxy: FaultProxy, users: UserHandle[]): Promise<ExpectedRejection[]> {
  const opOwner = new Map<string, { user: UserHandle; op: Parameters<SyncOracle['apply']>[0] }>();
  for (const user of users) {
    for (const [opId, op] of user.ops) {
      opOwner.set(opId, { user, op });
    }
  }
  const rejections: ExpectedRejection[] = [];
  const rejectedSeen = new Set<string>();
  for (const request of proxy.requests) {
    if (!request.forwarded || request.method !== 'POST' || !request.path.startsWith('/sync/ops')) {
      continue;
    }
    for (const opId of request.opIds) {
      const owner = opOwner.get(opId);
      if (owner === undefined) {
        throw new Error(`arrival log carries an op the harness never enqueued: ${opId}`);
      }
      const outcome = owner.user.profile.oracle.apply(owner.op);
      const rejectedCode = typeof outcome === 'string' ? null : outcome.rejected;
      if (rejectedCode !== null && !rejectedSeen.has(opId)) {
        rejectedSeen.add(opId);
        rejections.push({ opId, code: rejectedCode });
      }
    }
  }
  return rejections;
}

beforeAll(async () => {
  db = await createEphemeralKalDb('s4bsoak');
  db.applyMigrations();
  const url = new URL(process.env['DATABASE_URL'] as string);
  url.pathname = `/${db.name}`;
  const databaseUrl = url.toString();

  // Production-faithful catalog seeding (admin connection) — realistic
  // seed-pack food payloads per the launch context (s2a merged).
  const seedPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const seedClient = new PrismaClient({ adapter: new PrismaPg(seedPool, { disposeExternalPool: true }) });
  const seedResult = await applyFoodCatalogSeed(seedClient);
  expect(seedResult.foods).toBe(48);
  await seedClient.$disconnect();

  // The user-food limiter is raised for the soak (bounds-legal config
  // points): soak profiles must exercise idempotency/replay, not the
  // rate-limit surface (s4a's matrix owns that).
  app = await bootApp({
    DATABASE_URL: databaseUrl,
    IDENTITY_JWT_SIGNING_KEY: SIGNING_KEY,
    NODE_ENV: 'test',
    TRACKING_USER_FOOD_CREATE_MAX_PER_HOUR: '1000',
    TRACKING_USER_FOOD_CREATE_MAX_PER_DAY: '10000',
  });
  const address = (app.getHttpServer() as import('node:http').Server).address();
  if (address === null || typeof address === 'string') {
    throw new Error('soak app did not bind a tcp listener');
  }
  appBaseUrl = `http://127.0.0.1:${address.port}`;
  observer = new ObserverClient(appBaseUrl);
  const pool = db.pool;
  dbProbe = {
    async query<R extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
      const result = await pool.query(text, params as never[]);
      return { rows: result.rows as R[] };
    },
  };
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
}, 60_000);

describe('w3 soak harness — release-gate profiles (first green run; GR re-runs this)', () => {
  for (const definition of PROFILE_DEFINITIONS) {
    it(`profile ${definition.name}: ${definition.description}`, async () => {
      const proxy = new FaultProxy({ targetPort: Number(new URL(appBaseUrl).port), targetHost: '127.0.0.1' });
      await proxy.start();
      const checker = new InvariantChecker();
      const startedAt = Date.now();
      let runtimeMs = 0;
      const state: RunnerState = { proxy, rng: makeRng(RUN_SEED + definition.name.length * 7919 + definition.name.charCodeAt(0)), userCounter: { value: 0 }, users: [] };
      try {
        runnerState = state;
        const context: ProfileRunContext = {
          profileName: definition.name,
          rng: state.rng,
          proxy,
          observer,
          db: dbProbe,
          checker,
          provisionUser,
        };
        await definition.execute(context);
        const rejections = await replayOracle(proxy, state.users);
        for (const user of state.users) {
          const oracleRejections = rejections.filter((rejection) => user.ops.has(rejection.opId));
          const declared = user.expectedRejectionsExtra.filter((rejection) => !oracleRejections.some((oracleRejection) => oracleRejection.opId === rejection.opId));
          user.profile.expectedRejections = [...oracleRejections, ...declared];
        }
        // The invariant battery runs AFTER the oracle replay so the checker
        // sees the fully-replayed oracle (it validates oracle vs server vs
        // devices vs acks).
        await checker.runProfile({
          profileName: definition.name,
          users: state.users.map((handle) => handle.profile),
          db: dbProbe,
          observer,
          proxyFindings: proxy.findings,
          touchedDates: (profileUser) => [...(state.users.find((handle) => handle.profile === profileUser)?.datesTouched ?? [])],
          deletedDates: (profileUser) => [...(state.users.find((handle) => handle.profile === profileUser)?.datesEmptied ?? [])],
        });
      } finally {
        runtimeMs = Date.now() - startedAt;
        printProfileChecks(definition.name, checker.checks, checker.findings);
        const devices = state.users.flatMap((user) => Object.values(user.devices));
        reportRows = [
          ...reportRows,
          {
            profile: definition.name,
            users: state.users.length,
            devices: devices.length,
            opsEnqueued: devices.reduce((sum, device) => sum + device.ledger.length, 0),
            acksApplied: devices.reduce((sum, device) => sum + device.counters.acksApplied, 0),
            acksDuplicate: devices.reduce((sum, device) => sum + device.counters.acksDuplicate, 0),
            acksRejectedTerminal: devices.reduce((sum, device) => sum + device.counters.acksRejectedTerminal, 0),
            faultsDropsBefore: proxy.counters.dropsBefore,
            faultsDropsAfter: proxy.counters.dropsAfter,
            faultsStalls: proxy.counters.stalls,
            faultsRefused: proxy.counters.refused,
            faultsDuplicates: proxy.counters.duplicatesForwarded,
            byteIdenticalReplays: proxy.counters.byteIdenticalReplays,
            pushRetries: devices.reduce((sum, device) => sum + device.counters.pushRetries, 0),
            pullRetries: devices.reduce((sum, device) => sum + device.counters.pullRetries, 0),
            pagesPulled: devices.reduce((sum, device) => sum + device.counters.pagesPulled, 0),
            changesReceived: devices.reduce((sum, device) => sum + device.counters.changesReceived, 0),
            emptyPagesTolerated: devices.reduce((sum, device) => sum + device.counters.emptyPagesTolerated, 0),
            censusChanges: checker.censusChangesTotal,
            checks: checker.checks.length,
            violations: checker.violations.length,
            runtimeMs,
          },
        ];
        totalViolations += checker.violations.length;
        runnerState = null;
        await proxy.stop();
      }
      const formatted = checker.violations.length === 0 ? 'all invariants held' : `violations:\n${checker.violations.map((violation) => `  - ${violation}`).join('\n')}`;
      expect(checker.violations, formatted).toEqual([]);
    }, 300_000);
  }

  afterAll(() => {
    printHeader('pnpm vitest run --config test/e2e/w3-soak/vitest.w3-soak.config.ts', 'first green run record');
    printProfileTable(reportRows);
    printVerdict(reportRows, totalViolations, reportRows.reduce((sum, row) => sum + row.runtimeMs, 0));
  });
});
