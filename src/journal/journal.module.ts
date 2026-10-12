/**
 * Kal — journal module (wave-04; ARCHITECTURE §9 bounded context).
 *
 * THIS IS THE MINIMAL LANE-s2b WIRING (the supervisor-routed blessed block):
 * the exercise-catalog surface + its exported service. Lanes s2a (sessions/
 * routines/PRs + the sync seam implementations) and s2c union their wiring
 * into THIS module on rebase — the module exists so their registration
 * lines have one sanctioned home. Keep every addition inside the frozen
 * module gates (ARCHITECTURE §9): other modules talk to the journal ONLY
 * through its exported services; the journal never queries another module's
 * tables; user-scoped work runs only through the sanctioned service layer
 * with a validated UserContext under the per-transaction posture
 * (`journal/journal-tx.ts`).
 *
 * Current surface (lane s2b, w4 contract note §2):
 *   - `journal.exercises.search` GET /journal/exercises — normalized search
 *     over the platform exercise catalog (w3 §7 pipeline + matching model
 *     REUSED via the SAME `normalize` implementation).
 *   - `journal.exercises.get` GET /journal/exercises/{exerciseId} — catalog
 *     detail (names, aliases, AR/EN text instructions, display taxonomy;
 *     HD-26: no media fields exist anywhere in the shape).
 *   - `ExerciseCatalogService.catalogNameSnapshots` — the journal-internal
 *     seam s2a's session apply handlers consume to freeze name snapshots
 *     (w4 note §1.1 — server-derived, never client-authored).
 *
 * Catalog posture (w4 note §5): the `exercises` table is platform-owned —
 * no `user_id`, RLS DECLINED with written rationale (the foods posture);
 * reads are public-to-authenticated and run in the app-role transaction
 * posture; catalog writes exist ONLY in the seed path
 * (`prisma/seed-apply.ts` — the operator posture).
 *
 * Journal REST mutations do NOT exist (w4 note §2 freeze) — sessions and
 * routines flow exclusively through sync ingestion as the `journal_session`
 * and `journal_routine` kinds (s2a's handlers, registered into sync's
 * registries at sync's module init — the w3 §4 seam mechanics unchanged).
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

@Module({
  imports: [DbModule, IdentityModule, AuditModule],
  controllers: [ExerciseCatalogController],
  providers: [
    {
      provide: JournalConfigService,
      // The node env comes from the wave-01 validated configuration (same
      // environment the boot already accepted, I15) — the identity-config
      // pattern; validation runs at module-graph init, before any listener
      // (the tracking module's construction of TrackingConfigService,
      // mirrored; the journal cursor key derives domain-separated
      // `kal:journal:search-cursor:v1`).
      useFactory: (configService: ConfigService) => new JournalConfigService(configService.env),
      inject: [ConfigService],
    },
    ExerciseCatalogRepository,
    ExerciseCatalogService,
    // Lane s2a unions its session/routine handlers, delta providers, the
    // rate limiter, and the training-day reader service here (w4 note §4).
  ],
  exports: [
    // The module seam (ARCHITECTURE §9): s2a's session code and any future
    // module consume the catalog through the service — never the tables.
    ExerciseCatalogService,
    // The validated config points (w4 note §6) — s2a's rate limiter reads
    // its bounds through this service, never from the environment ad hoc.
    JournalConfigService,
  ],
})
export class JournalModule {}
