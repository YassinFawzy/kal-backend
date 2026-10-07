import { describe, expect, it } from 'vitest';
import {
  canonicalizeEmail,
  canonicalizeIdentifier,
  canonicalizePhone,
  canonicalizeUsername,
  classifyIdentifier,
  validateSigninBody,
  validateSignupBody,
} from './identity-validation.js';

/**
 * Validation/canonicalization goldens (contract §2): shapes are validated
 * BEFORE any database access, canonical forms match the migration CHECKs,
 * and no validation error ever echoes a received value (I12).
 */

const PASSWORD = 'twelve-chars-min';
const EMAIL = ['kal', 'example.com'].join('@');
const EMAIL_MIXED = ['Amira', 'Example.COM'].join('@');

describe('signup validation (contract §2)', () => {
  const valid = { email: EMAIL, phone: '+20100123456', username: 'amira', password: PASSWORD };

  it('accepts and canonicalizes: email/username lowercased, phone separators stripped', () => {
    const result = validateSignupBody({
      email: EMAIL_MIXED,
      phone: '+20 100-123-4567',
      username: 'Amira_Hassan',
      password: PASSWORD,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe(EMAIL_MIXED.toLowerCase()); // lowercased canonical form
      expect(result.value.phone).toBe('+201001234567');
      expect(result.value.username).toBe('amira_hassan');
      expect(result.value.deviceLabel).toBeNull();
    }
  });

  it('accepts an optional deviceLabel within 64 characters', () => {
    const result = validateSignupBody({ ...valid, deviceLabel: 'iPhone 15' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deviceLabel).toBe('iPhone 15');
    }
  });

  it('rejects malformed identifiers with structural, value-free errors', () => {
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ['short username', { ...valid, username: 'ab' }, 'username'],
      ['overlong username', { ...valid, username: 'a'.repeat(31) }, 'username'],
      ['username bad chars', { ...valid, username: 'has-dash' }, 'username'],
      ['email missing @', { ...valid, email: 'not-an-email' }, 'email'],
      ['email double dot', { ...valid, email: 'a..b@example.com' }, 'email'],
      ['email over 254', { ...valid, email: ['a'.repeat(250), 'example.com'].join('@') }, 'email'],
      ['phone without +', { ...valid, phone: '201001234567' }, 'phone'],
      ['phone too short', { ...valid, phone: '+20' }, 'phone'],
      ['phone letters', { ...valid, phone: '+20ab123456' }, 'phone'],
      ['password 11 chars', { ...valid, password: 'short-pw-11' }, 'password'],
      ['password 129 chars', { ...valid, password: 'x'.repeat(129) }, 'password'],
      ['deviceLabel 65 chars', { ...valid, deviceLabel: 'x'.repeat(65) }, 'deviceLabel'],
      ['non-string username', { ...valid, username: 42 }, 'username'],
    ];
    for (const [name, body, field] of cases) {
      const result = validateSignupBody(body);
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((error) => error.field), name).toContain(field);
        for (const error of result.errors) {
          // Received values are never echoed (I12).
          expect(error.message).not.toContain(String(body[field]));
        }
      }
    }
  });

  it('password length counts code points (astral characters are one character each)', () => {
    // Exactly 12 code points including astral characters (one each).
    const astral = '🌍'.repeat(10) + 'ab';
    // eslint-disable-next-line @typescript-eslint/no-misused-spread, typescript(no-misused-spread) -- code points ARE the unit under test
    expect([...astral].length).toBe(12);
    const ok = validateSignupBody({ ...valid, password: astral });
    expect(ok.ok).toBe(true);
    const tooShort = validateSignupBody({ ...valid, password: '🌍'.repeat(3) + 'ab' }); // 5 code points
    expect(tooShort.ok).toBe(false);
  });

  it('rejects unknown fields and non-object bodies (malformed ⇒ 400 upstream)', () => {
    expect(validateSignupBody({ ...valid, isAdmin: true }).ok).toBe(false);
    expect(validateSignupBody(null).ok).toBe(false);
    expect(validateSignupBody([valid]).ok).toBe(false);
    expect(validateSignupBody('signup').ok).toBe(false);
  });

  it('a 128-character password is accepted, 129 is not (boundary)', () => {
    expect(validateSignupBody({ ...valid, password: 'a'.repeat(128) }).ok).toBe(true);
    expect(validateSignupBody({ ...valid, password: 'a'.repeat(129) }).ok).toBe(false);
    expect(validateSignupBody({ ...valid, password: 'a'.repeat(12) }).ok).toBe(true);
    expect(validateSignupBody({ ...valid, password: 'a'.repeat(11) }).ok).toBe(false);
  });
});

