/**
 * Kal API bootstrap. Configuration validation (I15) runs during module
 * initialization — BEFORE any listener binds — so an unsafe environment
 * refuses the boot here, with a non-leaking message, and a non-zero exit.
 */
// Load .env for local dev boots (`pnpm start:dev`) — dotenv NEVER overrides
// variables already present in process.env, so production containers (real
// env) and the test harness (explicit ephemeral DATABASE_URL; boots AppModule
// directly, not this entry) are unaffected; I15 fail-closed semantics hold.
// Supervisor-blessed per playbook §8, 2026-10-08 (W1 DX gap: README promises
// `cp .env.example .env` + `pnpm start:dev` works; @nestjs/cli does not
// auto-load .env). Recorded in wave-03 ledger §10.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from './config/config.service.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.enableShutdownHooks();
  // CORS — browser origins allowed to call the API (Expo web dev servers by
  // default; production sets CORS_ALLOWED_ORIGINS to the real web origins).
  // Fail-closed on malformed entries (I15 spirit): an entry that is not an
  // http(s) origin refuses the boot. No wildcard: bearer tokens travel in
  // headers, and an explicit allowlist is the safe default. Supervisor-blessed
  // §8, 2026-10-08 — recorded in wave-03 ledger §10.
  const corsOrigins = (process.env['CORS_ALLOWED_ORIGINS'] ?? 'http://localhost:8081,http://localhost:19006')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const origin of corsOrigins) {
    if (!/^https?:\/\/[a-z0-9.:-]+$/iu.test(origin)) {
      throw new Error(`config: invalid configuration, refusing to start — CORS_ALLOWED_ORIGINS entries must be http(s) origins.`);
    }
  }
  app.enableCors({ origin: corsOrigins });
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown bootstrap failure';
  // Non-leaking by construction: config and module errors never embed
  // secret values (validate-config refuses to echo them).
  console.error(`kal-api: refusing to start — ${message}`);
  process.exit(1);
});
