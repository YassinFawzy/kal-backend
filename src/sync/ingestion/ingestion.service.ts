/**
 * Kal — sync batch ingestion service (wave-03 contract §1.2/§1.3; the
 * sanctioned mutation path: controller → validate → authorize → unit-of-work
 * transaction → dispatch → ack).
 *
 * FROZEN FLOW (one transaction per batch — ARCHITECTURE §12):
 *
 *   1. Shape validation, DATABASE-FREE, whole-batch (§1.2): malformed or
 *      missing `Idempotency-Key`, `deviceId` length, op count over the
 *      configured cap, envelope field parity, unknown `kind`/`action`
 *      strings ⇒ `400 VALIDATION_FAILED`, zero ops applied, nothing
 *      recorded. Shape errors never echo received values (I12).
 *
 *   2. Per-transaction posture (F1 binding guidance): the batch transaction
 *      opens with `SET LOCAL ROLE kal_app` + `app.user_id` = the verified
 *      UserContext binding + `TimeZone UTC` (the identity `inAppRoleTx`
 *      pattern, transaction-local — NEVER session-level GUCs on pooled
 *      clients). The authenticated UserContext is the SOLE ownership
 *      authority, re-verified here on every batch and every replay (I6):
 *      op payloads carry client entity ids that are never authorization.
 *
 *   3. Request-level idempotency (conventions §3): a live (within-retention)
 *      key with the SAME payload digest replays the recorded response
 *      BYTE-IDENTICALLY; a different digest ⇒ `409 CONFLICT`.
 *
 *   4. Per-op, in request-array order (the frozen per-device ordering — the
 *      server never re-sorts): dedupe on `(user_id, client_op_id)` first —
 *      a replayed op is acked from the record and the handler is NEVER
 *      re-run (I9; a replayed applied op acks `duplicate`, a replayed
 *      rejected op acks the same rejection). New ops dispatch ONLY through
 *      the op-handler registry; a registry miss is a per-op `rejected`
 *      (validation class). A rejected op NEVER aborts the batch.
 *
 *   5. The `rejected_rate_limited` outcome is acked but NOT durably
 *      recorded (the §1.7 directed resolution: an over-limit user-food
 *      create is not durably queued server-side — a retry after the window
 *      re-runs the handler and can succeed; per-op dedupe still makes every
 *      replay of APPLIED ops safe). Every other rejection is terminal and
 *      recorded for deterministic replay (§1.3).
 *
 *   6. The ack envelope is built with the frozen field projection (never
 *      echoes payloads — I12), stored as the key's recorded response, and
 *      served in canonical byte form — identical on original execution and
 *      on every replay.
 *
 * Atomicity/recovery: a handler THROWING is an infrastructure failure — the
 * whole batch transaction rolls back (dedupe rows + handler effects + key
 * record together), nothing is recorded, and a retry with the same batch is
 * clean. A unique-violation race (concurrent same-op/same-key push) is
 * converged at the batch boundary: the racing request re-reads the key —
 * recorded ⇒ replay (byte-stable) or `409 CONFLICT` (digest mismatch);
 * nothing recorded ⇒ ONE clean full re-run (per-op dedupe makes it
 * idempotent); a second failure surfaces as `INTERNAL_ERROR` — the client
 * retry contract (§1.2) stays the backstop.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.ts';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import type { UserContext } from '../../request-context/user-context.js';
import { PrismaService } from '../../db/prisma.service.js';
import { buildAckEnvelope, serializeAckEnvelope, type AckResult } from './ack.js';
import { canonicalJsonString, canonicalRequestDigest } from './canonical-json.js';
import { IdempotencyKeyStore, type RecordedKeyResponse } from './idempotency-key.store.js';
import { OpLedgerStore } from './op-ledger.store.js';
import { parseBatchBody, validateIdempotencyKey, type ParsedBatch } from './op-envelope.js';
import { OpHandlerRegistry } from './op-handler-registry.js';
import { SyncConfigService } from './sync.config.js';
import type { RecordedSyncOp } from './op-ledger.store.js';
import type { RejectionCode } from './sync-seams.js';

/** The endpoint scope of every key recorded by this service (conventions §3). */
export const SYNC_OPS_ENDPOINT = '/sync/ops';

/** A settled ingestion outcome: the ack's status and canonical byte body. */
export interface IngestionAck {
  readonly status: number;
  readonly body: string;
}

