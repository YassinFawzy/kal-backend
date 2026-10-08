/**
 * Kal — w3 soak harness oracle + invariant checker (test/e2e/w3-soak/**).
 *
 * The invariant checker is the release-gate core (task locked invariant
 * "zero dupes / zero losses"): after every profile run it reconciles FOUR
 * independent views of the world and fails loudly on any divergence:
 *
 *   1. the ORACLE — an independent transcription of the frozen contract
 *      state machine (§1.3 apply semantics, §1.4 LWW + tiebreak, §1.5
 *      tombstones, §1.2 dedupe/replay), replayed over the SERVER-ARRIVAL
 *      order the fault proxy recorded. The oracle deliberately does NOT
 *      import the implementation it audits;
 *   2. the SERVER — a full bootstrap census of the current-state delta feed
 *      (the no-resurrection census: every entity exactly once, tombstones
 *      payload-free) plus direct database evidence (sync_operations rows,
 *      entity row counts, diary-day rollups);
 *   3. the DEVICES — each emulated device's rendered merged view at rest;
 *   4. the ACKS — device ledgers (every enqueued op acked; ordering
 *      preserved; replays never re-applied).
 *
 * A false green here is the most expensive failure mode the wave has, so
 * every check names itself and every violation is collected, never swallowed.
 */
import { randomUUID } from 'node:crypto';
import type { EmulatedDevice, PullChangeWire } from './device.js';
import { isoInstant, lwwWins, type SoakOp } from './support.js';

// ---------------------------------------------------------------------------
// The oracle (independent contract transcription)
// ---------------------------------------------------------------------------

export type OracleStatus = 'absent' | 'live' | 'deleted';

export interface OracleEntity {
  kind: SoakOp['kind'];
  status: OracleStatus;
  snapshot: Record<string, unknown> | null;
  updatedAtMs: number;
  lastOpId: string | null;
}

export type OracleOutcome = 'applied' | 'duplicate' | { rejected: string };

export interface ExpectedRejection {
  readonly opId: string;
  readonly code: string;
}

export class SyncOracle {
  readonly entities = new Map<string, OracleEntity>();
  /** ops the server has seen (first server arrival), in arrival order. */
  readonly processedOpIds: string[] = [];
  /** recorded sync_operations rows the oracle expects: opId -> outcome/code. */
  readonly recordedRows = new Map<string, 'applied' | 'rejected_validation' | 'rejected_conflict' | 'rejected_deleted'>();
  /** acked-but-NOT-recorded ops (rejected_rate_limited — §1.7 directed resolution). */
  readonly ackedNotRecorded = new Set<string>();

  /** Apply one op per the frozen state machine (contract §1.3/§1.4/§1.5). */
  apply(op: SoakOp): OracleOutcome {
    const updatedAtMs = Date.parse(op.clientUpdatedAt);
    if (this.processedOpIds.includes(op.opId)) {
      // Per-op dedupe (I9): a replayed op is acknowledged, never re-applied;
      // the recorded outcome replays.
      const recorded = this.recordedRows.get(op.opId);
      if (recorded === 'applied') {
        return 'duplicate';
      }
      if (recorded !== undefined) {
        return { rejected: recorded };
      }
      return 'duplicate'; // acked-not-recorded replays re-run the handler; outcome equivalence is checked live, not re-derived here
    }
    this.processedOpIds.push(op.opId);
    const entity = this.entities.get(op.entityId) ?? null;
    if (op.action === 'create') {
      if (entity !== null && entity.status === 'live') {
        this.recordedRows.set(op.opId, 'rejected_conflict');
        return { rejected: 'rejected_conflict' };
      }
      if (entity !== null && entity.status === 'deleted') {
        // Same-entity-ID create after delete is blocked — no resurrection (I9).
        this.recordedRows.set(op.opId, 'rejected_deleted');
        return { rejected: 'rejected_deleted' };
      }
      this.entities.set(op.entityId, { kind: op.kind, status: 'live', snapshot: op.payload ?? null, updatedAtMs, lastOpId: op.opId });
      this.recordedRows.set(op.opId, 'applied');
      return 'applied';
    }
    if (op.action === 'update') {
      if (entity === null || entity.status === 'absent') {
        this.recordedRows.set(op.opId, 'rejected_conflict');
        return { rejected: 'rejected_conflict' };
      }
      if (entity.status === 'deleted') {
        // An update never undeletes (§1.5), regardless of timestamps.
        this.recordedRows.set(op.opId, 'rejected_deleted');
        return { rejected: 'rejected_deleted' };
      }
      const row = { updatedAtMs: entity.updatedAtMs, opId: entity.lastOpId ?? '' };
      const opComparator = { updatedAtMs, opId: op.opId };
      if (entity.lastOpId === null || lwwWins(opComparator, row)) {
        entity.status = 'live';
        entity.snapshot = op.payload ?? null;
        entity.updatedAtMs = updatedAtMs;
        entity.lastOpId = op.opId;
      }
      // A loser is recorded applied and changes nothing — the delta feed is
      // the convergence channel (§1.4).
      this.recordedRows.set(op.opId, 'applied');
      return 'applied';
    }
    // delete
    if (entity !== null && entity.status === 'live') {
      entity.status = 'deleted';
      entity.snapshot = null;
      entity.updatedAtMs = updatedAtMs;
      entity.lastOpId = op.opId;
      this.recordedRows.set(op.opId, 'applied');
      return 'applied';
    }
    // delete of tombstoned or absent row: idempotent — nothing written but the op is recorded.
    this.recordedRows.set(op.opId, 'applied');
    return 'applied';
  }

