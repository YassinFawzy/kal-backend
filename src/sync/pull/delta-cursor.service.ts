/**
 * Kal — opaque, user-bound sync delta cursors (wave-03 contract note §1.6;
 * conventions §2).
 *
 * The cursor is an HMAC-SHA256-tagged state token bound to the
 * authenticated user — the identity wave's session-cursor pattern
 * (base64url payload + base64url tag; constant-time tag comparison; every
 * failure class — tampered, foreign user, truncated, malformed, wrong
 * version, unknown kind, non-UUID entity, bad timestamp — decodes to `null`
 * and the caller maps ALL of them to the ONE generic `400 VALIDATION_FAILED`
 * body, byte-identically for every cause: no oracle, I7). A foreign cursor
 * never yields another user's rows: verification binds the payload's user
 * to the requesting context BEFORE any composition runs, and the composer's
 * transaction re-binds the database context to the authenticated user
 * (per-transaction `app.user_id` GUC + RLS).
 *
 * The payload carries the GLOBAL feed position `(updatedAt, kind,
 * entityId)` (note §1.6 order); the composer decomposes it into per-kind
 * `DeltaCursorState`s at composition time. `updatedAt` is the ISO 8601 UTC
 * instant exactly as the feed served it (millisecond precision) — carried
 * verbatim through mint → verify → provider filter. W3 cursors do NOT
 * expire (note §1.6) — no expiry dimension exists in the payload, and none
 * is checked; the rejection behavior is identical if one is introduced.
 * Clients treat cursors as opaque strings and echo the latest `nextCursor`
 * verbatim (conventions §2); the payload structure is never exposed.
 */
import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../request-context/user-context.js';
import { SyncPullConfigService } from './sync-pull.config.js';
import { isSyncEntityKind, type GlobalCursorPosition, type SyncOpKind } from './seams.js';

/** Payload version — rejects cursors minted by a different cursor scheme. */
const CURSOR_VERSION = 1;
/** Rejects absurd inputs before any parsing work (identity precedent: 512). */
const MAX_CURSOR_LENGTH = 512;

interface CursorPayload {
  v: number;
  u: string;
  ts: string;
  k: string;
  e: string;
}

@Injectable()
export class SyncDeltaCursorService {
  private readonly cursorKey: Buffer;

  constructor(config: SyncPullConfigService) {
    this.cursorKey = config.deltaCursorKey;
  }

  /** Mints the opaque next-cursor token for the caller's page position. */
  mint(userId: string, position: GlobalCursorPosition): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: CURSOR_VERSION,
        u: userId,
        ts: position.updatedAt,
        k: position.kind,
        e: position.entityId,
      } satisfies CursorPayload),
      'utf8',
    );
    const tag = createHmac('sha256', this.cursorKey).update(payload).digest();
    return `${payload.toString('base64url')}.${tag.toString('base64url')}`;
  }

  /**
   * Decodes and authenticates a presented cursor against the requesting
   * user. Returns `null` for EVERY failure class (malformed, truncated,
   * tampered tag, foreign user binding, wrong version, unknown kind,
   * non-UUID entity, bad timestamp) — one generic rejection upstream,
   * never a distinguishing observable (I7).
   */
  verify(cursor: string, requestingUserId: string): GlobalCursorPosition | null {
    const trusted = this.decodeTagValid(cursor);
    if (trusted === null || trusted.u !== requestingUserId) {
      return null;
    }
    return this.toPosition(trusted);
  }

  /**
   * AMENDMENT 3 (I14 audit emit): the EMBEDDED user binding of a
   * genuinely-minted cursor (tag-valid + shape-valid), regardless of the
   * requesting user — null for anything else. Side-channel audit signal
   * ONLY: never changes a response byte or awaits on the response path
   * (I7 — a latency-detectable branch would be an authenticity oracle).
   */
  inspectBinding(cursor: string): string | null {
    return this.decodeTagValid(cursor)?.u ?? null;
  }

  /** Tag-valid + shape-valid decode, trust-anchored on the HMAC tag. */
  private decodeTagValid(cursor: string): CursorPayload | null {
    if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
      return null;
    }
    const dot = cursor.indexOf('.');
    if (dot <= 0 || dot === cursor.length - 1) {
      return null;
    }
    let payload: Buffer;
    let tag: Buffer;
    try {
      payload = Buffer.from(cursor.slice(0, dot), 'base64url');
      tag = Buffer.from(cursor.slice(dot + 1), 'base64url');
    } catch {
      return null;
    }
    const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
    if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) {
      return null;
    }
    let parsed: CursorPayload;
    try {
      const json: unknown = JSON.parse(payload.toString('utf8'));
      if (typeof json !== 'object' || json === null) {
        return null;
      }
      parsed = json as CursorPayload;
    } catch {
      return null;
    }
    if (
      parsed.v !== CURSOR_VERSION ||
      typeof parsed.u !== 'string' ||
      typeof parsed.ts !== 'string' ||
      typeof parsed.k !== 'string' ||
      typeof parsed.e !== 'string'
    ) {
      return null;
    }
    // The instant must be the serialized ISO 8601 UTC form the feed serves
    // (providers re-parse it — a non-UTC or unparseable instant is invalid).
    if (!parsed.ts.endsWith('Z') || Number.isNaN(Date.parse(parsed.ts))) {
      return null;
    }
    if (!isSyncEntityKind(parsed.k) || !isUuid(parsed.e)) {
      return null;
    }
    return parsed;
  }

  /** The authenticated per-kind position (verify path — binding checked). */
  private toPosition(payload: CursorPayload): GlobalCursorPosition {
    return {
      updatedAt: payload.ts,
      // decodeTagValid proved isSyncEntityKind(payload.k) — the narrow is
      // structural, the interface carries the validated transport form.
      kind: payload.k as SyncOpKind,
      entityId: payload.e,
    };
  }
}
