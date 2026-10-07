/**
 * Kal — identity request validation and canonicalization (wave-02 contract §2).
 *
 * Pure functions: field validation NEVER consults the database and NEVER
 * echoes received values (contract §2; conventions §4 VALIDATION_FAILED).
 * Canonicalization happens before validation: email/username lowercased,
 * phone stripped of separator characters into the E.164 `+` form — the same
 * canonical forms the `users` CHECK constraints pin (migration
 * `20261007101836_identity_core`), so application and database can never
 * disagree about what a valid identifier is.
 *
 * Frozen shapes (contract §2):
 *   username  ^[a-z0-9_]{3,30}$            (after lowercasing)
 *   password  12–128 characters (length over composition)
 *   email     RFC-shaped, ≤ 254 chars      (after lowercasing)
 *   phone     ^\+[1-9][0-9]{6,15}$         (after separator stripping)
 *   deviceLabel ≤ 64 chars, optional
 *   X-Device-Id 1–128 printable ASCII chars, required on sign-in (§3)
 *   sign-in identifier: class by shape — contains '@' ⇒ email; '^+' ⇒ phone;
 *   otherwise username. No client-declared class, no per-class errors.
 */

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

export type ValidationOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface SignupInput {
  readonly email: string;
  readonly phone: string;
  readonly username: string;
  readonly password: string;
  readonly deviceLabel: string | null;
}

export interface SigninInput {
  /** Canonicalized identifier (email/username lowercased; phone E.164). */
  readonly identifier: string;
  readonly identifierClass: 'email' | 'phone' | 'username';
  readonly password: string;
  readonly deviceLabel: string | null;
  readonly deviceId: string;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/u;
const PHONE_PATTERN = /^\+[1-9][0-9]{6,15}$/u;/** Pragmatic RFC-shape: dot-atom local part + one or more dot-separated labels.
 * Local-part class = RFC 5321 atext (includes `-`). Supervisor-routed written
 * request 2026-10-07 (found during w02-s3-auth verification; s2 lane closed):
 * the class originally omitted the hyphen, wrongly rejecting valid RFC-shaped
 * addresses (e.g. live-123@x.test) — narrower than the frozen contract note §2
 * "email RFC-shaped, ≤ 254 chars". Direction dictated by the contract; DB CHECK
 * already loose; no migration, no fixture change. */
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
/** Opaque printable ASCII, same class as X-Request-Id (conventions §0). */
const DEVICE_ID_PATTERN = /^[\x20-\x7E]{1,128}$/u;
/** Sign-in identifier gross bound (email max; no class-specific 400/401 split). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this bound rejects
const IDENTIFIER_PATTERN = /^[^\x00-\x1F\x7F]{1,254}$/u;

const MAX_PASSWORD_CODEPOINTS = 128;
const MIN_PASSWORD_CODEPOINTS = 12;
const MAX_DEVICE_LABEL_CODEPOINTS = 64;

function codePointLength(value: string): number {
  // Code points are the contract's unit ("12–128 characters"); the spread is
  // the deliberate code-point decomposition (not a grapheme mistake).
  // eslint-disable-next-line @typescript-eslint/no-misused-spread, typescript/no-misused-spread
  return [...value].length;
}

/** Fixed generic messages — structural only; received values are never echoed. */
export const MESSAGES = {
  required: 'Required.',
  invalidFormat: 'Invalid format.',
  tooLong: (max: number): string => `Must be at most ${max} characters.`,
  tooShort: (min: number): string => `Must be at least ${min} characters.`,
  unexpectedField: 'Unexpected field.',
  notAString: 'Must be a string.',
} as const;

function fieldErrors(entries: readonly (readonly [string, string])[]): FieldError[] {
  return entries.map(([field, message]) => ({ field, message }));
}

/** Rejects non-objects and arrays (JSON bodies must be plain objects). */
function asPlainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

const ALLOWED_SIGNUP_FIELDS: readonly string[] = ['email', 'phone', 'username', 'password', 'deviceLabel'];
const ALLOWED_SIGNIN_FIELDS: readonly string[] = ['identifier', 'password', 'deviceLabel'];

/**
 * Canonicalizes an email candidate: trims surrounding whitespace and
 * lowercases. (Case in email local parts is canonicalized away per the
 * contract's "email/username lowercased"; the shape check runs after.)
 */
export function canonicalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  return raw.trim().toLowerCase();
}

export function canonicalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  return raw.trim().toLowerCase();
}

/** Canonicalizes a phone candidate: strips separator characters (spaces,
 * dashes, dots, parentheses, and the Unicode dash variants). Country codes
 * are NEVER inferred: the canonical form must already carry `+`. */
export function canonicalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  return raw.replace(/[\s.()\-\u2010-\u2015\u2212\uFF0D]/gu, '');
}

export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const length = codePointLength(raw);
  if (length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS) {
    return null;
  }
  return raw;
}

export function validateDeviceLabel(raw: unknown): string | null | false {
  // false = present but invalid; null = absent (valid optional); string = valid.
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    return false;
  }
  if (codePointLength(raw) > MAX_DEVICE_LABEL_CODEPOINTS) {
    return false;
  }
  return raw;
}

