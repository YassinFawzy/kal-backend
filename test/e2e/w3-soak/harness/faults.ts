/**
 * Kal — w3 soak harness fault-injection layer (test/e2e/w3-soak/**).
 *
 * Network faults are injected at the HTTP BOUNDARY ONLY (task locked
 * invariant): the emulated devices speak to a tiny local forward proxy and
 * never to server internals. The proxy forwards real bytes to the live
 * AppModule listener and can inject exactly the flaky-network shapes the
 * release gate names:
 *
 *   - `drop-before`  — the connection dies before the request reaches the
 *     server (the server never sees the request);
 *   - `drop-after`   — the request is fully forwarded and applied, then the
 *     response is destroyed in flight (the server APPLIED; the client saw a
 *     network error — the ambiguous-delivery case idempotent replay exists
 *     for);
 *   - `stall`        — the response is held past the client timeout (the
 *     server applied; the client aborts and retries);
 *   - partition      — every connection is refused until the gate lifts;
 *   - duplicate      — the SAME request bytes are forwarded twice
 *     sequentially (a genuine duplicate delivery; the second response must
 *     be the byte-identical recorded replay).
 *
 * Nothing here fakes server behavior: every byte the server ever sees is a
 * real request the harness would have sent anyway.
 */
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FaultMatcherInput {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
}

export type FaultSpec =
  | { readonly type: 'drop-before' }
  | { readonly type: 'drop-after' }
  | { readonly type: 'stall'; readonly holdMs: number }
  | { readonly type: 'duplicate' };

export interface RecordedRequest {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  /** opIds in request-array order for POST /sync/ops (the server-arrival order evidence). */
  readonly opIds: readonly string[];
  readonly deviceId: string | null;
  readonly bodyHash: string;
  readonly fault: FaultSpec | null;
  /** Whether the request bytes actually reached the server (forwarded). */
  readonly forwarded: boolean;
  /** Whether a response was relayed to the client. */
  readonly delivered: boolean;
  readonly status: number | null;
}

export interface FaultProxyOptions {
  /** Where the live app listener is. */
  readonly targetPort: number;
  readonly targetHost: string;
}

export class FaultProxy {
  private readonly server: Server;
  private seq = 0;
  private oneShots: Array<{ readonly matches: (req: FaultMatcherInput) => boolean; readonly fault: FaultSpec }> = [];
  private refuseRemaining = 0;
  private readonly refuseAtSeqs = new Set<number>();
  readonly requests: RecordedRequest[] = [];
  readonly findings: string[] = [];
  /** Recorded response bytes per (endpoint, Idempotency-Key) — replay-equivalence evidence. */
  private readonly keyResponses = new Map<string, { readonly bodyHash: string; readonly body: string; readonly status: number }>();
  readonly counters = {
    forwarded: 0,
    refused: 0,
    dropsBefore: 0,
    dropsAfter: 0,
    stalls: 0,
    duplicatesForwarded: 0,
    byteIdenticalReplays: 0,
  };

  constructor(private readonly options: FaultProxyOptions) {
    this.server = createServer((clientReq, clientRes) => {
      this.handle(clientReq, clientRes).catch((error: unknown) => {
        this.findings.push(`proxy handler error: ${String(error)}`);
        clientRes.destroy();
      });
    });
  }

  /** Listen on an ephemeral loopback port. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fault proxy not listening on a tcp port');
    }
    return address.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Script a one-shot fault on the NEXT request matching the predicate (header names lowercased, e.g. `x-kal-soak-push-seq`). */
  injectOnce(matches: (req: FaultMatcherInput) => boolean, fault: FaultSpec): void {
    this.oneShots = [...this.oneShots, { matches, fault }];
  }

  /** Network partition: refuse the next `n` connection attempts, then auto-lift. */
  refuseNext(n: number): void {
    this.refuseRemaining += n;
  }

  /** Network partition at exact upcoming request positions (deterministic mid-pull partitions). */
  refuseAtSeq(seq: number): void {
    this.refuseAtSeqs.add(seq);
  }

