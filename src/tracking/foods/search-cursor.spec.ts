/**
 * Unit spec — the user-bound search cursor codec (conventions §2; contract
 * §3): round-trip; ONE generic null for every failure cause — malformed,
 * truncated, tampered, or a foreign user's cursor (I7: a foreign cursor never
 * yields rows).
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { decodeSearchCursor, encodeSearchCursor } from './search-cursor.js';

const KEY = Buffer.alloc(32, 7);
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('search cursor codec', () => {
  it('round-trips a state for its own user', () => {
    const token = encodeSearchCursor({ rank: 1, id: USER_A }, USER_A, KEY);
    expect(decodeSearchCursor(token, USER_A, KEY)).toEqual({ rank: 1, id: USER_A });
  });

  it('rejects a cursor presented under a different authenticated context (byte-generic null → 400)', () => {
    const token = encodeSearchCursor({ rank: 0, id: USER_A }, USER_A, KEY);
    expect(decodeSearchCursor(token, USER_B, KEY)).toBeNull();
  });

  it('rejects tampered payloads, truncated tokens, and garbage identically', () => {
    const token = encodeSearchCursor({ rank: 0, id: USER_A }, USER_A, KEY);
    const [payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ rank: 2, id: USER_B })).toString('base64url');
    expect(decodeSearchCursor(`${tamperedPayload}.${signature}`, USER_A, KEY)).toBeNull();
    expect(decodeSearchCursor(payload, USER_A, KEY)).toBeNull();
    expect(decodeSearchCursor(`${payload}.${signature}.extra`, USER_A, KEY)).toBeNull();
    expect(decodeSearchCursor('garbage', USER_A, KEY)).toBeNull();
    expect(decodeSearchCursor('', USER_A, KEY)).toBeNull();
  });

  it('rejects well-signed tokens carrying out-of-domain state (rank/id shape)', () => {
    const forgedPayload = Buffer.from(JSON.stringify({ rank: 9, id: 'not-a-uuid' })).toString('base64url');
    const forged = `${forgedPayload}.${createHmac('sha256', KEY).update(`${USER_A}|${forgedPayload}`).digest('base64url')}`;
    expect(decodeSearchCursor(forged, USER_A, KEY)).toBeNull();
  });
});
