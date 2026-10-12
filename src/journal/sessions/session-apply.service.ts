/**
 * Kal — the `journal_session` sync op apply-handler (w4 contract §1; the
 * w3 §1.3 per-op state machine inherited verbatim).
 *
 * Journal session mutations exist ONLY as sync ops: this handler is the
 * single sanctioned write path (validate → authorize → unit-of-work state
 * machine → mark recompute). There is no journal REST mutation endpoint —
 * by design (w4 note §2 freeze; nothing else may be built).
 *
 * The handler implements the frozen per-op state machine exactly:
 *   create: no row → validate payload + catalog references, take the
 *           session-create rate limiter (§1.2 — creates only), then apply
 *           (INSERT with server-derived name snapshots; updated_at =
 *           clientUpdatedAt; last_op_id); active row → `rejected_conflict`;
 *           tombstoned row → `rejected_deleted` (same-entity-ID create
 *           after delete is blocked — no resurrection; a fresh client
 *           entity id is a NEW session).
 *   update: active row → LWW resolve (§1.4); the write happens only if the
 *           op wins — a loser is recorded `applied` and changes nothing
 *           (the delta feed is the convergence channel); tombstoned →
 *           `rejected_deleted` (an update never undeletes); no row →
 *           `rejected_conflict`. A winning update REPLACES the children
 *           (full-snapshot replacement) and RE-FREEZES name snapshots at
 *           THAT apply — an edit is a new log event (§1.1).
 *   delete: active row → tombstone write (deleted_at = now() server-side,
 *           updated_at = clientUpdatedAt, last_op_id = opId) + mark
 *           recompute; tombstoned or no row → `applied` idempotently,
 *           nothing written.
 * Tombstones win over stale ops; tombstones are never cleared (§1.5).
 *
 * Rate guard (§1.2): CREATE ops only — one limiter, rolling hour + 24 h
 * windows, ticked inside this transaction AFTER validation and BEFORE
 * application. Over-limit ⇒ `rejected_rate_limited`, retryable true, and
 * NOTHING is ticked or written — the w3 "acked-not-recorded" ruling holds:
 * sync records no ledger row, and the same opId retried after the window
 * rolls off applies cleanly. Updates and deletes are never limited.
 *
 * Training-day marks (§1.2): recomputed idempotently inside THIS unit of
 * work for the op's STORED client-local date on every applied op that
 * touches a day (create; winning update — both days when the edit moves
 * the session; delete — the stored day). Marks are never synced, never
 * REST-mutable, never in the delta feed.
 *
 * The handler THROWS NOTHING: outcomes are values. Validation failures
 * (payload shape, bounds, malformed/mismatched localDate, unknown
 * exercise reference) precede everything and yield
 * `rejected_validation`, retryable false.
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
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { EXERCISE_CATALOG_RESOLUTION_PORT, type ExerciseCatalogResolutionPort } from './exercise-catalog.port.js';
import { isValidLocalDate, localDateToDate } from './session-day.js';
import { opWinsSessionLww } from './session-lww.js';
import { isSessionUuid, parseSessionSnapshot, parseSessionUtcInstant, type SessionSnapshot } from './session-snapshot.js';
import { SessionCreateRateLimiter } from './session-rate-limiter.js';
import { SessionRepository } from './session-repository.js';
import { TrainingDayMarksService } from './training-day-marks.service.js';
import type { SyncOpHandlerResult, SyncOpContext, SyncOpEnvelope, SyncOpHandler } from '../../tracking/sync-seams.js';

const VALIDATION_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_validation', retryable: false };
const CONFLICT_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_conflict', retryable: false };
const DELETED_REJECTED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_deleted', retryable: false };
const RATE_LIMITED: SyncOpHandlerResult = { outcome: 'rejected', code: 'rejected_rate_limited', retryable: true };
const APPLIED: SyncOpHandlerResult = { outcome: 'applied' };

@Injectable()
export class SessionOpHandler implements SyncOpHandler {
  readonly kind = 'journal_session' as const;

  constructor(
    private readonly repository: SessionRepository,
    private readonly limiter: SessionCreateRateLimiter,
    private readonly marks: TrainingDayMarksService,
    // Journal-internal catalog seam (§4 module gates) — the JournalModule
    // may rebind this port to the catalog area's exported service without
    // touching this handler (the W3 diary food-reference precedent).
    @Inject(EXERCISE_CATALOG_RESOLUTION_PORT) private readonly catalog: ExerciseCatalogResolutionPort,
  ) {}

  async apply(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
    if (op.kind !== this.kind) {
      return VALIDATION_REJECTED;
    }
    if (!isSessionUuid(op.opId) || !isSessionUuid(op.entityId)) {
      return VALIDATION_REJECTED; // stable ids are UUIDs (§1.1); a malformed id must never reach a UUID column (it would abort the batch)
    }
    await this.assertTransactionPosture(tx, ctx);

    if (op.action === 'delete') {
      return this.applyDelete(op, ctx, tx);
    }
    if (op.action !== 'create' && op.action !== 'update') {
      return VALIDATION_REJECTED;
    }
    const parsed = parseSessionSnapshot(op);
    if (parsed === null) {
      return VALIDATION_REJECTED;
    }
    const { snapshot, clientUpdatedAt } = parsed;
    // Referential validation precedes any state read (the w3 §1.3 posture:
    // validation failures precede rate limiting and the state machine).
    // Unknown/malformed exercise references are indistinguishable (I7):
    // one rejection for every unknown-id cause.
    const catalogNames = await this.catalog.resolveCatalogNames(
      tx,
      snapshot.exercises.map((entry) => entry.exerciseId),
    );
    if (catalogNames === null) {
      return VALIDATION_REJECTED;
    }
    const existing = await this.repository.findSessionIncludingDeleted(tx, ctx.userId, op.entityId);
    if (op.action === 'create') {
      return this.applyCreate(op, ctx, snapshot, clientUpdatedAt, catalogNames, existing, tx);
    }
    return this.applyUpdate(op, ctx, snapshot, clientUpdatedAt, catalogNames, existing, tx);
  }

  private async applyCreate(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    snapshot: SessionSnapshot,
    clientUpdatedAt: Date,
    catalogNames: NonNullable<Awaited<ReturnType<ExerciseCatalogResolutionPort['resolveCatalogNames']>>>,
    existing: { deletedAt: Date | null } | null,
    tx: Prisma.TransactionClient,
  ): Promise<SyncOpHandlerResult> {
    if (existing !== null) {
      // Entity-id misuse: create on a live entity is a conflict; create on a
      // tombstone is the no-resurrection block (I9). Both terminal.
      return existing.deletedAt !== null ? DELETED_REJECTED : CONFLICT_REJECTED;
    }
    // Session-create rate guard (§1.2): AFTER validation, BEFORE
    // application; the tick commits atomically with the INSERT (one unit
    // of work). A rejected op ticks NOTHING and writes NOTHING.
    const limit = await this.limiter.assertCanCreateAndTick(tx, ctx.userId);
    if (!limit.ok) {
      return RATE_LIMITED;
    }
    await this.repository.insertSessionWithChildren(tx, {
      userId: ctx.userId,
      entityId: op.entityId,
      snapshot,
      clientUpdatedAt,
      opId: op.opId,
      catalogNames,
    });
    await this.marks.recomputeDay(tx, ctx.userId, localDateToDate(snapshot.localDate));
    return APPLIED;
  }

  private async applyUpdate(
    op: SyncOpEnvelope,
    ctx: SyncOpContext,
    snapshot: SessionSnapshot,
    clientUpdatedAt: Date,
    catalogNames: NonNullable<Awaited<ReturnType<ExerciseCatalogResolutionPort['resolveCatalogNames']>>>,
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
    if (!opWinsSessionLww({ clientUpdatedAt, opId: op.opId }, { updatedAt: existing.updatedAt, lastOpId: existing.lastOpId })) {
      // A deterministic loser: acked `applied`, changes nothing (§1.3/§1.4 —
      // the delta feed carries the winning state to every device). No mark
      // recompute: the day's active-session set is unchanged.
      return APPLIED;
    }
    await this.repository.updateSessionWithChildren(tx, {
      userId: ctx.userId,
      entityId: existing.id,
      snapshot,
      clientUpdatedAt,
      opId: op.opId,
      catalogNames,
    });
    // Marks recompute for BOTH client-local days when an edit moves a
    // session between days (each from its own active sessions only) —
    // idempotent on the unchanged-day case (same day ⇒ one recompute worth).
    const previousDay = existing.localDate;
    const newDay = localDateToDate(snapshot.localDate);
    if (previousDay.getTime() === newDay.getTime()) {
      await this.marks.recomputeDay(tx, ctx.userId, newDay);
    } else {
      await this.marks.recomputeDay(tx, ctx.userId, previousDay);
      await this.marks.recomputeDay(tx, ctx.userId, newDay);
    }
    return APPLIED;
  }

  private async applyDelete(op: SyncOpEnvelope, ctx: SyncOpContext, tx: Prisma.TransactionClient): Promise<SyncOpHandlerResult> {
    // Envelope parity (defensive — sync batch-validates this first, §1.2):
    // deletes carry no payload; journal_session ops carry a calendar-valid
    // localDate (shape-only — the carried date is never used to derive
    // anything here; the row's STORED local_date is the bucketing truth).
    if (op.payload !== undefined || !isValidLocalDate(op.localDate)) {
      return VALIDATION_REJECTED;
    }
    const clientUpdatedAt = parseSessionUtcInstant(op.clientUpdatedAt);
    if (clientUpdatedAt === null) {
      return VALIDATION_REJECTED;
    }
    const existing = await this.repository.findSessionIncludingDeleted(tx, ctx.userId, op.entityId);
    if (existing === null || existing.deletedAt !== null) {
      // Idempotent (§1.3): the deletion goal already holds; nothing is
      // written but the op is recorded (by sync) and acked `applied`.
      // Byte-identical for B against A's rows: the row is invisible, the
      // outcome is the same `applied`, and nothing of A's is touched (I7).
      return APPLIED;
    }
    await this.repository.tombstoneSession(tx, {
      userId: ctx.userId,
      entityId: existing.id,
      clientUpdatedAt,
      opId: op.opId,
    });
    // Tombstoning the day's LAST active session un-marks the day (the
    // frozen rule) — recompute from the STORED local_date only.
    await this.marks.recomputeDay(tx, ctx.userId, existing.localDate);
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
      throw new Error('journal session apply: transaction user context does not match the op context (fail-closed)');
    }
  }
}
