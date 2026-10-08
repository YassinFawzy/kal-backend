/**
 * Unit spec — the user-food + favorite payload validation (the frozen shared
 * shape: REST body === sync op payload, §1.1/§2). Generic messages, structural
 * field paths, received values never echoed (I12).
 */
import { describe, expect, it } from 'vitest';
import { validateFavoritePayload, validateUserFoodPayload } from './user-food.payload.js';

const VALID = {
  nameEn: 'Homemade lentil soup',
  nameAr: 'شوربة عدس بيتي',
  energyKcal: 90,
  proteinG: 5,
  carbsG: 14,
  fatG: 1.5,
  servings: [{ labelEn: 'Bowl', labelAr: 'طاسة', grams: 300 }],
};

describe('validateUserFoodPayload', () => {
  it('accepts the full valid snapshot', () => {
    const result = validateUserFoodPayload(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nameEn).toBe('Homemade lentil soup');
      expect(result.value.servings).toHaveLength(1);
    }
  });

  it('accepts AR-only and EN-only names; trims stored values', () => {
    const arOnly = validateUserFoodPayload({ ...VALID, nameEn: undefined });
    expect(arOnly.ok).toBe(true);
    const enOnly = validateUserFoodPayload({ ...VALID, nameAr: undefined });
    expect(enOnly.ok).toBe(true);
    const trimmed = validateUserFoodPayload({ ...VALID, nameAr: undefined, nameEn: '  padded name  ' });
    if (trimmed.ok) {
      expect(trimmed.value.nameEn).toBe('padded name');
    }
  });

  it('requires at least one name (schema CHECK parity)', () => {
    const result = validateUserFoodPayload({ ...VALID, nameEn: undefined, nameAr: undefined });
    expect(result.ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateUserFoodPayload(null).ok).toBe(false);
    expect(validateUserFoodPayload('food').ok).toBe(false);
    expect(validateUserFoodPayload([VALID]).ok).toBe(false);
  });

  it('rejects negative, non-finite, and over-column-bound macros with structural paths', () => {
    for (const field of ['energyKcal', 'proteinG', 'carbsG', 'fatG'] as const) {
      expect(validateUserFoodPayload({ ...VALID, [field]: -1 }).ok).toBe(false);
      expect(validateUserFoodPayload({ ...VALID, [field]: Number.NaN }).ok).toBe(false);
      expect(validateUserFoodPayload({ ...VALID, [field]: '90' }).ok).toBe(false);
      expect(validateUserFoodPayload({ ...VALID, [field]: 9_999_999_999 }).ok).toBe(false);
    }
    const result = validateUserFoodPayload({ ...VALID, proteinG: -2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('proteinG');
      expect(JSON.stringify(result.errors)).not.toContain('-2'); // values never echoed (I12)
    }
  });

  it('serving grams must be finite and positive (FR-012 resolution target)', () => {
    expect(validateUserFoodPayload({ ...VALID, servings: [{ grams: 0 }] }).ok).toBe(false);
    expect(validateUserFoodPayload({ ...VALID, servings: [{ grams: -5 }] }).ok).toBe(false);
    expect(validateUserFoodPayload({ ...VALID, servings: [{ grams: '300' }] }).ok).toBe(false);
    expect(validateUserFoodPayload({ ...VALID, servings: [{ grams: 300 }] }).ok).toBe(true);
  });

  it('bounds the serving array and rejects non-object servings', () => {
    const tooMany = validateUserFoodPayload({
      ...VALID,
      servings: Array.from({ length: 21 }, () => ({ grams: 10 })),
    });
    expect(tooMany.ok).toBe(false);
    expect(validateUserFoodPayload({ ...VALID, servings: 'two bowls' }).ok).toBe(false);
    expect(validateUserFoodPayload({ ...VALID, servings: [null] }).ok).toBe(false);
  });

  it('accepts absent servings (label-create minimum is a per-100g food)', () => {
    const { servings: _omit, ...withoutServings } = VALID;
    const result = validateUserFoodPayload(withoutServings);
    expect(result.ok).toBe(true);
  });
});

describe('validateFavoritePayload', () => {
  it('accepts exactly one target (XOR)', () => {
    expect(validateFavoritePayload({ foodId: '00000000-0000-4000-8000-00000000f001' }).ok).toBe(true);
    expect(validateFavoritePayload({ userFoodId: '00000000-0000-4000-8000-00000000f002' }).ok).toBe(true);
  });

  it('rejects both targets and neither', () => {
    expect(
      validateFavoritePayload({
        foodId: '00000000-0000-4000-8000-00000000f001',
        userFoodId: '00000000-0000-4000-8000-00000000f002',
      }).ok,
    ).toBe(false);
    expect(validateFavoritePayload({}).ok).toBe(false);
  });

  it('rejects non-uuid targets', () => {
    expect(validateFavoritePayload({ foodId: 'not-a-uuid' }).ok).toBe(false);
    expect(validateFavoritePayload({ userFoodId: 42 }).ok).toBe(false);
  });
});
