/**
 * Kal — identity token & secret material service (wave-02 contract §1).
 *
 * Access token (JWT): exact claim set {sub, sid, iat, exp, jti} — NO other
 * claims; tokens carrying extras are invalid. Signing is HS256 over the
 * validated config key (implementation configuration per contract §1;
 * validated at boot, I15). Clients never inspect tokens (conventions §1).
 *
 * Refresh token: an opaque base64url string, ≥ 256 bits of secret entropy,
 * bound to its session. Format (implementation decision, within the frozen
 * shape): base64url(16-byte session UUID || 32-byte random secret) — 64
 * opaque characters. The session prefix is what makes REUSE detectable on
 * the frozen schema: a presented token for a known session whose digest no
 * longer matches the rotated `refresh_token_hash` is a superseded token ⇒
 * chain revocation (contract §1) — a digest-only lookup could never
 * distinguish "superseded" from "unknown" and would silently drop the
 * theft signal. Only the SHA-256 hex digest is ever stored; the token is
 * never returned after issuance, never logged (I12).
 *
 * Opaque cursors (conventions §2): HMAC-SHA256-signed, user-bound payloads
 * — a cursor presented under another context or tampered in any way is one
 * generic VALIDATION_FAILED (no oracle). Keys are derived subkeys of the
 * validated signing key (never the raw key reused across protocols).
 */
import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { IdentityConfigService } from './identity.config.js';
import { isUuid } from '../request-context/user-context.js';

const EXACT_JWT_CLAIMS: readonly string[] = ['sub', 'sid', 'iat', 'exp', 'jti'];

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly jti: string;
  readonly exp: number;
}

export class AccessToken {
  constructor(
    readonly token: string,
    readonly expiresAt: Date,
  ) {}
}

@Injectable()
export class TokenService {
  private readonly signingKey: Uint8Array;
  private readonly counterKey: Buffer;
  private readonly cursorKey: Buffer;

  constructor(config: IdentityConfigService) {
    const secret = config.values.jwtSigningKey;
    this.signingKey = new TextEncoder().encode(secret);
    // Key separation: distinct derived subkeys per purpose (never the raw
    // signing key in a second protocol).
    this.counterKey = createHmac('sha256', secret).update('kal:identity:attempt-counter:v1').digest();
    this.cursorKey = createHmac('sha256', secret).update('kal:identity:session-cursor:v1').digest();
  }

  // ---------------------------------------------------------------------------
  // Access tokens (JWT)
  // ---------------------------------------------------------------------------

  async issueAccessToken(userId: string, sessionId: string, ttlSeconds: number, now: Date): Promise<AccessToken> {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ttlSeconds;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomBytes(16).toString('hex'))
      .sign(this.signingKey);
    return new AccessToken(token, new Date(exp * 1000));
  }

  /**
   * Verifies signature, expiry, and the EXACT claim set. Returns null on
   * every failure class — the caller maps all of them to the one generic
   * UNAUTHENTICATED observable (conventions §1; never states which).
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.signingKey, { algorithms: ['HS256'] });
      payload = result.payload as Record<string, unknown>;
    } catch {
      return null;
    }
    const keys = Object.keys(payload);
    if (keys.length !== EXACT_JWT_CLAIMS.length || !EXACT_JWT_CLAIMS.every((claim) => keys.includes(claim))) {
      return null;
    }
    const sub = payload['sub'];
    const sid = payload['sid'];
    const jti = payload['jti'];
    const exp = payload['exp'];
    const iat = payload['iat'];
    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number' ||
      typeof iat !== 'number' ||
      !isUuid(sub) ||
      !isUuid(sid)
    ) {
      return null;
    }
    return { sub, sid, jti, exp };
  }

  // ---------------------------------------------------------------------------
  // Refresh tokens (opaque, session-bound, rotating)
  // ---------------------------------------------------------------------------

  /** Mints a fresh refresh token for a session (≥256-bit secret entropy). */
  mintRefreshToken(sessionId: string, randomSource: (size: number) => Buffer = randomBytes): string {
    return Buffer.concat([uuidToBytes(sessionId), randomSource(32)]).toString('base64url');
  }

  /** SHA-256 hex digest — the only stored form of a refresh token. */
  refreshDigest(refreshToken: string): string {
    return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
  }

  /**
   * Extracts the bound session id from a presented refresh token. Returns
   * null for any malformed token (wrong length, unknown version, bad uuid).
   */
  refreshSessionId(refreshToken: string): string | null {
    let raw: Buffer;
    try {
      raw = Buffer.from(refreshToken, 'base64url');
    } catch {
      return null;
    }
    if (raw.length !== 48) {
      return null;
    }
    const sessionId = raw.subarray(0, 16).toString('hex');
    const uuid = `${sessionId.slice(0, 8)}-${sessionId.slice(8, 12)}-${sessionId.slice(12, 16)}-${sessionId.slice(16, 20)}-${sessionId.slice(20, 32)}`;
    return isUuid(uuid) ? uuid : null;
  }

  /** Constant-time digest comparison (never short-circuits on content). */
  digestsMatch(presented: string, storedHex: string): boolean {
    const presentedDigest = Buffer.from(this.refreshDigest(presented), 'hex');
    const storedDigest = Buffer.from(storedHex, 'hex');
    return presentedDigest.length === storedDigest.length && timingSafeEqual(presentedDigest, storedDigest);
  }

  // ---------------------------------------------------------------------------
  // Attempt-counter digests (contract §3 — server-keyed, never raw values)
  // ---------------------------------------------------------------------------

  attemptSubjectDigest(canonicalIdentifier: string): string {
    return createHmac('sha256', this.counterKey).update(canonicalIdentifier, 'utf8').digest('hex');
  }

  attemptDeviceDigest(deviceId: string): string {
    return createHmac('sha256', this.counterKey).update(deviceId, 'utf8').digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Opaque per-user session-list cursors (conventions §2)
  // ---------------------------------------------------------------------------

  encodeSessionCursor(userId: string, createdAt: Date, sessionId: string): string {
    const payload = Buffer.from(JSON.stringify({ u: userId, c: createdAt.getTime(), s: sessionId }), 'utf8');
    const tag = createHmac('sha256', this.cursorKey).update(payload).digest();
    return `${payload.toString('base64url')}.${tag.toString('base64url')}`;
  }

  /**
   * Decodes and authenticates a cursor. Returns null for every failure
   * class (tampered, foreign user, truncated, malformed) — the caller maps
   * all of them to one generic VALIDATION_FAILED body (conventions §2).
   */
  decodeSessionCursor(cursor: string, requestingUserId: string): { createdAt: Date; sessionId: string } | null {
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
    let parsed: { u?: unknown; c?: unknown; s?: unknown };
    try {
      parsed = JSON.parse(payload.toString('utf8')) as { u?: unknown; c?: unknown; s?: unknown };
    } catch {
      return null;
    }
    if (parsed.u !== requestingUserId || typeof parsed.c !== 'number' || typeof parsed.s !== 'string' || !isUuid(parsed.s)) {
      return null;
    }
    const createdAt = new Date(parsed.c);
    if (!Number.isFinite(createdAt.getTime())) {
      return null;
    }
    return { createdAt, sessionId: parsed.s };
  }
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/gu, ''), 'hex');
}
