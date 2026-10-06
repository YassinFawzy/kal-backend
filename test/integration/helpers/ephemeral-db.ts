/**
 * Ephemeral-database lifecycle for the W1 A/B/C isolation harness (task s4).
 *
 * The pattern every later wave reuses (PLAN.md §4 W1; ARCHITECTURE.md §11/§22;
 * ADR-0002 "Policies ship as migrations so every ephemeral test database
 * receives them automatically"):
 *
 *   1. CREATE DATABASE — one fresh scratch database per suite, named
 *      `kal_it_<label>_<rand>`. The dev `kal` database is NEVER touched
 *      (name guarded below); no databases are shared between suites.
 *   2. Migrations — the FULL history is applied by the real Prisma migration
 *      runner (`prisma migrate deploy`), as the admin/migration user from
 *      DATABASE_URL. Production-faithful: the same path used everywhere.
 *   3. Behavioral assertions — NEVER run over the admin connection's implicit
 *      superuser authority: use `helpers/acting-owner.ts`, which SET ROLEs to
 *      `kal_app`/`kal_platform` and asserts `current_user` first. Superusers
 *      bypass row security unconditionally, so a superuser assertion is proof
 *      of nothing (README "Roles & row-level security").
 *   4. DROP DATABASE ... WITH (FORCE) — the scratch database is destroyed
 *      afterwards; nothing survives the suite.
 *
 * Secrets never reach logs: the one boundary that could echo credentials (the
 * spawned migration runner's output) is redacted against the URL and its
 * password before any output is returned or surfaced.
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { Pool, type Client, type QueryResult, type QueryResultRow } from 'pg';

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve('prisma/build/index.js');

/** The dev database name — the harness must never create, touch, or drop it. */
const DEV_DATABASE_NAME = 'kal';

export interface MigrationApplyResult {
  readonly exitCode: number;
  /** Redacted runner output — safe to print in suite logs / evidence. */
  readonly stdout: string;
  readonly stderr: string;
}

export interface EphemeralKalDb {
  /** Scratch database name (`kal_it_<label>_<rand>`). */
  readonly name: string;
  /** Pooled connections to the scratch DB as the admin user. Behavioral tests must go through acting-owner helpers. */
  readonly pool: Pool;
  /**
   * Apply the full migration history with the real Prisma runner.
   * Throws (with redacted output) when the runner exits non-zero.
   */
  applyMigrations(): MigrationApplyResult;
  /**
   * Open a DEDICATED connection (outside the pool) to the scratch database.
   * Used for session-state semantics probes (e.g. GUC unset-vs-empty-string
   * behavior, which depends on what a specific session has set before).
   * The caller MUST call `end()` on the returned handle.
   */
  connectIsolated(): Promise<IsolatedClient>;
  /** Drop the scratch database (WITH FORCE) and close the pool. */
  drop(): Promise<void>;
}

/** Minimal dedicated-connection handle (subset of pg.Client used by the harness). */
export interface IsolatedClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

/** Load DATABASE_URL (via .env — see README) and refuse to continue without it. */
function resolveDatabaseUrl(): URL {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(
      'DATABASE_URL is not set — the isolation harness needs the admin/migration user URL from .env ' +
        '(README "Local database"). If no local PostgreSQL is reachable, this is an E7 escalation.',
    );
  }
  const url = new URL(raw);
  // The DEV database name in this URL is only the SOURCE of the connection
  // shape (host/port/user); scratch databases are always freshly named
  // `kal_it_<label>_<rand>` and guarded below — `kal` itself is never touched.
  if (url.pathname.length <= 1) {
    throw new Error('DATABASE_URL must name a database (empty path — malformed connection string)');
  }
  return url;
}

/** Admin connection target: same credentials, `postgres` maintenance database (CREATE/DROP DATABASE cannot run inside a transaction). */
function toAdminUrl(dbUrl: URL): URL {
  const admin = new URL(dbUrl.toString());
  admin.pathname = '/postgres';
  return admin;
}

function redact(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) {
    if (needle.length > 0) {
      out = out.split(needle).join('[redacted]');
    }
  }
  return out;
}

/** CREATE DATABASE cannot run in a transaction — pg runs it in implicit autocommit here. */
async function createScratchDatabase(adminUrl: URL, name: string): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${JSON.stringify(name)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Create (but do not migrate) one scratch database. Throws before any server
 * side effect when the name guard or URL guard fails.
 */
export async function createEphemeralKalDb(label: string): Promise<EphemeralKalDb> {
  const dbUrl = resolveDatabaseUrl();
  const adminUrl = toAdminUrl(dbUrl);
  const name = `kal_it_${label}_${randomBytes(4).toString('hex')}`;
  if (!name.startsWith('kal_it_') || name === DEV_DATABASE_NAME) {
    throw new Error(`scratch database name guard failed: ${name}`);
  }

  await createScratchDatabase(adminUrl, name);
  // eslint-disable-next-line no-console -- lifecycle must be visible in gate logs (PLAN.md §4 W1 evidence)
  console.log(`[kal-it] created ephemeral database ${name}`);

  const scratchUrl = new URL(dbUrl.toString());
  scratchUrl.pathname = `/${name}`;
  const secretNeedles = [scratchUrl.toString(), decodeURIComponent(scratchUrl.password), decodeURIComponent(dbUrl.password)];

  const pool = new Pool({ connectionString: scratchUrl.toString(), max: 5 });

  const connectIsolated = async (): Promise<IsolatedClient> => {
    const { Client: PgClient } = (await import('pg')) as { Client: typeof Client };
    const client = new PgClient({ connectionString: scratchUrl.toString() });
    await client.connect();
    return client as unknown as IsolatedClient;
  };

  const applyMigrations = (): MigrationApplyResult => {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      stdout = execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = err.status ?? 1;
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? '';
    }
    const result: MigrationApplyResult = {
      exitCode,
      stdout: redact(stdout, secretNeedles),
      stderr: redact(stderr, secretNeedles),
    };
    if (exitCode !== 0) {
      throw new Error(`prisma migrate deploy failed on ${name} (exit ${exitCode}):\n${result.stdout}\n${result.stderr}`);
    }
    return result;
  };

  const drop = async (): Promise<void> => {
    await pool.end().catch(() => undefined);
    const { Client } = await import('pg');
    const client = new Client({ connectionString: adminUrl.toString() });
    try {
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${JSON.stringify(name)} WITH (FORCE)`);
    } finally {
      await client.end().catch(() => undefined);
    }
    // eslint-disable-next-line no-console -- lifecycle must be visible in gate logs
    console.log(`[kal-it] dropped ephemeral database ${name}`);
  };

  return { name, pool, applyMigrations, connectIsolated, drop };
}

/** Convenience: run one query on the admin pool (catalog introspection only — never behavioral row-security assertions). */
export async function adminQuery<R extends QueryResultRow = QueryResultRow>(
  db: EphemeralKalDb,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  return db.pool.query<R>(text, params);
}
