/**
 * Kal — pull-side cursor verification for the `journal_session` kind (w4
 * contract §1.4; supervisor-blessed seam widening, ruling 1, 2026-10-12).
 *
 * The opaque, user-bound cursor carries the GLOBAL feed position
 * `(updatedAt, kind, entityId)`; `isSyncEntityKind` (driven by
 * `SYNC_ENTITY_KINDS`) gates every verification. This suite proves a
 * token positioned on a `journal_session` change mint-verify round-trips —
 * i.e. a pull that resumed from a journal change is not a 400 — and that
 * the not-yet-registered `journal_routine` kind stays rejected (s2c's
 * union adds it; the seam stays clean).
 */
import { describe, expect, it } from 'vitest';
import { fixtureUserUuid } from '../../request-context/user-context.js';
import { SyncDeltaCursorService } from './delta-cursor.service.js';
import { SyncPullConfigService } from './sync-pull.config.js';
import { isSyncEntityKind } from './seams.js';

const USER_A = fixtureUserUuid('a1');

const config = new SyncPullConfigService('test');
const cursors = new SyncDeltaCursorService(config);

describe('journal_session cursor positions verify (w4 §1.4, ruling 1)', () => {
  it('a cursor minted on a journal_session position verifies to the exact position', () => {
    const p = {
      updatedAt: '2026-10-12T21:59:00.000Z',
      kind: 'journal_session' as const,
      entityId: '7e100000-0000-4000-8000-00000000b001',
    };
    const cursor = cursors.mint(USER_A, p);
    expect(cursors.verify(cursor, USER_A)).toEqual(p);
  });

  it('journal_session is a registered sync entity kind for cursor validation', () => {
    expect(isSyncEntityKind('journal_session')).toBe(true);
  });

  it('journal_routine is not yet a kind (s2c union) — a token carrying it fails verification', () => {
    expect(isSyncEntityKind('journal_routine')).toBe(false);
  });
});
