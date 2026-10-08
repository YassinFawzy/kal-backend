/**
 * Kal — the frozen diary entry snapshot (wave-03 contract §1.1/§1.3/§2, I11).
 *
 * The op `payload` is the FULL entity snapshot (same shape for create and
 * update — no patch semantics); the delta feed's `upsert` payloads are the
 * same snapshot; the day-read entry shape (contract §2
 * `tracking.diary.day.get`) is the projection of it. This module is the
 * single transcription of that shape: validation (pure), row mapping, and
 * projections.
 *
 * FROZEN SNAPSHOT RULE (I11): the entry stores the nutrient values used at
 * log time. The server never re-resolves a food's current macros for an
 * existing entry — later catalog corrections never rewrite logged history.
 * An `update` op re-snapshots by REPLACING the full snapshot with the
 * winning payload's values (the client computes scaled macros; "ate half"
 * is a client-side recomposition, not a server recalculation).
 *
 * Payload shape (frozen by this lane's round-trip suites; §2 read shapes
 * are the projection):
 *   {
 *     localDate:  'YYYY-MM-DD' (calendar-valid; MUST equal the envelope's
 *                 `localDate` — one snapshot shape across op + delta)
 *     mealSlot:   'breakfast' | 'lunch' | 'dinner' | 'snack'
 *     entryMethod:'search'|'recents'|'favorites'|'copy_yesterday'|'quick_add'|'barcode'
 *     foodId?:    UUID — platform food reference (sourceKind platform_food)
 *     userFoodId?:UUID — the caller's OWN user food (sourceKind user_food)
 *     quantity:   number > 0 (× servingGramWeight reconstructs the grams logged)
 *     servingLabelEn?/servingLabelAr?: 1–100 chars (absent on quick-add)
 *     servingGramWeight?: number > 0 — REQUIRED on non-quick-add entries
 *                 (the FR-012 resolution, frozen at log time)
 *     energyKcal/proteinG/carbsG/fatG: numbers ≥ 0 (the frozen macros)
 *     status:     'confirmed' | 'edited'
 *   }
 * Source XOR (mirrors the migration's `diary_entries_source_exactly_one`
 * CHECK): quick-add ⇔ no food reference AND no serving fields; every other
 * entry method carries EXACTLY ONE food reference plus its serving gram
 * weight. `sourceKind` is derived, never carried.
 */
import type { DiaryEntry } from '../../../generated/prisma/client.ts';
import { isValidLocalDate, localDateToDate } from './diary-day.js';

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type EntryMethod = 'search' | 'recents' | 'favorites' | 'copy_yesterday' | 'quick_add' | 'barcode';
export type DiaryEntryStatus = 'confirmed' | 'edited';
export type DiarySourceKind = 'platform_food' | 'user_food' | 'quick_add';

export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const ENTRY_METHODS: readonly EntryMethod[] = ['search', 'recents', 'favorites', 'copy_yesterday', 'quick_add', 'barcode'];
export const DIARY_ENTRY_STATUSES: readonly DiaryEntryStatus[] = ['confirmed', 'edited'];

/** Column-scale bounds — a value the DECIMAL columns cannot store must be a per-op validation outcome, never a database error (it would abort the whole batch transaction). */
const MAX_QUANTITY = 1_000_000;
const MAX_GRAMS = 1_000_000;
const MAX_MACROS = 10_000_000;
const MAX_LABEL_LENGTH = 100;

export interface DiaryEntrySnapshot {
  /** Calendar-valid `YYYY-MM-DD`; equals the op envelope's `localDate`. */
  readonly localDate: string;
  readonly mealSlot: MealSlot;
  readonly entryMethod: EntryMethod;
  readonly foodId?: string;
  readonly userFoodId?: string;
  readonly quantity: number;
  readonly servingLabelEn?: string;
  readonly servingLabelAr?: string;
  readonly servingGramWeight?: number;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly status: DiaryEntryStatus;
}

export type SnapshotParseResult =
  | { readonly ok: true; readonly snapshot: DiaryEntrySnapshot }
  | { readonly ok: false };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Strict ISO 8601 UTC-instant parsing (conventions §0: "ISO 8601 UTC
 * instants"; the schema pins `client_updated_at` as client-authored UTC).
 * Returns null for anything that is not a `Z`-suffixed instant.
 */
export function parseUtcInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Guard against permissively-parsed oddities (e.g. folded whitespace):
  // re-serialize and compare shape-independently by instant round-trip.
  return parsed.toISOString() === normalizedInstant(value) ? parsed : null;
}

function normalizedInstant(value: string): string {
  // Accept fractional seconds of any length; compare on the canonical
  // millisecond rendering of the same instant.
  const trimmed = value.replace(/(\.\d{3})\d+Z$/u, '$1Z');
  return new Date(trimmed).toISOString();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A frozen macro: finite, non-negative, within the DECIMAL(9,·) column range. */
function validMacro(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value < MAX_MACROS;
}

function optionalBoundedString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    return null;
  }
  return value;
}

