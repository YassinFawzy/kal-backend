/**
 * Kal — the request-level Idempotency-Key store (`sync_idempotency_keys`,
 * conventions §3; wave-03 contract §1.2).
 *
 * OWNERSHIP: sync's OWN table (contract §5 — RLS DECLINED, metadata only:
 * request digest + recorded ack envelope, which never carries entity
 * payloads). Access runs inside the batch's unit of work under the
 * per-transaction `kal_app` posture; the `(user, endpoint, key)` scoping is
 * carried explicitly in every predicate (I1/I2).
 *
 * Semantics (conventions §3):
 *  - same key + same payload (digest) ⇒ the RECORDED original response is
 *    replayed byte-identically (canonical serialization both sides);
 *  - same key + different payload ⇒ `409 CONFLICT`;
 *  - concurrent same-key requests: PostgreSQL serialization (the batch's
 *    per-op dedupe rows and the key row's unique index) lets exactly one
 *    execution commit; the racing request re-reads and replays the recorded
 *    outcome or 409s (the ingestion service owns that convergence);
 *  - keys are retained for `sync.idempotencyKeyRetentionSeconds`: an expired
 *    key is invisible to the replay path (a replayed expired key is a NEW
 *    operation — per-op dedupe still prevents every re-application).
 *
 * The INSERT is `ON CONFLICT DO NOTHING` (raw SQL): the frozen grants give
 * `kal_app` SELECT, INSERT only — no UPDATE/DELETE — so the Prisma upsert's
 * update branch is structurally unavailable, and an expired row's physical
 * replacement is future housekeeping (retention policies land with the
 * first enumerated platform job — contract §5/§10).
 */
import type { Prisma } from '../../../generated/prisma/client.ts';

/** The recorded response of a live (within-retention) key. */
export interface RecordedKeyResponse {
  readonly requestDigest: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export interface InsertKeyInput {
  readonly userId: string;
  readonly endpoint: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export class IdempotencyKeyStore {
  /**
   * The live (within-retention) recorded response for `(user, endpoint,
   * key)`, or null. Retention is evaluated against the SERVER clock
   * (`now()`), never the caller's. Runs inside the caller's unit of work.
   */
  async findLive(
    tx: Prisma.TransactionClient,
    userId: string,
    endpoint: string,
    idempotencyKey: string,
    retentionSeconds: number,
  ): Promise<RecordedKeyResponse | null> {
    const rows = await tx.$queryRaw<
      { request_digest: string; response_status: number; response_body: unknown }[]
    >`
      SELECT request_digest, response_status, response_body
      FROM sync_idempotency_keys
      WHERE user_id = ${userId}::uuid
        AND endpoint = ${endpoint}
        AND idempotency_key = ${idempotencyKey}::uuid
        AND created_at > now() - (${retentionSeconds} * interval '1 second')`;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      requestDigest: row.request_digest,
      responseStatus: row.response_status,
      responseBody: row.response_body,
    };
  }

  /**
   * Records the batch outcome for this key inside the caller's unit of
   * work; a concurrent/conflicting row makes this a no-op (the service's
   * post-insert re-read resolves whose outcome is served).
   */
  async insertRecordOnConflictDoNothing(tx: Prisma.TransactionClient, input: InsertKeyInput): Promise<void> {
    await tx.$queryRaw`
      INSERT INTO sync_idempotency_keys
        (user_id, endpoint, idempotency_key, request_digest, response_status, response_body)
      VALUES (
        ${input.userId}::uuid,
        ${input.endpoint},
        ${input.idempotencyKey}::uuid,
        ${input.requestDigest},
        ${input.responseStatus},
        ${JSON.stringify(input.responseBody === undefined ? null : input.responseBody)}::jsonb
      )
      ON CONFLICT (user_id, endpoint, idempotency_key) DO NOTHING`;
  }
}
