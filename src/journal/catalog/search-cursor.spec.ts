/**
 * Unit spec — the exercise-search cursor codec (conventions §2; w4 note §2 —
 * the tracking foods codec mechanics, journal domain key): round-trip; ONE
 * generic null for every failure cause — malformed, truncated, tampered, or
 * a foreign user's cursor (I7: a foreign cursor never yields rows); the
 * journal-domain key never accepts a tracking-domain cursor (distinct
 * derivations of the same secret — mirroring here with an independently
 * derived key would be tautological, so the distinctness pinned is the
 * domain label constant + codec purity).
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  JOURNAL_SEARCH_CURSOR_DOMAIN,
  decodeExerciseSearchCursor,
  encodeExerciseSearchCursor,
  inspectExerciseSearchCursor,
} from './search-cursor.js';

const KEY = Buffer.alloc(32, 7);
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const EXERCISE_ID = '00000000-0000-4000-8000-00000000f201';

describe('exercise search cursor codec', () => {
  it('round-trips a state for its own user', () => {
    const token = encodeExerciseSearchCursor({ rank: 1, id: EXERCISE_ID }, USER_A, KEY);
    expect(decodeExerciseSearchCursor(token, USER_A, KEY)).toEqual({ rank: 1, id: EXERCISE_ID });
  });

  it('rejects a cursor presented under a different authenticated context (byte-generic null → 400)', () => {
    const token = encodeExerciseSearchCursor({ rank: 0, id: EXERCISE_ID }, USER_A, KEY);
    expect(decodeExerciseSearchCursor(token, USER_B, KEY)).toBeNull();
  });

  it('rejects tampered payloads, truncated tokens, and garbage identically', () => {
    const token = encodeExerciseSearchCursor({ rank: 0, id: EXERCISE_ID }, USER_A, KEY);
    const [payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ rank: 2, id: EXERCISE_ID })).toString('base64url');
    expect(decodeExerciseSearchCursor(`${tamperedPayload}.${signature}`, USER_A, KEY)).toBeNull();
    expect(decodeExerciseSearchCursor(payload, USER_A, KEY)).toBeNull();
    expect(decodeExerciseSearchCursor(`${payload}.${signature}.extra`, USER_A, KEY)).toBeNull();
    expect(decodeExerciseSearchCursor('garbage', USER_A, KEY)).toBeNull();
    expect(decodeExerciseSearchCursor('', USER_A, KEY)).toBeNull();
  });

  it('rejects well-signed tokens carrying out-of-domain state (rank/id shape, missing binding)', () => {
    const forgedPayload = Buffer.from(JSON.stringify({ rank: 9, id: 'not-a-uuid' })).toString('base64url');
    const forged = `${forgedPayload}.${createHmac('sha256', KEY).update(`${USER_A}|${forgedPayload}`).digest('base64url')}`;
    expect(decodeExerciseSearchCursor(forged, USER_A, KEY)).toBeNull();
    const unbound = Buffer.from(JSON.stringify({ rank: 0, id: EXERCISE_ID })).toString('base64url');
    const unboundToken = `${unbound}.${createHmac('sha256', KEY).update(`${USER_A}|${unbound}`).digest('base64url')}`;
    expect(decodeExerciseSearchCursor(unboundToken, USER_A, KEY)).toBeNull();
  });

  it('the domain label is the journal-specific derivation string (never tracking\'s)', () => {
    expect(JOURNAL_SEARCH_CURSOR_DOMAIN).toBe('kal:journal:search-cursor:v1');
  });

  it('inspect exposes the embedded binding only for genuinely-minted foreign tokens (I14 side channel)', () => {
    const foreign = encodeExerciseSearchCursor({ rank: 2, id: EXERCISE_ID }, USER_B, KEY);
    expect(inspectExerciseSearchCursor(foreign, KEY)).toBe(USER_B);
    // Presented under A it still fails decode (I7) — inspect never changes that.
    expect(decodeExerciseSearchCursor(foreign, USER_A, KEY)).toBeNull();
    expect(inspectExerciseSearchCursor('garbage', KEY)).toBeNull();
    const [, signature] = foreign.split('.');
    const tampered = Buffer.from(JSON.stringify({ rank: 0, id: EXERCISE_ID, u: USER_B })).toString('base64url');
    expect(inspectExerciseSearchCursor(`${tampered}.${signature}`, KEY)).toBeNull();
  });

  it('a token minted under a DIFFERENT domain key does not decode (domain separation)', () => {
    const foreignDomainKey = createHmac('sha256', KEY).update('kal:tracking:search-cursor:v1').digest();
    const token = encodeExerciseSearchCursor({ rank: 0, id: EXERCISE_ID }, USER_A, foreignDomainKey);
    // Same user, journal key: rejected — the journal cursor key is a distinct
    // derivation, so cross-surface cursor replay fails closed.
    expect(decodeExerciseSearchCursor(token, USER_A, KEY)).toBeNull();
  });

  it('codec is deterministic for identical inputs (same state + user + key ⇒ same token)', () => {
    const a = encodeExerciseSearchCursor({ rank: 1, id: EXERCISE_ID }, USER_A, KEY);
    const b = encodeExerciseSearchCursor({ rank: 1, id: EXERCISE_ID }, USER_A, KEY);
    expect(a).toBe(b);
  });
});
