/**
 * Kal — Prisma access over the pg driver adapter.
 *
 * Prisma 7's `prisma-client` generator is adapter-based: the client is
 * instantiated with `@prisma/adapter-pg` wrapping the repository's existing
 * `pg` dependency (routed shared-surface request from s1-schema). The
 * connection is lazy — construction does not dial the database, so boot
 * succeeds even when PostgreSQL is briefly unreachable; readiness is
 * reported by the health module's readiness check instead of crashing the
 * process (conventions.md §6.2 `health.readiness`).
 *
 * F-W2-1 (G2 carryover, mandatory — wave-02 ledger §10): the adapter parses
 * every timestamptz with its own text parser, which REWRITES the trailing
 * offset to `+00:00` without converting wall-clock time
 * (`@prisma/adapter-pg` `normalize_timestamptz`). On a session whose
 * TimeZone is not UTC (this dev cluster defaults to Africa/Cairo, +03), a
 * stored instant therefore reads back shifted (+3 h here). The systemic fix
 * is at the POOL level: every pooled connection passes
 * `options: '-c timezone=UTC'` as a startup parameter, so the server renders
 * every timestamptz as UTC and the adapter's offset rewrite is a no-op —
 * exactly the invariant identity's per-transaction `set_config('TimeZone',
 * 'UTC', true)` pins established empirically (they stay: harmless, and the
 * belt to this suspenders). The identity-tz e2e probe (non-UTC cluster
 * default) and the integration regression (`prisma-utc.itspec.ts`) pin the
 * round-trip.
 *
 * The pool is constructed explicitly (rather than a bare connection string)
 * so the startup options apply to every connection the pool opens, and
 * `disposeExternalPool: true` keeps the previous shutdown semantics: the
 * adapter's dispose ends OUR pool when `PrismaService` disconnects.
 *
 * Scope note: this service is infrastructure plumbing. Request-scope data
 * access against owned tables (with `SET ROLE kal_app` + the per-user GUC
 * per the README "Roles & row-level security" pattern) is established by the
 * identity module's `inAppRoleTx` posture and reused by every later module.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { Prisma } from '../../generated/prisma/client.ts';
import { ConfigService } from '../config/config.service.js';

/**
 * The F-W2-1 startup parameter (pinned by `prisma.service.spec.ts`; the
 * behavioral proof is `test/integration/prisma-utc.itspec.ts`): forces the
 * server-side session TimeZone to UTC on every pooled connection, so
 * adapter-pg's timestamptz offset rewrite (`normalize_timestamptz`) is a
 * no-op and reads are UTC-correct regardless of the cluster's default zone.
 */
export const PRISMA_POOL_UTC_STARTUP_OPTIONS = '-c timezone=UTC';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(config: ConfigService) {
    const pool = new Pool({
      connectionString: config.databaseUrl,
      // F-W2-1: force every pooled connection's session TimeZone to UTC at
      // startup (see the class doc — the adapter-pg offset-rewrite hazard).
      options: PRISMA_POOL_UTC_STARTUP_OPTIONS,
    });
    this.client = new PrismaClient({
      adapter: new PrismaPg(pool, { disposeExternalPool: true }),
    });
  }

  /** Cheap liveness probe for the database (readiness check). */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  /**
   * Unit-of-work: one transaction per command (ARCHITECTURE §9). Command
   * handlers run their writes — including audit appends — inside this
   * transaction so an audit failure rolls back the commanding mutation.
   */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(work);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
