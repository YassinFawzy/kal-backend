/**
 * Kal — tracking module (wave-03; ARCHITECTURE §9 bounded context).
 *
 * Owns the foods catalog surface (this lane, s2a: search/detail/barcode/user
 * foods/favorites + the shared limiter + the seed manifest's execution
 * module), the diary surface (s2c), and the frozen `sync` ↔ `tracking` seam
 * implementations (§4): the op handlers and delta providers sync registers
 * at ITS module init (`registerOpHandler` / `registerDeltaProvider` — sync
 * owns the registries).
 *
 * Module gates (ARCHITECTURE §9): other modules talk to tracking ONLY through
 * its exported services/seam implementations; tracking never queries another
 * module's tables; user-scoped work runs only through the sanctioned service
 * layer with a validated UserContext under the per-transaction posture
 * (`app-role-tx.ts` — F1 pool guidance: never session-level GUCs).
 *
 * Normalization binding: the frozen §7 pipeline is consumed through the
 * `TRACKING_NORMALIZER` port. INTERIM binding below = the in-lane
 * `interim-normalizer.ts` (rule-faithful §7 implementation) used until lane
 * s2b's merged module lands; the binding swaps to it at rebase and the
 * interim file is deleted.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { DbModule } from '../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DevBarcodeLookupAdapter } from './foods/barcode/dev-off.adapter.js';
import { KAL_BARCODE_LOOKUP } from './foods/barcode/barcode-lookup.port.js';
import { FavoriteOpHandler } from './foods/favorite-op.handler.js';
import { FavoriteDeltaProvider, UserFoodDeltaProvider } from './foods/foods-delta.providers.js';
import { FoodsController } from './foods/foods.controller.js';
import { FoodsRepository } from './foods/foods.repository.js';
import { FoodsService } from './foods/foods.service.js';
import { normalizeArabicLatin } from './foods/interim-normalizer.js';
import { TRACKING_NORMALIZER } from './foods/normalizer.port.js';
import { TrackingConfigService } from './foods/tracking.config.js';
import { UserFoodOpHandler } from './foods/user-food-op.handler.js';
import { UserFoodRateLimiter } from './foods/user-food-rate-limiter.js';

@Module({
  imports: [DbModule, IdentityModule],
  controllers: [FoodsController],
  providers: [
    {
      provide: TrackingConfigService,
      // The node env comes from the wave-01 validated configuration (same
      // environment the boot already accepted, I15) — the identity-config
      // pattern; validation runs at module-graph init, before any listener.
      useFactory: (configService: ConfigService) => new TrackingConfigService(configService.env),
      inject: [ConfigService],
    },
    {
      // INTERIM (pre-rebase): in-lane rule-faithful §7 pipeline. Swapped for
      // s2b's merged `src/tracking/normalization/**` at rebase.
      provide: TRACKING_NORMALIZER,
      useFactory: () => ({ normalize: normalizeArabicLatin }),
    },
    {
      // The Open Food Facts adapter seam (FR-017) — W3 binding: recorded-
      // fixture dev adapter; no live calls exist (contract §2).
      provide: KAL_BARCODE_LOOKUP,
      useClass: DevBarcodeLookupAdapter,
    },
    FoodsRepository,
    UserFoodRateLimiter,
    FoodsService,
    UserFoodOpHandler,
    FavoriteOpHandler,
    UserFoodDeltaProvider,
    FavoriteDeltaProvider,
  ],
  exports: [
    // The frozen seam implementations (§4) — sync (s2d/s2e) registers these
    // into its own registries at its module init.
    UserFoodOpHandler,
    FavoriteOpHandler,
    UserFoodDeltaProvider,
    FavoriteDeltaProvider,
    TrackingConfigService,
  ],
})
export class TrackingModule {}
