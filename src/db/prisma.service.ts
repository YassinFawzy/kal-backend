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
 * Scope note (W1): this service is infrastructure plumbing. Request-scope
 * data access against owned tables (with `SET ROLE kal_app` + owner GUC per
 * the README "Roles & row-level security" pattern) lands with the first
 * owner-data wave (W2/W3); nothing in W1 touches consumer-owned tables.
 */
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { Prisma } from '../../generated/prisma/client.ts';
import { ConfigService } from '../config/config.service.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(config: ConfigService) {
    this.client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: config.databaseUrl }),
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
