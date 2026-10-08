/**
 * Kal — the sync op-ledger data access (`sync_operations`, I9 dedupe store).
 *
 * OWNERSHIP: this is sync's OWN table (contract §5 — RLS ADOPTED: the
 * payload column mirrors entity content, so a leak is as catastrophic as the
 * entity tables). Every query binds the owning `user_id` explicitly (the
 * sanctioned user-scoped predicate) AND runs inside the caller's
 * per-transaction posture (`SET LOCAL ROLE kal_app` + `app.user_id` GUC —
 * the transaction is opened by the ingestion service), so the user binding
 * is enforced structurally (RLS) and by predicate (application), losing
 * neither (I1/I2/I6).
 *
 * Rows are SINGLE-PHASE final outcomes (no UPDATE grant exists in the
 * frozen grants): an op's row is appended once with its final outcome; the
 * `duplicate` ack outcome is DERIVED at replay time, never stored.
 *
 * Dedupe key (I9): `(user_id, client_op_id)` — unique in the frozen schema.
 * A replay from ANOTHER user can never match: the predicate carries the
 * verified caller binding and RLS hides every foreign row.
 */
import { Prisma } from '../../../generated/prisma/client.ts';
import type { RejectionCode } from './sync-seams.js';

/** The recorded final outcome of a previously ingested op (replay view). */
export interface RecordedSyncOp {
  readonly outcome: 'applied' | 'rejected';
  readonly rejectionCode: RejectionCode | null;
  readonly retryable: boolean | null;
}

export interface InsertRecordedInput {
  readonly userId: string;
  readonly clientOpId: string;
  readonly deviceId: string;
  readonly entityKind: string;
  readonly entityAction: string;
  readonly entityId: string;
  readonly localDate: string | null;
  /** Exact client-authored ISO instant (timestamptz(6) fidelity). */
  readonly clientUpdatedAtIso: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly outcome: 'applied' | 'rejected';
  readonly rejectionCode?: RejectionCode;
  readonly retryable?: boolean;
}

export class OpLedgerStore {
  /**
   * The recorded outcome of `(userId, clientOpId)`, or null. Runs inside the
   * caller's unit of work — same transaction as the batch (atomicity: the
   * dedupe decision and the batch's writes commit or roll back together).
   */
  async findRecorded(
    tx: Prisma.TransactionClient,
    userId: string,
    clientOpId: string,
  ): Promise<RecordedSyncOp | null> {
    const row = await tx.syncOperation.findFirst({
      where: { userId, clientOpId },
      select: { outcome: true, rejectionCode: true, retryable: true },
    });
    if (row === null) {
      return null;
    }
    // Column domains are CHECK-pinned (outcome enum, rejection-code enum,
    // rejection parity) — the literal narrowing is structural.
    return {
      outcome: row.outcome as RecordedSyncOp['outcome'],
      rejectionCode: row.rejectionCode as RecordedSyncOp['rejectionCode'],
      retryable: row.retryable,
    };
  }

  /**
   * Appends one final-outcome row inside the caller's unit of work. A
   * `(user_id, client_op_id)` collision (concurrent batch racing the same
   * op) surfaces as Prisma P2002 — the ingestion service's batch-boundary
   * race path re-converges it to the recorded outcome; nothing here
   * swallows it.
   */
  async insertRecorded(tx: Prisma.TransactionClient, input: InsertRecordedInput): Promise<void> {
    await tx.syncOperation.create({
      data: {
        userId: input.userId,
        clientOpId: input.clientOpId,
        deviceId: input.deviceId,
        entityKind: input.entityKind,
        entityAction: input.entityAction,
        entityId: input.entityId,
        localDate:
          input.localDate === null
            ? null
            : // @db.Date column: UTC midnight of the client-local day — the
              // stored `local_date` IS the day-boundary rule (§1.1/§1.8).
              new Date(`${input.localDate}T00:00:00Z`),
        // NOTE: the ledger instant is driver millisecond precision (the
        // ledger row is never an LWW input — it is the dedupe/replay
        // record). Handler-side comparators use the envelope's exact
        // `clientUpdatedAtIso` (see sync-seams.ts).
        clientUpdatedAt: new Date(input.clientUpdatedAtIso),
        payload: input.payload === null ? Prisma.DbNull : (input.payload as Prisma.InputJsonValue),
        outcome: input.outcome,
        ...(input.rejectionCode === undefined
          ? {}
          : { rejectionCode: input.rejectionCode }),
        ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
      },
    });
  }
}