describe('signin validation (contract §2/§3)', () => {
  const body = { identifier: EMAIL, password: PASSWORD };

  it('classifies by canonical shape: @ ⇒ email, + ⇒ phone, otherwise username', () => {
    expect(classifyIdentifier(EMAIL)).toBe('email');
    expect(classifyIdentifier('+201001234567')).toBe('phone');
    expect(classifyIdentifier('amira')).toBe('username');
    expect(canonicalizeIdentifier('+20 100-123-4567')).toEqual({
      identifier: '+201001234567',
      identifierClass: 'phone',
    });
    expect(canonicalizeIdentifier('Amira')).toEqual({ identifier: 'amira', identifierClass: 'username' });
  });

  it('requires X-Device-Id (1–128 printable ASCII)', () => {
    expect(validateSigninBody(body, 'device-123').ok).toBe(true);
    expect(validateSigninBody(body, undefined).ok).toBe(false);
    expect(validateSigninBody(body, '').ok).toBe(false);
    expect(validateSigninBody(body, 'x'.repeat(129)).ok).toBe(false);
    expect(validateSigninBody(body, 'bad\nid').ok).toBe(false);
    const result = validateSigninBody(body, undefined);
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('headers.x-device-id');
    }
  });

  it('absent password and malformed identifiers are 400-class, value-free', () => {
    expect(validateSigninBody({ identifier: EMAIL }, 'device').ok).toBe(false);
    expect(validateSigninBody({ password: PASSWORD }, 'device').ok).toBe(false);
    expect(validateSigninBody({ identifier: '', password: PASSWORD }, 'device').ok).toBe(false);
    expect(validateSigninBody({ identifier: 'a\nc', password: PASSWORD }, 'device').ok).toBe(false);
    expect(validateSigninBody({ ...body, surprise: 1 }, 'device').ok).toBe(false);
  });

  it('gross identifier bound: 254 characters accepted shape-wise, 255 refused', () => {
    expect(validateSigninBody({ identifier: 'a'.repeat(254), password: PASSWORD }, 'device').ok).toBe(true);
    expect(validateSigninBody({ identifier: 'a'.repeat(255), password: PASSWORD }, 'device').ok).toBe(false);
  });
});

describe('canonicalization helpers', () => {
  it('email/username trim and lowercase; phone strips separators without country inference', () => {
    expect(canonicalizeEmail('  User@Example.COM ')).toBe(['user', 'example.com'].join('@'));
    expect(canonicalizeUsername('  Alice_99 ')).toBe('alice_99');
    expect(canonicalizePhone('+20 (100) 123-4567')).toBe('+201001234567');
    expect(canonicalizePhone('201001234567')).toBe('201001234567'); // no + ⇒ still invalid downstream
    expect(canonicalizePhone(42)).toBeNull();
  });
});

/**
 * Supervisor-routed written request 2026-10-07 (found during w02-s3-auth
 * verification; s2 lane closed; executed by the active identity lane s2b per
 * the scoped grant): the local-part class is RFC 5321 atext INCLUDING the
 * hyphen — the frozen contract note §2 "email RFC-shaped, ≤ 254 chars" is the
 * direction. Additive cases only; every pre-existing golden above is untouched.
 */
describe('email local part accepts RFC 5321 atext hyphens (supervisor-routed contract alignment)', () => {
  const base = { phone: '+20100123456', username: 'amira', password: PASSWORD };

  it('accepts hyphenated local parts at signup and sign-in, with canonicalization unchanged', () => {
    const signup = validateSignupBody({ ...base, email: 'Live-123@Example.COM', username: 'amira' });
    expect(signup.ok).toBe(true);
    if (signup.ok) {
      expect(signup.value.email).toBe('live-123@example.com'); // accepted AND lowercased
    }

    const signin = validateSigninBody({ identifier: 'First-Last@Example.com', password: PASSWORD }, 'device-1');
    expect(signin.ok).toBe(true);
    if (signin.ok) {
      expect(signin.value.identifier).toBe('first-last@example.com');
      expect(signin.value.identifierClass).toBe('email');
    }
  });

  it('still rejects malformed local parts (non-atext characters, empty atoms)', () => {
    for (const email of ['has space@example.com', '"quoted"@example.com', 'a..b@example.com', '.leading-dot@example.com', 'trailing.@example.com']) {
      const result = validateSignupBody({ ...base, email, username: 'amira' });
      expect(result.ok, email).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((error) => error.field === 'email')).toBe(true);
        expect(JSON.stringify(result.errors)).not.toContain(email); // value-free (I12)
      }
    }
  });
});