/**
 * Validates one diary op envelope + payload into the frozen snapshot.
 * Pure: no database, no clock — every failure is the per-op
 * `rejected_validation` outcome (contract §1.3), never an exception.
 */
export function parseDiarySnapshot(op: {
  readonly opId: unknown;
  readonly entityId: unknown;
  readonly action: unknown;
  readonly clientUpdatedAt: unknown;
  readonly localDate?: unknown;
  readonly payload?: unknown;
}): { snapshot: DiaryEntrySnapshot; clientUpdatedAt: Date } | null {
  if (!isUuid(op.opId) || !isUuid(op.entityId)) {
    return null;
  }
  if (op.action !== 'create' && op.action !== 'update') {
    return null; // delete ops never reach here (no snapshot to parse)
  }
  const clientUpdatedAt = parseUtcInstant(op.clientUpdatedAt);
  if (clientUpdatedAt === null) {
    return null;
  }
  if (typeof op.localDate !== 'string' || !isValidLocalDate(op.localDate)) {
    return null;
  }
  if (typeof op.payload !== 'object' || op.payload === null || Array.isArray(op.payload)) {
    return null;
  }
  const body = op.payload as Record<string, unknown>;

  // The snapshot's own date must be present and agree with the envelope's
  // carried date (one snapshot shape; the envelope value is the day rule).
  if (typeof body['localDate'] !== 'string' || body['localDate'] !== op.localDate) {
    return null;
  }

  const mealSlot = body['mealSlot'];
  if (typeof mealSlot !== 'string' || !MEAL_SLOTS.includes(mealSlot as MealSlot)) {
    return null;
  }
  const entryMethod = body['entryMethod'];
  if (typeof entryMethod !== 'string' || !ENTRY_METHODS.includes(entryMethod as EntryMethod)) {
    return null;
  }
  const status = body['status'];
  if (typeof status !== 'string' || !DIARY_ENTRY_STATUSES.includes(status as DiaryEntryStatus)) {
    return null;
  }

  const foodId = body['foodId'];
  const userFoodId = body['userFoodId'];
  if (foodId !== undefined && !isUuid(foodId)) {
    return null;
  }
  if (userFoodId !== undefined && !isUuid(userFoodId)) {
    return null;
  }

  const quantity = body['quantity'];
  if (!isFiniteNumber(quantity) || quantity <= 0 || quantity >= MAX_QUANTITY) {
    return null;
  }

  const servingLabelEn = optionalBoundedString(body['servingLabelEn'], MAX_LABEL_LENGTH);
  const servingLabelAr = optionalBoundedString(body['servingLabelAr'], MAX_LABEL_LENGTH);
  if (servingLabelEn === null || servingLabelAr === null) {
    return null;
  }
  const rawGrams = body['servingGramWeight'];
  if (rawGrams !== undefined && (!isFiniteNumber(rawGrams) || rawGrams <= 0 || rawGrams >= MAX_GRAMS)) {
    return null;
  }

  const energyKcal = body['energyKcal'];
  const proteinG = body['proteinG'];
  const carbsG = body['carbsG'];
  const fatG = body['fatG'];
  if (!validMacro(energyKcal) || !validMacro(proteinG) || !validMacro(carbsG) || !validMacro(fatG)) {
    return null;
  }

  // Source XOR (contract §1.3 "source XOR violated"; migration CHECK twin):
  const quickAdd = entryMethod === 'quick_add';
  const hasPlatformFood = foodId !== undefined;
  const hasUserFood = userFoodId !== undefined;
  const hasServingFields =
    servingLabelEn !== undefined || servingLabelAr !== undefined || rawGrams !== undefined;
  if (quickAdd) {
    if (hasPlatformFood || hasUserFood || hasServingFields) {
      return null; // quick-add is bare kcal/macros — no food reference, no serving fields
    }
  } else {
    // Exactly one food reference, plus the FR-012 resolved gram weight.
    if (hasPlatformFood === hasUserFood || rawGrams === undefined) {
      return null;
    }
  }

  return {
    snapshot: {
      localDate: op.localDate,
      mealSlot: mealSlot as MealSlot,
      entryMethod: entryMethod as EntryMethod,
      ...(hasPlatformFood ? { foodId: foodId as string } : {}),
      ...(hasUserFood ? { userFoodId: userFoodId as string } : {}),
      quantity,
      ...(servingLabelEn !== undefined ? { servingLabelEn } : {}),
      ...(servingLabelAr !== undefined ? { servingLabelAr } : {}),
      ...(rawGrams !== undefined ? { servingGramWeight: rawGrams } : {}),
      energyKcal: energyKcal,
      proteinG: proteinG,
      carbsG: carbsG,
      fatG: fatG,
      status: status as DiaryEntryStatus,
    },
    clientUpdatedAt,
  };
}

