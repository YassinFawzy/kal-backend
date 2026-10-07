/**
 * F-W2-1 unit pins — the systemic UTC fix in PrismaService (G2 carryover,
 * wave-02 ledger §10: "Prisma 7 + adapter-pg reads shifted +3 h on this +03
 * cluster").
 *
 * The hazard: @prisma/adapter-pg parses timestamptz results with its own
 * text parser, which rewrites the trailing offset to `+00:00` WITHOUT
 * converting wall-clock time (`normalize_timestamptz`) — correct only when
 * the server renders UTC. The fix pins the pool-level startup option that
 * makes every pooled session render timestamptz as UTC.
 *
 * These unit pins cover what needs no database: the startup-option constant
 * (source of truth) and construction over the explicit pool (smoke — the
 * lazy connection must still boot without dialing). The behavioral proof —
 * exact round-trip through the adapter on the non-UTC dev cluster, with a
 * detectability control — is `test/integration/prisma-utc.itspec.ts`, and
 * the e2e `identity-tz` suite re-proves the identity surfaces end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service.js';
import { PRISMA_POOL_UTC_STARTUP_OPTIONS, PrismaService } from './prisma.service.js';

/** Placeholder-free fixture URL (I15) — construction never dials the database. */
const FIXTURE_DATABASE_URL = 'postgresql://kal_dev:syntheticfixturepw@localhost:5432/kal';

describe('PrismaService F-W2-1 construction pins', () => {
  it('pins the UTC startup option (the mechanism that defeats the adapter-pg offset rewrite)', () => {
    expect(PRISMA_POOL_UTC_STARTUP_OPTIONS).toBe('-c timezone=UTC');
  });

  it('constructs over the explicit UTC pool without dialing the database', () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = FIXTURE_DATABASE_URL;
    try {
      const service = new PrismaService(new ConfigService());
      expect(service.client).toBeDefined();
      expect(typeof service.transaction).toBe('function');
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previous;
      }
    }
  });
});
