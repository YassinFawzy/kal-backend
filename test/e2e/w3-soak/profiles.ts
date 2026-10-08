/**
 * Kal — w3 soak harness profile definitions (test/e2e/w3-soak/**).
 *
 * The six release-gate profiles (task contract "Required cases") plus the
 * embedded scenario asserts: three-meals-one-edit under the drop profile;
 * delete-then-edit converging to a tombstone; pull-after-tombstone never
 * resurrects; per-device ordering preserved on reconnect; and the SUB-MS
 * LWW golden — a pair differing ONLY below the millisecond decides on the
 * frozen `(clientUpdatedAt, opId)` tiebreak, so ms-truncation never
 * silently flips a winner.
 *
 * Profiles are DETERMINISTIC: faults are scripted at exact request
 * positions (counting predicates / seq positions), all fixtures derive
 * from fixed constants, and no assertion depends on which side of an
 * ambiguous delivery won — idempotency must hold under either.
 *
 * Cross-device arrival ORDER is orchestrated in explicit waves (each wave:
 * the named devices push every queued op in ledger order) so every
 * create/update dependency is deterministic — the oracle replays the
 * server-arrival order the proxy recorded.
 */
import { SEED_FOODS } from '../../../prisma/seed-manifest.ts';
import type { EmulatedDevice, NetworkAdapter } from './harness/device.js';
import type { DatabaseProbe, ExpectedRejection, InvariantChecker, ObserverClient, SoakUserProfile } from './harness/invariants.js';
import type { FaultProxy } from './harness/faults.js';
import { diaryDeleteOp, diaryOp, favoriteOp, isoInstant, userFoodOp, userFoodSnapshot, type SoakOp } from './harness/support.js';

const FOOD_FUL = SEED_FOODS[0]?.id ?? '';
const FOOD_TAAMEYA = SEED_FOODS[1]?.id ?? '';
const FOOD_KOSHARI = SEED_FOODS[2]?.id ?? '';

/** Deterministic client-generated uuid (v4-shaped, fixture range). */
function fixedUuid(seed: string, index: number): string {
  return `5bef0000-0000-4000-8000-${seed.slice(0, 8).padEnd(8, '0')}${(index % 0xffff).toString(16).padStart(4, '0')}`;
}

/** Monotonic instant cursor — deterministic clientUpdatedAt values from a fixed base. */
function instantCursor(baseMs: number, stepMs = 1000): { next(): string } {
  let current = baseMs;
  return {
    next(): string {
      current += stepMs;
      return isoInstant(current);
    },
  };
}

export interface DeviceTuning {
  readonly maxOpsPerBatch: number;
  readonly pullLimit: number;
  readonly clientTimeoutMs: number;
}

export interface UserHandle {
  readonly profile: SoakUserProfile;
  readonly devices: Record<string, EmulatedDevice>;
  /** Every op the scenario enqueued (opId -> op) — the oracle-replay dictionary. */
  readonly ops: Map<string, SoakOp>;
  readonly datesTouched: Set<string>;
  readonly datesEmptied: Set<string>;
  readonly expectedRejectionsExtra: ExpectedRejection[];
}

export interface ProfileRunContext {
  readonly profileName: string;
  readonly rng: () => number;
  readonly proxy: FaultProxy;
  readonly observer: ObserverClient;
  readonly db: DatabaseProbe;
  readonly checker: InvariantChecker;
  /** Provisions one synthetic user (real signup/signin over direct HTTP) with one emulated device per label. */
  readonly provisionUser: (tag: string, deviceLabels: string[], deviceOptions?: Partial<DeviceTuning>) => Promise<UserHandle>;
}

export interface ProfileDefinition {
  readonly name: string;
  readonly description: string;
  readonly execute: (ctx: ProfileRunContext) => Promise<void>;
}

/** A soak-network adapter bound to this profile's fault proxy (device-facing side). */
export function proxiedNetwork(proxyBase: string): NetworkAdapter {
  return {
    async send(input) {
      try {
        const response = await fetch(`${proxyBase}${input.path}`, {
          method: input.method,
          headers: { Authorization: `Bearer ${input.token}`, ...input.headers },
          ...(input.bodyText !== undefined ? { body: input.bodyText } : {}),
          signal: AbortSignal.timeout(input.timeoutMs),
        });
        return { ok: true, status: response.status, bodyText: await response.text(), networkError: null };
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        return { ok: false, status: 0, bodyText: '', networkError: name === 'TimeoutError' || name === 'AbortError' ? 'aborted' : 'refused' };
      }
    },
  };
}

function track(user: UserHandle, op: SoakOp): SoakOp {
  user.ops.set(op.opId, op);
  return op;
}

