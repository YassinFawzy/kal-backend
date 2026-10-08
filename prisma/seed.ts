/**
 * Kal — database seed scaffold (Wave 1, lane s1-schema).
 *
 * FIXTURES ONLY. Everything below is synthetic: fabricated UUIDs reserved for
 * fixtures, invented weights, a fake actor. No real identities, no real
 * credentials or secrets, no real health content (PLAN.md §2.10 / CLAUDE.md).
 *
 * Purpose in Wave 1: prove the seed pattern (Prisma client + idempotent upserts)
 * and provide the synthetic user rows the RLS pilot demonstration uses. Domain
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
import { applyFoodCatalogSeed } from "./seed-apply.ts";

/** Fixture user A — synthetic UUID reserved for fixtures, not a real account. */
const FIXTURE_USER_A = "00000000-0000-4000-8000-0000000000a1";
/** Fixture user B — synthetic UUID reserved for fixtures, not a real account. */
const FIXTURE_USER_B = "00000000-0000-4000-8000-0000000000b2";
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
  // Fixture users first: the W3 carryover added the retroactive weight_log
  // user FK (ON DELETE RESTRICT), so the synthetic weigh-ins below require
  // their owner rows to exist. NULL password = can never sign in (the schema
  // reserves NULL for the deferred social-login path); synthetic identifier
  // shapes satisfy the identity CHECK constraints. Nothing here is a real
  // account.
  for (const fixture of [
    { id: FIXTURE_USER_A, email: "seed-fixture-a@seed.invalid", username: "seed_fixture_a" },
    { id: FIXTURE_USER_B, email: "seed-fixture-b@seed.invalid", username: "seed_fixture_b" },
  ]) {
    await prisma.user.upsert({
      where: { id: fixture.id },
      update: {},
      create: {
        id: fixture.id,
        email: fixture.email,
        username: fixture.username,
        phone: null,
        passwordHash: null,
        status: "active",
      },
    });
  }

  // Synthetic weigh-ins: one per fixture user. Values are invented; nothing
  // here is a real person's measurement.
  await prisma.weightLog.upsert({
    where: { id: FIXTURE_WEIGHT_A },
    update: { weightKg: 82.5 },
    create: {
      id: FIXTURE_WEIGHT_A,
      userId: FIXTURE_USER_A,
      recordedAt: new Date("2026-10-01T08:00:00Z"),
      weightKg: 82.5,
    },
  });
  await prisma.weightLog.upsert({
    where: { id: FIXTURE_WEIGHT_B },
    update: { weightKg: 74.3 },
    create: {
      id: FIXTURE_WEIGHT_B,
      userId: FIXTURE_USER_B,
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

  // Wave 3 — curated Egyptian core pack (contract note §8), applied by the
  // extracted seed-execution module (prisma/seed-apply.ts — the same code the
  // integration suite drives for its idempotence/fidelity proofs).
  const catalog = await applyFoodCatalogSeed(prisma);

  console.log(
    `seed: fixtures in place (weight_log=${weights}, audit_events=${audits}, foods=${catalog.foods}, serving_variants=${catalog.servingVariants})`,
  );
}

assertLocalDev();
main()
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error("seed failed:", error instanceof Error ? error.message : error);
    void prisma.$disconnect();
    process.exit(1);
  });
