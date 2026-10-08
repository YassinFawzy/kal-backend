/**
 * Kal — user-food payload: the frozen entity snapshot shared by BOTH create
 * paths (wave-03 contract §1.1/§2: the REST body is the same payload shape as
 * the `user_food` sync op, with the same validation; the §2 read shapes are
 * the projection of the same snapshot).
 *
 * Field list (pinned here and by the round-trip suites against the contract's
 * field lists — §1.1):
 *   - `nameEn` / `nameAr`: optional strings, 1–200 chars after trim; AT LEAST
 *     ONE is required (schema CHECK `user_foods_at_least_one_name`).
 *   - `energyKcal`, `proteinG`, `carbsG`, `fatG`: REQUIRED finite numbers ≥ 0,
 *     bounded by the columns (DECIMAL(9,2) energy / DECIMAL(9,3) macros) so
 *     validation failures surface as `rejected_validation` / 400 — never as
 *     500s from constraint violations.
 *   - `servings`: optional array (absent ⇒ none) of AT MOST ONE variant
 *     `{ labelEn?, labelAr?, grams }` — the schema's partial unique index
 *     (`user_food_servings_active_per_food_key`) allows exactly one ACTIVE
 *     serving per user food (update ops replace the set); `grams` REQUIRED
 *     finite > 0 (a serving must resolve to a gram weight, FR-012).
 *
 * Validation failures NEVER echo received values (I12): errors carry
 * structural field paths + generic constraint messages only.
 */
import { isUuid } from '../../request-context/user-context.js';

/** Column bounds mirrored from the schema (DECIMAL(9,2) / DECIMAL(9,3)). */
export const ENERGY_MAX = 9_999_999.99;
export const MACRO_MAX = 999_999.999;
export const NAME_MAX_LENGTH = 200;
export const SERVINGS_MAX_COUNT = 1;

/** One validation error — structural path + generic message (no values, I12). */
export interface PayloadFieldError {
  readonly field: string;
  readonly message: string;
}

export interface UserFoodServingInput {
  readonly labelEn: string | null;
  readonly labelAr: string | null;
  readonly grams: number;
}

/** The validated create/update snapshot (identical shape for both). */
export interface UserFoodPayload {
  readonly nameEn: string | null;
  readonly nameAr: string | null;
  readonly energyKcal: number;
  readonly proteinG: number;
  readonly carbsG: number;
  readonly fatG: number;
  readonly servings: readonly UserFoodServingInput[];
}

export type PayloadValidationResult =
  | { readonly ok: true; readonly value: UserFoodPayload }
  | { readonly ok: false; readonly errors: readonly PayloadFieldError[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Optional trimmed string within 1..max after trim; null when absent. */
function optionalBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  errors: PayloadFieldError[],
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string when present.' });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    errors.push({ field, message: `must be between 1 and ${maxLength} characters after trim.` });
    return null;
  }
  return trimmed;
}

function requiredMacro(
  payload: Record<string, unknown>,
  field: string,
  max: number,
  errors: PayloadFieldError[],
): number | null {
  const value = payload[field];
  if (!isFiniteNumber(value)) {
    errors.push({ field, message: 'must be a finite number.' });
    return null;
  }
  if (value < 0 || value > max) {
    errors.push({ field, message: `must be between 0 and ${max}.` });
    return null;
  }
  return value;
}

/**
 * Validates the `user_food` create/update snapshot. Pure: no IO, no clock.
 * The same function serves the sync apply-handler (errors ⇒
 * `rejected_validation`) and the REST create (errors ⇒ 400 VALIDATION_FAILED).
 */