function enqueue(device: EmulatedDevice, user: UserHandle, op: SoakOp): void {
  track(user, op);
  device.enqueue(op);
  if (op.kind === 'diary_entry' && op.localDate !== undefined) {
    user.datesTouched.add(op.localDate);
  }
}

// ---------------------------------------------------------------------------
// Profile 1 — clean drain
// ---------------------------------------------------------------------------

export const PROFILE_1: ProfileDefinition = {
  name: 'p1-clean-drain',
  description: 'two devices; 22 creates (20 diary across 5 days/slots on seed-pack foods + quick-adds, 1 user_food, 1 favorite); clean ordered drain + bootstrap pull; full invariant battery',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p1', ['writer', 'observer']);
    const writer = user.devices['writer'];
    const observerDevice = user.devices['observer'];
    if (writer === undefined || observerDevice === undefined) {
      throw new Error('p1 devices missing');
    }
    const instants = instantCursor(Date.UTC(2026, 4, 8, 6, 0, 0));
    const days = ['2026-05-08', '2026-05-09', '2026-05-10', '2026-05-11', '2026-05-12'];
    const slots = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
    const foods = [FOOD_FUL, FOOD_TAAMEYA, FOOD_KOSHARI];
    let entityIndex = 0;
    for (const day of days) {
      for (const slot of slots) {
        entityIndex += 1;
        const quickAdd = entityIndex % 5 === 0;
        enqueue(
          writer,
          user,
          diaryOp(
            { opId: fixedUuid('0001', entityIndex * 10), entityId: fixedUuid('00e1', entityIndex), clientUpdatedAt: instants.next(), localDate: day },
            'create',
            quickAdd
              ? { localDate: day, mealSlot: slot, energyKcal: 120 + entityIndex, proteinG: 4, carbsG: 15, fatG: 3 }
              : {
                  localDate: day,
                  mealSlot: slot,
                  foodId: foods[entityIndex % foods.length] ?? FOOD_FUL,
                  energyKcal: 110 + entityIndex,
                  proteinG: 7,
                  carbsG: 19,
                  fatG: 1,
                },
          ),
        );
      }
    }
    enqueue(writer, user, userFoodOp({ opId: fixedUuid('0002', 1), entityId: fixedUuid('00f1', 1), clientUpdatedAt: instants.next() }, 'create', userFoodSnapshot('Soak branded rice', 130)));
    enqueue(writer, user, favoriteOp({ opId: fixedUuid('0003', 1), entityId: fixedUuid('00b1', 1), clientUpdatedAt: instants.next() }, 'create', FOOD_KOSHARI));

    await writer.drainAndPull();
    await observerDevice.drainAndPull();

    const census = await ctx.observer.censusFeed(user.profile.token);
    ctx.checker.scenario(
      'p1: observer bootstrap sees every entity exactly once (census == enqueued set)',
      census.changes.length === user.ops.size && census.findings.length === 0,
      `${String(census.changes.length)} census changes vs ${String(user.ops.size)} enqueued ops`,
    );
    // Payload fidelity (the F-S4B-1 pin, found by this soak's census and
    // fixed in supervisor amendment 3 @ 7ddc3fc): the delta payload of a
    // SYNC-created user food must carry the pushed servings (§1.6
    // full-entity snapshots; the FR-012 gram weight frozen at log time).
    // The strict census compare (snapshotMatches incl. servings) enforces
    // it; this scenario pins the round-trip explicitly so it cannot land
    // silently again.
    const userFoodEntityId = fixedUuid('00f1', 1);
    const userFoodChange = census.changes.find((change) => change.entityId === userFoodEntityId);
    const servedServings = (userFoodChange?.payload as { servings?: Array<Record<string, unknown>> } | undefined)?.servings;
    ctx.checker.scenario(
      'p1: user-food payload fidelity — sync-created servings round-trip through the delta feed (F-S4B-1, found-then-fixed @ 7ddc3fc)',
      Array.isArray(servedServings) && servedServings.length === 1 && servedServings[0]?.['labelEn'] === 'Serving' && servedServings[0]?.['grams'] === 100,
      `servings=${JSON.stringify(servedServings)}`,
    );
  },
};

// ---------------------------------------------------------------------------
// Profile 2 — drop-mid-batch + retry, with three-meals-one-edit (PRD §23.1)
// ---------------------------------------------------------------------------

