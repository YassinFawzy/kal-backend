import { describe, expect, it } from 'vitest';
import { fixtureUserUuid } from '../../request-context/user-context.js';
import { SyncDeltaComposer, type ComposedPullPage } from './delta-composer.service.js';
import { SyncDeltaCursorService } from './delta-cursor.service.js';
import { SyncDeltaRegistry } from './delta-registry.js';
import { SyncPullConfigService } from './sync-pull.config.js';
import { SyncPullService } from './sync-pull.service.js';
import type { GlobalCursorPosition, SyncOpContext } from './seams.js';

/**
 * The pull service unit level (note §1.6; conventions §2): limit clamping,
 * the ONE generic cursor rejection for every failure class, fail-closed
 * context, the per-transaction posture (role + user GUC + UTC) wrapping
 * composition, and nextCursor minting only while the feed continues.
 */

const USER_A = fixtureUserUuid('a1');
const T0 = '2026-10-08T07:00:00.000Z';

const config = new SyncPullConfigService('test');
const cursors = new SyncDeltaCursorService(config);

/** Captures the set_config posture statement and the composed call. */
function makeHarness(composed: ComposedPullPage) {
  const postureQueries: { sql: string; boundUserId: string | null }[] = [];
  const composeCalls: { cursor: GlobalCursorPosition | null; limit: number; ctx: SyncOpContext }[] = [];

  const fakeTx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      postureQueries.push({ sql, boundUserId: typeof values[0] === 'string' ? (values[0] as string) : null });
      return [];
    },
  };

  const db = {
    transaction: async (work: (tx: unknown) => Promise<ComposedPullPage>) => work(fakeTx),
  };
  const registry = new SyncDeltaRegistry();
  const composer = {
    compose: async (cursor: GlobalCursorPosition | null, limit: number, ctx: SyncOpContext, _tx: unknown) => {
      composeCalls.push({ cursor, limit, ctx });
      return composed;
    },
  } as unknown as SyncDeltaComposer;

  const service = new SyncPullService(
    db as unknown as ConstructorParameters<typeof SyncPullService>[0],
    registry,
    composer,
    cursors,
    // AMENDMENT 3: audit stub — fire-and-forget append (never blocks/throws).
    { append: async () => ({}) as never } as unknown as ConstructorParameters<typeof SyncPullService>[4],
  );
  return { service, postureQueries, composeCalls };
}

function composedPage(overrides: Partial<ComposedPullPage> = {}): ComposedPullPage {
  return {
    changes: [
      {
        kind: 'diary_entry',
        entityId: fixtureUserUuid('e1'),
        change: 'upsert',
        updatedAt: T0,
        payload: { snapshot: true },
      },
    ],
    endOfCollection: false,
    lastState: { updatedAt: T0, kind: 'diary_entry', entityId: fixtureUserUuid('e1') },
    ...overrides,
  };
}

