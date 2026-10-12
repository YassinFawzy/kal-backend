/**
 * Kal — exercise catalog repository (the ONLY data access the journal
 * module's catalog service uses).
 *
 * Isolation posture (the w4 contract note §5 decisions, implemented by s1's
 * migration): the `exercises` table is PLATFORM-OWNED — it carries no
 * `user_id` column and RLS is DECLINED with written rationale (the `foods`
 * posture: every authenticated consumer reads the same governed rows;
 * isolation is not a row-filtering question here). There is therefore no
 * user predicate to bind; reads run in the app-role transaction posture
 * (`journal/journal-tx.ts`) for least privilege — `kal_app` carries the
 * catalog's SELECT grants. Writes to these rows exist ONLY in the seed path
 * (`prisma/seed-apply.ts`, admin connection — the documented operator
 * posture); no request-scope code writes the catalog.
 *
 * Normalization parity (w3 §7 REUSED): the stored `name_en_normalized` /
 * `name_ar_normalized` / `aliases_normalized` targets are the manifest's
 * pipeline outputs; search receives the query ALREADY normalized by the
 * same frozen `normalize` implementation (consumed, never copied) and
 * matches exact → prefix → substring with the deterministic `id` tiebreak.
 *
 * No method here queries any other module's tables (module gate). The name
 * snapshot lookup for session applies (w4 §1.1 — the s2a seam) also lives
 * here, behind the service's exported method only.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import type { Exercise } from '../../../generated/prisma/client.ts';
import type { JournalTx } from '../journal-tx.js';
import type { ExerciseSearchCursorState } from './search-cursor.js';

/** One search-page row: the projection source + its deterministic rank tier. */
export interface ExerciseCatalogRow extends ExerciseProjectionColumns {
  readonly rank: number;
}

/** The projection-source columns (aliased camelCase — never SELECT *). */
export interface ExerciseProjectionColumns {
  readonly id: string;
  readonly provenance: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly aliases: readonly string[];
  readonly instructionsEn: string;
  readonly instructionsAr: string;
  readonly muscleGroups: readonly string[];
  readonly tags: readonly string[];
}

@Injectable()
export class ExerciseCatalogRepository {
  // -------------------------------------------------------------------------
  // Catalog search (platform plane, RLS declined — public to authenticated)
  // -------------------------------------------------------------------------

  /**
   * One ordered candidate page for the already-normalized query: rank 0 exact
   * normalized equality → 1 prefix → 2 substring containment, deterministic
   * tiebreak by id ascending (w3 §7 matching model REUSED; w4 note §2).
   * Targets: `name_en_normalized`, `name_ar_normalized`, `aliases_normalized`
   * (element-wise via `unnest`). Fetches `limit + 1` rows so the caller can
   * detect exhaustion. Empty queries never reach this method (the service
   * short-circuits to the empty set).
   */
  async searchPage(
    tx: JournalTx,
    normalizedQuery: string,
    limit: number,
    cursor: ExerciseSearchCursorState | null,
  ): Promise<{ rows: ExerciseCatalogRow[]; exhausted: boolean }> {
    const q = normalizedQuery;
    const cursorFilter = cursor
      ? Prisma.sql`WHERE (candidate.rank, candidate.id) > (${cursor.rank}::int, ${cursor.id}::text)`
      : Prisma.empty;
    const rows = await tx.$queryRaw<ExerciseCatalogRow[]>`
      SELECT candidate.id AS "id",
             candidate.rank,
             candidate.provenance,
             candidate.name_en AS "nameEn",
             candidate.name_ar AS "nameAr",
             candidate.aliases,
             candidate.instructions_en AS "instructionsEn",
             candidate.instructions_ar AS "instructionsAr",
             candidate.muscle_groups AS "muscleGroups",
             candidate.tags
      FROM (
        SELECT e.id::text AS id,
               e.provenance,
               e.name_en,
               e.name_ar,
               e.aliases,
               e.instructions_en,
               e.instructions_ar,
               e.muscle_groups,
               e.tags,
               LEAST(
                 CASE WHEN e.name_en_normalized = ${q} OR e.name_ar_normalized = ${q}
                           OR EXISTS (SELECT 1 FROM unnest(e.aliases_normalized) a WHERE a = ${q})
                      THEN 0 ELSE 3 END,
                 CASE WHEN strpos(e.name_en_normalized, ${q}) = 1 OR strpos(e.name_ar_normalized, ${q}) = 1
                           OR EXISTS (SELECT 1 FROM unnest(e.aliases_normalized) a WHERE strpos(a, ${q}) = 1)
                      THEN 1 ELSE 3 END,
                 CASE WHEN strpos(e.name_en_normalized, ${q}) > 0 OR strpos(e.name_ar_normalized, ${q}) > 0
                           OR EXISTS (SELECT 1 FROM unnest(e.aliases_normalized) a WHERE strpos(a, ${q}) > 0)
                      THEN 2 ELSE 3 END
               ) AS rank
        FROM exercises e
        WHERE strpos(e.name_en_normalized, ${q}) > 0
           OR strpos(e.name_ar_normalized, ${q}) > 0
           OR EXISTS (SELECT 1 FROM unnest(e.aliases_normalized) a WHERE strpos(a, ${q}) > 0)
      ) candidate
      ${cursorFilter}
      ORDER BY candidate.rank ASC, candidate.id ASC
      LIMIT ${limit + 1}`;
    const exhausted = rows.length > limit;
    return { rows: rows.slice(0, limit), exhausted };
  }

  // -------------------------------------------------------------------------
  // Catalog detail (platform plane)
  // -------------------------------------------------------------------------

  findExercise(tx: JournalTx, exerciseId: string): Promise<Exercise | null> {
    return tx.exercise.findUnique({ where: { id: exerciseId } });
  }

  // -------------------------------------------------------------------------
  // The s2a seam — name snapshots for session applies (w4 note §1.1)
  // -------------------------------------------------------------------------

  /**
   * The catalog rows a session apply must freeze name snapshots from
   * (server-derived at apply time — clients never author display data).
   * Reachable ONLY through `ExerciseCatalogService.catalogNameSnapshots`
   * (the journal module's exported service — s2a's session handler consumes
   * the service, never the tables).
   */
  findManyForSnapshot(tx: JournalTx, exerciseIds: readonly string[]): Promise<Exercise[]> {
    if (exerciseIds.length === 0) {
      return Promise.resolve([]);
    }
    return tx.exercise.findMany({ where: { id: { in: [...exerciseIds] } } });
  }
}
