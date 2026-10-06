/**
 * Kal API bootstrap. Configuration validation (I15) runs during module
 * initialization — BEFORE any listener binds — so an unsafe environment
 * refuses the boot here, with a non-leaking message, and a non-zero exit.
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from './config/config.service.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown bootstrap failure';
  // Non-leaking by construction: config and module errors never embed
  // secret values (validate-config refuses to echo them).
  console.error(`kal-api: refusing to start — ${message}`);
  process.exit(1);
});
