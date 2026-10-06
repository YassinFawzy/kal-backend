/**
 * Kal — boot-time configuration validation (I15).
 *
 * Runs BEFORE the process serves any traffic: `ConfigService` is constructed
 * during AppModule initialization, so an invalid configuration makes every
 * boot path (including the e2e harness) fail fast.
 *
 * Redaction contract: error messages name the variable and the failure CLASS
 * only. Values — especially credential components — are never echoed.
 */

export type KalEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  env: KalEnv;
  port: number;
  /** Validated PostgreSQL connection URL (never logged, never echoed). */
  databaseUrl: string;
}

export type ConfigValidationResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const ENV_VALUES: readonly KalEnv[] = ['development', 'production', 'test'];

const DEFAULT_PORT = 3000;

/**
 * Placeholder-class secret detection (I15). A credential value is refused as
 * unsafe when it is empty, a well-known placeholder ("changeme"-class,
 * "TODO"-class), an obviously dummy literal, or a long single-character run.
 * Deliberately conservative: the goal is catching forgotten defaults, not
 * policing password strength.
 */
export function isPlaceholderSecret(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) {
    return true;
  }
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  const placeholderTokens = [
    'changeme',
    'changeit',
    'placeholder',
    'todo',
    'tbd',
    'fixme',
    'dummy',
    'example',
    'sample',
    'default',
    'password',
    'passwd',
    'secret',
    'letmein',
    'qwerty',
    'admin',
    'test',
    'unset',
    'redacted',
    'xxxxxxxx',
  ];
  if (placeholderTokens.some((token) => normalized.includes(token))) {
    return true;
  }
  if (/^(.)\1{7,}$/u.test(value)) {
    // 8+ repetitions of a single character ("aaaaaaaa", "********").
    return true;
  }
  if (/^[0-9]{6,}$/u.test(value)) {
    // Long pure-digit runs ("123456789").
    return true;
  }
  return false;
}

function validateDatabaseUrl(raw: string | undefined): { url: URL } | { error: string } {
  if (raw === undefined || raw.trim().length === 0) {
    return { error: 'DATABASE_URL is required (the API cannot start without its system of record).' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'DATABASE_URL is not a parseable URL (expected a postgresql:// connection string).' };
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return { error: 'DATABASE_URL must use the postgresql:// or postgres:// scheme.' };
  }
  if (url.hostname.length === 0) {
    return { error: 'DATABASE_URL is missing a database host.' };
  }
  if (url.pathname.replace(/^\//u, '').length === 0) {
    return { error: 'DATABASE_URL is missing a database name.' };
  }
  // The password is a credential: refuse empty or placeholder-class values
  // (I15). The value itself is never included in any message.
  if (isPlaceholderSecret(decodeURIComponent(url.password))) {
    return {
      error:
        'DATABASE_URL has an empty or placeholder-class password; refusing to start. ' +
        'Set a real credential in the environment (never in code or fixtures).',
    };
  }
  return { url };
}

export function validateConfig(env: Record<string, string | undefined>): ConfigValidationResult {
  const errors: string[] = [];

  const database = validateDatabaseUrl(env['DATABASE_URL']);
  if ('error' in database) {
    errors.push(database.error);
  }

  const envRaw = env['NODE_ENV'] ?? 'development';
  let nodeEnv: KalEnv | undefined;
  if ((ENV_VALUES as readonly string[]).includes(envRaw)) {
    nodeEnv = envRaw as KalEnv;
  } else {
    errors.push(`NODE_ENV must be one of: ${ENV_VALUES.join(', ')}.`);
  }

  let port = DEFAULT_PORT;
  const portRaw = env['PORT'];
  if (portRaw !== undefined && portRaw.length > 0) {
    if (/^[0-9]+$/u.test(portRaw) && Number(portRaw) >= 1 && Number(portRaw) <= 65_535) {
      port = Number(portRaw);
    } else {
      errors.push('PORT must be an integer between 1 and 65535.');
    }
  }

  if (errors.length > 0 || 'error' in database || nodeEnv === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      env: nodeEnv,
      port,
      databaseUrl: database.url.toString(),
    },
  };
}