export const PROFILE_2: ProfileDefinition = {
  name: 'p2-drop-midbatch-3meals',
  description: 'drop-after-apply hits the FIRST push (the three-meals-one-edit batch itself) and drop-before the next; 25 ops in 6-op batches; retry = same batch + same key',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p2', ['phone'], { maxOpsPerBatch: 6, pullLimit: 7 });
    const device = user.devices['phone'];
    if (device === undefined) {
      throw new Error('p2 device missing');
    }
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && headers['x-kal-soak-push-seq'] === '1', { type: 'drop-after' });
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && headers['x-kal-soak-push-seq'] === '2', { type: 'drop-before' });

    const instants = instantCursor(Date.UTC(2026, 4, 10, 7, 0, 0));
    const day = '2026-05-10';
    const breakfast = fixedUuid('00e2', 101);
    const lunch = fixedUuid('00e2', 102);
    const dinner = fixedUuid('00e2', 103);
    // The PRD §23.1 scenario: offline device logs three meals, edits one —
    // exactly three entries plus one edit sync, no duplicates, persisted.
    enqueue(
      device,
      user,
      diaryOp({ opId: fixedUuid('0012', 1), entityId: breakfast, clientUpdatedAt: instants.next(), localDate: day }, 'create', {
        localDate: day,
        mealSlot: 'breakfast',
        foodId: FOOD_FUL,
        energyKcal: 220,
        proteinG: 15.2,
        carbsG: 38.6,
        fatG: 1,
      }),
    );
    enqueue(
      device,
      user,
      diaryOp({ opId: fixedUuid('0012', 2), entityId: lunch, clientUpdatedAt: instants.next(), localDate: day }, 'create', {
        localDate: day,
        mealSlot: 'lunch',
        foodId: FOOD_KOSHARI,
        energyKcal: 680,
        proteinG: 24,
        carbsG: 120,
        fatG: 10,
      }),
    );
    enqueue(
      device,
      user,
      diaryOp({ opId: fixedUuid('0012', 3), entityId: dinner, clientUpdatedAt: instants.next(), localDate: day }, 'create', {
        localDate: day,
        mealSlot: 'dinner',
        foodId: FOOD_TAAMEYA,
        energyKcal: 480,
        proteinG: 39,
        carbsG: 84,
        fatG: 51,
      }),
    );
    enqueue(
      device,
      user,
      diaryOp({ opId: fixedUuid('0012', 4), entityId: lunch, clientUpdatedAt: instants.next(), localDate: day }, 'update', {
        localDate: day,
        mealSlot: 'lunch',
        foodId: FOOD_KOSHARI,
        energyKcal: 340, // "ate half" — the client recomposes the snapshot
        proteinG: 12,
        carbsG: 60,
        fatG: 5,
        status: 'edited',
      }),
    );
    for (let index = 0; index < 21; index += 1) {
      const otherDay = index % 2 === 0 ? '2026-05-11' : '2026-05-12';
      enqueue(
        device,
        user,
        diaryOp({ opId: fixedUuid('0013', index), entityId: fixedUuid('00e3', index), clientUpdatedAt: instants.next(), localDate: otherDay }, 'create', {
          localDate: otherDay,
          mealSlot: 'snack',
          energyKcal: 90 + index,
          proteinG: 2,
          carbsG: 12,
          fatG: 3,
        }),
      );
    }

    await device.drainAndPull();

    const view = await ctx.observer.readDay(user.profile.token, day);
    ctx.checker.scenario(
      'p2: three-meals-one-edit — exactly 3 entries persist for the day under drop+retry',
      !('error' in view) && view.totals.entryCount === 3,
      'error' in view ? view.error : `entryCount=${String(view.totals.entryCount)} kcal=${String(view.totals.energyKcal)}`,
    );
    if (!('error' in view)) {
      const lunchEntry = view.entries.find((entry) => entry['id'] === lunch);
      ctx.checker.scenario(
        'p2: the edit landed as the winning snapshot (edited status, scaled macros) exactly once',
        lunchEntry !== undefined && lunchEntry['status'] === 'edited' && lunchEntry['energyKcal'] === 340,
        lunchEntry === undefined ? 'lunch entry missing' : `status=${String(lunchEntry['status'])} kcal=${String(lunchEntry['energyKcal'])}`,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Profile 3 — stall / slow-drain (ambiguous delivery, backoff retry)
// ---------------------------------------------------------------------------

export const PROFILE_3: ProfileDefinition = {
  name: 'p3-stall-slowdrain',
  description: 'client timeout 150ms; response held 400ms on pushes 1 and 4 (client aborts, server applied, retry replays) and 60ms on pushes 2 and 6 (late but delivered); 18 ops in 5-op batches',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p3', ['tablet'], { maxOpsPerBatch: 5, clientTimeoutMs: 150 });
    const device = user.devices['tablet'];
    if (device === undefined) {
      throw new Error('p3 device missing');
    }
    const stallPushes = new Set(['1', '4']);
    // TWO one-shots: one fires on logical push 1, the second on push 4
    // (retries reuse the same logical seq header; the one-shot per match
    // keeps exactly one stall per scripted push).
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && stallPushes.has(headers['x-kal-soak-push-seq'] ?? ''), { type: 'stall', holdMs: 400 });
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && stallPushes.has(headers['x-kal-soak-push-seq'] ?? ''), { type: 'stall', holdMs: 400 });
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && headers['x-kal-soak-push-seq'] === '2', { type: 'stall', holdMs: 60 });

    const instants = instantCursor(Date.UTC(2026, 4, 12, 5, 0, 0));
    for (let index = 0; index < 18; index += 1) {
      const day = index % 3 === 0 ? '2026-05-12' : index % 3 === 1 ? '2026-05-13' : '2026-05-14';
      enqueue(
        device,
        user,
        diaryOp({ opId: fixedUuid('0031', index), entityId: fixedUuid('00e4', index), clientUpdatedAt: instants.next(), localDate: day }, 'create', {
          localDate: day,
          mealSlot: 'lunch',
          energyKcal: 150 + index,
          proteinG: 6,
          carbsG: 20,
          fatG: 4,
        }),
      );
    }

    await device.drainAndPull();

    ctx.checker.scenario(
      'p3: stalls forced abort+retry and the retries replayed byte-identically (no duplicate effects)',
      ctx.proxy.counters.stalls >= 3 && ctx.proxy.counters.byteIdenticalReplays >= 2 && device.counters.pushRetries >= 2,
      `stalls=${String(ctx.proxy.counters.stalls)} byteReplays=${String(ctx.proxy.counters.byteIdenticalReplays)} pushRetries=${String(device.counters.pushRetries)}`,
    );
  },
};

