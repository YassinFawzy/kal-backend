/**
 * Kal — journal module (wave-04; ARCHITECTURE §9 bounded context).
 *
 * Reconciled union (merge order s2b → s2a): lane s2b's exercise-catalog
 * surface (the supervisor-routed blessed block, landed first) + lane
 * s2a's sessions domain — the `journal_session` sync seam implementations,
 * the §2 session read surface, the session-create rate guard, and the
 * derived training-day marks with their W5-facing reader. Lane s2c unions
 * routines + PRs into THIS module in its post-s2a rebase and reconciles it
 * semantically (the W3 s2e-owns-the-union precedent).
 *
 * Module gates (ARCHITECTURE §9): other modules talk to the journal ONLY
 * through its exported services/seam implementations; the journal never
 * queries another module's tables. The exercise catalog is consumed
 * through the journal-internal `EXERCISE_CATALOG_RESOLUTION_PORT`, bound
 * below to the `ExerciseCatalogService`-backed adapter — s2a's session
 * logic consumes the port; the binding (service, seed, tests) is s2b's
 * declared seam surface (`catalogNameSnapshots`). Sync registers the
 * exported handler/provider into its OWN registries at ITS module init
 * (`src/sync/sync.module.ts` — sync owns the registries; the journal
 * implements).
 *
 * Catalog posture (w4 note §5): the `exercises` table is platform-owned —
 * no `user_id`, RLS DECLINED with written rationale (the foods posture);
 * reads are public-to-authenticated and run in the app-role transaction
 * posture (`journal-tx.ts`); catalog writes exist ONLY in the seed path.
 *
 * Isolation posture: every journal owned table carries immutable `user_id`;
 * user-scoped work runs only through the sanctioned service layer with a
 * validated UserContext under the per-transaction posture
 * (`journal-tx.ts` — F1 pool guidance: never session-level GUCs).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '../config/config.service.js';
import { JournalConfigService } from '../config/journal.config.js';
import { AuditModule } from '../audit/audit.module.js';
import { DbModule } from '../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ExerciseCatalogController } from './catalog/catalog.controller.js';
import { ExerciseCatalogRepository } from './catalog/catalog.repository.js';
import { ExerciseCatalogService } from './catalog/catalog.service.js';
import { CatalogServiceSnapshotAdapter, EXERCISE_CATALOG_RESOLUTION_PORT } from './sessions/exercise-catalog.port.js';
import { SessionDeltaProvider } from './sessions/session-delta.service.js';
import { SessionOpHandler } from './sessions/session-apply.service.js';
import { SessionCreateRateLimiter } from './sessions/session-rate-limiter.js';
import { SessionReadController } from './sessions/session-read.controller.js';
import { SessionReadService } from './sessions/session-read.service.js';
import { SessionRepository } from './sessions/session-repository.js';
import { JournalTrainingDayReader, TrainingDayMarksService } from './sessions/training-day-marks.service.js';
import { PrController } from './prs/pr.controller.js';
import { PrService } from './prs/pr.service.js';
import { RecentsService } from './recents/recents.service.js';
import { RoutineDeltaProviderService } from './routines/routine-delta.provider.js';
import { RoutineOpHandler } from './routines/routine-apply.handler.js';
import { RoutineReadService } from './routines/routine-read.service.js';

@Module({
  imports: [DbModule, IdentityModule, AuditModule],
  controllers: [ExerciseCatalogController, SessionReadController, PrController],
  providers: [
    {
      provide: JournalConfigService,
      // The node env comes from the wave-01 validated configuration (same
      // environment the boot already accepted, I15) — the identity/tracking
      // config pattern; validation runs at module-graph init, before any
      // listener binds (out-of-bounds rate-guard caps refuse the boot).
      useFactory: (configService: ConfigService) => new JournalConfigService(configService.env),
      inject: [ConfigService],
    },
    ExerciseCatalogRepository,
    ExerciseCatalogService,
    {
      // The journal-internal catalog seam (§4): the session handler's
      // name-snapshot resolution, backed by the catalog service's declared
      // `catalogNameSnapshots` seam (lane s2b). The port keeps the handler
      // testable and the binding swappable without touching session logic.
      provide: EXERCISE_CATALOG_RESOLUTION_PORT,
      useClass: CatalogServiceSnapshotAdapter,
    },
    SessionRepository,
    SessionCreateRateLimiter,
    TrainingDayMarksService,
    SessionOpHandler,
    SessionDeltaProvider,
    SessionReadService,
    JournalTrainingDayReader,
    // Lane s2c (the registration union): the journal_routine sync domain,
    // the derived-never-stored PR read model + the frozen
    // journal.exercises.pr.get read endpoint, and the recents inputs
    // service. The routine handler consumes EXERCISE_CATALOG_RESOLUTION_PORT
    // above for its apply-time name-snapshot freeze (the same module-internal
    // seam the session handler uses — Ruling 4 posture).
    RoutineOpHandler,
    RoutineDeltaProviderService,
    RoutineReadService,
    PrService,
    RecentsService,
  ],
  exports: [
    // The module seam (ARCHITECTURE §9): s2a's session code and any future
    // module consume the catalog through the service — never the tables.
    ExerciseCatalogService,
    // The frozen sync-seam implementations (w4 §4) — sync registers these
    // into its own registries at its module init (the sanctioned direction:
    // the journal implements, sync consumes).
    SessionOpHandler,
    SessionDeltaProvider,
    // Lane s2c's frozen seam implementation (the journal_routine kind) —
    // sync registers it beside s2a's session entries at ITS init (§4).
    RoutineOpHandler,
    RoutineDeltaProviderService,
    // The W5-facing training-day surface (w4 note §4 — the ONLY sanctioned
    // goals→journal path; the flag is not enumerable by any HTTP surface).
    JournalTrainingDayReader,
    // Journal-internal surfaces (same module — PR derivation reads sessions
    // through the module's own transaction posture, never across tables).
    SessionRepository,
    TrainingDayMarksService,
    RoutineReadService,
    PrService,
    RecentsService,
    // The validated config points (w4 note §6) — the rate limiter reads its
    // bounds through this service, never from the environment ad hoc.
    JournalConfigService,
  ],
})
export class JournalModule {}
