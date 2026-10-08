/**
 * Kal — the sync-owned delta-provider registry (wave-03 contract note §4;
 * the delta-side twin of ingestion's `OpHandlerRegistry`).
 *
 * "sync owns the registries; tracking registers implementations at module
 * init." Composition NEVER reaches around this seam: the pull path reads
 * tracking data exclusively through registered `TrackingDeltaProvider`s
 * running inside the pull transaction — sync never queries tracking's
 * tables (module gate, ARCHITECTURE §9). The canonical seam types are the
 * declarations in `src/tracking/sync-seams.ts` (type-level import across
 * the seam — tracking implements, sync consumes).
 *
 * Registration signature matches the frozen sketch (`registerDeltaProvider(
 * kind, provider)`, note §4): the kind is passed explicitly AND validated
 * against the provider's own `kind` — a mismatch refuses the boot (wiring
 * bug, fail fast). A kind with NO registered provider contributes nothing
 * to the feed (silent skip — the frozen response envelope has no marker
 * slot, and a missing provider must never crash a pull). Duplicate
 * registration of one kind is a module-composition error and fails fast at
 * registration time (boot), never mid-request.
 */
import { Injectable } from '@nestjs/common';
import type { SyncOpKind, TrackingDeltaProvider } from './seams.js';

@Injectable()
export class SyncDeltaRegistry {
  private readonly providers = new Map<SyncOpKind, TrackingDeltaProvider>();

  /** Module-init registration path (tracking's real providers; test harnesses). */
  registerDeltaProvider(kind: SyncOpKind, provider: TrackingDeltaProvider): void {
    if (provider.kind !== kind) {
      throw new Error(`sync: delta provider reports kind "${provider.kind}" but was registered for "${kind}"`);
    }
    if (this.providers.has(kind)) {
      throw new Error(`sync: a delta provider is already registered for kind ${kind}`);
    }
    this.providers.set(kind, provider);
  }

  /** The registered provider for a kind, or `undefined` (composition skips it). */
  providerFor(kind: SyncOpKind): TrackingDeltaProvider | undefined {
    return this.providers.get(kind);
  }

  /** Currently registered kinds — diagnostics/tests only, never response data. */
  registeredKinds(): readonly SyncOpKind[] {
    return [...this.providers.keys()];
  }
}
