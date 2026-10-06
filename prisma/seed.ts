/**
 * Kal — database seed scaffold (Wave 1, lane s1-schema).
 *
 * FIXTURES ONLY. Everything below is synthetic: fabricated UUIDs reserved for
 * fixtures, invented weights, a fake actor. No real identities, no real
 * credentials or secrets, no real health content (PLAN.md §2.10 / CLAUDE.md).
 *
 * Purpose in Wave 1: prove the seed pattern (Prisma client + idempotent upserts)
 * and provide the synthetic owner rows the RLS pilot demonstration uses. Domain
 * fixtures land with their waves and follow this same shape.
 *
 * Run (local dev only — refuses to run against anything but localhost):
 *   node prisma/seed.ts          # Node 24+ runs TypeScript directly
 *   pnpm dlx tsx prisma/seed.ts  # alternative runner
 *
 * Requires `@prisma/adapter-pg` (Prisma 7's prisma-client generator is
 * adapter-based — see README "Local database"). Requested from w01-s2-infra
 * as a shared-surface dependency addition.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

/** Fixture owner A — synthetic UUID reserved for fixtures, not a real account. */
const FIXTURE_OWNER_A = "00000000-0000-4000-8000-0000000000a1";
/** Fixture owner B — synthetic UUID reserved for fixtures, not a real account. */
const FIXTURE_OWNER_B = "00000000-0000-4000-8000-0000000000b2";
/** Fixture row ids — fixed so re-runs upsert instead of duplicating. */
const FIXTURE_WEIGHT_A = "00000000-0000-4000-8000-0000000000fa";
const FIXTURE_WEIGHT_B = "00000000-0000-4000-8000-0000000000fb";
const FIXTURE_AUDIT = "00000000-0000-4000-8000-0000000000fe";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function assertLocalDev(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "";
  }
  if (!raw || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    console.error(
      "seed: refusing to run — DATABASE_URL is missing or does not point at localhost. " +
        "Seed fixtures are for local development only.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Synthetic weigh-ins: one per fixture owner. Values are invented; nothing
  // here is a real person's measurement.
  await prisma.weightLog.upsert({
    where: { id: FIXTURE_WEIGHT_A },
    update: { weightKg: 82.5 },
    create: {
      id: FIXTURE_WEIGHT_A,
      ownerId: FIXTURE_OWNER_A,
      recordedAt: new Date("2026-10-01T08:00:00Z"),
      weightKg: 82.5,
    },
  });
  await prisma.weightLog.upsert({
    where: { id: FIXTURE_WEIGHT_B },
    update: { weightKg: 74.3 },
    create: {
      id: FIXTURE_WEIGHT_B,
      ownerId: FIXTURE_OWNER_B,
      recordedAt: new Date("2026-10-02T08:00:00Z"),
      weightKg: 74.3,
    },
  });

  // One synthetic audit event so the append-only path has a fixture row.
  await prisma.auditEvent.upsert({
    where: { id: FIXTURE_AUDIT },
    update: {}, // append-only: a replayed seed never rewrites history
    create: {
      id: FIXTURE_AUDIT,
      actor: "fixture:seed",
      action: "fixture.seed.applied",
      target: `fixture:weight_log:${FIXTURE_WEIGHT_A}`,
      justification: "Seed scaffold demonstration — synthetic fixtures only (no real data).",
    },
  });

  const weights = await prisma.weightLog.count();
  const audits = await prisma.auditEvent.count();
  console.log(`seed: fixtures in place (weight_log=${weights}, audit_events=${audits})`);
}

assertLocalDev();
main()
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error("seed failed:", error instanceof Error ? error.message : error);
    void prisma.$disconnect();
    process.exit(1);
  });
