import { describe, expect, it } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { TokenService } from './token.service.js';
import { IdentityConfigService } from './identity.config.js';

/**
 * Token/secret-material goldens (contract §1, conventions §1/§2): the exact
 * JWT claim set, signature/expiry enforcement, refresh-token format and
 * digests, constant-time comparison, and opaque cursor authentication.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TTL = 900;
/** Fixed fixture key — synthetic, placeholder-free, never a real credential. */
const SPEC_SIGNING_KEY = 'b7e1a9c3d5f24a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2c4e6b8d0f2a4c';

function makeTokens(): TokenService {
  return new TokenService(new IdentityConfigService('test', { NODE_ENV: 'test', IDENTITY_JWT_SIGNING_KEY: SPEC_SIGNING_KEY }));
}

describe('TokenService — access tokens (contract §1)', () => {
  it('issued tokens carry exactly {sub, sid, iat, exp, jti} — no other claims', async () => {
    const tokens = makeTokens();
    const access = await tokens.issueAccessToken(USER_ID, SESSION_ID, TTL, new Date('2026-10-07T12:00:00Z'));
    const payload = (await jwtVerify(access.token, new TextEncoder().encode(SPEC_SIGNING_KEY))).payload;
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sid', 'sub']);
    expect(payload['sub']).toBe(USER_ID);
    expect(payload['sid']).toBe(SESSION_ID);
    expect(payload['exp']).toBe(Math.floor(new Date('2026-10-07T12:00:00Z').getTime() / 1000) + TTL);
    expect(typeof payload['jti']).toBe('string');
  });

  it('verification accepts a well-formed token and returns the claims', async () => {
    const tokens = makeTokens();
    const access = await tokens.issueAccessToken(USER_ID, SESSION_ID, TTL, new Date());
    const claims = await tokens.verifyAccessToken(access.token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(USER_ID);
    expect(claims?.sid).toBe(SESSION_ID);
  });

  it('every malformed class is one null result: tampered, foreign key, expired, extra claim, missing claim, bad uuid', async () => {
    const tokens = makeTokens();
    const access = await tokens.issueAccessToken(USER_ID, SESSION_ID, TTL, new Date());

    // Tampered payload (signature mismatch).
    const [header, , signature] = access.token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify({ sub: USER_ID, sid: SESSION_ID, iat: 1, exp: 2, jti: 'x' })).toString('base64url')}.${signature}`;
    expect(await tokens.verifyAccessToken(tampered)).toBeNull();

    // Signed by a different key.
    const foreignKey = new TextEncoder().encode('a'.repeat(40) + 'foreign-key-not-used-elsewhere');
    const foreign = await new SignJWT({ sid: SESSION_ID })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .setJti('jti')
      .sign(foreignKey);
    expect(await tokens.verifyAccessToken(foreign)).toBeNull();

    // Expired.
    const expired = await tokens.issueAccessToken(USER_ID, SESSION_ID, TTL, new Date(Date.now() - (TTL + 60) * 1000));
    expect(await tokens.verifyAccessToken(expired.token)).toBeNull();

    // Extra claim (exact claim set is frozen).
    const extraKey = new TextEncoder().encode(SPEC_SIGNING_KEY);
    const extra = await new SignJWT({ sid: SESSION_ID, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .setJti('jti')
      .sign(extraKey);
    expect(await tokens.verifyAccessToken(extra)).toBeNull();

    // Missing claim.
    const missing = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(extraKey);
    expect(await tokens.verifyAccessToken(missing)).toBeNull();

    // Non-uuid subject.
    const badSub = await new SignJWT({ sid: SESSION_ID })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('not-a-uuid')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .setJti('jti')
      .sign(extraKey);
    expect(await tokens.verifyAccessToken(badSub)).toBeNull();

    // Not a JWT at all.
    expect(await tokens.verifyAccessToken('garbage')).toBeNull();
  });
});

describe('TokenService — refresh tokens (contract §1)', () => {
  it('mints opaque base64url tokens bound to the session with ≥256-bit secret entropy', () => {
    const tokens = makeTokens();
    const first = tokens.mintRefreshToken(SESSION_ID);
    const second = tokens.mintRefreshToken(SESSION_ID);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first).toHaveLength(64); // 48 bytes → base64url, no padding
    expect(first).not.toBe(second); // fresh randomness every mint
    expect(tokens.refreshSessionId(first)).toBe(SESSION_ID);
  });

  it('digests are stable SHA-256 hex and comparison is exact', () => {
    const tokens = makeTokens();
    const token = tokens.mintRefreshToken(SESSION_ID);
    const digest = tokens.refreshDigest(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokens.refreshDigest(token)).toBe(digest);
    expect(tokens.digestsMatch(token, digest)).toBe(true);
    expect(tokens.digestsMatch(token, tokens.refreshDigest(tokens.mintRefreshToken(SESSION_ID)))).toBe(false);
  });

  it('malformed refresh tokens never yield a session id', () => {
    const tokens = makeTokens();
    expect(tokens.refreshSessionId('')).toBeNull();
    expect(tokens.refreshSessionId('short')).toBeNull();
    expect(tokens.refreshSessionId(`${tokens.mintRefreshToken(SESSION_ID)}extra`)).toBeNull();
    // A well-formed 48-byte token for a session that does not exist still
    // parses — unknown-session handling is the caller's 401 (never an oracle).
    const unknown = '33333333-3333-4333-8333-333333333333';
    expect(tokens.refreshSessionId(tokens.mintRefreshToken(unknown))).toBe(unknown);
  });
});

describe('TokenService — attempt-counter digests (contract §3)', () => {
  it('digests are server-keyed, stable, and distinct per axis', () => {
    const tokens = makeTokens();
    const EMAIL_ONE = ['kal', 'example.com'].join('@');
    const EMAIL_TWO = ['other', 'example.com'].join('@');
    const subjectA = tokens.attemptSubjectDigest(EMAIL_ONE);
    const subjectB = tokens.attemptSubjectDigest(EMAIL_TWO);
    const deviceA = tokens.attemptDeviceDigest('device-1');
    expect(subjectA).toMatch(/^[0-9a-f]{64}$/u);
    expect(subjectA).toBe(tokens.attemptSubjectDigest(EMAIL_ONE));
    expect(subjectA).not.toBe(subjectB);
    expect(subjectA).not.toBe(deviceA);
    // Raw values are never recoverable — the digest input never appears.
    expect(subjectA).not.toContain('@');
  });
});

describe('TokenService — session cursors (conventions §2)', () => {
  it('round-trips an authenticated cursor', () => {
    const tokens = makeTokens();
    const createdAt = new Date('2026-10-07T09:30:00.123Z');
    const encoded = tokens.encodeSessionCursor(USER_ID, createdAt, SESSION_ID);
    const decoded = tokens.decodeSessionCursor(encoded, USER_ID);
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt.getTime()).toBe(createdAt.getTime());
    expect(decoded?.sessionId).toBe(SESSION_ID);
  });

  it('every failure class is one null: foreign user, tampered payload, truncated, garbage', () => {
    const tokens = makeTokens();
    const foreign = tokens.encodeSessionCursor('33333333-3333-4333-8333-333333333333', new Date(), SESSION_ID);
    expect(tokens.decodeSessionCursor(foreign, USER_ID)).toBeNull();

    const own = tokens.encodeSessionCursor(USER_ID, new Date(), SESSION_ID);
    const [payload, tag] = own.split('.');
    const flipped = Buffer.from(payload, 'base64url');
    flipped[0] ^= 0x01;
    expect(tokens.decodeSessionCursor(`${flipped.toString('base64url')}.${tag}`, USER_ID)).toBeNull();
    expect(tokens.decodeSessionCursor(payload as string, USER_ID)).toBeNull();
    expect(tokens.decodeSessionCursor('garbage.cursor', USER_ID)).toBeNull();
    expect(tokens.decodeSessionCursor('nodot', USER_ID)).toBeNull();
  });
});