// ---------------------------------------------------------------------------
// Profile 4 — duplicate delivery (same key + fresh key, both safe)
// ---------------------------------------------------------------------------

export const PROFILE_4: ProfileDefinition = {
  name: 'p4-duplicate-delivery',
  description: 'transport duplicate: the same request bytes forwarded twice on push 2 (same Idempotency-Key); then every batch re-dispatched once under FRESH keys — both exactly-once',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p4', ['watch'], { maxOpsPerBatch: 4 });
    const device = user.devices['watch'];
    if (device === undefined) {
      throw new Error('p4 device missing');
    }
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && headers['x-kal-soak-push-seq'] === '2', { type: 'duplicate' });

    const instants = instantCursor(Date.UTC(2026, 4, 15, 8, 0, 0));
    for (let index = 0; index < 12; index += 1) {
      enqueue(
        device,
        user,
        diaryOp({ opId: fixedUuid('0041', index), entityId: fixedUuid('00e5', index), clientUpdatedAt: instants.next(), localDate: '2026-05-15' }, 'create', {
          localDate: '2026-05-15',
          mealSlot: 'breakfast',
          energyKcal: 200 + index,
          proteinG: 8,
          carbsG: 25,
          fatG: 6,
        }),
      );
    }

    await device.drainAndPull();

    // Application-level duplicate: re-dispatch the SAME batches under FRESH
    // Idempotency-Keys — per contract §1.2 the per-op dedupe must ack every
    // op `duplicate` and produce no second effect.
    let freshKeyAcks = 0;
    let freshKeyNonDuplicate = 0;
    for (let offset = 0; offset < device.ledger.length; offset += 4) {
      const batch = device.ledger.slice(offset, offset + 4).map((entry) => entry.op);
      const acks = await ctx.observer.pushOps(user.profile.token, device.deviceId, batch);
      for (const result of acks) {
        freshKeyAcks += 1;
        if (result.outcome !== 'duplicate') {
          freshKeyNonDuplicate += 1;
        }
      }
    }
    ctx.checker.scenario(
      'p4: same-key transport duplicate replayed byte-identically',
      ctx.proxy.counters.duplicatesForwarded === 1 && ctx.proxy.counters.byteIdenticalReplays >= 1 && ctx.proxy.findings.length === 0,
      `dupForwarded=${String(ctx.proxy.counters.duplicatesForwarded)} byteReplays=${String(ctx.proxy.counters.byteIdenticalReplays)} findings=${String(ctx.proxy.findings.length)}`,
    );
    ctx.checker.scenario(
      'p4: fresh-key re-dispatch of every op acks duplicate (never re-applied, I9)',
      freshKeyAcks === device.ledger.length && freshKeyNonDuplicate === 0,
      `${String(freshKeyAcks)} acks, ${String(freshKeyNonDuplicate)} non-duplicate`,
    );
  },
};