export function validateDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !DEVICE_ID_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}

export function validateSignupBody(body: unknown): ValidationOutcome<SignupInput> {
  const object = asPlainObject(body);
  if (object === null) {
    return { ok: false, errors: fieldErrors([['body', MESSAGES.invalidFormat]]) };
  }
  const errors: FieldError[] = [];
  for (const key of Object.keys(object)) {
    if (!ALLOWED_SIGNUP_FIELDS.includes(key)) {
      errors.push({ field: 'body', message: MESSAGES.unexpectedField });
      break;
    }
  }

  const email = canonicalizeEmail(object['email']);
  if (email === null || !EMAIL_PATTERN.test(email) || email.length > 254) {
    errors.push({ field: 'email', message: MESSAGES.invalidFormat });
  }
  const phone = canonicalizePhone(object['phone']);
  if (phone === null || !PHONE_PATTERN.test(phone)) {
    errors.push({ field: 'phone', message: MESSAGES.invalidFormat });
  }
  const username = canonicalizeUsername(object['username']);
  if (username === null || !USERNAME_PATTERN.test(username)) {
    errors.push({ field: 'username', message: MESSAGES.invalidFormat });
  }
  const password = validatePassword(object['password']);
  if (password === null) {
    errors.push({
      field: 'password',
      message:
        typeof object['password'] === 'string'
          ? `${MESSAGES.tooShort(MIN_PASSWORD_CODEPOINTS)} ${MESSAGES.tooLong(MAX_PASSWORD_CODEPOINTS)}`
          : MESSAGES.notAString,
    });
  }
  const deviceLabel = validateDeviceLabel(object['deviceLabel']);
  let validDeviceLabel: string | null = null;
  if (deviceLabel === false) {
    errors.push({ field: 'deviceLabel', message: MESSAGES.tooLong(MAX_DEVICE_LABEL_CODEPOINTS) });
  } else {
    validDeviceLabel = deviceLabel;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      email: email as string,
      phone: phone as string,
      username: username as string,
      password: password as string,
      deviceLabel: validDeviceLabel,
    },
  };
}

/** Class detection by canonical shape (contract §2): '@' ⇒ email; '^+' ⇒ phone; otherwise username. */
export function classifyIdentifier(raw: string): 'email' | 'phone' | 'username' {
  if (raw.includes('@')) {
    return 'email';
  }
  if (raw.startsWith('+')) {
    return 'phone';
  }
  return 'username';
}

/** Canonicalizes a submitted sign-in identifier per its detected class. */
export function canonicalizeIdentifier(raw: string): { identifier: string; identifierClass: 'email' | 'phone' | 'username' } {
  const identifierClass = classifyIdentifier(raw);
  if (identifierClass === 'email') {
    return { identifier: raw.trim().toLowerCase(), identifierClass };
  }
  if (identifierClass === 'phone') {
    return { identifier: canonicalizePhone(raw) as string, identifierClass };
  }
  return { identifier: raw.trim().toLowerCase(), identifierClass };
}

export function validateSigninBody(body: unknown, deviceIdHeader: unknown): ValidationOutcome<SigninInput> {
  const object = asPlainObject(body);
  if (object === null) {
    return { ok: false, errors: fieldErrors([['body', MESSAGES.invalidFormat]]) };
  }
  const errors: FieldError[] = [];
  for (const key of Object.keys(object)) {
    if (!ALLOWED_SIGNIN_FIELDS.includes(key)) {
      errors.push({ field: 'body', message: MESSAGES.unexpectedField });
      break;
    }
  }

  const deviceId = validateDeviceId(deviceIdHeader);
  if (deviceId === null) {
    errors.push({ field: 'headers.x-device-id', message: MESSAGES.required });
  }

  const rawIdentifier = object['identifier'];
  if (typeof rawIdentifier !== 'string' || !IDENTIFIER_PATTERN.test(rawIdentifier) || rawIdentifier.trim().length === 0) {
    errors.push({ field: 'identifier', message: MESSAGES.invalidFormat });
  }
  const password = validatePassword(object['password']);
  if (password === null) {
    errors.push({
      field: 'password',
      message:
        typeof object['password'] === 'string'
          ? `${MESSAGES.tooShort(MIN_PASSWORD_CODEPOINTS)} ${MESSAGES.tooLong(MAX_PASSWORD_CODEPOINTS)}`
          : MESSAGES.notAString,
    });
  }
  const deviceLabel = validateDeviceLabel(object['deviceLabel']);
  let validDeviceLabel: string | null = null;
  if (deviceLabel === false) {
    errors.push({ field: 'deviceLabel', message: MESSAGES.tooLong(MAX_DEVICE_LABEL_CODEPOINTS) });
  } else {
    validDeviceLabel = deviceLabel;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const { identifier, identifierClass } = canonicalizeIdentifier(rawIdentifier as string);
  return {
    ok: true,
    value: {
      identifier,
      identifierClass,
      password: password as string,
      deviceLabel: validDeviceLabel,
      deviceId: deviceId as string,
    },
  };
}