export function validateUserFoodPayload(payload: unknown): PayloadValidationResult {
  const errors: PayloadFieldError[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: 'payload', message: 'must be an object.' }] };
  }
  const record = payload as Record<string, unknown>;

  const nameEn = optionalBoundedText(record['nameEn'], 'nameEn', NAME_MAX_LENGTH, errors);
  const nameAr = optionalBoundedText(record['nameAr'], 'nameAr', NAME_MAX_LENGTH, errors);
  if (nameEn === null && nameAr === null && errors.length === 0) {
    errors.push({ field: 'nameEn', message: 'at least one of nameEn or nameAr is required.' });
  }

  const energyKcal = requiredMacro(record, 'energyKcal', ENERGY_MAX, errors);
  const proteinG = requiredMacro(record, 'proteinG', MACRO_MAX, errors);
  const carbsG = requiredMacro(record, 'carbsG', MACRO_MAX, errors);
  const fatG = requiredMacro(record, 'fatG', MACRO_MAX, errors);

  const servings: UserFoodServingInput[] = [];
  const rawServings = record['servings'];
  if (rawServings !== undefined && rawServings !== null) {
    if (!Array.isArray(rawServings)) {
      errors.push({ field: 'servings', message: 'must be an array when present.' });
    } else {
      if (rawServings.length > SERVINGS_MAX_COUNT) {
        errors.push({ field: 'servings', message: `must contain at most ${SERVINGS_MAX_COUNT} variants.` });
      }
      rawServings.forEach((raw, index) => {
        const base = `servings[${index}]`;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          errors.push({ field: base, message: 'must be an object.' });
          return;
        }
        const serving = raw as Record<string, unknown>;
        const labelEn = optionalBoundedText(serving['labelEn'], `${base}.labelEn`, NAME_MAX_LENGTH, errors);
        const labelAr = optionalBoundedText(serving['labelAr'], `${base}.labelAr`, NAME_MAX_LENGTH, errors);
        const grams = serving['grams'];
        if (!isFiniteNumber(grams)) {
          errors.push({ field: `${base}.grams`, message: 'must be a finite number.' });
        } else if (grams <= 0 || grams > MACRO_MAX) {
          errors.push({ field: `${base}.grams`, message: `must be between 0 (exclusive) and ${MACRO_MAX}.` });
        } else {
          servings.push({ labelEn, labelAr, grams });
        }
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      nameEn,
      nameAr,
      energyKcal: energyKcal as number,
      proteinG: proteinG as number,
      carbsG: carbsG as number,
      fatG: fatG as number,
      servings,
    },
  };
}

/** Validation result for the favorite target payload. */
export type FavoriteValidationResult =
  | { readonly ok: true; readonly value: FavoritePayload }
  | { readonly ok: false; readonly errors: readonly PayloadFieldError[] };

/**
 * The favorite payload: exactly one target — a platform food id XOR the
 * caller's own user-food id (schema CHECK XOR; the user-food side carries the
 * compound user reference, I3). Validated shape only — existence/ownership is
 * the handler's authorization step.
 */
export interface FavoritePayload {
  readonly foodId: string | null;
  readonly userFoodId: string | null;
}

export function validateFavoritePayload(payload: unknown): FavoriteValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: [{ field: 'payload', message: 'must be an object.' }] };
  }
  const record = payload as Record<string, unknown>;
  const foodId = record['foodId'];
  const userFoodId = record['userFoodId'];
  const errors: PayloadFieldError[] = [];

  const foodIdPresent = foodId !== undefined && foodId !== null;
  const userFoodIdPresent = userFoodId !== undefined && userFoodId !== null;
  if (foodIdPresent === userFoodIdPresent) {
    errors.push({ field: 'payload', message: 'exactly one of foodId or userFoodId is required.' });
  }
  if (foodIdPresent && (typeof foodId !== 'string' || !isUuid(foodId))) {
    errors.push({ field: 'foodId', message: 'must be a uuid when present.' });
  }
  if (userFoodIdPresent && (typeof userFoodId !== 'string' || !isUuid(userFoodId))) {
    errors.push({ field: 'userFoodId', message: 'must be a uuid when present.' });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      foodId: foodIdPresent ? (foodId as string) : null,
      userFoodId: userFoodIdPresent ? (userFoodId as string) : null,
    },
  };
}
