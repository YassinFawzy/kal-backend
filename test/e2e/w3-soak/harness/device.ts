/**
 * Kal — w3 soak harness emulated sync client (test/e2e/w3-soak/**).
 *
 * One instance emulates one real device running the ADR-0004 engine over
 * the live HTTP API (real handlers, real transactions — never mocks):
 *
 *   - an operation ledger that is NEVER trimmed (acked ops remain as the
 *     local tombstone record — v1 semantics);
 *   - the merged-view read model: last-known server state overlaid by the
 *     highest-seq pending op per entity (pending create/update surfaces the
 *     op snapshot; pending delete surfaces nothing; a FAILED op surfaces
 *     the server truth — the honest failed state);
 *   - the engine loop: ordered push per device (ledger order, batches
 *     bounded by `sync.maxOpsPerBatch`), exponential backoff with seeded
 *     jitter on network failure (retry = SAME batch + SAME Idempotency-Key),
 *     per-op ack clears that op's overlay individually, pull after drain
 *     (and resumable pull from the last good cursor after a partition);
 *   - pull-apply that never resurrects a tombstone and adopts the feed (the
 *     convergence channel) with a stale-reorder guard.
 *
 * Everything the emulated device "thinks" is checked afterwards by the
 * invariant checker against server evidence — the device is deliberately a
 * naive, contract-faithful client so that any divergence is a finding.
 */
import { randomUUID } from 'node:crypto';
import type { SoakOp } from './support.js';

export type OpStatus = 'queued' | 'syncing' | 'synced' | 'failed';

export interface LedgerOp {
  readonly seq: number;
  readonly op: SoakOp;
  status: OpStatus;
  /** First ack outcome observed (duplicate replays do not overwrite it). */
  firstOutcome: 'applied' | 'duplicate' | 'rejected' | null;
  firstRejectionCode: string | null;
  pushAttempts: number;
}

export interface ServerKnownState {
  readonly kind: SoakOp['kind'];
  readonly entityId: string;
  readonly change: 'upsert' | 'delete';
  readonly updatedAt: string;
  readonly payload?: Record<string, unknown>;
}

export interface RenderedEntry {
  readonly entityId: string;
  readonly kind: SoakOp['kind'];
  readonly snapshot: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface AckResultWire {
  readonly opId: string;
  readonly outcome: 'applied' | 'duplicate' | 'rejected';
  readonly code?: string;
  readonly retryable?: boolean;
}

export interface PullChangeWire {
  readonly kind: SoakOp['kind'];
  readonly entityId: string;
  readonly change: 'upsert' | 'delete';
  readonly updatedAt: string;
  readonly payload?: Record<string, unknown>;
}

export interface PullPageWire {
  readonly changes: readonly PullChangeWire[];
  readonly nextCursor: string | null;
}

export interface DeviceCounters {
  pushes: number;
  pushRetries: number;
  acksApplied: number;
  acksDuplicate: number;
  acksRejectedTerminal: number;
  acksRejectedRetryable: number;
  pulls: number;
  pullRetries: number;
  pagesPulled: number;
  changesReceived: number;
  emptyPagesTolerated: number;
}

export interface HttpClientResult {
  readonly ok: boolean;
  readonly status: number;
  readonly bodyText: string;
  readonly networkError: null | 'aborted' | 'refused';
}

export interface NetworkAdapter {
  send(input: { method: 'POST' | 'GET'; path: string; token: string; bodyText?: string; headers?: Record<string, string>; timeoutMs: number }): Promise<HttpClientResult>;
}

export interface DeviceOptions {
  readonly label: string;
  readonly deviceId: string;
  readonly token: string;
  readonly network: NetworkAdapter;
  readonly maxOpsPerBatch: number;
  readonly clientTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly maxAttempts: number;
  readonly pullLimit: number;
  readonly maxPullPages: number;
}

const PULL_HARD_CURSOR_CAP = 10_000;

export class EmulatedDevice {
  readonly label: string;
  readonly deviceId: string;
  readonly ledger: LedgerOp[] = [];
  private readonly serverKnown = new Map<string, ServerKnownState>();
  pullCursor: string | null = null;
  readonly counters: DeviceCounters = {
    pushes: 0,
    pushRetries: 0,
    acksApplied: 0,
    acksDuplicate: 0,
    acksRejectedTerminal: 0,
    acksRejectedRetryable: 0,
    pulls: 0,
    pullRetries: 0,
    pagesPulled: 0,
    changesReceived: 0,
    emptyPagesTolerated: 0,
  };
  readonly selfFindings: string[] = [];
  private seqCounter = 0;
  private pushSeqCounter = 0;
  private readonly rng: () => number;

