import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureUserUuid } from '../../request-context/user-context.js';
import { SyncDeltaCursorService } from './delta-cursor.service.js';
import { SyncPullConfigService } from './sync-pull.config.js';
import type { GlobalCursorPosition } from './seams.js';

/**
 * Delta cursor mint/verify (note §1.6; conventions §2) against the CANONICAL
 * seam types: the token carries the GLOBAL position `(updatedAt ISO, kind,
 * entityId)`; the composer decomposes per kind. The gate property — the
 * cursor user-binding equivalence set — is pinned at this level as "every
 * failure class decodes to `null`" (the HTTP layer maps all of them to the
 * ONE generic 400 body; the e2e suite pins the byte-identical bodies).
 */

const USER_A = fixtureUserUuid('a1');
const USER_B = fixtureUserUuid('b2');

const T0 = '2026-10-08T07:00:00.000Z';

function position(kind: GlobalCursorPosition['kind'] = 'diary_entry', entityId = fixtureUserUuid('e1'), updatedAt = T0): GlobalCursorPosition {
  return { updatedAt, kind, entityId };
}

/** Fixture config in the test env (ephemeral per-boot key — never a real secret). */
const config = new SyncPullConfigService('test');
const cursors = new SyncDeltaCursorService(config);

/** Signs an arbitrary payload with the fixture subkey — adversarial variant factory. */
function signPayload(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const tag = createHmac('sha256', config.deltaCursorKey).update(body).digest();
  return `${body.toString('base64url')}.${tag.toString('base64url')}`;
}

