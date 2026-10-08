import { describe, expect, it } from 'vitest';
import { fixtureUserUuid } from '../../request-context/user-context.js';
import { decomposeCursorPosition, SyncDeltaComposer, type DeltaChangeWire } from './delta-composer.service.js';
import { SyncDeltaRegistry } from './delta-registry.js';
import {
  CURSOR_ENTITY_MAX,
  CURSOR_ENTITY_MIN,
  type DeltaChange,
  type DeltaCursorState,
  type GlobalCursorPosition,
  type SyncOpContext,
  type SyncOpKind,
  type TrackingDeltaProvider,
} from './seams.js';

/**
 * The delta composer (note §1.6/§4) against the CANONICAL seam types
 * (src/tracking/sync-seams.ts): deterministic `(updatedAt, kind, entityId)`
 * ordering, page truncation, end-of-collection ⇔ nextCursor null, tombstone
 * serialization (no payload on delete), registry-only composition, and the
 * global-position → per-kind cursor decomposition.
 */

const CTX: SyncOpContext = { userId: fixtureUserUuid('a1'), deviceId: '' };
const FAKE_TX = { fake: true } as unknown as Parameters<TrackingDeltaProvider['changesSince']>[3];
const T0 = '2026-10-08T07:00:00.000Z';
const T1 = '2026-10-08T07:00:00.150Z';
const T2 = '2026-10-08T07:00:00.200Z';

function change(kind: DeltaChange['kind'], entityId: string, updatedAt: string, type: 'upsert' | 'delete' = 'upsert', payload?: unknown): DeltaChange {
  return {
    kind,
    entityId,
    change: type,
    updatedAt,
    ...(type === 'upsert' ? { payload: payload ?? { snapshot: entityId } } : {}),
  };
}

interface RecordedCall {
  readonly cursor: DeltaCursorState | null;
  readonly limit: number;
}

/** Stub provider with a scripted page; records the per-kind cursor it received. */
function stubProvider(page: { changes: DeltaChange[]; exhausted: boolean }, calls: RecordedCall[] = []): TrackingDeltaProvider {
  return {
    kind: 'diary_entry' as SyncOpKind,
    async changesSince(cursor, limit, _ctx, _tx) {
      calls.push({ cursor, limit });
      return page;
    },
  };
}

/** Stub provider bound to a NON-diary kind (the kind rides on the canonical seam). */
function stubFavorite(page: { changes: DeltaChange[]; exhausted: boolean }, calls: RecordedCall[] = []): TrackingDeltaProvider {
  return {
    kind: 'favorite',
    async changesSince(cursor, limit) {
      calls.push({ cursor, limit });
      return page;
    },
  };
}

function stubUserFood(page: { changes: DeltaChange[]; exhausted: boolean }, calls: RecordedCall[] = []): TrackingDeltaProvider {
  return {
    kind: 'user_food',
    async changesSince(cursor, limit) {
      calls.push({ cursor, limit });
      return page;
    },
  };
}

function composerWith(...registrations: { kind: SyncOpKind; provider: TrackingDeltaProvider }[]): SyncDeltaComposer {
  const registry = new SyncDeltaRegistry();
  for (const { kind, provider } of registrations) {
    registry.registerDeltaProvider(kind, provider);
  }
  return new SyncDeltaComposer(registry);
}

const ENT_A = fixtureUserUuid('a0');
const ENT_B = fixtureUserUuid('b0');
const ENT_C = fixtureUserUuid('c0');

