/**
 * Kal — the exercise catalog service (w4 contract note §2; lane s2b).
 *
 * Sanctioned path per read: controller → service (validate → authorize →
 * app-role/user-scoped unit of work → project). Errors are problem-details
 * registry codes only (conventions §4/§5); denials are byte-identical whether
 * or not the object exists (I7); no health data in logs (I12) — this service
 * logs nothing.
 *
 * Surfaces:
 *   - `journal.exercises.search` GET /journal/exercises — the normalized
 *     query (frozen wave-03 pipeline, consumed via the SAME `normalize`
 *     implementation — imported, never copied) over the platform catalog's
 *     stored normalized targets; exact → prefix → substring, deterministic
 *     `id` tiebreak; opaque user-bound cursor pagination (conventions §2).
 *   - `journal.exercises.get` GET /journal/exercises/{exerciseId} — catalog
 *     detail (names, aliases, AR/EN text instructions, display taxonomy);
 *     404 byte-identical for absent/malformed ids (the catalog is public to
 *     authenticated users — 404 means "no such catalog row", the w3
 *     `foods.get` posture).
 *   - `catalogNameSnapshots` — the journal-INTERNAL seam for s2a's session
 *     apply handlers (w4 note §1.1: name snapshots are server-derived at
 *     apply time). Not an HTTP surface.
 *
 * The exercise catalog is platform-owned (RLS declined — w4 note §5): reads
 * are public-to-authenticated consumers, exactly the foods posture; there is
 * no per-user catalog state anywhere in this service.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { PrismaService } from '../../db/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { normalize } from '../../tracking/normalization/normalization.js';
import { JournalConfigService } from '../../config/journal.config.js';
import { inUserScopeTx, type JournalTx } from '../journal-tx.js';
import { ExerciseCatalogRepository } from './catalog.repository.js';
import { projectExercise, type ExerciseItemProjection } from './catalog.projection.js';
import {
  decodeExerciseSearchCursor,
  encodeExerciseSearchCursor,
  inspectExerciseSearchCursor,
} from './search-cursor.js';

/** The frozen query-parameter contract (conventions §2 + w4 note §2). */
const QUERY_MAX_LENGTH = 80;
const LIMIT_DEFAULT = 50;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ExerciseSearchResponse {
  /** `data` is a list OF EXERCISE projections (w4 note §2: `200 {data: [exercise], nextCursor}`). */
  readonly data: readonly ExerciseItemProjection[];
  readonly nextCursor: string | null;
}

export interface ExerciseNameSnapshot {
  readonly nameEn: string;
  readonly nameAr: string;
}

