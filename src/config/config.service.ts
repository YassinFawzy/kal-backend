/**
 * Kal — validated application configuration (I15).
 *
 * Validation runs in the constructor, which executes when Nest instantiates
 * the module graph — i.e. before any listener binds. A placeholder-class
 * credential in the environment therefore refuses the boot in every path
 * (real bootstrap, e2e harness, tests).
 */
import { Injectable } from '@nestjs/common';
import { AppConfig, KalEnv, validateConfig } from './validate-config.js';

@Injectable()
export class ConfigService {
  private readonly config: AppConfig;

  constructor() {
    const result = validateConfig(process.env);
    if (!result.ok) {
      // Non-leaking by construction: validateConfig never echoes values.
      throw new Error(
        `config: invalid configuration, refusing to start — ${result.errors.join(' ')}`,
      );
    }
    this.config = result.config;
  }

  get env(): KalEnv {
    return this.config.env;
  }

  get port(): number {
    return this.config.port;
  }

  get databaseUrl(): string {
    return this.config.databaseUrl;
  }
}
