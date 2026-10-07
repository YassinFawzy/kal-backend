/**
 * Kal — recovery request validation and canonicalization (wave-02 contract §2).
 *
 * Pure functions: field validation NEVER consults the database and NEVER
 * echoes received values (contract §2; conventions §4). The frozen shapes are
 * exactly the identity shapes (`identity-validation.ts` is the source of
 * truth for canonicalization and the password/device policies — consumed
 * here, never reimplemented):
 *
 *   recovery.request  body { identifier } + required X-Device-Id header —
 *                     identifier class detected by canonical shape ('@' ⇒
 *                     email, '^+' ⇒ phone, otherwise username), identical to
 *                     sign-in; no deviceLabel field.
 *   recovery.complete body { newPassword } — the signup password policy
 *                     (12–128 characters). The ticket is verified BEFORE this
 *                     body is validated (ordering frozen in contract §2);
 *                     that ordering lives in the commanding service, not here.
 *
 * Only the gross identifier bound is re-declared locally (the constant is not
 * exported by `identity-validation.ts` and that file is outside this lane's
 * owned paths); the value is character-for-character the frozen one.
 */
import {
  canonicalizeIdentifier,
  MESSAGES,
  validateDeviceId,
  validatePassword,
  type ValidationOutcome,
} from '../identity-validation.js';

export interface RecoveryRequestInput {
  /** Canonicalized identifier (email/username lowercased; phone E.164). */
  readonly identifier: string;
  readonly identifierClass: 'email' | 'phone' | 'username';
  readonly deviceId: string;
}

export interface RecoveryCompleteInput {
  readonly newPassword: string;
}

/** Sign-in identifier gross bound (email max; no class-specific 400/401 split). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this bound rejects
const IDENTIFIER_PATTERN = /^[^\x00-\x1F\x7F]{1,254}$/u;

const ALLOWED_REQUEST_FIELDS: readonly string[] = ['identifier'];
const ALLOWED_COMPLETE_FIELDS: readonly string[] = ['newPassword'];

function asPlainObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function rejectUnexpectedFields(object: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      return true;
    }
  }
  return false;
}

export function validateRecoveryRequestBody(body: unknown, deviceIdHeader: unknown): ValidationOutcome<RecoveryRequestInput> {
  const object = asPlainObject(body);
  if (object === null) {
    return { ok: false, errors: [{ field: 'body', message: MESSAGES.invalidFormat }] };
  }
  const errors: { field: string; message: string }[] = [];
  if (rejectUnexpectedFields(object, ALLOWED_REQUEST_FIELDS)) {
    errors.push({ field: 'body', message: MESSAGES.unexpectedField });
  }

  const deviceId = validateDeviceId(deviceIdHeader);
  if (deviceId === null) {
    errors.push({ field: 'headers.x-device-id', message: MESSAGES.required });
  }

  const rawIdentifier = object['identifier'];
  if (typeof rawIdentifier !== 'string' || !IDENTIFIER_PATTERN.test(rawIdentifier) || rawIdentifier.trim().length === 0) {
    errors.push({ field: 'identifier', message: MESSAGES.invalidFormat });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const { identifier, identifierClass } = canonicalizeIdentifier(rawIdentifier as string);
  return {
    ok: true,
    value: { identifier, identifierClass, deviceId: deviceId as string },
  };
}

export function validateRecoveryCompleteBody(body: unknown): ValidationOutcome<RecoveryCompleteInput> {
  const object = asPlainObject(body);
  if (object === null) {
    return { ok: false, errors: [{ field: 'body', message: MESSAGES.invalidFormat }] };
  }
  const errors: { field: string; message: string }[] = [];
  if (rejectUnexpectedFields(object, ALLOWED_COMPLETE_FIELDS)) {
    errors.push({ field: 'body', message: MESSAGES.unexpectedField });
  }

  const newPassword = validatePassword(object['newPassword']);
  if (newPassword === null) {
    errors.push({
      field: 'newPassword',
      message:
        typeof object['newPassword'] === 'string'
          ? `${MESSAGES.tooShort(12)} ${MESSAGES.tooLong(128)}`
          : MESSAGES.notAString,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { newPassword: newPassword as string } };
}