/** Server-keyed opaque digest (I14 audit payloads — ids become digests). */
function digestId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class ExerciseCatalogService {
  constructor(
    private readonly db: PrismaService,
    private readonly repository: ExerciseCatalogRepository,
    private readonly config: JournalConfigService,
    private readonly requestContext: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The validated consumer binding (I2). The bearer guard has already
   * resolved and stored it; the extra fail-closed check refuses any
   * non-consumer plane with the generic object-independent denial (the
   * foods posture — unreachable in w4, where only consumer identities
   * exist, and kept fail-closed for exactly that reason).
   */
  private requireConsumerUserId(): string {
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('FORBIDDEN');
    }
    return context.userId;
  }

  // -------------------------------------------------------------------------
  // journal.exercises.search — GET /journal/exercises
  // -------------------------------------------------------------------------

  async search(q: unknown, limitRaw: unknown, cursorRaw: unknown): Promise<ExerciseSearchResponse> {
    const userId = this.requireConsumerUserId();

    if (typeof q !== 'string') {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'q', message: 'is required.' }],
      });
    }
    const trimmedQuery = q.trim();
    if (trimmedQuery.length > QUERY_MAX_LENGTH) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'q', message: `must be at most ${QUERY_MAX_LENGTH} characters after trim.` }],
      });
    }

    const limit = ExerciseCatalogService.parseLimit(limitRaw);

    let cursorState: ReturnType<typeof decodeExerciseSearchCursor> = null;
    if (cursorRaw !== undefined && cursorRaw !== null) {
      if (typeof cursorRaw !== 'string') {
        throw ExerciseCatalogService.genericCursorRejection();
      }
      // One generic, byte-identical rejection for EVERY failure cause —
      // malformed, truncated, or a cursor minted for another user (I7).
      cursorState = decodeExerciseSearchCursor(cursorRaw, userId, this.config.values.searchCursorKey);
      if (cursorState === null) {
        // The tracking Amendment-3 posture (I14 audit emit): a tag-valid
        // search cursor minted for another account is a server-known
        // cross-tenant fact — one fire-and-forget audit row (digests only;
        // never awaited on the response path — I7), then the SAME
        // byte-identical generic 400.
        const embedded = inspectExerciseSearchCursor(cursorRaw, this.config.values.searchCursorKey);
        if (embedded !== null && embedded !== userId) {
          void this.audit
            .append({
              actor: 'system:journal',
              action: 'journal.search_cursor.foreign_binding',
              target: `cursor:${digestId(userId)}:${digestId(embedded)}`,
              justification: 'A tag-valid exercise-search cursor minted for another account was presented by the caller (I14 cross-tenant signal; response unchanged).',
            })
            .catch(() => undefined);
        }
        throw ExerciseCatalogService.genericCursorRejection();
      }
    }

    // Empty/whitespace-only query ⇒ the EMPTY result set — not an error
    // (w4 note §2; the foods precedent).
    if (trimmedQuery.length === 0) {
      return { data: [], nextCursor: null };
    }

    // The frozen pipeline normalizes the query ONCE; matching runs against
    // the catalog's stored normalized targets (w3 §7 model REUSED).
    const normalizedQuery = normalize(trimmedQuery);

    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const { rows, exhausted } = await this.repository.searchPage(tx, normalizedQuery, limit, cursorState);

      const data = rows.map(projectExercise);

      // nextCursor: null ⇔ end of collection (conventions §2; the w4 note's
      // drained polarity — the last page serves `nextCursor: null`); 
      // otherwise the opaque, user-bound token for the position AFTER the
      // last entry.
      const last = rows.at(-1);
      const nextCursor = exhausted && last !== undefined
        ? encodeExerciseSearchCursor({ rank: last.rank, id: last.id }, userId, this.config.values.searchCursorKey)
        : null;
      return { data, nextCursor };
    });
  }

  /** conventions §2: clamp 1–100, default 50; non-numeric ⇒ generic 400. */
  private static parseLimit(limitRaw: unknown): number {
    if (limitRaw === undefined || limitRaw === null || limitRaw === '') {
      return LIMIT_DEFAULT;
    }
    if (typeof limitRaw !== 'string' || !/^[0-9]+$/u.test(limitRaw)) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'limit', message: 'must be a positive integer.' }],
      });
    }
    return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Number(limitRaw)));
  }

  /** The one generic cursor-rejection body (byte-stable; no errors array). */
  private static genericCursorRejection(): KalProblemException {
    return new KalProblemException('VALIDATION_FAILED');
  }

  // -------------------------------------------------------------------------
  // journal.exercises.get — GET /journal/exercises/{exerciseId}
  // -------------------------------------------------------------------------

  async exerciseDetail(exerciseIdRaw: string): Promise<{ exercise: ExerciseItemProjection }> {
    const userId = this.requireConsumerUserId();
    // Malformed ids are the SAME generic 404 as absent ones — byte-identical,
    // no existence oracle (I7; w4 note §2 — the w3 foods.get posture).
    if (!UUID_PATTERN.test(exerciseIdRaw)) {
      throw new KalProblemException('NOT_FOUND');
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const exercise = await this.repository.findExercise(tx, exerciseIdRaw);
      if (exercise === null) {
        throw new KalProblemException('NOT_FOUND');
      }
      return { exercise: projectExercise(exercise) };
    });
  }

  // -------------------------------------------------------------------------
  // The s2a seam — server-derived name snapshots (w4 note §1.1)
  // -------------------------------------------------------------------------

  /**
   * The journal-INTERNAL snapshot seam: the session apply handler freezes
   * `nameEn`/`nameAr` from the catalog row's CURRENT values at apply time
   * (later catalog edits never rewrite logged session history). s2a's
   * handler consumes THIS method — never the tables (module boundary);
   * every id must reference an existing catalog row (validated by the
   * payload rules before this is called — a missing row is the handler's
   * `rejected_validation` case).
   */
  async catalogNameSnapshots(
    tx: JournalTx,
    exerciseIds: readonly string[],
  ): Promise<Map<string, ExerciseNameSnapshot>> {
    const rows = await this.repository.findManyForSnapshot(tx, exerciseIds);
    return new Map(rows.map((row) => [row.id, { nameEn: row.nameEn, nameAr: row.nameAr }]));
  }
}
