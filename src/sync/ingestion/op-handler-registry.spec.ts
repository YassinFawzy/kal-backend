/**
 * Unit — the sync-owned op-handler registry (wave-03 contract §4).
 *
 * Pinned: registration through the production path, one handler per kind
 * (duplicate registration refuses — fail fast), lookup semantics, and the
 * dispatch-miss shape (undefined ⇒ per-op rejected, never a crash).
 */
import { describe, expect, it } from 'vitest';
import { OpHandlerRegistry } from './op-handler-registry.js';
import type { SyncOpHandler, SyncOpKind } from '../../tracking/sync-seams.js';

function fakeHandler(kind: SyncOpKind): SyncOpHandler {
  return {
    kind,
    apply: async () => ({ outcome: 'applied' }),
  };
}

describe('OpHandlerRegistry (§4 — sync owns the registries)', () => {
  it('registers and looks up one handler per kind', () => {
    const registry = new OpHandlerRegistry();
    const handler = fakeHandler('diary_entry');
    registry.registerOpHandler(handler);
    expect(registry.lookup('diary_entry')).toBe(handler);
    expect(registry.registeredKinds()).toEqual(['diary_entry']);
  });

  it('refuses a duplicate registration of the same kind (module-composition error)', () => {
    const registry = new OpHandlerRegistry();
    registry.registerOpHandler(fakeHandler('user_food'));
    expect(() => registry.registerOpHandler(fakeHandler('user_food'))).toThrow(/already registered/u);
  });

  it('a kind without a registered handler resolves undefined (dispatch-miss ⇒ per-op rejected, §4)', () => {
    const registry = new OpHandlerRegistry();
    registry.registerOpHandler(fakeHandler('favorite'));
    expect(registry.lookup('diary_entry')).toBeUndefined();
    expect(registry.lookup('user_food')).toBeUndefined();
  });
});
