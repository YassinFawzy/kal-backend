/**
 * Kal — the journal routines/PRs/recents lane module (wave-04, lane s2c).
 *
 * PRE-UNION WIRING: the journal MODULE file (`src/journal/journal.module.ts`)
 * belongs to lane s2a first (its sessions domain creates it); THIS lane owns
 * the module-file reconciliation at its post-s2a registration-union rebase
 * (the wave-03 s2e precedent). Until that rebase, this lane module carries
 * the s2c providers and is what `app.module.ts` imports; the union commit
 * folds every provider below into the journal module and deletes this file.
 *
 * Owned here (task contract):
 *   - `routines/` — the `journal_routine` apply handler + delta provider
 *     (the §1.3 state machine + §1.6 feed for templates), the owning-user
 *     read service.
 *   - `prs/` — the derived-never-stored PR/1RM read model + the frozen
 *     `journal.exercises.pr.get` read endpoint (REST reads only; the §2
 *     freeze: journal mutations exist ONLY as sync ops).
 *   - `recents/` — the derived recent-exercise inputs (no synced entity, no
 *     REST endpoint in w4).
 *
 * Module gates (ARCHITECTURE §9): sessions' tables are read ONLY through
 * the journal module's own internal services (same module — direct queries
 * inside the module are sanctioned); no tracking/identity table is ever
 * touched; sync owns the registries and registers THIS module's exported
 * seam implementations at ITS init (the sanctioned direction: journal
 * implements, sync consumes).
 */
import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PrController } from './prs/pr.controller.js';
import { PrService } from './prs/pr.service.js';
import { RecentsService } from './recents/recents.service.js';
import { RoutineDeltaProviderService } from './routines/routine-delta.provider.js';
import { RoutineOpHandler } from './routines/routine-apply.handler.js';
import { RoutineReadService } from './routines/routine-read.service.js';

@Module({
  imports: [DbModule, IdentityModule],
  controllers: [PrController],
  providers: [
    RoutineOpHandler,
    RoutineDeltaProviderService,
    RoutineReadService,
    PrService,
    RecentsService,
  ],
  exports: [
    // The frozen §4 seam implementations — sync registers these into its OWN
    // registries at its module init (this lane's registration-union commit
    // adds the registerOpHandler/registerDeltaProvider lines beside s2a's
    // journal_session entries).
    RoutineOpHandler,
    RoutineDeltaProviderService,
    // The owning-user read models (module-internal consumers; suites).
    RoutineReadService,
    PrService,
    RecentsService,
  ],
})
export class JournalRoutinesPrsModule {}
