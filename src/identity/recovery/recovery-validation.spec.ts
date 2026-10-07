/**
 * Unit — recovery request validation (wave-02 contract §2; conventions §4).
 *
 * Pure-function pins: shapes, canonicalization, the required X-Device-Id, the
 * frozen validation ORDERING invariant (ticket before password lives in the
 * service — here: the body policies themselves), and the redaction rule
 * (generic messages only — received values are never echoed).
 */
import { describe, expect, it } from 'vitest';
import { validateRecoveryCompleteBody, validateRecoveryRequestBody } from './recovery-validation.js';

const DEVICE = 'device-A-01';

describe('validateRecoveryRequestBody', () => {
  it('accepts each identifier class and canonicalizes exactly like sign-in', () => {
    const email = validateRecoveryRequestBody({ identifier: '  Kalila@Example.COM ' }, DEVICE);
    expect(email.ok).toBe(true);
    expect(email.ok && email.value).toMatchObject({ identifier: 'kalila@example.com', identifierClass: 'email', deviceId: DEVICE });

    const phone = validateRecoveryRequestBody({ identifier: '+20 100-0000.001' }, DEVICE);
    expect(phone.ok).toBe(true);
    expect(phone.ok && phone.value).toMatchObject({ identifier: '+201000000001', identifierClass: 'phone' });

    const username = validateRecoveryRequestBody({ identifier: 'Kalila_01' }, DEVICE);
    expect(username.ok).toBe(true);
    expect(username.ok && username.value).toMatchObject({ identifier: 'kalila_01', identifierClass: 'username' });
  });

  it('missing, oversized, or non-printable X-Device-Id is a generic 400 field error', () => {
    for (const device of [undefined, null, '', 'x'.repeat(129), 42]) {
      const result = validateRecoveryRequestBody({ identifier: 'kalila' }, device);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors).toEqual([{ field: 'headers.x-device-id', message: 'Required.' }]);
    }
  });

  it('rejects malformed identifiers, non-objects, arrays, and unexpected fields — value-free', () => {
    const malformed = validateRecoveryRequestBody({ identifier: '' }, DEVICE);
    expect(!malformed.ok && malformed.errors).toEqual([{ field: 'identifier', message: 'Invalid format.' }]);

    const unexpected = validateRecoveryRequestBody({ identifier: 'kalila', password: 'irrelevant-guest-value' }, DEVICE);
    expect(!unexpected.ok && unexpected.errors).toEqual([{ field: 'body', message: 'Unexpected field.' }]);

    for (const body of [null, 'identifier', 42, [], { identifier: 42 }, { identifier: null }, { identifier: 'a\tb' }]) {
      expect(validateRecoveryRequestBody(body, DEVICE).ok).toBe(false);
    }
    // A control character in the identifier is rejected by the gross bound.
    expect(validateRecoveryRequestBody({ identifier: 'kalila\n@example.com' }, DEVICE).ok).toBe(false);
  });

  it('error messages are generic constants — received values are never echoed', () => {
    // A control character fails the gross bound; the secret-looking value text
    // must not appear anywhere in the errors array.
    const secretLooking = { identifier: 'topsecret-identifier\tvalue' };
    const result = validateRecoveryRequestBody(secretLooking, DEVICE);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(!result.ok && result.errors)).not.toContain('topsecret');
  });
});

describe('validateRecoveryCompleteBody', () => {
  it('accepts the signup password policy (12–128 characters, length over composition)', () => {
    const shortest = validateRecoveryCompleteBody({ newPassword: 'a'.repeat(12) });
    expect(shortest.ok).toBe(true);
    const longest = validateRecoveryCompleteBody({ newPassword: 'b'.repeat(128) });
    expect(longest.ok).toBe(true);
    expect(validateRecoveryCompleteBody({ newPassword: 'c'.repeat(11) }).ok).toBe(false);
    expect(validateRecoveryCompleteBody({ newPassword: 'd'.repeat(129) }).ok).toBe(false);
    // Composition-free: 12 plain characters pass.
    expect(validateRecoveryCompleteBody({ newPassword: 'aaaaaaaaaaaa' }).ok).toBe(true);
  });

  it('rejects non-strings, non-objects, and unexpected fields', () => {
    for (const body of [null, undefined, 42, 'newPassword', [], { newPassword: 42 }, { newPassword: null }]) {
      expect(validateRecoveryCompleteBody(body).ok).toBe(false);
    }
    const unexpected = validateRecoveryCompleteBody({ newPassword: 'a'.repeat(12), identifier: 'x' });
    expect(!unexpected.ok && unexpected.errors).toEqual([{ field: 'body', message: 'Unexpected field.' }]);
  });

  it('missing body is the generic invalid-format 400 (field-generic, never value-echoing)', () => {
    const result = validateRecoveryCompleteBody(undefined);
    expect(!result.ok && result.errors).toEqual([{ field: 'body', message: 'Invalid format.' }]);
  });
});
