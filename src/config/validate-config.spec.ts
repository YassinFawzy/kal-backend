import { describe, expect, it } from 'vitest';
import { isPlaceholderSecret, validateConfig } from './validate-config.js';

/** A fixture credential of the right SHAPE — synthetic, never a real secret. */
const FIXTURE_DB_URL = 'postgresql://kal_dev:local_fixture_only@localhost:5432/kal';

describe('isPlaceholderSecret (I15 placeholder classes)', () => {
  it('refuses empty and whitespace-only values', () => {
    expect(isPlaceholderSecret('')).toBe(true);
    expect(isPlaceholderSecret('   ')).toBe(true);
  });

  it('refuses changeme-class values in any spelling', () => {
    expect(isPlaceholderSecret('changeme')).toBe(true);
    expect(isPlaceholderSecret('ChangeMe')).toBe(true);
    expect(isPlaceholderSecret('change-me-now')).toBe(true);
    expect(isPlaceholderSecret('change_me_please')).toBe(true);
  });

  it('refuses TODO-class values', () => {
    expect(isPlaceholderSecret('TODO')).toBe(true);
    expect(isPlaceholderSecret('tbd-later')).toBe(true);
    expect(isPlaceholderSecret('FIXME!!')).toBe(true);
  });

  it('refuses obvious dummy literals', () => {
    expect(isPlaceholderSecret('password')).toBe(true);
    expect(isPlaceholderSecret('SECRET')).toBe(true);
    expect(isPlaceholderSecret('my-password-here')).toBe(true);
    expect(isPlaceholderSecret('example')).toBe(true);
    expect(isPlaceholderSecret('placeholder-value')).toBe(true);
    expect(isPlaceholderSecret('unset')).toBe(true);
    expect(isPlaceholderSecret('admin')).toBe(true);
  });

  it('refuses long single-character runs and pure digit runs', () => {
    expect(isPlaceholderSecret('aaaaaaaa')).toBe(true);
    expect(isPlaceholderSecret('********')).toBe(true);
    expect(isPlaceholderSecret('123456789')).toBe(true);
  });

  it('accepts values that merely resemble safe credentials', () => {
    expect(isPlaceholderSecret('local_fixture_only')).toBe(false);
    expect(isPlaceholderSecret('correct-horse-battery-staple')).toBe(false);
    expect(isPlaceholderSecret('Tr0ub4dor&3')).toBe(false);
  });
});

describe('validateConfig', () => {
  const validEnv = (): Record<string, string | undefined> => ({
    DATABASE_URL: FIXTURE_DB_URL,
    NODE_ENV: 'test',
    PORT: '3210',
  });

  it('accepts a valid configuration and applies defaults', () => {
    const env = validEnv();
    delete env['PORT'];
    delete env['NODE_ENV'];
    const result = validateConfig(env);
    expect(result).toMatchObject({
      ok: true,
      config: { env: 'development', port: 3000, databaseUrl: FIXTURE_DB_URL },
    });
  });

  it('accepts every supported NODE_ENV value and a bounded PORT', () => {
    for (const nodeEnv of ['development', 'production', 'test']) {
      const result = validateConfig({ ...validEnv(), NODE_ENV: nodeEnv, PORT: '1' });
      expect(result).toMatchObject({ ok: true, config: { env: nodeEnv, port: 1 } });
    }
    expect(validateConfig({ ...validEnv(), PORT: '65535' })).toMatchObject({ ok: true });
    expect(validateConfig({ ...validEnv(), PORT: '0' })).toMatchObject({ ok: false });
    expect(validateConfig({ ...validEnv(), PORT: '65536' })).toMatchObject({ ok: false });
    expect(validateConfig({ ...validEnv(), PORT: 'http' })).toMatchObject({ ok: false });
  });

  it('refuses a missing or empty DATABASE_URL', () => {
    const missing = validEnv();
    delete missing['DATABASE_URL'];
    expect(validateConfig(missing)).toMatchObject({ ok: false });
    expect(validateConfig({ ...validEnv(), DATABASE_URL: '   ' })).toMatchObject({ ok: false });
  });

  it('refuses malformed or non-PostgreSQL URLs without echoing them', () => {
    for (const bad of ['not-a-url', 'mysql://x:y@localhost/kal', 'postgresql:///']) {
      const result = validateConfig({ ...validEnv(), DATABASE_URL: bad });
      expect(result).toMatchObject({ ok: false });
      if (result.ok === false) {
        expect(result.errors.join(' ')).not.toContain(bad);
      }
    }
  });

  it.each([
    'postgresql://kal_dev:changeme@localhost:5432/kal',
    'postgresql://kal_dev:TODO@localhost:5432/kal',
    'postgresql://kal_dev@localhost:5432/kal',
    'postgresql://kal_dev:password@localhost:5432/kal',
    'postgresql://kal_dev:aaaaaaaa@localhost:5432/kal',
  ])('refuses placeholder-class credentials: %s', (url) => {
    const result = validateConfig({ ...validEnv(), DATABASE_URL: url });
    expect(result).toMatchObject({ ok: false });
    // Non-leaking: the message names the variable and the failure class, never the value.
    if (result.ok === false) {
      const message = result.errors.join(' ');
      expect(message).toContain('DATABASE_URL');
      expect(message.toLowerCase()).toContain('placeholder');
      expect(message).not.toContain('changeme');
      expect(message).not.toContain('aaaaaaaa');
    }
  });

  it('reports every failure at once (no partial boot)', () => {
    const result = validateConfig({ DATABASE_URL: 'nope', NODE_ENV: 'staging', PORT: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.length).toBe(3);
    }
  });
});