@Injectable()
export class SyncIngestionService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: SyncConfigService,
    private readonly registry: OpHandlerRegistry,
    private readonly ledger: OpLedgerStore,
    private readonly keys: IdempotencyKeyStore,
  ) {}

  /**
   * Ingests one batch for the verified consumer context. Throws
   * `KalProblemException` (`VALIDATION_FAILED` / `CONFLICT`) for the frozen
   * client-error paths; returns the ack's canonical bytes on success.
   */
  async ingest(userContext: UserContext, rawBody: unknown, rawIdempotencyKey: unknown): Promise<IngestionAck> {
    // Fail closed (I2): sync is a consumer-plane surface.
    if (userContext.kind !== 'consumer') {
      throw new KalProblemException('FORBIDDEN');
    }

    // 1. Shape validation — database-free, whole-batch, nothing recorded.
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    if (idempotencyKey === null) {
      throw new KalProblemException('VALIDATION_FAILED', {
        errors: [{ field: 'Idempotency-Key', message: 'Required header is missing or malformed.' }],
      });
    }
    const parsed = parseBatchBody(rawBody, this.config.values.maxOpsPerBatch);
    if (!parsed.ok) {
      throw new KalProblemException('VALIDATION_FAILED', { errors: parsed.errors });
    }
    const digest = canonicalRequestDigest(rawBody);

    // 2..6 — one transaction per attempt; the boundary race converges below.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.executeBatch(userContext, idempotencyKey, digest, parsed.value);
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) {
          // Concurrent same-op/same-key push: this batch rolled back with
          // zero partial state. The recorded key (if the racing request
          // settled) replays byte-stably — or 409s on digest mismatch;
          // otherwise ONE clean re-run (per-op dedupe ⇒ idempotent).
          const replayed = await this.readRecordedAfterRace(userContext, idempotencyKey, digest);
          if (replayed !== null) {
            return replayed;
          }
          continue;
        }
        throw error;
      }
    }
    // Unreachable (the loop returns or throws on both attempts).
    throw new KalProblemException('INTERNAL_ERROR');
  }

  // ---------------------------------------------------------------------------
  // unit of work
  // ---------------------------------------------------------------------------

  private async executeBatch(
    userContext: UserContext,
    idempotencyKey: string,
    digest: string,
    batch: ParsedBatch,
  ): Promise<IngestionAck> {
    const { idempotencyKeyRetentionSeconds: retention } = this.config.values;
    return this.db.transaction(async (tx) => {
      // Per-transaction role + user context + UTC (F1; the identity
      // inAppRoleTx pattern — transaction-local, never session-level).
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userContext.userId}, true), set_config('TimeZone', 'UTC', true)`;

      // 3. Request-level idempotency (conventions §3).
      const recorded = await this.keys.findLive(tx, userContext.userId, SYNC_OPS_ENDPOINT, idempotencyKey, retention);
      if (recorded !== null) {
        if (recorded.requestDigest !== digest) {
          throw new KalProblemException('CONFLICT');
        }
        return ackFromRecorded(recorded);
      }

      // 4. Per-op application in request-array order (never re-sorted).
      const results: AckResult[] = [];
      for (const op of batch.ops) {
        const previous = await this.ledger.findRecorded(tx, userContext.userId, op.opId);
        if (previous !== null) {
          // I9: replayed op — acked from the record, never re-applied.
          results.push(replayAckResult(op.opId, previous));
          continue;
        }

        const handler = this.registry.lookup(op.kind);
        if (handler === undefined) {
          // Registry-dispatch miss (§4): per-op rejected, validation class —
          // terminal, recorded for deterministic replay. Unreachable for
          // enum-valid kinds in the assembled system (tracking registers
          // all three at init); a defensive seam, never a crash.
          await this.ledger.insertRecorded(tx, {
            userId: userContext.userId,
            clientOpId: op.opId,
            deviceId: batch.deviceId,
            entityKind: op.kind,
            entityAction: op.action,
            entityId: op.entityId,
            localDate: op.localDate,
            clientUpdatedAtIso: op.clientUpdatedAtIso,
            payload: op.payload,
            outcome: 'rejected',
            rejectionCode: 'rejected_validation',
            retryable: false,
          });
          results.push({ opId: op.opId, outcome: 'rejected', code: 'rejected_validation', retryable: false });
          continue;
        }

        // Dispatch (§4): the handler owns the entity state machine, entity
        // validation, and the shared limiter (§1.7 — no limiter logic in
        // sync); sync records and surfaces outcomes faithfully.
        const verdict = await handler.apply(op, { userId: userContext.userId, deviceId: batch.deviceId }, tx);

        if (verdict.outcome === 'applied') {
          await this.ledger.insertRecorded(tx, {
            userId: userContext.userId,
            clientOpId: op.opId,
            deviceId: batch.deviceId,
            entityKind: op.kind,
            entityAction: op.action,
            entityId: op.entityId,
            localDate: op.localDate,
            clientUpdatedAtIso: op.clientUpdatedAtIso,
            payload: op.payload,
            outcome: 'applied',
          });
          results.push({ opId: op.opId, outcome: 'applied' });
        } else if (verdict.code === 'rejected_rate_limited') {
          // §1.7 directed resolution: NOT durably recorded — the op stays
          // unrecorded so a retry after the window re-runs the handler.
          results.push({ opId: op.opId, outcome: 'rejected', code: verdict.code, retryable: verdict.retryable });
        } else {
          // Terminal rejection (validation/conflict/deleted): recorded — a
          // replay deterministically re-acks it (§1.2), handler not re-run.
          await this.ledger.insertRecorded(tx, {
            userId: userContext.userId,
            clientOpId: op.opId,
            deviceId: batch.deviceId,
            entityKind: op.kind,
            entityAction: op.action,
            entityId: op.entityId,
            localDate: op.localDate,
            clientUpdatedAtIso: op.clientUpdatedAtIso,
            payload: op.payload,
            outcome: 'rejected',
            rejectionCode: verdict.code,
            retryable: verdict.retryable,
          });
          results.push({ opId: op.opId, outcome: 'rejected', code: verdict.code, retryable: verdict.retryable });
        }
      }

      // Ack: frozen projection, canonical bytes, recorded as the key's
      // response INSIDE the same unit of work (atomic with the batch).
      const envelope = buildAckEnvelope(results);
      const body = serializeAckEnvelope(envelope);
      await this.keys.insertRecordOnConflictDoNothing(tx, {
        userId: userContext.userId,
        endpoint: SYNC_OPS_ENDPOINT,
        idempotencyKey,
        requestDigest: digest,
        responseStatus: 200,
        responseBody: envelope,
      });
      const postInsert = await this.keys.findLive(tx, userContext.userId, SYNC_OPS_ENDPOINT, idempotencyKey, retention);
      if (postInsert !== null) {
        if (postInsert.requestDigest !== digest) {
          // A concurrent same-key request settled first with a different
          // payload: this execution rolls back entirely (exactly one
          // executes — conventions §3).
          throw new KalProblemException('CONFLICT');
        }
        // Serve THE recorded bytes (ours, or the racing same-payload
        // winner's) — byte-stable by construction.
        return ackFromRecorded(postInsert);
      }
      // Unrecordable edge (retention-boundary race with a physically
      // present expired row): the request itself succeeds; per-op dedupe
      // still guarantees zero re-application on any replay.
      return { status: 200, body };
    });
  }

  /** Fresh-transaction key re-read on the batch-boundary race path. */
  private async readRecordedAfterRace(
    userContext: UserContext,
    idempotencyKey: string,
    digest: string,
  ): Promise<IngestionAck | null> {
    const retention = this.config.values.idempotencyKeyRetentionSeconds;
    return this.db.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('role', 'kal_app', true), set_config('app.user_id', ${userContext.userId}, true), set_config('TimeZone', 'UTC', true)`;
      const recorded = await this.keys.findLive(tx, userContext.userId, SYNC_OPS_ENDPOINT, idempotencyKey, retention);
      if (recorded === null) {
        return null;
      }
      if (recorded.requestDigest !== digest) {
        throw new KalProblemException('CONFLICT');
      }
      return ackFromRecorded(recorded);
    });
  }
}

/** Maps a recorded op row to its replay ack outcome (I9 — never re-applied). */
function replayAckResult(opId: string, recorded: RecordedSyncOp): AckResult {
  if (recorded.outcome === 'applied') {
    return { opId, outcome: 'duplicate' };
  }
  // Rejection parity is CHECK-pinned (code + retryable present iff rejected).
  return {
    opId,
    outcome: 'rejected',
    code: recorded.rejectionCode as RejectionCode,
    retryable: recorded.retryable === true,
  };
}

function ackFromRecorded(recorded: RecordedKeyResponse): IngestionAck {
  return {
    status: recorded.responseStatus,
    // Canonical serialization of the stored envelope: byte-identical to the
    // original response (JSONB key order cannot leak into the bytes).
    body: canonicalJsonString(recorded.responseBody),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
