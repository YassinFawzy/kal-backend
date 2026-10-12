/**
 * Kal — the per-exercise PR READ model (wave-04 contract §1.3/§2
 * `journal.exercises.pr.get`; server-derived, derived-never-stored —
 * "PRs are derived, never hand-edited, never stored: every read recomputes
 * from applied sessions").
 *
 * Visibility is OWNING-USER-ONLY (I7): the caller's validated consumer
 * context is the sole scope; every query binds `userId` explicitly (I1)
 * inside the journal's per-transaction posture (`SET LOCAL ROLE kal_app` +
 * `app.user_id` + `TimeZone UTC` — I2), and the derivation consumes ONLY
 * the caller's own NON-DELETED sessions (deleted sessions, superseded
 * entries, and superseded sets never contribute — the tombstone posture
 * makes a deleted PR disappear from reads).
 *
 * Denials are byte-identical by construction: a malformed id, an absent
 * catalog id — the `404 NOT_FOUND` problem details is the SAME generic
 * envelope for every cause (no existence oracle). A catalog row that exists
 * with no qualifying sets is the success-shaped `result: "none"` empty
 * state, never an error.
 *
 * The catalog existence probe reads the platform `exercises` table directly:
 * the catalog is journal-module-owned state (RLS declined — platform data,
 * every authenticated consumer reads the same governed rows; the w4 note §5
 * posture), so no cross-module gate is crossed. The module-gate rule holds:
 * no tracking/identity table is ever touched.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { PrismaService } from '../../db/prisma.service.js';
import { inUserScopeTx } from '../journal-tx.js';
import { isUuid } from '../routines/routine-payload.js';
import { derivePr, type PrCandidateRow } from './pr-math.js';

/** The contract §1.3 read shape (`journal.exercises.pr.get` 200 body). */
export interface PrReadView {
  readonly result: 'pr' | 'none';
  readonly pr?: {
    readonly exerciseId: string;
    readonly estimatedOneRepMaxKg: number;
    readonly sourceSet: {
      readonly sessionId: string;
      readonly setId: string;
      readonly weightKg: number;
      readonly reps: number;
      readonly sessionLocalDate: string;
    };
    readonly achievedOn: string;
  };
}

@Injectable()
export class PrService {
  constructor(private readonly db: PrismaService) {}

  async readPr(userId: string, exerciseId: string): Promise<PrReadView> {
    // Malformed ids and unknown catalog ids are the SAME byte-identical
    // generic denial (§3 — the 404 parity set); the shape check runs first
    // so a malformed id never reaches a UUID cast (which would abort as a
    // raw 22P02 instead of a clean denial).
    if (!isUuid(exerciseId)) {
      throw new KalProblemException('NOT_FOUND');
    }
    return inUserScopeTx(this.db, { userId }, async (tx) => {
      const exercise = await tx.exercise.findUnique({
        where: { id: exerciseId },
        select: { id: true },
      });
      if (exercise === null) {
        throw new KalProblemException('NOT_FOUND');
      }
      // The derivation's candidate query: the caller's OWN weighted sets in
      // NON-DELETED sessions, on NON-DELETED (current) exercise entries.
      // Every weighted set carries reps ≥ 1 and weight > 0 (validation
      // pinned + CHECK-pinned); the null filters restate the discriminated
      // XOR so a hostile row can never enter the arithmetic.
      const rows = await tx.journalExerciseSet.findMany({
        where: {
          deletedAt: null,
          format: 'weighted',
          weightKg: { not: null },
          reps: { not: null },
          sessionExercise: {
            is: {
              deletedAt: null,
              exerciseId,
              session: { is: { deletedAt: null, userId } },
            },
          },
        },
        select: {
          id: true,
          position: true,
          weightKg: true,
          reps: true,
          sessionExercise: {
            select: {
              position: true,
              session: { select: { id: true, localDate: true } },
            },
          },
        },
      });
      const candidates: PrCandidateRow[] = rows.map((row) => ({
        setId: row.id,
        setPosition: row.position,
        weightKg: row.weightKg as Prisma.Decimal,
        reps: row.reps as number,
        exerciseEntryPosition: row.sessionExercise.position,
        sessionId: row.sessionExercise.session.id,
        sessionLocalDate: row.sessionExercise.session.localDate,
      }));
      const derived = derivePr(candidates);
      if (derived === null) {
        return { result: 'none' as const };
      }
      return {
        result: 'pr' as const,
        pr: {
          exerciseId,
          estimatedOneRepMaxKg: derived.estimatedOneRepMaxKg,
          sourceSet: {
            sessionId: derived.sessionId,
            setId: derived.setId,
            weightKg: Number(derived.weightKg),
            reps: derived.reps,
            sessionLocalDate: derived.sessionLocalDate,
          },
          achievedOn: derived.sessionLocalDate,
        },
      };
    });
  }
}
