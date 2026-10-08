/**
 * Kal — the sync-owned op-handler registry (wave-03 contract §4).
 *
 * "sync owns the registries; tracking registers implementations at module
 * init." Registration happens through `registerOpHandler` — the SAME
 * production path the tracking lanes (w03-s2a/w03-s2c) will use and the
 * test suites use for the clearly-marked test-only seam handler. Duplicate
 * registration of a kind is a module-composition error and refuses the boot
 * (fail fast — two handlers for one kind would make dispatch ambiguous).
 *
 * Dispatch discipline (locked invariant): unknown ENTITY KINDS that pass
 * batch shape validation but have no registered handler resolve to a per-op
 * `rejected` outcome (validation class) — never a crash, never a dynamic
 * import, never a direct table access outside sync's own op/dedupe tables
 * (ARCHITECTURE §9 module gates).
 *
 * The seam TYPES are the canonical declarations in
 * `src/tracking/sync-seams.ts` (supervisor directive, post-s2c rebase:
 * tracking implements, sync consumes — type-level import across the seam).
 */
import { Injectable } from '@nestjs/common';
import type { SyncOpHandler, SyncOpKind } from '../../tracking/sync-seams.js';

@Injectable()
export class OpHandlerRegistry {
  private readonly handlers = new Map<SyncOpKind, SyncOpHandler>();

  /** Module-init registration path (tracking lanes; test harness). */
  registerOpHandler(handler: SyncOpHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`op-handler-registry: a handler for kind "${handler.kind}" is already registered`);
    }
    this.handlers.set(handler.kind, handler);
  }

  /** The registered handler for a kind, or undefined (dispatch-miss ⇒ per-op rejected). */
  lookup(kind: SyncOpKind): SyncOpHandler | undefined {
    return this.handlers.get(kind);
  }

  /** Currently registered kinds (observability; never client-facing). */
  registeredKinds(): readonly SyncOpKind[] {
    return [...this.handlers.keys()];
  }
}
