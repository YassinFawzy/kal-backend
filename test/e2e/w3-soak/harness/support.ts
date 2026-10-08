/**
 * Kal — w3 soak harness shared support (test/e2e/w3-soak/**).
 *
 * Synthetic-fixture utilities for the replay/soak harness (gate criterion 9;
 * task contract `docs/development/wave-03/tasks/s4b-soak-dayboundary.md`).
 * Everything here is deterministic: ids and instants derive from a seeded
 * PRNG so a soak run is exactly rerunnable, and the GR gate can re-run the
 * same profiles byte-for-byte. No real identities, no real health content.
 *
 * The op builders below transcribe the FROZEN envelope/payload shapes from
 * `docs/api/wave-03-contract.md` §1.1 (diary snapshot per
 * `src/tracking/diary/diary-snapshot.ts`, user-food/favorite per
 * `src/tracking/foods/user-food.payload.ts`) — the harness emulates real
 * clients, so it speaks exactly the frozen wire shapes.
 */
import { randomUUID } from 'node:crypto';

/** Seeded PRNG (mulberry32) — profiles are seeded/configurable (task invariant). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic v4-shaped UUID from an RNG stream (client-generated id semantics). */
export function seededUuid(rng: () => number): string {
  const hex = (): string =>
    Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  const raw = `${hex()}${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-a${hex().slice(1, 4)}-${hex()}${hex()}`;
  return raw;
}

/** Non-deterministic UUID (server-side fixtures only — never used for op/entity ids). */
export function randomUuid(): string {
  return randomUUID();
}

/** Canonical UTC instant string (the only `clientUpdatedAt` form the envelope accepts). */
export function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/** The frozen LWW comparator, re-transcribed from contract §1.4 (INDEPENDENT of src code — the harness oracle must not import the implementation it audits). */
export function lwwWins(a: { readonly updatedAtMs: number; readonly opId: string }, b: { readonly updatedAtMs: number; readonly opId: string }): boolean {
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs > b.updatedAtMs;
  }
  return a.opId > b.opId;
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

// ---------------------------------------------------------------------------
// Synthetic users / devices
// ---------------------------------------------------------------------------

export interface SoakUserCredentials {
  readonly email: string;
  readonly phone: string;
  readonly username: string;
  readonly password: string;
}

/** Synthetic credentials in the frozen identity shapes (username `^[a-z0-9_]{3,30}$`, E.164 phone). */
export function makeUserCredentials(rng: () => number, tag: string): SoakUserCredentials {
  const runId = Math.floor(rng() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const username = `soak${tag}${runId}`.slice(0, 30).replace(/[^a-z0-9_]/g, '');
  return {
    email: `${username}@soak.example.net`,
    phone: `+2019${Math.floor(rng() * 100000000)
      .toString()
      .padStart(8, '0')}`,
    username,
    password: `soak-${runId}-harness-password`,
  };
}

// ---------------------------------------------------------------------------
// Sync op builders (frozen wire shapes — contract §1.1)
// ---------------------------------------------------------------------------

export type SyncOpKind = 'diary_entry' | 'user_food' | 'favorite';
export type SyncOpAction = 'create' | 'update' | 'delete';
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface SoakOp {
  readonly opId: string;
  readonly kind: SyncOpKind;
  readonly entityId: string;
  readonly action: SyncOpAction;
  readonly clientUpdatedAt: string;
  readonly localDate?: string;
  readonly payload?: Record<string, unknown>;
}

/** Full diary-entry snapshot (source XOR: platform food + grams, or bare quick-add). */
export interface DiarySnapshotInput {
  readonly localDate: string;
  readonly mealSlot: MealSlot;
  readonly entryMethod?: 'search' | 'recents' | 'favorites' | 'copy_yesterday' | 'quick_add' | 'barcode';
  readonly foodId?: string;
  readonly servingLabelEn?: string;
  readonly servingLabelAr?: string;
  readonly servingGramWeight?: number;
  readonly quantity?: number;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly status?: 'confirmed' | 'edited';
}

export function diarySnapshot(snap: DiarySnapshotInput): Record<string, unknown> {
  const entryMethod = snap.entryMethod ?? (snap.foodId === undefined ? 'quick_add' : 'search');
  return {
    localDate: snap.localDate,
    mealSlot: snap.mealSlot,
    entryMethod,
    ...(snap.foodId !== undefined
      ? {
          foodId: snap.foodId,
          servingLabelEn: snap.servingLabelEn ?? 'Bowl',
          servingGramWeight: snap.servingGramWeight ?? 200,
        }
      : {}),
    quantity: snap.quantity ?? 1,
    energyKcal: snap.energyKcal,
    proteinG: snap.proteinG,
    carbsG: snap.carbsG,
    fatG: snap.fatG,
    status: snap.status ?? 'confirmed',
  };
}

export interface SoakOpInput {
  readonly opId: string;
  readonly entityId: string;
  readonly clientUpdatedAt: string;
  readonly localDate?: string;
}

export function diaryOp(input: SoakOpInput, action: 'create' | 'update', snapshot: DiarySnapshotInput): SoakOp {
  return {
    opId: input.opId,
    kind: 'diary_entry',
    entityId: input.entityId,
    action,
    clientUpdatedAt: input.clientUpdatedAt,
    localDate: snapshot.localDate,
    payload: diarySnapshot(snapshot),
  };
}

export function diaryDeleteOp(input: Omit<SoakOpInput, 'localDate'> & { readonly localDate: string }): SoakOp {
  return {
    opId: input.opId,
    kind: 'diary_entry',
    entityId: input.entityId,
    action: 'delete',
    clientUpdatedAt: input.clientUpdatedAt,
    localDate: input.localDate,
  };
}

/** User-food snapshot (at least one name; ≥1 serving variant with gram weight). */
export function userFoodSnapshot(nameEn: string, kcal: number, grams = 100): Record<string, unknown> {
  return {
    nameEn,
    energyKcal: kcal,
    proteinG: Math.round(kcal * 0.15 * 10) / 10,
    carbsG: Math.round(kcal * 0.5 * 10) / 10,
    fatG: Math.round(kcal * 0.35 * 10) / 10,
    servings: [{ labelEn: 'Serving', grams }],
  };
}

export function userFoodOp(input: SoakOpInput, action: 'create' | 'update', snapshot: Record<string, unknown>): SoakOp {
  return {
    opId: input.opId,
    kind: 'user_food',
    entityId: input.entityId,
    action,
    clientUpdatedAt: input.clientUpdatedAt,
    payload: snapshot,
  };
}

export function userFoodDeleteOp(input: Omit<SoakOpInput, 'localDate'>): SoakOp {
  return {
    opId: input.opId,
    kind: 'user_food',
    entityId: input.entityId,
    action: 'delete',
    clientUpdatedAt: input.clientUpdatedAt,
  };
}

export function favoriteOp(input: Omit<SoakOpInput, 'localDate'>, action: 'create' | 'delete', foodId: string): SoakOp {
  return {
    opId: input.opId,
    kind: 'favorite',
    entityId: input.entityId,
    action,
    clientUpdatedAt: input.clientUpdatedAt,
    ...(action === 'create' ? { payload: { foodId, userFoodId: null } } : {}),
  };
}