/** `sourceKind` is derived from the reference set — it is never stored, never carried. */
export function deriveSourceKind(foodId: string | null | undefined, userFoodId: string | null | undefined): DiarySourceKind {
  if (foodId !== null && foodId !== undefined) {
    return 'platform_food';
  }
  if (userFoodId !== null && userFoodId !== undefined) {
    return 'user_food';
  }
  return 'quick_add';
}

/** The frozen snapshot as Prisma write data (create/update columns only — every one carries a column-level UPDATE grant). */
export function snapshotToRowData(snapshot: DiaryEntrySnapshot): {
  localDate: Date;
  mealSlot: string;
  entryMethod: string;
  foodId: string | null;
  userFoodId: string | null;
  quantity: number;
  servingLabelEn: string | null;
  servingLabelAr: string | null;
  servingGramWeight: number | null;
  energyKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  status: string;
} {
  return {
    localDate: localDateToDate(snapshot.localDate),
    mealSlot: snapshot.mealSlot,
    entryMethod: snapshot.entryMethod,
    foodId: snapshot.foodId ?? null,
    userFoodId: snapshot.userFoodId ?? null,
    quantity: snapshot.quantity,
    servingLabelEn: snapshot.servingLabelEn ?? null,
    servingLabelAr: snapshot.servingLabelAr ?? null,
    servingGramWeight: snapshot.servingGramWeight ?? null,
    energyKcal: snapshot.energyKcal,
    proteinG: snapshot.proteinG,
    carbsG: snapshot.carbsG,
    fatG: snapshot.fatG,
    status: snapshot.status,
  };
}

/**
 * The delta feed's `upsert` payload: the FULL entity snapshot of a stored
 * row (same shape as the op payload — the snapshot freezes at write time;
 * reading a row projects exactly what was frozen).
 */
export function rowToSnapshot(row: DiaryEntry): DiaryEntrySnapshot {
  const foodId = row.foodId ?? undefined;
  const userFoodId = row.userFoodId ?? undefined;
  const servingLabelEn = row.servingLabelEn ?? undefined;
  const servingLabelAr = row.servingLabelAr ?? undefined;
  const servingGramWeight = row.servingGramWeight === null ? undefined : Number(row.servingGramWeight);
  return {
    localDate: formatStoredDate(row.localDate),
    mealSlot: row.mealSlot as MealSlot,
    entryMethod: row.entryMethod as EntryMethod,
    ...(foodId !== undefined ? { foodId } : {}),
    ...(userFoodId !== undefined ? { userFoodId } : {}),
    quantity: Number(row.quantity),
    ...(servingLabelEn !== undefined ? { servingLabelEn } : {}),
    ...(servingLabelAr !== undefined ? { servingLabelAr } : {}),
    ...(servingGramWeight !== undefined ? { servingGramWeight } : {}),
    energyKcal: Number(row.energyKcal),
    proteinG: Number(row.proteinG),
    carbsG: Number(row.carbsG),
    fatG: Number(row.fatG),
    status: row.status as DiaryEntryStatus,
  };
}

function formatStoredDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day-read entry projection (contract §2 `tracking.diary.day.get` — the frozen snapshot fields plus identity/update metadata). */
export interface DiaryEntryView {
  readonly id: string;
  readonly localDate: string;
  readonly mealSlot: MealSlot;
  readonly entryMethod: EntryMethod;
  readonly sourceKind: DiarySourceKind;
  readonly foodId: string | null;
  readonly userFoodId: string | null;
  readonly quantity: number;
  readonly servingLabelEn: string | null;
  readonly servingLabelAr: string | null;
  readonly servingGramWeight: number | null;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly status: DiaryEntryStatus;
  readonly updatedAt: string;
}

export function rowToEntryView(row: DiaryEntry): DiaryEntryView {
  return {
    id: row.id,
    localDate: formatStoredDate(row.localDate),
    mealSlot: row.mealSlot as MealSlot,
    entryMethod: row.entryMethod as EntryMethod,
    sourceKind: deriveSourceKind(row.foodId, row.userFoodId),
    foodId: row.foodId,
    userFoodId: row.userFoodId,
    quantity: Number(row.quantity),
    servingLabelEn: row.servingLabelEn,
    servingLabelAr: row.servingLabelAr,
    servingGramWeight: row.servingGramWeight === null ? null : Number(row.servingGramWeight),
    energyKcal: Number(row.energyKcal),
    proteinG: Number(row.proteinG),
    carbsG: Number(row.carbsG),
    fatG: Number(row.fatG),
    status: row.status as DiaryEntryStatus,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The day rollup (contract §2: totals ONLY — target comparison is W5, ledger §7-E3). */
export interface DiaryDayTotals {
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly entryCount: number;
}

export const EMPTY_DAY_TOTALS: DiaryDayTotals = { energyKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entryCount: 0 };

/** The `tracking.diary.day.get` 200 body. A day with no entries is an EMPTY 200 (a date is not an object). */
export interface DiaryDayView {
  readonly localDate: string;
  readonly totals: DiaryDayTotals;
  readonly entries: readonly DiaryEntryView[];
}
