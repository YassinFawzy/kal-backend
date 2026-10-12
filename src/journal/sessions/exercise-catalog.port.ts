/**
 * Kal — the journal-internal exercise-catalog seam the session domain
 * consumes (w4 contract §1.1 name snapshots + §4 module gates; task
 * contract "Module gates").
 *
 * The session apply-handler must (a) VALIDATE that every payload
 * `exerciseId` references an existing catalog row (unknown/nonexistent ⇒
 * per-op `rejected_validation`), and (b) FREEZE the catalog row's current
 * display names into the exercise entries' snapshot columns at apply time
 * (the I11-analog: later catalog edits never rewrite logged history; an
 * edit op re-freezes at THAT apply — an edit is a new log event).
 *
 * This port is deliberately name-resolution-only — nothing else of the
 * catalog (taxonomy, instructions, search) enters the write path. Two
 * adapters exist:
 *   - `CatalogServiceSnapshotAdapter` — the PRODUCTION binding: it
 *     delegates to the catalog area's declared journal-internal seam
 *     (`ExerciseCatalogService.catalogNameSnapshots`, lane s2b) — the
 *     JournalModule binds the port to it; session logic never changes if
 *     the catalog side evolves its internals.
 *   - `ExerciseCatalogNameResolver` — the batched referential read against
 *     the frozen schema table, used by the integration suite to exercise
 *     the handler against the REAL seed table without constructing the
 *     full catalog service (test-support posture, clearly documented).
 *
 * Validation is total-or-nothing by design (I7): a payload referencing ANY
 * unknown id resolves to `null` — the caller answers the per-op
 * `rejected_validation` outcome; a foreign/absent/malformed id is
 * indistinguishable from any other unknown id.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { ExerciseCatalogService } from '../catalog/catalog.service.js';

/** The frozen display names a session entry snapshots at apply time. */
export interface CatalogExerciseNames {
  readonly nameEn: string;
  readonly nameAr: string | null;
}

export const EXERCISE_CATALOG_RESOLUTION_PORT = 'EXERCISE_CATALOG_RESOLUTION_PORT';

export interface ExerciseCatalogResolutionPort {
  /**
   * Resolves EVERY requested catalog id to its current display names, or
   * `null` when ANY id is unknown (total-or-nothing: a payload referencing
   * an unknown exercise is invalid in full). Duplicate ids are collapsed.
   */
  resolveCatalogNames(
    tx: Prisma.TransactionClient,
    exerciseIds: readonly string[],
  ): Promise<Map<string, CatalogExerciseNames> | null>;
}

/**
 * The PRODUCTION binding (the JournalModule wires this): delegates to the
 * catalog service's declared `catalogNameSnapshots` seam and enforces the
 * total-or-nothing contract on top of it (the service returns the rows it
 * found; a payload referencing an unknown exercise must resolve to `null`).
 */
@Injectable()
export class CatalogServiceSnapshotAdapter implements ExerciseCatalogResolutionPort {
  constructor(private readonly catalog: ExerciseCatalogService) {}

  async resolveCatalogNames(
    tx: Prisma.TransactionClient,
    exerciseIds: readonly string[],
  ): Promise<Map<string, CatalogExerciseNames> | null> {
    const unique = [...new Set(exerciseIds)];
    const resolved = await this.catalog.catalogNameSnapshots(tx, unique);
    for (const id of unique) {
      if (!resolved.has(id)) {
        return null; // at least one referenced exercise does not exist
      }
    }
    return resolved;
  }
}

/** The referential adapter (the integration suite's handler-facing binding). */
@Injectable()
export class ExerciseCatalogNameResolver implements ExerciseCatalogResolutionPort {
  async resolveCatalogNames(
    tx: Prisma.TransactionClient,
    exerciseIds: readonly string[],
  ): Promise<Map<string, CatalogExerciseNames> | null> {
    const unique = [...new Set(exerciseIds)];
    const rows = await tx.exercise.findMany({
      where: { id: { in: unique } },
      select: { id: true, nameEn: true, nameAr: true },
    });
    if (rows.length !== unique.length) {
      return null; // at least one referenced exercise does not exist
    }
    const resolved = new Map<string, CatalogExerciseNames>();
    for (const row of rows) {
      resolved.set(row.id, { nameEn: row.nameEn, nameAr: row.nameAr });
    }
    return resolved;
  }
}