  /** Live (non-deleted) entities of one kind. */
  liveOfKind(kind: SoakOp['kind']): Array<{ entityId: string; snapshot: Record<string, unknown>; updatedAtMs: number }> {
    const out: Array<{ entityId: string; snapshot: Record<string, unknown>; updatedAtMs: number }> = [];
    for (const [entityId, entity] of this.entities) {
      if (entity.kind === kind && entity.status === 'live' && entity.snapshot !== null) {
        out.push({ entityId, snapshot: entity.snapshot, updatedAtMs: entity.updatedAtMs });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Independent HTTP observer (the census/day-read client — zero faults, direct to the app)
// ---------------------------------------------------------------------------

export interface DayTotalsWire {
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly entryCount: number;
}

export interface DayViewWire {
  readonly localDate: string;
  readonly totals: DayTotalsWire;
  readonly entries: ReadonlyArray<Record<string, unknown>>;
}

export class ObserverClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async fetchJson(token: string, path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }

  /** Full bootstrap census of the current-state feed (walks every page to `nextCursor: null`). */
  async censusFeed(token: string, limit = 50): Promise<{ changes: PullChangeWire[]; emptyPages: number; findings: string[] }> {
    const changes: PullChangeWire[] = [];
    const seenOnce = new Set<string>();
    const findings: string[] = [];
    let cursor: string | null = null;
    let emptyPages = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 1000) {
        findings.push('census: cursor never drained within guard');
        break;
      }
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) {
        query.set('cursor', cursor);
      }
      const { status, body } = await this.fetchJson(token, `/sync/changes?${query.toString()}`);
      if (status !== 200) {
        findings.push(`census page returned HTTP ${String(status)}`);
        break;
      }
      const page = body as { changes?: PullChangeWire[]; nextCursor?: string | null };
      if (!Array.isArray(page.changes)) {
        findings.push('census page missing changes array');
        break;
      }
      if (page.changes.length === 0 && page.nextCursor !== null) {
        // Amendment-2 drained polarity: a conservative provider may render one
        // extra empty page before the null — a normal page, never an error.
        emptyPages += 1;
      }
      for (const change of page.changes) {
        if (seenOnce.has(change.entityId)) {
          findings.push(`census: entity ${change.entityId} appeared more than once in the current-state feed`);
        }
        seenOnce.add(change.entityId);
        if (change.change === 'delete' && change.payload !== undefined) {
          findings.push(`census: tombstone for ${change.entityId} carries a payload member`);
        }
        if (change.change === 'upsert' && change.payload === undefined) {
          findings.push(`census: upsert for ${change.entityId} has no payload`);
        }
        changes.push(change);
      }
      if (page.nextCursor === null || page.nextCursor === undefined) {
        break;
      }
      cursor = page.nextCursor;
    }
    return { changes, emptyPages, findings };
  }

  async readDay(token: string, localDate: string): Promise<DayViewWire | { error: string }> {
    const { status, body } = await this.fetchJson(token, `/tracking/diary/days/${localDate}`);
    if (status !== 200) {
      return { error: `day read returned HTTP ${String(status)} for ${localDate}` };
    }
    return body as DayViewWire;
  }

