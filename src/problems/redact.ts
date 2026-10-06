/**
 * Kal — shared problem-details redactor (conventions.md §5).
 *
 * "A single shared redactor strips user-existence signals, health-shaped
 * keys, and internal fields from every problem-details construction."
 *
 * Every module that attaches structured data anywhere near a problem-details
 * body MUST pass it through `redactForProblemDetails` first. The envelope
 * builder and the global filter enforce the fixed members themselves; this
 * helper is the defense-in-depth for anything structured that a call site
 * carries alongside (e.g. `errors` entries).
 *
 * Design notes:
 *  - Deny-by-key: the token sets below are what the conventions bind. Keys
 *    are normalized (camelCase/snake_case/kebab-case → snake) and refused
 *    when any denied token appears at a token boundary.
 *  - The `errors` array additionally goes through `redactErrorEntry`, an
 *    allowlist projection — received values are never echoed, period.
 *  - Prototype-polluting keys ("__proto__", "prototype", "constructor") are
 *    denied unconditionally and the clone never mutates the input.
 */

/** Normalizes a key to lowercase snake-ish tokens for shape matching. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/gu, '_')
    .toLowerCase();
}

function containsToken(normalizedKey: string, token: string): boolean {
  return new RegExp(`(^|_)${token}(_|$)`, 'u').test(normalizedKey);
}

/** Keys whose presence signals whether another user's object exists (I7). */
const USER_EXISTENCE_TOKENS: readonly string[] = [
  'exists',
  'exist',
  'existed',
  'existing',
  'found',
  'present',
  'matched',
  'matching',
  'hit',
  'hits',
  'belongs_to',
  'owned_by',
  'visible',
  'visibility',
  'accessible',
];

/** Keys carrying health-shaped content (I12 — never in responses or logs). */
const HEALTH_TOKENS: readonly string[] = [
  'weight',
  'weigh',
  'weigh_in',
  'height',
  'bmi',
  'body_fat',
  'bodyfat',
  'glucose',
  'blood',
  'heart',
  'heartrate',
  'pulse',
  'steps',
  'calorie',
  'calories',
  'kcal',
  'macro',
  'macros',
  'protein',
  'carb',
  'carbs',
  'fat',
  'diary',
  'meal',
  'food',
  'nutrition',
  'workout',
  'exercise',
  'reps',
  'medication',
  'dose',
  'dosage',
  'diagnosis',
  'symptom',
  'condition',
  'pregnancy',
  'pregnant',
  'menstrual',
  'cycle',
  'sleep',
  'tdee',
  'bmr',
];

/** Keys carrying internal/infrastructure detail (I7/I12). */
const INTERNAL_TOKENS: readonly string[] = [
  'stack',
  'stacktrace',
  'trace',
  'sql',
  'query',
  'bindings',
  'bound_values',
  'host',
  'hostname',
  'env',
  'environment',
  'cwd',
  'path',
  'filepath',
  'file_path',
  'filename',
  'file_name',
  'directory',
  'dir',
  'config',
  'secret',
  'secrets',
  'password',
  'passwd',
  'credential',
  'credentials',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'header',
  'internal',
  'debug',
  'connection_string',
  'dsn',
  'provider',
  'vendor',
  'driver',
];

/** Universal guard: these keys are never safe regardless of position. */
const ABSOLUTE_DENY_TOKENS: readonly string[] = ['__proto__', 'proto', 'prototype', 'constructor'];

function isDeniedKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    ABSOLUTE_DENY_TOKENS.some((token) => normalized.includes(token)) ||
    USER_EXISTENCE_TOKENS.some((token) => containsToken(normalized, token)) ||
    HEALTH_TOKENS.some((token) => containsToken(normalized, token)) ||
    INTERNAL_TOKENS.some((token) => containsToken(normalized, token))
  );
}

/**
 * Deep-strips denied keys from a structured value. Returns a sanitized
 * structural clone — the input is never mutated, and prototype-polluting
 * keys are removed before they can reach Object operations.
 */
export function redactForProblemDetails(value: unknown, maxDepth = 12): unknown {
  if (maxDepth <= 0) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForProblemDetails(item, maxDepth - 1));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (isDeniedKey(key)) {
        continue;
      }
      output[key] = redactForProblemDetails(item, maxDepth - 1);
    }
    return output;
  }
  return value;
}

/** The only members an `errors` entry may carry (conventions.md §5). */
export interface RedactedErrorEntry {
  readonly field: string;
  readonly message: string;
}

/**
 * Allowlist projection for `VALIDATION_FAILED` `errors` entries: field path
 * (structural) + generic constraint message. Anything else — most notably
 * any received value — is dropped (conventions.md §4/§5).
 */
export function redactErrorEntry(candidate: unknown): RedactedErrorEntry | null {
  if (candidate === null || typeof candidate !== 'object') {
    return null;
  }
  const source = candidate as Record<string, unknown>;
  const field = source['field'];
  const message = source['message'];
  if (typeof field !== 'string' || field.length === 0 || typeof message !== 'string') {
    return null;
  }
  // Field paths are structural ("entries[3].weightKg"); cap absurd lengths.
  return { field: field.slice(0, 256), message: message.slice(0, 256) };
}

export function redactErrorEntries(
  candidates: readonly unknown[] | undefined,
): RedactedErrorEntry[] | undefined {
  if (candidates === undefined) {
    return undefined;
  }
  return candidates
    .map((entry) => redactErrorEntry(entry))
    .filter((entry): entry is RedactedErrorEntry => entry !== null);
}

/**
 * Scrubs credential-shaped material from free text destined for internal
 * logs (never for responses). Used by the global filter when logging
 * unhandled errors: exception messages can embed SQL or connection strings.
 */
export function redactTextForLog(text: string, maxLength = 500): string {
  return text
    .replace(/postgres(ql)?:\/\/\S+/giu, '[redacted-url]')
    .replace(/(bearer\s+)\S+/giu, '$1[redacted]')
    .slice(0, maxLength);
}