function expectProblem(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('sync pull service — parameter handling', () => {
  it('clamps limit to 1–100 with default 50 (conventions §2)', async () => {
    for (const [raw, expected] of [
      [null, 50],
      ['', 50],
      ['1', 1],
      ['50', 50],
      ['0', 1],
      ['100', 100],
      ['101', 100],
      ['999999', 100],
    ] as const) {
      const { service, composeCalls } = makeHarness(composedPage({ endOfCollection: true, lastState: null }));
      await service.pull(USER_A, null, raw);
      expect(composeCalls[0]?.limit).toBe(expected);
    }
  });

  it('a non-integer limit is the generic VALIDATION_FAILED', async () => {
    const { service } = makeHarness(composedPage());
    await expectProblem(service.pull(USER_A, null, 'abc'), 'VALIDATION_FAILED');
    await expectProblem(service.pull(USER_A, null, '3.5'), 'VALIDATION_FAILED');
    await expectProblem(service.pull(USER_A, null, ' 5'), 'VALIDATION_FAILED');
    await expectProblem(service.pull(USER_A, null, '-5'), 'VALIDATION_FAILED');
  });

  it('a non-UUID context fails closed with FORBIDDEN before any database work (I2)', async () => {
    const { service, composeCalls, postureQueries } = makeHarness(composedPage());
    await expectProblem(service.pull('not-a-uuid', null, null), 'FORBIDDEN');
    expect(composeCalls).toHaveLength(0);
    expect(postureQueries).toHaveLength(0);
  });
});

describe('sync pull service — cursor rejection equivalence (I7)', () => {
  it('every cursor failure class is the SAME generic VALIDATION_FAILED', async () => {
    const { service: plain } = makeHarness(composedPage());
    // foreign (minted for another user), malformed, truncated, tampered:
    const foreign = cursors.mint(fixtureUserUuid('b2'), { updatedAt: T0, kind: 'diary_entry', entityId: fixtureUserUuid('e1') });
    const ownCursor = cursors.mint(USER_A, { updatedAt: T0, kind: 'diary_entry', entityId: fixtureUserUuid('e1') });
    for (const bad of [foreign, 'garbage', ownCursor.slice(0, 20), `${ownCursor}x`, '']) {
      const { service } = makeHarness(composedPage());
      await expectProblem(service.pull(USER_A, bad, null), 'VALIDATION_FAILED');
    }
    expect(plain).toBeDefined();
  });

  it('an oversized cursor (>512) is rejected before verification', async () => {
    const { service, composeCalls } = makeHarness(composedPage());
    await expectProblem(service.pull(USER_A, 'a'.repeat(513), null), 'VALIDATION_FAILED');
    expect(composeCalls).toHaveLength(0);
  });

  it('a valid own cursor composes strictly after its position (state passed through)', async () => {
    const position: GlobalCursorPosition = { updatedAt: T0, kind: 'user_food', entityId: fixtureUserUuid('e9') };
    const { service, composeCalls } = makeHarness(composedPage());
    await service.pull(USER_A, cursors.mint(USER_A, position), null);
    expect(composeCalls[0]?.cursor).toEqual(position);
  });

  it('no cursor composes from the beginning (bootstrap = same mechanism)', async () => {
    const { service, composeCalls } = makeHarness(composedPage());
    await service.pull(USER_A, null, null);
    expect(composeCalls[0]?.cursor).toBeNull();
  });
});

describe('sync pull service — per-transaction posture and envelope', () => {
  it('composition runs inside SET ROLE kal_app + app.user_id + TimeZone UTC (per-transaction)', async () => {
    const { service, postureQueries, composeCalls } = makeHarness(composedPage());
    await service.pull(USER_A, null, null);
    expect(postureQueries).toHaveLength(1);
    const sql = postureQueries[0]?.sql ?? '';
    expect(sql).toContain('set_config(');
    expect(sql).toContain("'kal_app'");
    expect(sql).toContain("'app.user_id'");
    expect(sql).toContain("'TimeZone'");
    expect(postureQueries[0]?.boundUserId).toBe(USER_A);
    expect(composeCalls[0]?.ctx).toEqual({ userId: USER_A, deviceId: '' });
  });

  it('mints nextCursor from the page position while the feed continues; null at end', async () => {
    const continuing = makeHarness(composedPage());
    const continued = await continuing.service.pull(USER_A, null, null);
    expect(typeof continued.nextCursor).toBe('string');
    expect(cursors.verify(continued.nextCursor as string, USER_A)).toEqual(composedPage().lastState);

    const drained = makeHarness(composedPage({ endOfCollection: true, lastState: null, changes: [] }));
    const ended = await drained.service.pull(USER_A, null, null);
    expect(ended.nextCursor).toBeNull();
    expect(ended.changes).toEqual([]);
  });

  it('a registry-miss world still serves an empty, exhausted page (pre-provider reality)', async () => {
    const { service } = makeHarness(composedPage({ changes: [], endOfCollection: true, lastState: null }));
    const page = await service.pull(USER_A, null, null);
    expect(page).toEqual({ changes: [], nextCursor: null });
  });
});