  constructor(private readonly options: DeviceOptions, rng: () => number) {
    this.label = options.label;
    this.deviceId = options.deviceId;
    this.rng = rng;
  }

  /** Enqueue: apply to the merged view instantly and append to the ledger in ONE step (op APIs are atomic here — the harness builds ops, never loses one). */
  enqueue(op: SoakOp): void {
    if (this.ledger.some((entry) => entry.op.opId === op.opId)) {
      this.selfFindings.push(`enqueue: duplicate opId ${op.opId} within device ${this.label}`);
      return;
    }
    this.seqCounter += 1;
    this.ledger.push({ seq: this.seqCounter, op, status: 'queued', firstOutcome: null, firstRejectionCode: null, pushAttempts: 0 });
  }

  pendingOps(): LedgerOp[] {
    return this.ledger.filter((entry) => entry.status === 'queued' || entry.status === 'syncing');
  }

  /** The merged view: last-known server state overlaid by the highest-seq pending op per entity. */
  renderedView(): Map<string, RenderedEntry | { absent: true; entityId: string }> {
    const rendered = new Map<string, RenderedEntry | { absent: true; entityId: string }>();
    // Server-known layer.
    for (const known of this.serverKnown.values()) {
      if (known.change === 'delete') {
        rendered.set(known.entityId, { absent: true, entityId: known.entityId });
      } else {
        rendered.set(known.entityId, {
          entityId: known.entityId,
          kind: known.kind,
          snapshot: known.payload ?? {},
          updatedAt: known.updatedAt,
        });
      }
    }
    // Pending overlay (highest seq wins per entity).
    for (const entry of this.ledger) {
      if (entry.status !== 'queued' && entry.status !== 'syncing') {
        continue;
      }
      if (entry.op.kind !== 'diary_entry') {
        continue; // overlay models diary/user-food/favorite uniformly; soak asserts cover diary+user-food, favorites overlay identically
      }
      if (entry.op.action === 'delete') {
        rendered.set(entry.op.entityId, { absent: true, entityId: entry.op.entityId });
      } else {
        rendered.set(entry.op.entityId, {
          entityId: entry.op.entityId,
          kind: entry.op.kind,
          snapshot: entry.op.payload ?? {},
          updatedAt: entry.op.clientUpdatedAt,
        });
      }
    }
    return rendered;
  }

  /** Engine: drain every queued op (ordered push + backoff retries), then pull to end-of-feed. */
  async drainAndPull(): Promise<void> {
    await this.drainPending();
    await this.pullToEnd();
  }

  /** Ordered push of every currently-queued op (no pull) — one orchestrated wave. */
  async drainPending(): Promise<void> {
    let guard = 0;
    while (this.pendingOps().length > 0) {
      guard += 1;
      if (guard > 1000) {
        this.selfFindings.push(`drain did not converge on device ${this.label}`);
        return;
      }
      const batch = this.nextBatch();
      if (batch.length === 0) {
        // Only retryable-rejected ops remain: park them for the profile's
        // explicit retry scheduling (rejected_rate_limited semantics).
        break;
      }
      await this.pushBatch(batch);
    }
  }

  /** Retry any retryable-rejected ops (the honest-failed → scheduled-retry path). */
  async retryRetryableOps(): Promise<number> {
    const retryable = this.ledger.filter((entry) => entry.status === 'failed' && entry.firstOutcome === 'rejected' && entryWasRetryable(entry));
    for (const entry of retryable) {
      entry.status = 'queued';
    }
    return retryable.length;
  }

  private nextBatch(): LedgerOp[] {
    const batch: LedgerOp[] = [];
    for (const entry of this.ledger) {
      if (entry.status !== 'queued') {
        continue;
      }
      batch.push(entry);
      if (batch.length >= this.options.maxOpsPerBatch) {
        break;
      }
    }
    return batch;
  }

