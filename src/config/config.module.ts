import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';

/**
 * Global configuration module (I15). `ConfigService` validates the
 * environment at construction — importing this module anywhere therefore
 * inherits the fail-fast guarantee.
 */
@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
