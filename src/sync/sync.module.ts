/**
 * Kal — sync module (wave-03): the ingestion write path (s2d) and the
 * delta-pull read path (s2e), one module carrying BOTH frozen registries.
 *
 * Write path (s2d): batch ingestion (`POST /sync/ops`), the op-ledger and
 * Idempotency-Key stores, the ack envelope, and the SYNC-OWNED op-handler
 * registry. Read path (s2e): `GET /sync/changes`, the opaque per-user
 * cursor mint/verify, the SYNC-OWNED delta-provider registry, and the
 * deterministic cross-kind composer (contract §1.2/§1.6 — "cursor
 * mint/verify and endpoint wiring are sync-owned").
 *
 * Module gates (ARCHITECTURE §9): sync dispatches op application and delta
 * assembly ONLY through its two registries — it never queries tracking's
 * tables; tracking never queries sync's op/dedupe tables. Both modules
 * reach the database only through their own sanctioned service layer under
 * the per-transaction posture (`SET LOCAL ROLE kal_app` + `app.user_id`
 * GUC + `TimeZone UTC`).
 *
 * Hosting authenticated routes means importing IdentityModule (the
 * sanctioned host pattern — it re-exports the request-context plumbing and
 * provides the JWT-backed `USER_CONTEXT_RESOLVER` + bearer guard).
 *
 * Seam registration (§4 — "sync owns the registries; tracking registers
 * implementations at module init" is realized as: tracking EXPORTS the
 * implementations; THIS module registers them at init). The frozen
 * entity-kind registry is EXHAUSTIVE for W3 (contract §1.1): all three
 * handlers AND all three delta providers register here; a duplicate
 * registration refuses the boot (registry integrity, fail fast) in BOTH
 * registries.
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { DbModule } from '../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DiaryEntryOpHandler } from '../tracking/diary/diary-apply.service.js';
import { DiaryDeltaProvider } from '../tracking/diary/diary-delta.service.js';
import { FavoriteOpHandler } from '../tracking/foods/favorite-op.handler.js';
import { UserFoodOpHandler } from '../tracking/foods/user-food-op.handler.js';
import { FavoriteDeltaProvider, UserFoodDeltaProvider } from '../tracking/foods/foods-delta.providers.js';
import { TrackingModule } from '../tracking/tracking.module.js';
import { IdempotencyKeyStore } from './ingestion/idempotency-key.store.js';
import { OpLedgerStore } from './ingestion/op-ledger.store.js';
import { OpHandlerRegistry } from './ingestion/op-handler-registry.js';
import { SyncIngestionController } from './ingestion/ingestion.controller.js';
import { SyncIngestionService } from './ingestion/ingestion.service.js';
import { SyncConfigService } from './ingestion/sync.config.js';
import { SyncDeltaComposer } from './pull/delta-composer.service.js';
import { SyncDeltaCursorService } from './pull/delta-cursor.service.js';
import { SyncDeltaRegistry } from './pull/delta-registry.js';
import { SyncPullConfigService } from './pull/sync-pull.config.js';
import { SyncPullController } from './pull/sync-pull.controller.js';
import { SyncPullService } from './pull/sync-pull.service.js';

@Module({
  imports: [IdentityModule, DbModule, TrackingModule, AuditModule],
  controllers: [SyncIngestionController, SyncPullController],
  providers: [
    {
      provide: SyncConfigService,
      // Reads the validated environment at graph-initialization time —
      // BEFORE any listener binds (I15, the identity-config fail-fast
      // posture); out-of-bounds values refuse the boot in every path.
      useFactory: () => new SyncConfigService(process.env),
    },
    {
      provide: SyncPullConfigService,
      // The node env comes from the wave-01 validated configuration (same
      // environment the boot already accepted, I15); the pull-cursor key
      // derives its purpose subkey here (s2e — see sync-pull.config.ts).
      useFactory: (configService: ConfigService) => new SyncPullConfigService(configService.env),
      inject: [ConfigService],
    },
    OpHandlerRegistry,
    OpLedgerStore,
    IdempotencyKeyStore,
    SyncIngestionService,
    SyncDeltaCursorService,
    SyncDeltaRegistry,
    SyncDeltaComposer,
    SyncPullService,
  ],
  exports: [
    // The sync-owned registries: tracking registers handlers AND delta
    // providers at module init (via this module's own init below); the test
    // harnesses register clearly-marked test-only seam implementations
    // through the same production paths.
    OpHandlerRegistry,
    SyncDeltaRegistry,
  ],
})
export class SyncModule implements OnModuleInit {
  constructor(
    private readonly registry: OpHandlerRegistry,
    private readonly deltaRegistry: SyncDeltaRegistry,
    // The frozen §4 seam implementations, exported by tracking (s2a/s2c) —
    // sync registers them into its OWN registries at ITS module init (the
    // sanctioned direction: tracking implements, sync consumes).
    private readonly userFoodHandler: UserFoodOpHandler,
    private readonly favoriteHandler: FavoriteOpHandler,
    private readonly diaryHandler: DiaryEntryOpHandler,
    private readonly diaryDeltaProvider: DiaryDeltaProvider,
    private readonly userFoodDeltaProvider: UserFoodDeltaProvider,
    private readonly favoriteDeltaProvider: FavoriteDeltaProvider,
  ) {}

  onModuleInit(): void {
    // Op handlers (§1.3 state machines live inside tracking).
    this.registry.registerOpHandler(this.userFoodHandler);
    this.registry.registerOpHandler(this.favoriteHandler);
    this.registry.registerOpHandler(this.diaryHandler);
    // Delta providers (§1.6 pages live inside tracking; the cross-kind
    // merge, cursor mint/verify, and endpoint wiring are sync-owned).
    this.deltaRegistry.registerDeltaProvider('diary_entry', this.diaryDeltaProvider);
    this.deltaRegistry.registerDeltaProvider('user_food', this.userFoodDeltaProvider);
    this.deltaRegistry.registerDeltaProvider('favorite', this.favoriteDeltaProvider);
  }
}
