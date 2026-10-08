/**
 * Kal — the ingestion ack envelope (wave-03 contract §1.2).
 *
 * `200 {"results": [{"opId", "outcome", "code?", "retryable"?}]}` in request
 * order. The ack NEVER echoes payloads, identifiers beyond the caller's own
 * `opId`s, or health data (I12) — by construction: the builder projects
 * exactly the fields below and nothing else.
 *
 * Outcome is `applied | duplicate | rejected`:
 *  - `applied`    — the op was applied this request (or was an idempotent
 *                   no-write apply, e.g. delete-of-absent / LWW loser);
 *  - `duplicate`  — replay of a previously APPLIED op (recorded; the
 *                   handler is not re-run, I9);
 *  - `rejected`   — this request's rejection or the deterministic replay of
 *                   a previously recorded rejection (code + retryable from
 *                   the record).
 *
 * `code`/`retryable` appear exactly when `outcome` is `rejected`.
 *
 * Byte stability: responses are serialized with the shared canonical
 * serializer (`canonicalJsonString`) both on original execution and on
 * recorded-outcome replay, so the replayed body is byte-identical to the
 * original even though the ledger stores it as JSONB (no key-order
 * preservation).
 */
import { canonicalJsonString } from './canonical-json.js';
import type { RejectionCode } from './sync-seams.js';

export type AckOutcome = 'applied' | 'duplicate' | 'rejected';

export interface AckResult {
  readonly opId: string;
  readonly outcome: AckOutcome;
  readonly code?: RejectionCode;
  readonly retryable?: boolean;
}

export interface AckEnvelope {
  readonly results: readonly AckResult[];
}

/** Builds one ack result with the frozen field projection (no echoes). */
export function ackResult(result: AckResult): AckResult {
  if (result.outcome === 'rejected') {
    return { opId: result.opId, outcome: result.outcome, code: result.code, retryable: result.retryable };
  }
  return { opId: result.opId, outcome: result.outcome };
}

export function buildAckEnvelope(results: readonly AckResult[]): AckEnvelope {
  return { results: results.map(ackResult) };
}

/** The canonical byte form of an ack envelope (original AND replay path). */
export function serializeAckEnvelope(envelope: AckEnvelope): string {
  return canonicalJsonString(envelope);
}