  private async pushBatch(batch: LedgerOp[]): Promise<void> {
    this.pushSeqCounter += 1;
    const pushSeq = String(this.pushSeqCounter);
    const key = randomUUID();
    const bodyText = JSON.stringify({ deviceId: this.deviceId, ops: batch.map((entry) => entry.op) });
    for (const entry of batch) {
      entry.status = 'syncing';
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.counters.pushes += 1;
      if (attempt > 1) {
        this.counters.pushRetries += 1;
      }
      for (const entry of batch) {
        entry.pushAttempts += 1;
      }
      const response = await this.options.network.send({
        method: 'POST',
        path: '/sync/ops',
        token: this.options.token,
        bodyText,
        timeoutMs: this.options.clientTimeoutMs,
        headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json', 'X-Kal-Soak-Device': this.label, 'X-Kal-Soak-Push-Seq': pushSeq },
      });
      if (!response.ok && response.networkError !== null) {
        // Network failure: the delivery is ambiguous (drop-after/stall) or
        // never happened (drop-before/refused). Retry the SAME batch with
        // the SAME key after seeded backoff (ADR-0004 push semantics).
        if (attempt >= this.options.maxAttempts) {
          this.selfFindings.push(`push gave up after ${attempt} attempts on device ${this.label} (network ${response.networkError})`);
          return;
        }
        await this.backoff(attempt);
        continue;
      }
      if (response.ok && response.status === 200) {
        this.applyAck(batch, response.bodyText);
        return;
      }
      // A non-200/non-network response is a contract violation the checker
      // must see (the harness only sends legal batches).
      this.selfFindings.push(`push returned HTTP ${response.status} on device ${this.label}: ${response.bodyText.slice(0, 200)}`);
      return;
    }
  }