  /** Direct (fault-free) batch push — used for oracle-probe replays and fresh-key duplicate deliveries. */
  async pushOps(token: string, deviceId: string, ops: ReadonlyArray<object>): Promise<Array<{ readonly opId: string; readonly outcome: string; readonly code?: string; readonly retryable?: boolean }>> {
    const response = await fetch(`${this.baseUrl}/sync/ops`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, ops }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: unknown = await response.json();
    const results = (body as { results?: Array<{ opId: string; outcome: string; code?: string; retryable?: boolean }> }).results ?? [];
    return results;
  }
}

// ---------------------------------------------------------------------------
// The invariant checker
// ---------------------------------------------------------------------------

export interface SoakUserProfile {
  readonly label: string;
  readonly userId: string;
  readonly token: string;
  readonly devices: EmulatedDevice[];
  readonly oracle: SyncOracle;
  /** Accumulated by the runner's oracle replay over the recorded server-arrival order. */
  expectedRejections: ExpectedRejection[];
}

export interface DatabaseProbe {
  query<R extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface ProfileReportRow {
  readonly profile: string;
  readonly users: number;
  readonly devices: number;
  readonly opsEnqueued: number;
  readonly acksApplied: number;
  readonly acksDuplicate: number;
  readonly acksRejectedTerminal: number;
  readonly faultsDropsBefore: number;
  readonly faultsDropsAfter: number;
  readonly faultsStalls: number;
  readonly faultsRefused: number;
  readonly faultsDuplicates: number;
  readonly byteIdenticalReplays: number;
  readonly pushRetries: number;
  readonly pullRetries: number;
  readonly pagesPulled: number;
  readonly changesReceived: number;
  readonly emptyPagesTolerated: number;
  readonly censusChanges: number;
  readonly checks: number;
  readonly violations: number;
  readonly runtimeMs: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function payloadMatches(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Kind-aware snapshot comparison. Diary snapshots round-trip verbatim.
 * User-food delta payloads are the server's full projection
 * (`projectUserFood`); the oracle compares the CLIENT-AUTHORED subset
 * (names, macros, and per-serving label/grams — the state machinery
 * guarantees these verbatim) and treats server-generated fields (id, type,
 * provenance, licensePartition, createdAt/updatedAt, serving ids) as
 * opaque. The servings member was the F-S4B-1 gap (sync create dropped it
 * until supervisor amendment 3 @ 7ddc3fc) — the soak now pins it as a
 * full client-authored fidelity requirement.
 */
function snapshotMatches(kind: string, feedPayload: unknown, oracleSnapshot: unknown): boolean {
  if (kind !== 'user_food') {
    return payloadMatches(feedPayload, oracleSnapshot);
  }
  const feed = feedPayload as Record<string, unknown> | null;
  const expected = oracleSnapshot as Record<string, unknown> | null;
  if (feed === null || expected === null) {
    return feed === expected;
  }
  const clientView = (snapshot: Record<string, unknown>): Record<string, unknown> => ({
    nameEn: snapshot['nameEn'] ?? null,
    nameAr: snapshot['nameAr'] ?? null,
    energyKcal: snapshot['energyKcal'],
    proteinG: snapshot['proteinG'],
    carbsG: snapshot['carbsG'],
    fatG: snapshot['fatG'],
    servings: Array.isArray(snapshot['servings'])
      ? (snapshot['servings'] as Array<Record<string, unknown>>).map((serving) => ({
          labelEn: serving['labelEn'] ?? null,
          labelAr: serving['labelAr'] ?? null,
          grams: serving['grams'],
        }))
      : [],
  });
  return payloadMatches(clientView(feed), clientView(expected));
}

export class InvariantChecker {
  readonly checks: CheckResult[] = [];
  readonly violations: string[] = [];
  /** Recorded contract-divergence findings (reported, never fixed in this lane; routed via the MR findings register). */
  readonly findings: string[] = [];
  /** Total changes seen across all census walks this profile (evidence counter). */
  censusChangesTotal = 0;

  private check(name: string, pass: boolean, detail: string): void {
    this.checks.push({ name, pass, detail });
    if (!pass) {
      this.violations.push(`${name}: ${detail}`);
    }
  }

  /** A named scenario assertion (e.g. three-meals-one-edit, sub-ms LWW golden) recorded as evidence alongside the invariant checks. */
  scenario(name: string, pass: boolean, detail: string): void {
    this.check(name, pass, detail);
  }

  /** Records an observed contract-divergence finding WITHOUT failing the gate criteria (dupes/losses/convergence) — the finding is reported, never masked. */
  finding(text: string): void {
    this.findings.push(text);
  }

  async runProfile(input: {
    readonly profileName: string;
    readonly users: readonly SoakUserProfile[];
    readonly db: DatabaseProbe;
    readonly observer: ObserverClient;
    readonly proxyFindings: readonly string[];
    readonly touchedDates: (user: SoakUserProfile) => readonly string[];
    readonly deletedDates?: (user: SoakUserProfile) => readonly string[];
  }): Promise<void> {
    for (const finding of input.proxyFindings) {
      this.violations.push(`proxy: ${finding}`);
    }
    this.check('proxy-clean', input.proxyFindings.length === 0, `${String(input.proxyFindings.length)} proxy findings`);

    for (const user of input.users) {
      await this.checkUser(user, input);
    }
  }

  private async checkUser(user: SoakUserProfile, input: { readonly profileName: string; readonly db: DatabaseProbe; readonly observer: ObserverClient; readonly touchedDates: (user: SoakUserProfile) => readonly string[]; readonly deletedDates?: (user: SoakUserProfile) => readonly string[] }): Promise<void> {
    const tag = `[${input.profileName}/${user.label}]`;

    // -- 4a. Device self-findings (ordering, ack-shape, resurrection guard).
    for (const device of user.devices) {
      for (const finding of device.selfFindings) {
        this.violations.push(`${tag}/device-${device.label}: ${finding}`);
      }
    }
    const deviceFindings = user.devices.reduce((count, device) => count + device.selfFindings.length, 0);
    this.check(`${tag} device-self-findings`, deviceFindings === 0, `${String(deviceFindings)} device findings`);

    // -- 1. Ledger durability (zero losses): every enqueued op reached an
    // ack; no op left queued/syncing; terminal states only where declared.
    let enqueued = 0;
    let unsettled = 0;
    let unexpectedFailures = 0;
    const declaredRejections = new Map(user.expectedRejections.map((rejection) => [rejection.opId, rejection.code]));
    for (const device of user.devices) {
      for (const ledgerEntry of device.ledger) {
        enqueued += 1;
        if (ledgerEntry.status === 'queued' || ledgerEntry.status === 'syncing') {
          unsettled += 1;
        }
        if (ledgerEntry.status === 'failed') {
          const declared = declaredRejections.get(ledgerEntry.op.opId);
          if (declared === undefined || ledgerEntry.firstRejectionCode !== declared) {
            unexpectedFailures += 1;
          }
        }
      }
    }
    this.check(`${tag} ledger-durability`, unsettled === 0, `${String(unsettled)} of ${String(enqueued)} ops never reached an ack (zero-losses gate)`);
    this.check(`${tag} declared-rejections-only`, unexpectedFailures === 0, `${String(unexpectedFailures)} unexpected failed ops`);

    // -- 4b. Ack ordering per batch is asserted inside the device; here we
    // additionally verify every declared rejection was ACKED as rejected
    // with exactly the declared code (honest failed surface).
    let ackOutcomeErrors = 0;
    for (const device of user.devices) {
      for (const ledgerEntry of device.ledger) {
        const declared = declaredRejections.get(ledgerEntry.op.opId);
        if (declared !== undefined && (ledgerEntry.firstOutcome !== 'rejected' || ledgerEntry.firstRejectionCode !== declared)) {
          ackOutcomeErrors += 1;
        }
      }
    }
    this.check(`${tag} ack-outcomes`, ackOutcomeErrors === 0, `${String(ackOutcomeErrors)} acks contradicted the declared per-op outcomes`);

    // -- 2a. sync_operations exactness (DB evidence: no duplicate effects).
    const ledgerRows = await input.db.query<{ client_op_id: string; outcome: string; rejection_code: string | null }>(
      `SELECT client_op_id, outcome::text, NULLIF(rejection_code::text, '') AS rejection_code FROM sync_operations WHERE user_id = $1`,
      [user.userId],
    );
    const expectedRows = new Map<string, string>();
    for (const [opId, outcome] of user.oracle.recordedRows) {
      expectedRows.set(opId, outcome);
    }
    let ledgerMismatch = 0;
    const seenLedgerOps = new Set<string>();
    for (const row of ledgerRows.rows) {
      seenLedgerOps.add(row.client_op_id);
      const expected = expectedRows.get(row.client_op_id);
      if (expected === undefined) {
        ledgerMismatch += 1; // a row the oracle never recorded — phantom apply
        continue;
      }
      if (expected === 'applied' && row.outcome !== 'applied') {
        ledgerMismatch += 1;
      }
      if (expected !== 'applied' && row.rejection_code !== expected) {
        ledgerMismatch += 1;
      }
    }
    for (const opId of expectedRows.keys()) {
      if (!seenLedgerOps.has(opId)) {
        ledgerMismatch += 1; // expected recorded op missing
      }
    }
    this.check(
      `${tag} sync-operations-exact`,
      ledgerMismatch === 0,
      `${String(ledgerRows.rows.length)} ledger rows vs ${String(expectedRows.size)} oracle-recorded ops, ${String(ledgerMismatch)} mismatches`,
    );

    // -- 3. Feed census (current-state keyset): every entity exactly once;
    // live upserts carry the oracle snapshot; tombstones payload-free.
    const census = await input.observer.censusFeed(user.token);
    this.censusChangesTotal += census.changes.length;
    for (const finding of census.findings) {
      this.violations.push(`${tag}/${finding}`);
    }
    const oracleById = user.oracle.entities;
    let censusMismatch = 0;
    if (census.changes.length !== oracleById.size) {
      censusMismatch += 1;
      this.violations.push(`${tag} census size ${String(census.changes.length)} != oracle entities ${String(oracleById.size)}`);
    }
    for (const change of census.changes) {
      const expected = oracleById.get(change.entityId);
      if (expected === undefined) {
        censusMismatch += 1;
        continue;
      }
      if (expected.status === 'deleted') {
        if (change.change !== 'delete') {
          censusMismatch += 1;
          this.violations.push(`${tag} deleted entity ${change.entityId} served as ${change.change} (no-resurrection census)`);
        }
        continue;
      }
      if (expected.status === 'absent') {
        censusMismatch += 1;
        this.violations.push(`${tag} never-created entity ${change.entityId} appeared in the feed as ${change.change}`);
        continue;
      }
      if (change.change !== 'upsert' || !snapshotMatches(expected.kind, change.payload, expected.snapshot)) {
        censusMismatch += 1;
        this.violations.push(`${tag} live entity ${change.entityId} payload mismatch in feed: feed=${JSON.stringify(change.payload)?.slice(0, 700)} oracle=${JSON.stringify(expected.snapshot)?.slice(0, 700)}`);
        continue;
      }
      if (change.updatedAt !== isoInstant(expected.updatedAtMs)) {
        censusMismatch += 1;
        this.violations.push(`${tag} live entity ${change.entityId} updatedAt ${change.updatedAt} != oracle ${isoInstant(expected.updatedAtMs)}`);
      }
    }
    this.check(`${tag} feed-census`, censusMismatch === 0, `${String(census.changes.length)} changes, ${String(census.emptyPages)} empty pages tolerated, ${String(censusMismatch)} mismatches`);

    // -- 4c. Device convergence: every device's rendered merged view equals
    // the oracle state exactly (multi-device convergence, no third state).
    let convergenceMismatch = 0;
    for (const device of user.devices) {
      const rendered = device.renderedView();
      if (rendered.size !== oracleById.size) {
        convergenceMismatch += 1;
        this.violations.push(`${tag}/device-${device.label} rendered ${String(rendered.size)} entities vs oracle ${String(oracleById.size)}`);
        continue;
      }
      for (const [entityId, expected] of oracleById) {
        const view = rendered.get(entityId);
        if (expected.status !== 'live') {
          if (view === undefined || !('absent' in view)) {
            convergenceMismatch += 1;
            this.violations.push(`${tag}/device-${device.label} renders ${entityId} as present but oracle says ${expected.status} (resurrection/no-durability)`);
          }
          continue;
        }
        if (view === undefined || 'absent' in view) {
          convergenceMismatch += 1;
          this.violations.push(`${tag}/device-${device.label} lost acknowledged entity ${entityId} (acknowledged-write loss)`);
          continue;
        }
        if (!snapshotMatches(expected.kind, view.snapshot, expected.snapshot)) {
          convergenceMismatch += 1;
          this.violations.push(`${tag}/device-${device.label} entity ${entityId} snapshot diverged (third state?): view=${JSON.stringify(view.snapshot)?.slice(0, 160)} oracle=${JSON.stringify(expected.snapshot)?.slice(0, 160)}`);
        }
      }
    }
    this.check(`${tag} device-convergence`, convergenceMismatch === 0, `${String(convergenceMismatch)} divergences across ${String(user.devices.length)} devices`);

    // -- 2b. Entity row counts (DB: exactly one row per entity; no orphans).
    const diaryRows = await input.db.query<{ id: string; deleted: boolean }>(
      `SELECT id::text, (deleted_at IS NOT NULL) AS deleted FROM diary_entries WHERE user_id = $1`,
      [user.userId],
    );
    const diaryOracle = new Map([...oracleById].filter(([, entity]) => entity.kind === 'diary_entry'));
    let rowCountMismatch = Math.abs(diaryRows.rows.length - diaryOracle.size);
    const seenDiaryRows = new Set<string>();
    for (const row of diaryRows.rows) {
      if (seenDiaryRows.has(row.id)) {
        rowCountMismatch += 1; // duplicate row for one entity — a second effect
      }
      seenDiaryRows.add(row.id);
      const expected = diaryOracle.get(row.id);
      if (expected === undefined) {
        rowCountMismatch += 1;
        continue;
      }
      if ((expected.status === 'deleted') !== row.deleted) {
        rowCountMismatch += 1;
      }
    }
    for (const entityId of diaryOracle.keys()) {
      if (!seenDiaryRows.has(entityId)) {
        rowCountMismatch += 1;
      }
    }
    this.check(`${tag} diary-row-exactness`, rowCountMismatch === 0, `${String(diaryRows.rows.length)} rows vs ${String(diaryOracle.size)} oracle diary entities, ${String(rowCountMismatch)} mismatches`);

    // -- 6. Diary-day rollups: day-read totals equal oracle sums; the
    // diary_days row equals the day-read (recompute-after-delete included).
    let rollupMismatch = 0;
    const touched = new Set<string>([...input.touchedDates(user), ...(input.deletedDates?.(user) ?? [])]);
    for (const localDate of touched) {
      const expectedEntries = user.oracle.liveOfKind('diary_entry').filter((entry) => (entry.snapshot as { localDate?: unknown }).localDate === localDate);
      let kcal = 0;
      let protein = 0;
      let carbs = 0;
      let fat = 0;
      for (const entry of expectedEntries) {
        const snapshot = entry.snapshot as Record<string, number>;
        kcal += snapshot['energyKcal'] ?? 0;
        protein += snapshot['proteinG'] ?? 0;
        carbs += snapshot['carbsG'] ?? 0;
        fat += snapshot['fatG'] ?? 0;
      }
      const view = await input.observer.readDay(user.token, localDate);
      if ('error' in view) {
        rollupMismatch += 1;
        this.violations.push(`${tag} ${view.error}`);
        continue;
      }
      const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
      if (
        !near(view.totals.energyKcal, kcal) ||
        !near(view.totals.proteinG, protein) ||
        !near(view.totals.carbsG, carbs) ||
        !near(view.totals.fatG, fat) ||
        view.totals.entryCount !== expectedEntries.length
      ) {
        rollupMismatch += 1;
        this.violations.push(`${tag} day ${localDate} totals mismatch: got ${JSON.stringify(view.totals)} expected kcal=${String(kcal)} count=${String(expectedEntries.length)}`);
      }
      const dayRows = await input.db.query<{ energy_kcal: string; entry_count: number }>(
        `SELECT energy_kcal::text, entry_count FROM diary_days WHERE user_id = $1 AND local_date = $2::date`,
        [user.userId, localDate],
      );
      if (expectedEntries.length === 0) {
        if (dayRows.rows.length > 0 && dayRows.rows[0] !== undefined && dayRows.rows[0].entry_count !== 0) {
          rollupMismatch += 1;
          this.violations.push(`${tag} day ${localDate} should have an empty rollup, got ${JSON.stringify(dayRows.rows[0])}`);
        }
      } else {
        const row = dayRows.rows[0];
        if (row === undefined || !near(Number(row.energy_kcal), kcal) || row.entry_count !== expectedEntries.length) {
          rollupMismatch += 1;
          this.violations.push(`${tag} diary_days row for ${localDate} diverges from the day read`);
        }
      }
    }
    this.check(`${tag} diary-rollups`, rollupMismatch === 0, `${String(touched.size)} days checked, ${String(rollupMismatch)} mismatches`);
  }
}
