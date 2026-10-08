/**
 * Kal — the `diary_entry` sync op apply-handler (wave-03 contract §1.3, I8/I9/I11).
 *
 * Diary mutations exist ONLY as sync ops: this handler is the single
 * sanctioned write path (validate → authorize → unit-of-work state machine
 * → rollup recompute). There is no diary REST mutation endpoint — by
 * design (contract §2 freeze; nothing else may be built).
 *
 * The handler implements the frozen per-op state machine exactly:
 *   create: no row → apply (INSERT, updated_at = clientUpdatedAt, last_op_id);
 *           active row → `rejected_conflict`; tombstoned row → `rejected_deleted`
 *           (same-entity-ID create after delete is blocked — no resurrection, I9;
 *           a fresh client entity id is a NEW entry).
 *   update: active row → LWW resolve (§1.4); the write happens only if the op
 *           wins — a loser is recorded `applied` and changes nothing (the delta
 *           feed is the convergence channel); tombstoned → `rejected_deleted`
 *           (an update never undeletes); no row → `rejected_conflict`.
 *   delete: active row → tombstone write (deleted_at = now() server-side,
 *           updated_at = clientUpdatedAt, last_op_id = opId) + rollup recompute;
 *           tombstoned or no row → `applied` idempotently, nothing written.
 * Tombstones win over stale ops; tombstones are never cleared (§1.5).
 *
 * The handler THROWS NOTHING: outcomes are values. Validation failures
 * (payload shape, bad localDate, unknown meal slot, macros negative, source
 * XOR violated, unresolvable food reference) precede everything and yield
 * `rejected_validation`, retryable false (contract §1.3). Diary entries are
 * UNLIMITED — logging is never rate-limited (§1.7): the ADR-0004 durability
 * guarantee holds without exception for the diary.
 *
 * Posture (F1 guidance): the caller (sync ingestion, one transaction per
 * batch) hands in a transaction already carrying the per-transaction
 * posture — `SET LOCAL ROLE kal_app` + `app.user_id` + `TimeZone UTC`. The
 * handler re-verifies that the transaction's user context IS the op's
 * validated context before touching a row (I6 made structural: a
 * context-less or mismatched transaction is a seam violation and is
 * refused — fail closed, never a per-op outcome). Every query additionally
 * binds `userId` explicitly (I1: the GUC is the backstop, not the only
 * layer).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { isValidLocalDate, localDateToDate } from './diary-day.js';
import { opWinsLww } from './diary-lww.js';
import { parseDiarySnapshot, parseUtcInstant, isUuid, snapshotToRowData, type DiaryEntrySnapshot } from './diary-snapshot.js';
import { DiaryFoodReferenceValidator } from './diary-food-reference.port.js';
import { DiaryRollupsService } from './diary-rollups.service.js';
import type { SyncOpHandlerResult, SyncOpContext, SyncOpEnvelope, SyncOpHandler } from '../sync-seams.js';

const VALIDATION_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_validation', retryable: false };
const CONFLICT_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_conflict', retryable: false };
const DELETED_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_deleted', retryable: false };
const APPLIED: SyncOpHandlerResult = { outcome: 'applied' };

@Injectable()
export class DiaryEntryOpHandler implements SyncOpHandler {
  readonly kind = 'diary_entry' as const;

  constructor(
    private readonly rollups: DiaryRollupsService,
    private readonly foodReferences: DiaryFoodReferenceValidator,
  ) {}

  async apply(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
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
    const parsed = parseDiarySnapshot(op);
    if (parsed === null) {
      return VALIDATION_REJECTED;
    }
    const { snapshot, clientUpdatedAt } = parsed;
    // Referential validation precedes any state read (contract §1.3:
    // validation failures precede rate limiting and the state machine).
    if (!(await this.foodReferences.validateDiaryReferences(tx, ctx.userId, snapshot))) {
      return VALIDATION_REJECTED;
    }
    const existing = await tx.diaryEntry.findFirst({
      where: { id: op.entityId, userId: ctx.userId },
    });
    if (op.action === 'create') {
      return this.applyCreate(op, ctx, snapshot, clientUpdatedAt, existing, tx);
    }
    return this.applyUpdate(op, ctx, snapshot, clientUpdatedAt, existing, tx);
  }

  private async applyCreate(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    snapshot: DiaryEntrySnapshot,
    clientUpdatedAt: Date,
    existing: { deletedAt: Date | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<SyncOpHandlerResult> {
    if (existing !== null) {
      // Entity-id misuse: create on a live entity is a conflict; create on a
      // tombstone is the no-resurrection block (I9). Both terminal.
      return existing.deletedAt !== null ? DELETED_REJECTED : CONFLICT_REJECTED;
    }
    await tx.diaryEntry.create({
      data: {
        id: op.entityId,
        userId: ctx.userId,
        ...snapshotToRowData(snapshot),
        updatedAt: clientUpdatedAt,
        lastOpId: op.opId,
      },
    });
    await this.rollups.recomputeDay(tx, ctx.userId, localDateToDate(snapshot.localDate));
    return APPLIED;
  }

  private async applyUpdate(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    snapshot: DiaryEntrySnapshot,
    clientUpdatedAt: Date,
    existing: { id: string; localDate: Date; deletedAt: Date | null; updatedAt: Date; lastOpId: string | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<SyncOpHandlerResult> {
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
    const updated = await tx.diaryEntry.updateMany({
      where: { id: existing.id, userId: ctx.userId },
      data: {
        ...snapshotToRowData(snapshot),
        updatedAt: clientUpdatedAt,
        lastOpId: op.opId,
      },
    });
    if (updated.count !== 1) {
      // The row was visible to the read above in THIS transaction — reaching
      // here would mean a broken posture. Refuse rather than half-apply.
      throw new Error('diary apply: winning update matched no row (fail-closed)');
    }
    const previousDay = existing.localDate;
    const newDay = localDateToDate(snapshot.localDate);
    await this.rollups.recomputeDay(tx, ctx.userId, previousDay);
    if (previousDay.getTime() !== newDay.getTime()) {
      // An edit may move an entry between client-local days: both buckets
      // recompute (each from its own non-deleted entries only).
      await this.rollups.recomputeDay(tx, ctx.userId, newDay);
    }
    return APPLIED;
  }

  private async applyDelete(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
    // Envelope parity (defensive — sync batch-validates this first, §1.2):
    // deletes carry no payload; diary ops carry a calendar-valid localDate
    // (shape-only — the carried date is never used to derive anything here;
    // the row's stored local_date is the bucketing truth).
    if (op.payload !== undefined || !isValidLocalDate(op.localDate)) {
      return VALIDATION_REJECTED;
    }
    const clientUpdatedAt = parseUtcInstant(op.clientUpdatedAt);
    if (clientUpdatedAt === null) {
      return VALIDATION_REJECTED;
    }
    const existing = await tx.diaryEntry.findFirst({
      where: { id: op.entityId, userId: ctx.userId },
    });
    if (existing === null || existing.deletedAt !== null) {
      // Idempotent (§1.3): the deletion goal already holds; nothing is
      // written but the op is recorded (by sync) and acked `applied`.
      // Byte-identical for B against A's rows: the row is invisible, the
      // outcome is the same `applied`, and nothing of A's is touched.
      return APPLIED;
    }
    const deleted = await tx.diaryEntry.updateMany({
      where: { id: existing.id, userId: ctx.userId },
      data: {
        deletedAt: new Date(), // server-side tombstone instant (§1.3)
        updatedAt: clientUpdatedAt, // the LWW substrate stays client-authored
        lastOpId: op.opId,
      },
    });
    if (deleted.count !== 1) {
      throw new Error('diary apply: tombstone write matched no row (fail-closed)');
    }
    await this.rollups.recomputeDay(tx, ctx.userId, existing.localDate);
    return APPLIED;
  }

  /**
   * I6, structural: the caller's transaction must ALREADY be operating as
   * the op's verified user (sync's per-transaction posture). A missing or
   * mismatched transaction context is a seam violation — refuse the whole
   * apply (throw) rather than silently applying under the wrong identity.
   */
  private async assertTransactionPosture(tx: Prisma.TransactionClient, ctx: SyncOpContext): Promise<void> {
    const probe = await tx.$queryRaw<{ currentRole: string; gucUser: string | null }[]>`
      SELECT current_user AS "currentRole", current_setting('app.user_id', true) AS "gucUser"`;
    const row = probe[0];
    if (row === undefined || row.currentRole !== 'kal_app' || row.gucUser !== ctx.userId) {
      throw new Error('diary apply: transaction user context does not match the op context (fail-closed)');
    }
  }
}
