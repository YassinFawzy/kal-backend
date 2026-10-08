/**
 * Kal — search-pagination cursor codec (conventions §2; contract §3).
 *
 * Opaque, HMAC-SHA256-tagged, USER-BOUND tokens: the tag covers the payload
 * AND the authenticated user id, so a cursor presented under a different
 * authenticated context, or tampered/truncated in any way, fails verification
 * with ONE generic `400 VALIDATION_FAILED` body — byte-identically for every
 * cause; a foreign cursor never yields rows (I7).
 *
 * Key management mirrors the identity wave's session-cursor posture: the
 * cursor key is a DOMAIN-SEPARATED HMAC derivation of the process's single
 * validated secret (`kal:tracking:search-cursor:v1`) — distinct purpose,
 * distinct key, raw secret never shared (see tracking.config.ts).
 *
 * Cursor state for `GET /tracking/foods` is the position in the deterministic
 * result order: `(rank, id)` ascending — exact-normalized-equality first, then
 * prefix, then substring, tiebreak by id (contract §2). Cursor state for the
 * search surface carries no user data — only the ordering key.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SEARCH_CURSOR_DOMAIN = 'kal:tracking:search-cursor:v1';

export interface SearchCursorState {
  /** Result rank tier: 0 exact · 1 prefix · 2 substring (contract §2). */
  readonly rank: number;
  /** The last emitted food id (strictly-after tiebreak). */
  readonly id: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function tag(payload: string, userId: string, cursorKey: Buffer): string {
  return base64Url(createHmac('sha256', cursorKey).update(`${userId}|${payload}`).digest());
}

/** Mints an opaque, user-bound cursor token for the given state. */
export function encodeSearchCursor(state: SearchCursorState, userId: string, cursorKey: Buffer): string {
  const payload = base64Url(Buffer.from(JSON.stringify(state), 'utf8'));
  return `${payload}.${tag(payload, userId, cursorKey)}`;
}

/**
 * Verifies and decodes a cursor for the authenticated user. Returns `null`
 * for EVERY failure cause (malformed, truncated, foreign user, bad tag) —
 * callers map `null` to the one generic 400 (I7; the cause is never
 * observable).
 */
export function decodeSearchCursor(
  token: string,
  userId: string,
  cursorKey: Buffer,
): SearchCursorState | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts as [string, string];
  const expected = tag(payload, userId, cursorKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  const rank = candidate['rank'];
  const id = candidate['id'];
  if (
    (rank !== 0 && rank !== 1 && rank !== 2) ||
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)
  ) {
    return null;
  }
  return { rank, id };
}