  /** The seq the NEXT request will carry (deterministic scripting for single-active-device phases). */
  get nextSeq(): number {
    return this.seq + 1;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  // -------------------------------------------------------------------------

  private async handle(clientReq: IncomingMessage, clientRes: ServerResponse): Promise<void> {
    const seq = ++this.seq;
    const chunks: Buffer[] = [];
    for await (const chunk of clientReq) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    const path = clientReq.url ?? '/';
    const method = (clientReq.method ?? 'GET').toUpperCase();
    const idempotencyKey = clientReq.headers['idempotency-key'] === undefined ? null : String(clientReq.headers['idempotency-key']);
    const deviceId = clientReq.headers['x-kal-soak-device'] === undefined ? null : String(clientReq.headers['x-kal-soak-device']);
    const opIds = method === 'POST' && path.startsWith('/sync/ops') ? parseOpIds(body) : [];

    // Partition: refuse at the boundary (connection reset — the request never reaches the server).
    if (this.refuseRemaining > 0 || this.refuseAtSeqs.has(seq)) {
      this.refuseAtSeqs.delete(seq);
      if (this.refuseRemaining > 0) {
        this.refuseRemaining -= 1;
      }
      this.counters.refused += 1;
      this.requests.push({ seq, method, path, idempotencyKey, opIds, deviceId, bodyHash: hash(body), fault: null, forwarded: false, delivered: false, status: null });
      clientRes.destroy();
      return;
    }

    const lowerHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(clientReq.headers)) {
      if (typeof value === 'string') {
        lowerHeaders[name] = value;
      }
    }
    const oneShotIndex = this.oneShots.findIndex((oneShot) => oneShot.matches({ method, path, headers: lowerHeaders }));
    const fault = oneShotIndex === -1 ? null : this.oneShots[oneShotIndex]?.fault ?? null;
    if (oneShotIndex !== -1) {
      this.oneShots = this.oneShots.filter((_, index) => index !== oneShotIndex);
    }

    const record = { seq, method, path, idempotencyKey, opIds, deviceId, bodyHash: hash(body), fault, forwarded: false, delivered: false, status: null as number | null };
    this.requests.push(record);

    if (fault?.type === 'drop-before') {
      this.counters.dropsBefore += 1;
      clientRes.destroy();
      return;
    }

    // Forward the real bytes to the live app.
    const upstream = await this.forward(method, path, clientReq.headers, body);
    record.forwarded = true;
    this.counters.forwarded += 1;

    // Idempotency-Key replay equivalence (conventions §3 / contract §1.2):
    // the same (endpoint, key) + same body must replay the recorded response
    // BYTE-identically. A changed body under a reused key is a 409 — the
    // harness never mutates payloads under a key, so any 409 is a violation.
    if (method === 'POST' && idempotencyKey !== null) {
      const keyRecord = { key: idempotencyKey, bodyHash: hash(body) };
      const prior = this.keyResponses.get(replayKey(keyRecord.key, path));
      if (prior === undefined) {
        this.keyResponses.set(replayKey(keyRecord.key, path), { bodyHash: hash(upstream.body), body: upstream.body, status: upstream.status });
      } else {
        if (prior.bodyHash !== hash(upstream.body) || prior.status !== upstream.status) {
          this.findings.push(
            `idempotency replay drift on key ${keyRecord.key}: first ${prior.status}/${prior.bodyHash.slice(0, 8)} then ${upstream.status}/${hash(upstream.body).slice(0, 8)}`,
          );
        } else {
          this.counters.byteIdenticalReplays += 1;
        }
      }
      if (upstream.status === 409) {
        this.findings.push(`unexpected 409 CONFLICT under reused key ${keyRecord.key} (harness never mutates a batch under its key)`);
      }
    }

    if (fault?.type === 'drop-after') {
      this.counters.dropsAfter += 1;
      record.status = upstream.status;
      clientRes.destroy(); // server applied; response destroyed in flight
      return;
    }

    if (fault?.type === 'stall') {
      this.counters.stalls += 1;
      record.status = upstream.status;
      await sleepInternal(fault.holdMs);
      if (clientRes.destroyed) {
        return; // client already timed out
      }
    }

    if (fault?.type === 'duplicate') {
      this.counters.duplicatesForwarded += 1;
      const second = await this.forward(method, path, clientReq.headers, body);
      this.counters.forwarded += 1;
      if (second.body !== upstream.body || second.status !== upstream.status) {
        this.findings.push(`duplicate delivery diverged: first ${upstream.status}/${hash(upstream.body).slice(0, 8)} second ${second.status}/${hash(second.body).slice(0, 8)}`);
      } else {
        this.counters.byteIdenticalReplays += 1;
      }
    }

    record.delivered = true;
    record.status = upstream.status;
    clientRes.writeHead(upstream.status, upstream.headers);
    clientRes.end(upstream.body);
  }

  private async forward(
    method: string,
    path: string,
    headers: IncomingMessage['headers'],
    body: Buffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return await new Promise((resolve, reject) => {
      const forwardHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'string') {
          forwardHeaders[name] = value;
        } else if (Array.isArray(value)) {
          forwardHeaders[name] = value.join(', ');
        }
      }
      delete forwardHeaders['connection'];
      delete forwardHeaders['transfer-encoding'];
      const upstreamReq = httpRequest(
        {
          host: this.options.targetHost,
          port: this.options.targetPort,
          method,
          path,
          headers: { ...forwardHeaders, 'content-length': String(body.length) },
        },
        (upstreamRes) => {
          const responseChunks: Buffer[] = [];
          upstreamRes.on('data', (chunk: Buffer) => {
            responseChunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (typeof value === 'string') {
                responseHeaders[name] = value;
              } else if (Array.isArray(value)) {
                responseHeaders[name] = value.join(', ');
              }
            }
            delete responseHeaders['transfer-encoding'];
            resolve({ status: upstreamRes.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(responseChunks).toString('utf8') });
          });
          upstreamRes.on('error', reject);
        },
      );
      upstreamReq.on('error', reject);
      upstreamReq.end(body);
    });
  }
}

function replayKey(key: string, path: string): string {
  // conventions §3: the key scopes to (user, endpoint, key); the bearer
  // distinguishes users and the path the endpoint — enough for replay
  // bookkeeping here.
  return `${path}|${key}`;
}

function hash(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseOpIds(body: Buffer): string[] {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'ops' in parsed) {
      const ops = (parsed as { ops: unknown }).ops;
      if (Array.isArray(ops)) {
        return ops
          .map((op) => (typeof op === 'object' && op !== null && 'opId' in op ? String((op as { opId: unknown }).opId) : ''))
          .filter((opId) => opId.length > 0);
      }
    }
  } catch {
    // Malformed probe bodies are legal harness traffic; no opIds to record.
  }
  return [];
}

function sleepInternal(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