describe('delta composer — deterministic ordering and pagination', () => {
  it('merges providers into the frozen (updatedAt, kind, entityId) ascending order', async () => {
    // Feed arrival order is deliberately scrambled across kinds.
    const diary = stubProvider({ changes: [change('diary_entry', ENT_B, T2), change('diary_entry', ENT_A, T0)], exhausted: true });
    const favorite = stubFavorite({ changes: [change('favorite', ENT_C, T1)], exhausted: true });
    const composer = composerWith({ kind: 'favorite', provider: favorite }, { kind: 'diary_entry', provider: diary });

    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes.map((c) => `${c.kind}:${c.entityId}`)).toEqual([
      `diary_entry:${ENT_A}`,
      `favorite:${ENT_C}`,
      `diary_entry:${ENT_B}`,
    ]);
    expect(page.endOfCollection).toBe(true);
    expect(page.lastState).toEqual({ updatedAt: T2, kind: 'diary_entry', entityId: ENT_B });
  });

  it('breaks equal updatedAt ties by kind, then entityId (total order)', async () => {
    const diary = stubProvider({ changes: [change('diary_entry', ENT_B, T0), change('diary_entry', ENT_A, T0)], exhausted: true });
    const userFood = stubUserFood({ changes: [change('user_food', ENT_C, T0)], exhausted: true });
    const composer = composerWith({ kind: 'user_food', provider: userFood }, { kind: 'diary_entry', provider: diary });

    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes.map((c) => `${c.kind}:${c.entityId}`)).toEqual([
      `diary_entry:${ENT_A}`,
      `diary_entry:${ENT_B}`,
      `user_food:${ENT_C}`,
    ]);
  });

  it('the same server state renders the same page twice (reproducible pagination)', async () => {
    const provider = stubProvider({ changes: [change('diary_entry', ENT_A, T0), change('diary_entry', ENT_B, T1)], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const first = await composer.compose(null, 50, CTX, FAKE_TX);
    const second = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(first).toEqual(second);
  });

  it('truncates the merged feed to limit and reports more-to-come', async () => {
    const diary = stubProvider({ changes: [change('diary_entry', ENT_A, T0), change('diary_entry', ENT_B, T2)], exhausted: true });
    const userFood = stubUserFood({ changes: [change('user_food', ENT_C, T1)], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider: diary }, { kind: 'user_food', provider: userFood });

    const page = await composer.compose(null, 2, CTX, FAKE_TX);
    expect(page.changes).toHaveLength(2);
    expect(page.changes.map((c) => `${c.kind}:${c.entityId}`)).toEqual([`diary_entry:${ENT_A}`, `user_food:${ENT_C}`]);
    expect(page.endOfCollection).toBe(false);
    expect(page.lastState).toEqual({ updatedAt: T1, kind: 'user_food', entityId: ENT_C });
  });

  it('an exactly-limit page with every provider exhausted IS the end (no empty trailing page)', async () => {
    const provider = stubProvider({ changes: [change('diary_entry', ENT_A, T0)], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 1, CTX, FAKE_TX);
    expect(page.changes).toHaveLength(1);
    expect(page.endOfCollection).toBe(true);
  });

  it('a provider with more data after a short page keeps the cursor alive', async () => {
    const provider = stubProvider({ changes: [change('diary_entry', ENT_A, T0)], exhausted: false });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.endOfCollection).toBe(false);
  });

  it('an empty page from an exhausted feed ends the collection exactly like any page', async () => {
    const provider = stubProvider({ changes: [], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes).toEqual([]);
    expect(page.endOfCollection).toBe(true);
    expect(page.lastState).toBeNull();
  });
});

describe('delta composer — global-position → per-kind cursor decomposition', () => {
  it('pure decomposition: the position kind resumes strictly after; later kinds at-or-after; earlier kinds strictly later', () => {
    const position: GlobalCursorPosition = { updatedAt: T1, kind: 'favorite', entityId: ENT_C };
    expect(decomposeCursorPosition(position, 'favorite')).toEqual({ updatedAt: T1, entityId: ENT_C });
    // 'user_food' sorts AFTER 'favorite': every user_food change at T1 is
    // globally after → resume at-or-after (sentinel MIN).
    expect(decomposeCursorPosition(position, 'user_food')).toEqual({ updatedAt: T1, entityId: CURSOR_ENTITY_MIN });
    // 'diary_entry' sorts BEFORE 'favorite': nothing at T1 qualifies.
    expect(decomposeCursorPosition(position, 'diary_entry')).toEqual({ updatedAt: T1, entityId: CURSOR_ENTITY_MAX });
    // First pull passes null through to every kind.
    expect(decomposeCursorPosition(null, 'favorite')).toBeNull();
    expect(decomposeCursorPosition(null, 'diary_entry')).toBeNull();
  });

  it('continuation pulls hand each provider its own per-kind state (not the global tuple)', async () => {
    const diaryCalls: RecordedCall[] = [];
    const favCalls: RecordedCall[] = [];
    const diary = stubProvider({ changes: [], exhausted: true }, diaryCalls);
    const favorite = stubFavorite({ changes: [], exhausted: true }, favCalls);
    const composer = composerWith({ kind: 'diary_entry', provider: diary }, { kind: 'favorite', provider: favorite });

    const position: GlobalCursorPosition = { updatedAt: T1, kind: 'favorite', entityId: ENT_C };
    await composer.compose(position, 7, CTX, FAKE_TX);
    expect(diaryCalls).toEqual([{ cursor: { updatedAt: T1, entityId: CURSOR_ENTITY_MAX }, limit: 7 }]);
    expect(favCalls).toEqual([{ cursor: { updatedAt: T1, entityId: ENT_C }, limit: 7 }]);
  });
});

describe('delta composer — registry-only composition', () => {
  it('composes only through registered providers, passing limit/ctx/tx verbatim', async () => {
    const calls: RecordedCall[] = [];
    const provider = stubProvider({ changes: [], exhausted: true }, calls);
    const composer = composerWith({ kind: 'diary_entry', provider });

    await composer.compose(null, 7, CTX, FAKE_TX);
    expect(calls).toEqual([{ cursor: null, limit: 7 }]);
  });

  it('a kind with no registered provider contributes nothing — never a crash (silent skip)', async () => {
    const favoriteProvider = stubFavorite({ changes: [change('favorite', ENT_C, T0)], exhausted: true });
    const composer = composerWith({ kind: 'favorite', provider: favoriteProvider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes.map((c) => c.kind)).toEqual(['favorite']);
    expect(page.endOfCollection).toBe(true);
  });

  it('no providers at all: an empty, exhausted page', async () => {
    const composer = composerWith();
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes).toEqual([]);
    expect(page.endOfCollection).toBe(true);
  });
});

describe('delta composer — tombstone serialization (note §1.5/§1.6)', () => {
  it('a delete change carries NO payload member, structurally', async () => {
    const provider = stubProvider({
      changes: [
        change('diary_entry', ENT_A, T0, 'delete'),
        // A misbehaving provider attaching a payload to a delete cannot leak it:
        { ...change('diary_entry', ENT_B, T1, 'delete'), payload: { health: 'data' } } as DeltaChange,
      ],
      exhausted: true,
    });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes.map((c: DeltaChangeWire) => Object.keys(c).sort())).toEqual([
      ['change', 'entityId', 'kind', 'updatedAt'],
      ['change', 'entityId', 'kind', 'updatedAt'],
    ]);
    expect(page.changes.every((c) => c.change === 'delete')).toBe(true);
    expect(JSON.stringify(page.changes)).not.toContain('health');
  });

  it('an upsert carries the full snapshot payload verbatim', async () => {
    const snapshot = { localDate: '2026-10-08', energyKcal: 320 };
    const provider = stubProvider({ changes: [change('diary_entry', ENT_A, T0, 'upsert', snapshot)], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes[0]).toMatchObject({ change: 'upsert', payload: snapshot });
  });

  it('updatedAt is carried verbatim as the provider-emitted ISO instant', async () => {
    const provider = stubProvider({ changes: [change('diary_entry', ENT_A, T0)], exhausted: true });
    const composer = composerWith({ kind: 'diary_entry', provider });
    const page = await composer.compose(null, 50, CTX, FAKE_TX);
    expect(page.changes[0]?.updatedAt).toBe(T0);
  });
});
