/**
 * Kal — sync module (wave-03, lane s2d: the ingestion write path).
 *
 * Owns the batch ingestion surface (`POST /sync/ops`), the op-ledger and
 * Idempotency-Key stores, the ack envelope, and the SYNC-OWNED op-handler
 * registry (contract §4 — "sync owns the registries"). The registry is
 * EXPORTED so the tracking lanes (w03-s2a/w03-s2c) register their real
 * entity handlers at module init through the same production path; the
 * delta-pull lane (w03-s2e) owns `src/sync/pull/**` separately.
 *
 * Module gates (ARCHITECTURE §9): sync dispatches op application ONLY
 * through the registry — it never queries tracking's tables; tracking never
 * queries sync's op/dedupe tables. Both modules reach the database only
 * through their own sanctioned service layer under the per-transaction
 * posture (`SET LOCAL ROLE kal_app` + `app.user_id` GUC + `TimeZone UTC`).
 *
 * Hosting authenticated routes means importing IdentityModule (the
 * sanctioned host pattern — it re-exports the request-context plumbing and
 * provides the JWT-backed `USER_CONTEXT_RESOLVER` + bearer guard).
 *
 * Seam registration (§4 — "sync owns the registries; tracking registers
 * implementations at module init" is realized as: tracking EXPORTS the
 * implementations; THIS module registers them at init). The delta-provider
 * registrations belong to the delta-pull lane (w03-s2e).
 */
import { Module, OnModuleInit } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DiaryEntryOpHandler } from '../tracking/diary/diary-apply.service.js';
import { FavoriteOpHandler } from '../tracking/foods/favorite-op.handler.js';
import { UserFoodOpHandler } from '../tracking/foods/user-food-op.handler.js';
import { TrackingModule } from '../tracking/tracking.module.js';
import { IdempotencyKeyStore } from './ingestion/idempotency-key.store.js';
import { OpLedgerStore } from './ingestion/op-ledger.store.js';
import { OpHandlerRegistry } from './ingestion/op-handler-registry.js';
import { SyncIngestionController } from './ingestion/ingestion.controller.js';
import { SyncIngestionService } from './ingestion/ingestion.service.js';
import { SyncConfigService } from './ingestion/sync.config.js';

@Module({
  imports: [IdentityModule, DbModule, TrackingModule],
  controllers: [SyncIngestionController],
  providers: [
    {
      provide: SyncConfigService,
      // Reads the validated environment at graph-initialization time —
      // BEFORE any listener binds (I15, the identity-config fail-fast
      // posture); out-of-bounds values refuse the boot in every path.
      useFactory: () => new SyncConfigService(process.env),
    },
    OpHandlerRegistry,
    OpLedgerStore,
    IdempotencyKeyStore,
    SyncIngestionService,
  ],
  exports: [
    // The sync-owned registry: tracking registers handlers at module init;
    // the test harness registers the clearly-marked test-only seam handler
    // through the same production path.
    OpHandlerRegistry,
  ],
})
export class SyncModule implements OnModuleInit {
  constructor(
    private readonly registry: OpHandlerRegistry,
    // The frozen §4 seam implementations, exported by tracking (s2a/s2c) —
    // sync registers them into its OWN registries at ITS module init (the
    // sanctioned direction: tracking implements, sync consumes).
    private readonly userFoodHandler: UserFoodOpHandler,
    private readonly favoriteHandler: FavoriteOpHandler,
    private readonly diaryHandler: DiaryEntryOpHandler,
  ) {}

  onModuleInit(): void {
    // The frozen entity-kind registry is EXHAUSTIVE for W3 (contract §1.1):
    // all three kinds register here; a duplicate registration refuses the
    // boot (registry integrity, fail fast).
    this.registry.registerOpHandler(this.userFoodHandler);
    this.registry.registerOpHandler(this.favoriteHandler);
    this.registry.registerOpHandler(this.diaryHandler);
  }
}
