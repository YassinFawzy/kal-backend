/**
 * Kal — the frozen diary snapshot shape specs (wave-03 contract §1.1/§1.3;
 * payload shape frozen by this lane's round-trip suites; I11 semantics).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveSourceKind,
  EMPTY_DAY_TOTALS,
  parseDiarySnapshot,
  parseUtcInstant,
  rowToEntryView,
  rowToSnapshot,
  snapshotToRowData,
  type DiaryEntrySnapshot,
} from './diary-snapshot.js';
import type { DiaryEntry } from '../../../generated/prisma/client.ts';

const OP_ID = '11111111-1111-4111-8111-000000000001';
const ENTITY_ID = '11111111-1111-4111-8111-000000000002';
const FOOD_ID = '00000000-0000-4000-8000-00000000f001';
const USER_FOOD_ID = '11111111-1111-4111-8111-000000000003';

function platformFoodPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localDate: '2026-01-15',
    mealSlot: 'breakfast',
    entryMethod: 'search',
    foodId: FOOD_ID,
    quantity: 2,
    servingLabelEn: 'Bowl',
    servingLabelAr: 'طاسة',
    servingGramWeight: 200,
    energyKcal: 220,
    proteinG: 15.2,
    carbsG: 38.6,
    fatG: 1,
    status: 'confirmed',
    ...overrides,
  };
}

function parsePayload(payload: Record<string, unknown>, opOverrides: Record<string, unknown> = {}): ReturnType<typeof parseDiarySnapshot> {
  return parseDiarySnapshot({
    opId: OP_ID,
    entityId: ENTITY_ID,
    action: 'create',
    clientUpdatedAt: '2026-01-16T00:01:00Z',
    localDate: '2026-01-15',
    payload,
    ...opOverrides,
  });
}

describe('the frozen diary snapshot parses (op payload = full entity snapshot)', () => {
  it('accepts a full platform-food snapshot (frozen macros + resolved serving)', () => {
    const parsed = parsePayload(platformFoodPayload());
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error('expected success');
    }
    expect(parsed.snapshot.localDate).toBe('2026-01-15');
    expect(parsed.snapshot.mealSlot).toBe('breakfast');
    expect(parsed.snapshot.entryMethod).toBe('search');
    expect(parsed.snapshot.foodId).toBe(FOOD_ID);
    expect(parsed.snapshot.quantity).toBe(2);
    expect(parsed.snapshot.servingGramWeight).toBe(200);
    expect(parsed.snapshot.energyKcal).toBe(220);
    expect(parsed.snapshot.proteinG).toBe(15.2);
    expect(parsed.snapshot.status).toBe('confirmed');
    expect(parsed.clientUpdatedAt.toISOString()).toBe('2026-01-16T00:01:00.000Z');
  });

  it('accepts the bare quick-add shape (no food reference, no serving fields)', () => {
    const parsed = parsePayload({
      localDate: '2026-01-15',
      mealSlot: 'snack',
      entryMethod: 'quick_add',
      quantity: 1,
      energyKcal: 180,
      proteinG: 0,
      carbsG: 0,
      fatG: 8,
      status: 'confirmed',
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error('expected success');
    }
    expect(parsed.snapshot.foodId).toBeUndefined();
    expect(parsed.snapshot.userFoodId).toBeUndefined();
    expect(parsed.snapshot.servingGramWeight).toBeUndefined();
    expect(parsed.snapshot.servingLabelEn).toBeUndefined();
  });

  it('accepts an "edited" status and every meal slot (frozen four — HD-17 held)', () => {
    for (const mealSlot of ['breakfast', 'lunch', 'dinner', 'snack']) {
      const parsed = parsePayload(platformFoodPayload({ mealSlot, status: 'edited' }));
      expect(parsed?.snapshot.mealSlot).toBe(mealSlot);
      expect(parsed?.snapshot.status).toBe('edited');
    }
  });

  it('accepts fractional-seconds UTC instants and normalizes the parse', () => {
    const parsed = parsePayload(platformFoodPayload(), { clientUpdatedAt: '2026-01-16T00:01:00.123Z' });
    expect(parsed?.clientUpdatedAt.toISOString()).toBe('2026-01-16T00:01:00.123Z');
  });
});

describe('per-op validation outcomes (rejected_validation by construction — §1.3)', () => {
  it('rejects every source-XOR violation', () => {
    // quick-add carrying a food reference
    expect(parsePayload(platformFoodPayload({ entryMethod: 'quick_add' }))).toBeNull();
    // quick-add carrying serving fields
    expect(
      parsePayload({
        localDate: '2026-01-15',
        mealSlot: 'snack',
        entryMethod: 'quick_add',
        quantity: 1,
        servingGramWeight: 100,
        energyKcal: 100,
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        status: 'confirmed',
      }),
    ).toBeNull();
    // both food references at once
    expect(parsePayload(platformFoodPayload({ userFoodId: USER_FOOD_ID }))).toBeNull();
    // non-quick-add with NO food reference
    const { foodId: _foodId, ...noFood } = platformFoodPayload();
    expect(parsePayload(noFood)).toBeNull();
    // non-quick-add without the resolved gram weight
    const { servingGramWeight: _grams, ...noGrams } = platformFoodPayload();
    expect(parsePayload(noGrams)).toBeNull();
  });

  it('rejects a bad carried localDate (shape-only rule) and a payload/envelope date mismatch', () => {
    expect(parsePayload(platformFoodPayload(), { localDate: '2026-2-15' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { localDate: '2026-02-30' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { localDate: undefined })).toBeNull();
    expect(parsePayload(platformFoodPayload({ localDate: '2026-01-16' }))).toBeNull();
  });

  it('rejects unknown meal slots, entry methods, and statuses (the frozen enums)', () => {
    expect(parsePayload(platformFoodPayload({ mealSlot: 'suhoor' }))).toBeNull(); // Ramadan slots deferred — HD-17
    expect(parsePayload(platformFoodPayload({ entryMethod: 'voice' }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ status: 'pending_order' }))).toBeNull(); // Phase 3 reserved boundary
  });

  it('rejects negative, non-numeric, and out-of-range macros/quantities (never a database error)', () => {
    expect(parsePayload(platformFoodPayload({ energyKcal: -1 }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ proteinG: Number.NaN }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ carbsG: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ fatG: '12' }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ quantity: 0 }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ quantity: -2 }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ quantity: 2_000_000 }))).toBeNull(); // beyond DECIMAL(9,3)
    expect(parsePayload(platformFoodPayload({ servingGramWeight: 0 }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ servingGramWeight: -1 }))).toBeNull();
  });

  it('rejects malformed references and overlong serving labels', () => {
    expect(parsePayload(platformFoodPayload({ foodId: 'not-a-uuid' }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ userFoodId: '123' }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ servingLabelEn: 'x'.repeat(101) }))).toBeNull();
    expect(parsePayload(platformFoodPayload({ servingLabelAr: '' }))).toBeNull();
  });

  it('rejects malformed ids, timestamps, and payload containers', () => {
    expect(parsePayload(platformFoodPayload(), { opId: 'nope' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { entityId: '11111111-1111-4111-8111-00000000000g' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { clientUpdatedAt: '2026-01-16T00:01:00+03:00' })).toBeNull(); // not a UTC instant
    expect(parsePayload(platformFoodPayload(), { clientUpdatedAt: 'yesterday' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { action: 'delete' })).toBeNull(); // deletes never parse a snapshot
    expect(parsePayload(platformFoodPayload(), { payload: 'string' })).toBeNull();
    expect(parsePayload(platformFoodPayload(), { payload: [1, 2] })).toBeNull();
  });
});

describe('UTC-instant parsing (the LWW substrate is client-authored UTC only)', () => {
  it('accepts Z-suffixed ISO instants only', () => {
    expect(parseUtcInstant('2026-01-15T23:59:00Z')?.toISOString()).toBe('2026-01-15T23:59:00.000Z');
    expect(parseUtcInstant('2026-01-15T23:59:00.5Z')?.toISOString()).toBe('2026-01-15T23:59:00.500Z');
    expect(parseUtcInstant('2026-01-15T23:59:00+00:00')).toBeNull(); // ISO, but not expressed in UTC
    expect(parseUtcInstant('2026-01-15T23:59:00+03:00')).toBeNull();
    expect(parseUtcInstant('2026-01-15')).toBeNull();
    expect(parseUtcInstant('')).toBeNull();
    expect(parseUtcInstant(17)).toBeNull();
    expect(parseUtcInstant('2026-13-40T99:99:99Z')).toBeNull();
  });
});

describe('snapshot ⇄ row mapping (what is frozen at write is what reads back — I11)', () => {
  it('round-trips a platform-food snapshot through row data and back', () => {
    const parsed = parsePayload(platformFoodPayload());
    if (parsed === null) {
      throw new Error('expected success');
    }
    const rowData = snapshotToRowData(parsed.snapshot);
    expect(rowData.localDate.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(rowData.foodId).toBe(FOOD_ID);
    expect(rowData.userFoodId).toBeNull();
    expect(rowData.servingGramWeight).toBe(200);
    const fakeRow = {
      id: ENTITY_ID,
      localDate: rowData.localDate,
      mealSlot: rowData.mealSlot,
      entryMethod: rowData.entryMethod,
      foodId: rowData.foodId,
      userFoodId: rowData.userFoodId,
      quantity: rowData.quantity,
      servingLabelEn: rowData.servingLabelEn,
      servingLabelAr: rowData.servingLabelAr,
      servingGramWeight: rowData.servingGramWeight,
      energyKcal: rowData.energyKcal,
      proteinG: rowData.proteinG,
      carbsG: rowData.carbsG,
      fatG: rowData.fatG,
      status: rowData.status,
    } as unknown as DiaryEntry;
    const roundTripped: DiaryEntrySnapshot = rowToSnapshot(fakeRow);
    expect(roundTripped).toEqual(parsed.snapshot);
  });

  it('derives sourceKind from the reference set (never stored, never carried)', () => {
    expect(deriveSourceKind(FOOD_ID, null)).toBe('platform_food');
    expect(deriveSourceKind(null, USER_FOOD_ID)).toBe('user_food');
    expect(deriveSourceKind(null, null)).toBe('quick_add');
  });

  it('projects the day-read entry view with identity and update metadata', () => {
    const fakeRow = {
      id: ENTITY_ID,
      localDate: new Date('2026-01-15T00:00:00.000Z'),
      mealSlot: 'lunch',
      entryMethod: 'recents',
      foodId: null,
      userFoodId: USER_FOOD_ID,
      quantity: 1.5,
      servingLabelEn: 'Cup',
      servingLabelAr: null,
      servingGramWeight: 180,
      energyKcal: 195,
      proteinG: 4.05,
      carbsG: 42,
      fatG: 0.45,
      status: 'edited',
      updatedAt: new Date('2026-01-16T05:00:00.000Z'),
    } as unknown as DiaryEntry;
    const view = rowToEntryView(fakeRow);
    expect(view).toMatchObject({
      id: ENTITY_ID,
      localDate: '2026-01-15',
      mealSlot: 'lunch',
      entryMethod: 'recents',
      sourceKind: 'user_food',
      foodId: null,
      userFoodId: USER_FOOD_ID,
      quantity: 1.5,
      servingGramWeight: 180,
      energyKcal: 195,
      status: 'edited',
      updatedAt: '2026-01-16T05:00:00.000Z',
    });
  });

  it('exposes the empty-day totals constant (an absent day reads as zeros, no oracle)', () => {
    expect(EMPTY_DAY_TOTALS).toEqual({ energyKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entryCount: 0 });
  });
});
