/**
 * Kal — canonical JSON serialization and the request digest (conventions §3;
 * wave-03 contract §1.2).
 *
 * TWO frozen consumers:
 *
 *  1. The Idempotency-Key changed-payload detector: the digest is the
 *     SHA-256 hex of the canonical form of the parsed request body. Equality
 *     is SEMANTIC (same data ⇒ same digest regardless of client key order or
 *     whitespace); a different payload under the same key ⇒ `409 CONFLICT`.
 *
 *  2. Byte-stable responses: the ack envelope is serialized with THIS
 *     canonical serializer on the original execution AND on every recorded-
 *     outcome replay, so the two bodies are byte-identical even though the
 *     ledger stores the envelope as JSONB (which does not preserve key
 *     order — a naive stringify of the round-tripped object would not).
 *
 * Canonical form: object keys recursively sorted by code-unit order, no
 * insignificant whitespace, JSON number semantics (parsed numbers only —
 * `1` and `1.0` arrive as the same number and are the same payload), arrays
 * keep order (op order is semantic — the frozen per-device ordering).
 */
import { createHash } from 'node:crypto';

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Digest of a parsed JSON body — the Idempotency-Key payload fingerprint. */
export function canonicalRequestDigest(body: unknown): string {
  return sha256Hex(canonicalJsonString(body));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}