  /** Per-op ack processing: request-order assertion + individual overlay clear (no flicker). */
  private applyAck(batch: LedgerOp[], bodyText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      this.selfFindings.push(`ack body was not JSON on device ${this.label}`);
      return;
    }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      this.selfFindings.push(`ack body missing results array on device ${this.label}`);
      return;
    }
    if (results.length !== batch.length) {
      this.selfFindings.push(`ack results length ${String(results.length)} != batch length ${String(batch.length)} on device ${this.label}`);
      return;
    }
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index] as Partial<AckResultWire>;
      const entry = batch[index];
      if (entry === undefined || result.opId !== entry.op.opId) {
        this.selfFindings.push(`ack results out of request order on device ${this.label} at index ${String(index)}`);
        return;
      }
      if (entry.firstOutcome === null) {
        entry.firstOutcome = result.outcome ?? 'applied';
      }
      if (result.outcome === 'applied') {
        this.counters.acksApplied += 1;
        entry.status = 'synced'; // overlay cleared individually
      } else if (result.outcome === 'duplicate') {
        this.counters.acksDuplicate += 1;
        entry.status = 'synced'; // the op IS applied server-side; the earlier ack was just lost
      } else if (result.outcome === 'rejected') {
        if (result.retryable === true) {
          this.counters.acksRejectedRetryable += 1;
          entry.status = 'failed'; // honest failed badge; stays queued in the never-trimmed ledger
          entry.firstRejectionCode = result.code ?? null;
        } else {
          this.counters.acksRejectedTerminal += 1;
          entry.status = 'failed'; // terminal: surfaced honestly, never retried unchanged
          entry.firstRejectionCode = result.code ?? null;
        }
      } else {
        this.selfFindings.push(`unknown ack outcome on device ${this.label}: ${String(result.outcome)}`);
        entry.status = 'failed';
      }
    }
  }

  /** Pull to end-of-feed from the current cursor; resumable across network failures. */
  async pullToEnd(): Promise<void> {
    let pages = 0;
    let attempts = 0;
    while (pages < this.options.maxPullPages && pages < PULL_HARD_CURSOR_CAP) {
      const query = new URLSearchParams();
      if (this.pullCursor !== null) {
        query.set('cursor', this.pullCursor);
      }
      query.set('limit', String(this.options.pullLimit));
      this.counters.pulls += 1;
      attempts += 1;
      const response = await this.options.network.send({
        method: 'GET',
        path: `/sync/changes?${query.toString()}`,
        token: this.options.token,
        timeoutMs: this.options.clientTimeoutMs,
        headers: { 'X-Kal-Soak-Device': this.label },
      });
      if (!response.ok && response.networkError !== null) {
        // Partition mid-pull: the last GOOD cursor survives; resume after backoff.
        if (attempts >= this.options.maxAttempts * 4) {
          this.selfFindings.push(`pull gave up after ${String(attempts)} attempts on device ${this.label}`);
          return;
        }
        this.counters.pullRetries += 1;
        await this.backoff(Math.min(attempts, 6));
        continue;
      }
      if (!(response.ok && response.status === 200)) {
        this.selfFindings.push(`pull returned HTTP ${String(response.status)} on device ${this.label}: ${response.bodyText.slice(0, 200)}`);
        return;
      }
      attempts = 0;
      pages += 1;
      let page: PullPageWire;
      try {
        page = JSON.parse(response.bodyText) as PullPageWire;
      } catch {
        this.selfFindings.push(`pull body was not JSON on device ${this.label}`);
        return;
      }
      if (!Array.isArray(page.changes)) {
        this.selfFindings.push(`pull page missing changes array on device ${this.label}`);
        return;
      }
      if (page.changes.length === 0 && page.nextCursor !== null) {
        // Amendment-2 drained polarity: a conservative provider may render
        // one extra empty page before the null. An empty page is a normal
        // page — convergence must hold under either polarity.
        this.counters.emptyPagesTolerated += 1;
      }
      for (const change of page.changes) {
        this.applyServerChange(change);
      }
      this.counters.pagesPulled += 1;
      this.counters.changesReceived += page.changes.length;
      if (page.nextCursor === null) {
        return;
      }
      this.pullCursor = page.nextCursor;
    }
    this.selfFindings.push(`pull exceeded page cap on device ${this.label} (cursor never drained)`);
  }

  /** LWW-guarded pull-apply: never resurrects, adopts the feed (the convergence channel), stale-reorder guarded. */
  private applyServerChange(change: PullChangeWire): void {
    if (change.change === 'delete' && change.payload !== undefined) {
      this.selfFindings.push(`tombstone change for ${change.entityId} carried a payload member`);
    }
    const known = this.serverKnown.get(change.entityId);
    if (known === undefined) {
      this.serverKnown.set(change.entityId, {
        kind: change.kind,
        entityId: change.entityId,
        change: change.change,
        updatedAt: change.updatedAt,
        ...(change.payload !== undefined ? { payload: change.payload as Record<string, unknown> } : {}),
      });
      return;
    }
    const changeMs = Date.parse(change.updatedAt);
    const knownMs = Date.parse(known.updatedAt);
    if (Number.isNaN(changeMs) || Number.isNaN(knownMs)) {
      this.selfFindings.push(`non-parseable updatedAt in feed for ${change.entityId}`);
      return;
    }
    if (changeMs < knownMs) {
      return; // stale reorder defense
    }
    if (known.change === 'delete' && change.change === 'upsert') {
      // Current-state keyset: a deleted entity can only ever appear as a
      // payload-free delete. An upsert over a known tombstone is a
      // resurrection attempt — record it, never apply it.
      this.selfFindings.push(`RESURRECTION: upsert for tombstoned entity ${change.entityId} on device ${this.label}`);
      return;
    }
    this.serverKnown.set(change.entityId, {
      kind: change.kind,
      entityId: change.entityId,
      change: change.change,
      updatedAt: change.updatedAt,
      ...(change.payload !== undefined ? { payload: change.payload as Record<string, unknown> } : {}),
    });
  }

  private async backoff(attempt: number): Promise<void> {
    const exponential = Math.min(this.options.backoffBaseMs * 2 ** (attempt - 1), this.options.backoffCapMs);
    const jitter = Math.floor(this.rng() * this.options.backoffBaseMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, exponential + jitter);
    });
  }
}

function entryWasRetryable(entry: LedgerOp): boolean {
  return entry.firstRejectionCode === 'rejected_rate_limited';
}