describe('delta cursor mint → verify round-trip', () => {
  it('a minted cursor verifies to the exact global position it was minted from', () => {
    const p = position('user_food', fixtureUserUuid('e7'), '2026-10-08T07:30:01.123Z');
    const cursor = cursors.mint(USER_A, p);
    expect(cursors.verify(cursor, USER_A)).toEqual(p);
  });

  it('the wire form is opaque: no raw user/kind/entity material in the token', () => {
    const cursor = cursors.mint(USER_A, position());
    expect(cursor).not.toContain(USER_A);
    expect(cursor).not.toContain('diary_entry');
    expect(cursor).not.toContain('2026-10-08');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  });

  it('mints distinct tokens for distinct positions (pagination positions differ)', () => {
    const a = cursors.mint(USER_A, position('diary_entry', fixtureUserUuid('e1'), T0));
    const b = cursors.mint(USER_A, position('diary_entry', fixtureUserUuid('e1'), '2026-10-08T07:00:00.001Z'));
    const c = cursors.mint(USER_A, position('favorite', fixtureUserUuid('e1'), T0));
    const d = cursors.mint(USER_A, position('diary_entry', fixtureUserUuid('e2'), T0));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('W3 cursors do not expire: an old timestamp verifies (note §1.6)', () => {
    const cursor = cursors.mint(USER_A, position('diary_entry', fixtureUserUuid('e1'), '2020-01-01T00:00:00.000Z'));
    expect(cursors.verify(cursor, USER_A)).not.toBeNull();
  });
});

describe('cursor user binding — every failure class decodes to null', () => {
  it('A’s cursor under B’s authenticated context is null (foreign cursor — the gate criterion)', () => {
    const cursor = cursors.mint(USER_A, position());
    expect(cursors.verify(cursor, USER_A)).not.toBeNull();
    expect(cursors.verify(cursor, USER_B)).toBeNull();
  });

  it('a tampered payload byte is null (tag no longer matches)', () => {
    const cursor = cursors.mint(USER_A, position());
    const [payload, tag] = cursor.split('.');
    const decoded = Buffer.from(payload as string, 'base64url');
    decoded[decoded.length - 1] ^= 0x01;
    const forged = `${decoded.toString('base64url')}.${tag}`;
    expect(cursors.verify(forged, USER_A)).toBeNull();
  });

  it('a tampered tag is null', () => {
    const cursor = cursors.mint(USER_A, position());
    const [payload, tag] = cursor.split('.');
    const tagBytes = Buffer.from(tag as string, 'base64url');
    tagBytes[0] ^= 0x01;
    expect(cursors.verify(`${payload}.${tagBytes.toString('base64url')}`, USER_A)).toBeNull();
  });

  it('a truncated cursor is null (and truncation never flips into another valid token)', () => {
    const cursor = cursors.mint(USER_A, position());
    expect(cursors.verify(cursor.slice(0, cursor.length - 4), USER_A)).toBeNull();
    expect(cursors.verify(cursor.slice(0, Math.floor(cursor.length / 2)), USER_A)).toBeNull();
  });

  it('structurally malformed cursors are null', () => {
    expect(cursors.verify('', USER_A)).toBeNull();
    expect(cursors.verify('no-tag-segment', USER_A)).toBeNull();
    expect(cursors.verify('.tag-only', USER_A)).toBeNull();
    expect(cursors.verify('payload-only.', USER_A)).toBeNull();
    expect(cursors.verify('!!!not-base64url!!!.!!!', USER_A)).toBeNull();
    expect(cursors.verify(`${Buffer.from('not json', 'utf8').toString('base64url')}.${Buffer.from('tag', 'utf8').toString('base64url')}`, USER_A)).toBeNull();
    expect(cursors.verify(`${Buffer.from('["an","array"]', 'utf8').toString('base64url')}.${Buffer.from('tag', 'utf8').toString('base64url')}`, USER_A)).toBeNull();
  });

  it('a correctly-signed token with doctored fields is null (version/kind/entity/timestamp)', () => {
    const wrongVersion = signPayload({ v: 2, u: USER_A, ts: T0, k: 'diary_entry', e: fixtureUserUuid('e1') });
    expect(cursors.verify(wrongVersion, USER_A)).toBeNull();

    const unknownKind = signPayload({ v: 1, u: USER_A, ts: T0, k: 'meal_plan', e: fixtureUserUuid('e1') });
    expect(cursors.verify(unknownKind, USER_A)).toBeNull();

    const nonUuidEntity = signPayload({ v: 1, u: USER_A, ts: T0, k: 'diary_entry', e: 'not-a-uuid' });
    expect(cursors.verify(nonUuidEntity, USER_A)).toBeNull();

    const naiveTimestamp = signPayload({ v: 1, u: USER_A, ts: '2026-10-08T07:00:00.000', k: 'diary_entry', e: fixtureUserUuid('e1') });
    expect(cursors.verify(naiveTimestamp, USER_A)).toBeNull();

    const nonIsoTimestamp = signPayload({ v: 1, u: USER_A, ts: 'not-an-instant', k: 'diary_entry', e: fixtureUserUuid('e1') });
    expect(cursors.verify(nonIsoTimestamp, USER_A)).toBeNull();

    const numericTimestamp = signPayload({ v: 1, u: USER_A, ts: 1791840000000, k: 'diary_entry', e: fixtureUserUuid('e1') });
    expect(cursors.verify(numericTimestamp, USER_A)).toBeNull();

    const missingEntity = signPayload({ v: 1, u: USER_A, ts: T0, k: 'diary_entry' });
    expect(cursors.verify(missingEntity, USER_A)).toBeNull();
  });

  it('a cursor signed under a foreign subkey is null (key separation)', () => {
    const otherKey = createHmac('sha256', 'another-root-key-material-for-the-fixture-only').update('kal:identity:session-cursor:v1').digest();
    const body = Buffer.from(JSON.stringify({ v: 1, u: USER_A, ts: T0, k: 'diary_entry', e: fixtureUserUuid('e1') }), 'utf8');
    const foreign = `${body.toString('base64url')}.${createHmac('sha256', otherKey).update(body).digest('base64url')}`;
    expect(cursors.verify(foreign, USER_A)).toBeNull();
  });
});
