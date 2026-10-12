/**
 * Kal — the `journal_routine` sync op apply-handler (wave-04 contract §1.1/
 * §1.2; the frozen per-op state machine of wave-03 §1.3 applies verbatim).
 *
 * Routine templates (PRD §21, FR-024) exist ONLY as sync ops: this handler
 * is the single sanctioned write path (validate → authorize → unit-of-work
 * state machine → snapshot freeze). There is NO routine REST mutation
 * endpoint — by design (contract §2 freeze); "start from routine" is an app
 * concern that surfaces server-side as an ordinary `journal_session` op.
 *
 * The handler implements the frozen per-op state machine exactly:
 *   create: no row → apply (INSERT routine + child tree, updated_at =
 *           clientUpdatedAt, last_op_id = opId); active row ⇒
 *           `rejected_conflict`; tombstoned row ⇒ `rejected_deleted`
 *           (same-entity-ID create after delete is blocked — no
 *           resurrection; a fresh client entity id is a NEW template).
 *   update: active row → LWW resolve (§1.4); the write happens only if the
 *           op wins — a loser is recorded `applied` and changes nothing
 *           (the delta feed is the convergence channel); tombstoned ⇒
 *           `rejected_deleted` (an update never undeletes); no row ⇒
 *           `rejected_conflict`.
 *   delete: active row → tombstone write (deleted_at = now() server-side,
 *           updated_at = clientUpdatedAt, last_op_id = opId); tombstoned or
 *           no row → `applied` idempotently, nothing written. Tombstones
 *           win over stale ops; tombstones are never cleared (§1.5).
 *   A winning update REPLACES the child tree (the W3 serving-set pattern:
 *   the superseded entries/sets soft-delete, fresh rows insert — an edit is
 *   a new log event; observables identical for upsert-in-place).
 *
 * The handler THROWS NOTHING: outcomes are values. Validation failures
 * (payload shape, exact §1.1 bounds, malformed format mixes, unknown or
 * nonexistent exerciseId) precede everything and yield
 * `rejected_validation`, retryable false.
 *
 * NAME SNAPSHOTS freeze server-side at apply time (§1.1): the catalog
 * rows' current `nameEn`/`nameAr` copy into the entry snapshot columns;
 * later catalog edits never rewrite the template (I11-analog), and an
 * applying edit re-freezes at THAT apply.
 *
 * NO RATE LIMIT exists for routines (contract §1.2 rate-guards
 * `journal_session` creates only; a template is not a log). Routines carry
 * NO training-day mark either (a template has no day; marks derive from
 * session ops only — the session lane owns that projection).
 *
 * Posture: the caller (sync ingestion, one transaction per batch) hands in
 * a transaction already carrying `SET LOCAL ROLE kal_app` + `app.user_id` +
 * `TimeZone UTC`. The handler re-verifies that the transaction's user
 * context IS the op's validated context before touching a row (I6 made
 * structural — fail closed, never a per-op outcome). Every query
 * additionally binds `userId` explicitly (I1: the GUC is the backstop, not
 * the only layer).
 *
 * SEAM NOTE (pre-union): this class satisfies the canonical `SyncOpHandler`
 * shape with the widened kind; the local structural mirror
 * (`./routine-seams.ts`) swaps to canonical type-level imports at this
 * lane's registration-union rebase (the W3 s2d precedent — supervisor
 * ruling 1, wave-04 ledger).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.ts';
import {
  isUuid,
  parseRoutineSnapshot,
  parseUtcInstant,
  type RoutineSnapshot,
} from './routine-payload.js';
import { opWinsLww } from './routine-lww.js';
import type { RoutineOpContext, RoutineOpEnvelope, RoutineOpHandlerResult, RoutineOpHandler as RoutineOpHandlerSeam } from './routine-seams.js';

const VALIDATION_REJECTED: RoutineOpHandlerResult = { outcome: 'rejected', code: 'rejected_validation', retryable: false };
const CONFLICT_REJECTED: RoutineOpHandlerResult = { outcome: 'rejected', code: 'rejected_conflict', retryable: false };
const DELETED_REJECTED: RoutineOpHandlerResult = { outcome: 'rejected', code: 'rejected_deleted', retryable: false };
const APPLIED: RoutineOpHandlerResult = { outcome: 'applied' };

@Injectable()
export class RoutineOpHandler implements RoutineOpHandlerSeam {
  readonly kind = 'journal_routine' as const;

  async apply(op: RoutineOpEnvelope, ctx: RoutineOpContext, tx: Prisma.TransactionClient): Promise<RoutineOpHandlerResult> {
    if (op.kind !== this.kind) {
      return VALIDATION_REJECTED;
    }
    if (!isUuid(op.opId) || !isUuid(op.entityId)) {
      return VALIDATION_REJECTED; // stable ids are UUIDs (§1.1); a malformed id must never reach a UUID column (it would abort the batch)
    }
    await this.assertTransactionPosture(tx, ctx);

    if (op.action === 'delete') {
      return this.applyDelete(op, ctx, tx);
    }
    if (op.action !== 'create' && op.action !== 'update') {
      return VALIDATION_REJECTED;
    }
    const parsed = parseRoutineSnapshot(op);
    if (!parsed.ok) {
      return VALIDATION_REJECTED;
    }
    const { snapshot, clientUpdatedAt } = parsed;
    // Referential validation precedes any state read (contract §1.3:
    // validation failures precede the state machine) — every exerciseId
    // must reference an existing catalog row, and the SAME read freezes the
    // server-derived name snapshots (§1.1).
    const names = await this.freezeNameSnapshots(tx, snapshot);
    if (names === null) {
      return VALIDATION_REJECTED; // unknown/nonexistent exerciseId
    }
    const existing = await tx.journalRoutine.findFirst({
      where: { id: op.entityId, userId: ctx.userId },
    });
    if (op.action === 'create') {
      return this.applyCreate(op, ctx, snapshot, clientUpdatedAt, names, existing, tx);
    }
    return this.applyUpdate(op, ctx, snapshot, clientUpdatedAt, names, existing, tx);
  }

  /**
   * Resolves every referenced catalog row and returns the snapshot map
   * (exerciseId → frozen names). Null when ANY id is unknown — the whole op
   * rejects (partial templates never apply). Each apply freezes the rows'
   * CURRENT names (an edit re-freezes at that apply).
   */
  private async freezeNameSnapshots(
    tx: Prisma.TransactionClient,
    snapshot: RoutineSnapshot,
  ): Promise<Map<string, { nameEn: string; nameAr: string }> | null> {
    const ids = [...new Set(snapshot.exercises.map((entry) => entry.exerciseId))];
    const rows = await tx.exercise.findMany({
      where: { id: { in: ids } },
      select: { id: true, nameEn: true, nameAr: true },
    });
    if (rows.length !== ids.length) {
      return null;
    }
    return new Map(rows.map((row) => [row.id, { nameEn: row.nameEn, nameAr: row.nameAr }]));
  }

  /** Inserts the full child tree for a fresh (or LWW-winning) snapshot. */
  private async insertChildTree(
    tx: Prisma.TransactionClient,
    ctx: RoutineOpContext,
    routineId: string,
    snapshot: RoutineSnapshot,
    names: Map<string, { nameEn: string; nameAr: string }>,
  ): Promise<void> {
    for (const entry of snapshot.exercises) {
      const frozen = names.get(entry.exerciseId);
      if (frozen === undefined) {
        throw new Error('routine apply: snapshot map lost an entry (fail-closed)');
      }
      const created = await tx.journalRoutineExercise.create({
        data: {
          routineId,
          userId: ctx.userId,
          exerciseId: entry.exerciseId,
          position: entry.position,
          nameSnapshotEn: frozen.nameEn,
          nameSnapshotAr: frozen.nameAr,
        },
        select: { id: true },
      });
      if (entry.sets.length > 0) {
        // Sets are ordered by ARRAY ORDER (the §1.1 payload carries no set
        // positions — the array index IS the stored position, CHECK-pinned ≥ 0).
        await tx.journalRoutineSet.createMany({
          data: entry.sets.map((set, index) => ({
            routineExerciseId: created.id,
            userId: ctx.userId,
            position: index,
            format: set.format,
            weightKg: set.weightKg ?? null,
            reps: set.reps ?? null,
            durationSeconds: set.durationSeconds ?? null,
            notesText: set.text ?? null,
          })),
        });
      }
    }
  }

  /**
   * The W3 serving-set replacement: a winning update soft-deletes the whole
   * superseded child tree (entries + their sets) before the fresh tree
   * inserts. Never a hard delete — history stays in the tombstone posture
   * of the owned tables.
   */
  private async softDeleteChildTree(
    tx: Prisma.TransactionClient,
    ctx: RoutineOpContext,
    routineId: string,
  ): Promise<void> {
    const entries = await tx.journalRoutineExercise.findMany({
      where: { routineId, userId: ctx.userId, deletedAt: null },
      select: { id: true },
    });
    if (entries.length > 0) {
      await tx.journalRoutineSet.updateMany({
        where: { routineExerciseId: { in: entries.map((entry) => entry.id) }, userId: ctx.userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await tx.journalRoutineExercise.updateMany({
        where: { id: { in: entries.map((entry) => entry.id) }, userId: ctx.userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }
  }

  private async applyCreate(
    op: RoutineOpEnvelope,
    ctx: RoutineOpContext,
    snapshot: RoutineSnapshot,
    clientUpdatedAt: Date,
    names: Map<string, { nameEn: string; nameAr: string }>,
    existing: { deletedAt: Date | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<RoutineOpHandlerResult> {
    if (existing !== null) {
      // Entity-id misuse: create on a live entity is a conflict; create on a
      // tombstone is the no-resurrection block (I9). Both terminal.
      return existing.deletedAt !== null ? DELETED_REJECTED : CONFLICT_REJECTED;
    }
    await tx.journalRoutine.create({
      data: {
        id: op.entityId,
        userId: ctx.userId,
        name: snapshot.name,
        updatedAt: clientUpdatedAt,
        lastOpId: op.opId,
      },
      select: { id: true },
    });
    await this.insertChildTree(tx, ctx, op.entityId, snapshot, names);
    return APPLIED;
  }

  private async applyUpdate(
    op: RoutineOpEnvelope,
    ctx: RoutineOpContext,
    snapshot: RoutineSnapshot,
    clientUpdatedAt: Date,
    names: Map<string, { nameEn: string; nameAr: string }>,
    existing: { id: string; deletedAt: Date | null; updatedAt: Date; lastOpId: string | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<RoutineOpHandlerResult> {
    if (existing === null) {
      // Client belief vs server truth — the client must re-pull (§1.3).
      return CONFLICT_REJECTED;
    }
    if (existing.deletedAt !== null) {
      return DELETED_REJECTED; // an update never undeletes (§1.3/§1.5)
    }
    if (!opWinsLww({ clientUpdatedAt, opId: op.opId }, { updatedAt: existing.updatedAt, lastOpId: existing.lastOpId })) {
      // A deterministic loser: acked `applied`, changes nothing (§1.3/§1.4 —
      // the delta feed carries the winning state to every device).
      return APPLIED;
    }
    await this.softDeleteChildTree(tx, ctx, existing.id);
    const updated = await tx.journalRoutine.updateMany({
      where: { id: existing.id, userId: ctx.userId },
      data: {
        name: snapshot.name,
        updatedAt: clientUpdatedAt,
        lastOpId: op.opId,
      },
    });
    if (updated.count !== 1) {
      // The row was visible to the read above in THIS transaction — reaching
      // here would mean a broken posture. Refuse rather than half-apply.
      throw new Error('routine apply: winning update matched no row (fail-closed)');
    }
    await this.insertChildTree(tx, ctx, existing.id, snapshot, names);
    return APPLIED;
  }

  private async applyDelete(
    op: RoutineOpEnvelope,
    ctx: RoutineOpContext,
    tx: Prisma.TransactionClient,
  ): Promise<RoutineOpHandlerResult> {
    // Envelope parity (defensive — sync batch-validates this first, §1.2):
    // deletes carry no payload; routine ops carry NO localDate (a template
    // has no day — the parity CHECK agrees).
    if (op.payload !== undefined || (op.localDate !== undefined && op.localDate !== null)) {
      return VALIDATION_REJECTED;
    }
    const clientUpdatedAt = parseUtcInstant(op.clientUpdatedAt);
    if (clientUpdatedAt === null) {
      return VALIDATION_REJECTED;
    }
    const existing = await tx.journalRoutine.findFirst({
      where: { id: op.entityId, userId: ctx.userId },
    });
    if (existing === null || existing.deletedAt !== null) {
      // Idempotent (§1.3): the deletion goal already holds; nothing is
      // written but the op is recorded (by sync) and acked `applied`.
      // Byte-identical for B against A's rows: the row is invisible, the
      // outcome is the same `applied`, and nothing of A's is touched.
      return APPLIED;
    }
    const deleted = await tx.journalRoutine.updateMany({
      where: { id: existing.id, userId: ctx.userId },
      data: {
        deletedAt: new Date(), // server-side tombstone instant (§1.3)
        updatedAt: clientUpdatedAt, // the LWW substrate stays client-authored
        lastOpId: op.opId,
      },
    });
    if (deleted.count !== 1) {
      throw new Error('routine apply: tombstone write matched no row (fail-closed)');
    }
    return APPLIED;
  }

  /**
   * I6, structural: the caller's transaction must ALREADY be operating as
   * the op's verified user (sync's per-transaction posture). A missing or
   * mismatched transaction context is a seam violation — refuse the whole
   * apply (throw) rather than silently applying under the wrong identity.
   */
  private async assertTransactionPosture(tx: Prisma.TransactionClient, ctx: RoutineOpContext): Promise<void> {
    const probe = await tx.$queryRaw<{ currentRole: string; gucUser: string | null }[]>`
      SELECT current_user AS "currentRole", current_setting('app.user_id', true) AS "gucUser"`;
    const row = probe[0];
    if (row === undefined || row.currentRole !== 'kal_app' || row.gucUser !== ctx.userId) {
      throw new Error('routine apply: transaction user context does not match the op context (fail-closed)');
    }
  }
}