// ---------------------------------------------------------------------------
// Profile 5 — partition during push and mid-pagination pull (cursor resume)
// ---------------------------------------------------------------------------

export const PROFILE_5: ProfileDefinition = {
  name: 'p5-partition-pull-resume',
  description: 'writer drains 40 entries clean; bootstrap device (limit 6 → 8 pages) has its push refused once and pull pages 3 and 5 refused mid-pagination — resumes from the last good cursor, no loss, no duplication',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p5', ['writer', 'bootstrapper'], { pullLimit: 6 });
    const writer = user.devices['writer'];
    const bootstrapper = user.devices['bootstrapper'];
    if (writer === undefined || bootstrapper === undefined) {
      throw new Error('p5 devices missing');
    }
    const instants = instantCursor(Date.UTC(2026, 4, 20, 4, 0, 0));
    for (let index = 0; index < 40; index += 1) {
      enqueue(
        writer,
        user,
        diaryOp({ opId: fixedUuid('0051', index), entityId: fixedUuid('00e6', index), clientUpdatedAt: instants.next(), localDate: '2026-05-20' }, 'create', {
          localDate: '2026-05-20',
          mealSlot: 'dinner',
          energyKcal: 300 + index,
          proteinG: 12,
          carbsG: 30,
          fatG: 9,
        }),
      );
    }
    await writer.drainAndPull();

    // Deterministic scripting for the single-active-device phase: the next
    // requests are bootstrapper's — first its push (refused once), then its
    // pulls. With the push retrying once (seq+1) the pull pages land from
    // seq+2; refuse page 2's response position and page 3's.
    const pushSeq = ctx.proxy.nextSeq;
    ctx.proxy.refuseAtSeq(pushSeq);
    ctx.proxy.refuseAtSeq(pushSeq + 3);
    ctx.proxy.refuseAtSeq(pushSeq + 5);
    for (let index = 0; index < 5; index += 1) {
      enqueue(
        bootstrapper,
        user,
        diaryOp({ opId: fixedUuid('0052', index), entityId: fixedUuid('00e7', index), clientUpdatedAt: instants.next(), localDate: '2026-05-21' }, 'create', {
          localDate: '2026-05-21',
          mealSlot: 'breakfast',
          energyKcal: 210 + index,
          proteinG: 9,
          carbsG: 22,
          fatG: 5,
        }),
      );
    }
    await bootstrapper.drainAndPull();
    // Convergence round: the writer pulls the bootstrapper's entries too.
    await writer.pullToEnd();

    ctx.checker.scenario(
      'p5: partitions hit the push and mid-pagination pulls (refusals observed, pulls retried)',
      ctx.proxy.counters.refused >= 3 && bootstrapper.counters.pullRetries >= 2 && bootstrapper.counters.pushRetries >= 1,
      `refused=${String(ctx.proxy.counters.refused)} pullRetries=${String(bootstrapper.counters.pullRetries)} pushRetries=${String(bootstrapper.counters.pushRetries)}`,
    );
    ctx.checker.scenario(
      'p5: cursor resume delivered every page exactly once — no loss across the partition',
      bootstrapper.counters.changesReceived >= 45 && bootstrapper.selfFindings.length === 0,
      `received=${String(bootstrapper.counters.changesReceived)} findings=${String(bootstrapper.selfFindings.length)}`,
    );
  },
};

// ---------------------------------------------------------------------------
// Profile 6 — interleaved two devices: LWW + tiebreaks (incl. SUB-MS golden)
// + tombstone propagation + ordering across reconnect
// ---------------------------------------------------------------------------

const OPID_HIGH_1 = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
const OPID_HIGH_2 = 'ffffffff-ffff-4fff-8fff-fffffffffff1';

