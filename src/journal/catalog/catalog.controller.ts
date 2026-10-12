/**
 * Kal — the exercise catalog HTTP surface (w4 contract note §2 fixture
 * entries `journal.exercises.search` + `journal.exercises.get`; conventions
 * §1 bearer).
 *
 * Route class is bearer-guarded (`RequireIdentityBearer` — the identity
 * wave's JWT→UserContext resolution; 401 UNAUTHENTICATED +
 * `WWW-Authenticate: Bearer` for every failure class). Controllers stay
 * thin: parse nothing, validate nothing — they hand raw parameter values to
 * the service, which owns validation, authorization, and the unit of work
 * (sanctioned path).
 *
 * JOURNAL REST MUTATIONS DO NOT EXIST by design (w4 note §2 freeze) — no
 * POST/PUT/PATCH/DELETE lands on any /journal path; journal user-owned
 * mutations flow exclusively through sync ingestion. The per-exercise PR
 * read (`journal.exercises.pr.get`) and the session reads belong to lane
 * s2a (the session/routine/PR lane), which unions this module's wiring.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { ExerciseCatalogService } from './catalog.service.js';

@RequireIdentityBearer()
@Controller('journal')
export class ExerciseCatalogController {
  constructor(private readonly catalog: ExerciseCatalogService) {}

  /** `journal.exercises.search` — GET /journal/exercises?q&limit&cursor */
  @Get('exercises')
  search(@Query('q') q: unknown, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    return this.catalog.search(q, limit, cursor);
  }

  /** `journal.exercises.get` — GET /journal/exercises/{exerciseId} */
  @Get('exercises/:exerciseId')
  exerciseDetail(@Param('exerciseId') exerciseId: string) {
    return this.catalog.exerciseDetail(exerciseId);
  }
}
