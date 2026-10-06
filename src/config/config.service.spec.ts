import { describe, expect, it } from 'vitest';
import { ConfigService } from './config.service.js';

describe('ConfigService (boot-path, I15)', () => {
  it('constructs and exposes validated values when the environment is safe', () => {
    const previous = { ...process.env };
    try {
      process.env['DATABASE_URL'] = 'postgresql://kal_dev:local_fixture_only@localhost:5432/kal';
      process.env['PORT'] = '3211';
      process.env['NODE_ENV'] = 'development';
      const service = new ConfigService();
      expect(service.port).toBe(3211);
      expect(service.env).toBe('development');
    } finally {
      process.env = previous;
    }
  });

  it.each([
    'postgresql://kal_dev:changeme@localhost:5432/kal',
    'postgresql://kal_dev:TODO@localhost:5432/kal',
  ])('refuses to construct (serve) with a placeholder-class credential: %s', (url) => {
    const previous = { ...process.env };
    try {
      process.env['DATABASE_URL'] = url;
      expect(() => new ConfigService()).toThrow(/refusing to start/u);
    } finally {
      process.env = previous;
    }
  });

  it('failure messages never contain the refused credential value', () => {
    const previous = { ...process.env };
    try {
      process.env['DATABASE_URL'] = 'postgresql://kal_dev:super-secret-value@localhost:5432/kal';
      let message = '';
      try {
        new ConfigService(); // eslint-disable-line no-new
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain('super-secret-value');
      expect(message).toContain('DATABASE_URL');
    } finally {
      process.env = previous;
    }
  });
});