export const PROFILE_6: ProfileDefinition = {
  name: 'p6-lww-tombstone-convergence',
  description: 'two devices interleave in waves on shared entities: plain LWW; exact-ms tie (higher opId wins); SUB-MS pairs in BOTH opId orientations (the ms-truncation golden); delete-vs-LATER-edit (tombstone wins, edit rejected_deleted); fresh-id-after-delete; ordered u1→u2→u3 across a dropped batch; both devices pull to convergence',
  execute: async (ctx) => {
    const user = await ctx.provisionUser('p6', ['alpha', 'beta'], { maxOpsPerBatch: 4 });
    const alpha = user.devices['alpha'];
    const beta = user.devices['beta'];
    if (alpha === undefined || beta === undefined) {
      throw new Error('p6 devices missing');
    }
    const instants = instantCursor(Date.UTC(2026, 4, 25, 10, 0, 0));
    const subMs = (baseMs: number, fraction: '000100Z' | '000200Z'): string => isoInstant(baseMs).replace('.000Z', `.${fraction}`);
    const subMsA = Date.UTC(2026, 4, 25, 11, 30, 0); // E3's pair instant (whole second)
    const subMsB = Date.UTC(2026, 4, 25, 11, 31, 0); // E4's pair instant

    // E1: plain LWW — alpha's earlier update first; beta's later one wins.
    const e1 = fixedUuid('00e8', 1);
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 1), entityId: e1, clientUpdatedAt: instants.next(), localDate: '2026-05-25' }, 'create', { localDate: '2026-05-25', mealSlot: 'breakfast', energyKcal: 100, proteinG: 5, carbsG: 10, fatG: 1 }));
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 2), entityId: e1, clientUpdatedAt: instants.next(), localDate: '2026-05-25' }, 'update', { localDate: '2026-05-25', mealSlot: 'breakfast', energyKcal: 140, proteinG: 6, carbsG: 12, fatG: 2, status: 'edited' }));
    enqueue(beta, user, diaryOp({ opId: fixedUuid('0062', 1), entityId: e1, clientUpdatedAt: instants.next(), localDate: '2026-05-25' }, 'update', { localDate: '2026-05-25', mealSlot: 'breakfast', energyKcal: 250, proteinG: 9, carbsG: 20, fatG: 4, status: 'edited' }));

    // E2: EXACT-ms tie — the SAME ISO string from both devices; the higher
    // opId wins regardless of arrival order.
    const e2 = fixedUuid('00e8', 2);
    const tieInstant = instants.next();
    const e2BetaCreateOp = fixedUuid('0062', 2);
    if (!(OPID_HIGH_1 > e2BetaCreateOp)) {
      throw new Error('p6 tie fixture mis-ordered');
    }
    enqueue(beta, user, diaryOp({ opId: e2BetaCreateOp, entityId: e2, clientUpdatedAt: tieInstant, localDate: '2026-05-25' }, 'create', { localDate: '2026-05-25', mealSlot: 'lunch', energyKcal: 300, proteinG: 10, carbsG: 30, fatG: 8 }));

    // E3: SUB-MS pair, orientation A — the sub-ms LATER op also carries the
    // higher opId (both rules agree). create@alpha .000100Z/LOW, update@beta .000200Z/HIGH.
    const e3 = fixedUuid('00e8', 3);
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 30), entityId: e3, clientUpdatedAt: subMs(subMsA, '000100Z'), localDate: '2026-05-25' }, 'create', { localDate: '2026-05-25', mealSlot: 'dinner', energyKcal: 400, proteinG: 20, carbsG: 40, fatG: 10 }));
    enqueue(beta, user, diaryOp({ opId: fixedUuid('0062', 30), entityId: e3, clientUpdatedAt: subMs(subMsA, '000200Z'), localDate: '2026-05-25' }, 'update', { localDate: '2026-05-25', mealSlot: 'dinner', energyKcal: 410, proteinG: 21, carbsG: 41, fatG: 11, status: 'edited' }));

    // E4: SUB-MS pair, orientation B — the sub-ms LATER op carries the LOWER
    // opId. At ms precision the instants are EQUAL, so the pinned opId
    // tiebreak decides: the sub-ms-EARLIER HIGH-opId op MUST win.
    const e4 = fixedUuid('00e8', 4);
    if (!(OPID_HIGH_2 > fixedUuid('0061', 40))) {
      throw new Error('p6 sub-ms fixture mis-ordered');
    }
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 40), entityId: e4, clientUpdatedAt: subMs(subMsB, '000200Z'), localDate: '2026-05-25' }, 'create', { localDate: '2026-05-25', mealSlot: 'snack', energyKcal: 500, proteinG: 25, carbsG: 50, fatG: 12 }));
    enqueue(beta, user, diaryOp({ opId: OPID_HIGH_2, entityId: e4, clientUpdatedAt: subMs(subMsB, '000100Z'), localDate: '2026-05-25' }, 'update', { localDate: '2026-05-25', mealSlot: 'snack', energyKcal: 520, proteinG: 26, carbsG: 52, fatG: 13, status: 'edited' }));

    // E5: tombstone wins — delete with an EARLIER instant than a LATER edit;
    // the edit must be rejected_deleted (an update never undeletes) and the
    // tombstone propagates; pull-after-tombstone never resurrects.
    const e5 = fixedUuid('00e8', 5);
    const e5EditOpId = fixedUuid('0062', 50);
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 50), entityId: e5, clientUpdatedAt: instants.next(), localDate: '2026-05-26' }, 'create', { localDate: '2026-05-26', mealSlot: 'lunch', energyKcal: 600, proteinG: 30, carbsG: 60, fatG: 15 }));
    enqueue(alpha, user, diaryDeleteOp({ opId: fixedUuid('0061', 51), entityId: e5, clientUpdatedAt: instants.next(), localDate: '2026-05-26' }));
    const e5LaterEditInstant = instants.next(); // strictly AFTER the delete's instant — still loses to the tombstone
    enqueue(beta, user, diaryOp({ opId: e5EditOpId, entityId: e5, clientUpdatedAt: e5LaterEditInstant, localDate: '2026-05-26' }, 'update', { localDate: '2026-05-26', mealSlot: 'lunch', energyKcal: 650, proteinG: 33, carbsG: 66, fatG: 16, status: 'edited' }));
    user.datesEmptied.add('2026-05-26');

    // E6: fresh-id-after-delete is a NEW entry (same-id create-after-delete
    // stays blocked — I9).
    const e6 = fixedUuid('00e8', 6);
    const e6v2 = fixedUuid('00e8', 7);
    enqueue(beta, user, diaryOp({ opId: fixedUuid('0062', 60), entityId: e6, clientUpdatedAt: instants.next(), localDate: '2026-05-27' }, 'create', { localDate: '2026-05-27', mealSlot: 'dinner', energyKcal: 700, proteinG: 35, carbsG: 70, fatG: 20 }));
    enqueue(beta, user, diaryDeleteOp({ opId: fixedUuid('0062', 61), entityId: e6, clientUpdatedAt: instants.next(), localDate: '2026-05-27' }));
    enqueue(beta, user, diaryOp({ opId: fixedUuid('0062', 62), entityId: e6v2, clientUpdatedAt: instants.next(), localDate: '2026-05-27' }, 'create', { localDate: '2026-05-27', mealSlot: 'dinner', energyKcal: 720, proteinG: 36, carbsG: 72, fatG: 21 }));

    // E7: per-device ordering across a reconnect — alpha pushes u1 < u2 < u3
    // on one entity; a drop-after severs a batch; order must survive.
    const e7 = fixedUuid('00e8', 8);
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 70), entityId: e7, clientUpdatedAt: instants.next(), localDate: '2026-05-28' }, 'create', { localDate: '2026-05-28', mealSlot: 'snack', energyKcal: 100, proteinG: 1, carbsG: 2, fatG: 3 }));
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 71), entityId: e7, clientUpdatedAt: instants.next(), localDate: '2026-05-28' }, 'update', { localDate: '2026-05-28', mealSlot: 'snack', energyKcal: 110, proteinG: 2, carbsG: 3, fatG: 4, status: 'edited' }));
    enqueue(alpha, user, diaryOp({ opId: fixedUuid('0061', 72), entityId: e7, clientUpdatedAt: instants.next(), localDate: '2026-05-28' }, 'update', { localDate: '2026-05-28', mealSlot: 'snack', energyKcal: 120, proteinG: 3, carbsG: 4, fatG: 5, status: 'edited' }));

    // The drop-after for the reconnect-ordering scenario fires on alpha's
    // logical push 3 (alpha's 9 wave-1 ops → batches [4][4][1]: the third
    // batch carries E7's final update).
    ctx.proxy.injectOnce(({ method, path, headers }) => method === 'POST' && path.startsWith('/sync/ops') && headers['x-kal-soak-push-seq'] === '3', { type: 'drop-after' });

    // Wave 1: both devices push everything queued so far (alpha first, then
    // beta — every update arrives after its entity's create).
    await alpha.drainPending();
    await beta.drainPending();
    // Wave 2: alpha's tie-winning E2 update — it must arrive AFTER beta's
    // E2 create (wave 1); then only the opId decides the exact-ms tie.
    enqueue(alpha, user, diaryOp({ opId: OPID_HIGH_1, entityId: e2, clientUpdatedAt: tieInstant, localDate: '2026-05-25' }, 'update', { localDate: '2026-05-25', mealSlot: 'lunch', energyKcal: 320, proteinG: 11, carbsG: 31, fatG: 9, status: 'edited' }));
    await alpha.drainPending();
    // Convergence: both pull to end-of-feed.
    await alpha.pullToEnd();
    await beta.pullToEnd();

    // Scenario asserts — the LWW goldens, off the server census.
    const census = await ctx.observer.censusFeed(user.profile.token);
    const censusById = new Map(census.changes.map((change) => [change.entityId, change]));
    const kcalOf = (change: unknown): number | undefined => (change as { payload?: Record<string, number> } | undefined)?.payload?.['energyKcal'];

    const e1Change = censusById.get(e1);
    ctx.checker.scenario('p6: plain LWW converged on the later update, no third state', e1Change?.change === 'upsert' && kcalOf(e1Change) === 250, `change=${String(e1Change?.change)} kcal=${String(kcalOf(e1Change))}`);

    const e2Change = censusById.get(e2);
    ctx.checker.scenario('p6: exact-ms tie resolved by the higher opId (arrival order irrelevant)', e2Change?.change === 'upsert' && kcalOf(e2Change) === 320, `kcal=${String(kcalOf(e2Change))}`);

    const e3Change = censusById.get(e3);
    ctx.checker.scenario('p6: sub-ms pair (orientation A) — equal at ms precision, higher opId wins (both rules agree)', e3Change?.change === 'upsert' && kcalOf(e3Change) === 410, `kcal=${String(kcalOf(e3Change))}`);

    const e4Change = censusById.get(e4);
    ctx.checker.scenario(
      'p6: SUB-MS GOLDEN (orientation B) — ms-truncation never silently flips a winner: the pinned (clientUpdatedAt, opId) tiebreak gives the sub-ms-EARLIER HIGH-opId op the win, deterministically',
      e4Change?.change === 'upsert' && kcalOf(e4Change) === 520 && e4Change?.updatedAt === isoInstant(subMsB),
      `updatedAt=${String(e4Change?.updatedAt)} kcal=${String(kcalOf(e4Change))} (expect ${isoInstant(subMsB)} + 520)`,
    );
    // And the golden is stable: replaying the losing op (fresh key) changes nothing.
    const e4LoserOp = user.ops.get(fixedUuid('0061', 40));
    if (e4LoserOp === undefined) {
      throw new Error('p6 E4 loser op not tracked');
    }
    const loserReplay = await ctx.observer.pushOps(user.profile.token, alpha.deviceId, [e4LoserOp]);
    const e4AfterReplay = (await ctx.observer.censusFeed(user.profile.token)).changes.find((change) => change.entityId === e4);
    ctx.checker.scenario(
      'p6: the sub-ms loser replays as duplicate and flips nothing (convergence is stable)',
      loserReplay.length === 1 && loserReplay[0]?.outcome === 'duplicate' && kcalOf(e4AfterReplay) === 520,
      `replayOutcome=${String(loserReplay[0]?.outcome)} kcalAfter=${String(kcalOf(e4AfterReplay))}`,
    );

    const e5Change = censusById.get(e5);
    ctx.checker.scenario(
      'p6: delete-then-LATER-edit converges to the tombstone (tombstones win over stale ops; edit rejected_deleted, no resurrection)',
      e5Change?.change === 'delete' && e5Change.payload === undefined,
      `change=${String(e5Change?.change)} hasPayload=${String(e5Change?.payload !== undefined)}`,
    );
    const e6Change = censusById.get(e6);
    const e6v2Change = censusById.get(e6v2);
    ctx.checker.scenario(
      'p6: same-id create-after-delete blocked (tombstone persists); fresh-id create is a NEW entry',
      e6Change?.change === 'delete' && e6v2Change?.change === 'upsert',
      `old=${String(e6Change?.change)} new=${String(e6v2Change?.change)}`,
    );
    const e7Change = censusById.get(e7);
    ctx.checker.scenario(
      'p6: per-device ordering preserved across reconnect (u1→u2→u3 ends at u3 across a dropped batch)',
      e7Change?.change === 'upsert' && kcalOf(e7Change) === 120 && ctx.proxy.counters.dropsAfter >= 1,
      `kcal=${String(kcalOf(e7Change))} dropsAfter=${String(ctx.proxy.counters.dropsAfter)}`,
    );

    // Pull-after-tombstone never resurrects: a fresh small-limit census walk
    // (a stale bootstrap position) still shows the deleted entity exactly
    // once, payload-free, never as an upsert.
    const staleCensus = await ctx.observer.censusFeed(user.profile.token, 3);
    const e5Stale = staleCensus.changes.filter((change) => change.entityId === e5);
    ctx.checker.scenario(
      'p6: no-resurrection census on a small-limit stale walk — tombstone exactly once, payload-free',
      e5Stale.length === 1 && e5Stale[0]?.change === 'delete' && staleCensus.findings.length === 0,
      `e5 appearances=${String(e5Stale.length)} findings=${String(staleCensus.findings.length)}`,
    );

  },
};

export const PROFILE_DEFINITIONS: readonly ProfileDefinition[] = [PROFILE_1, PROFILE_2, PROFILE_3, PROFILE_4, PROFILE_5, PROFILE_6];
