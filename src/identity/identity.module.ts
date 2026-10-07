/**
 * Kal — identity module (wave-02, G2-identity).
 *
 * Provides the identity HTTP surface and — via the wave-01 seam — the
 * JWT-backed `USER_CONTEXT_RESOLVER` implementation every later
 * authenticated route resolves through (I2/I6; RequestContextMenu's comment
 * records the W2 override). The module re-exports the request-context
 * plumbing so a host that imports IdentityModule (instead of
 * RequestContextMenu directly) sees BOTH the middleware/guard exports AND
 * the JWT-backed resolver: Nest resolves a provider from the module's own
 * providers before its imports' exports, so this local provider is the one
 * every consumer of this module gets.
 *
 * Module gate: other modules talk to identity only through its exported
 * services (tokens, hasher, guard, resolver); identity never queries
 * another module's tables.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigService } from '../config/config.service.js';
import { DbModule } from '../db/db.module.js';
import { RequestContextMenu } from '../request-context/index.js';
import { USER_CONTEXT_RESOLVER } from '../request-context/user-context.resolver.js';
import { IdentityBearerGuard } from './identity-bearer.guard.js';
import { IdentityConfigService } from './identity.config.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { JwtUserContextResolver } from './jwt-user-context.resolver.js';
import { PasswordHasherService } from './password-hasher.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [RequestContextMenu, DbModule, AuditModule],
  controllers: [IdentityController],
  providers: [
    {
      provide: USER_CONTEXT_RESOLVER,
      useClass: JwtUserContextResolver,
    },
    {
      provide: IdentityConfigService,
      // The node env comes from the wave-01 validated configuration (same
      // environment the boot already accepted, I15).
      useFactory: (configService: ConfigService) => new IdentityConfigService(configService.env),
      inject: [ConfigService],
    },
    PasswordHasherService,
    TokenService,
    IdentityService,
    JwtUserContextResolver,
    IdentityBearerGuard,
  ],
  exports: [
    // The W2 resolver override (wave-01 seam) + its class for direct injection.
    USER_CONTEXT_RESOLVER,
    JwtUserContextResolver,
    IdentityBearerGuard,
    IdentityConfigService,
    PasswordHasherService,
    TokenService,
    // Re-exported request-context plumbing (middleware, guard, ALS service):
    // importing IdentityModule is the sanctioned way to host authenticated
    // routes with JWT-backed resolution.
    RequestContextMenu,
  ],
})
export class IdentityModule {}
