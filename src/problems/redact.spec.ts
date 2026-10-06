import { describe, expect, it } from 'vitest';
import { redactErrorEntries, redactForProblemDetails, redactTextForLog } from './redact.js';

describe('redactForProblemDetails (adversarial, I7/I12)', () => {
  it('strips user-existence signal keys in every casing convention', () => {
    // The key shapes below deliberately include owner-flavored spellings:
    // whatever a call site (or a hostile payload) calls the signal, a key
    // carrying an existence/belongs-to token is stripped (I7) — the
    // denylist is wording-independent by design.
    const input = {
      ownerExists: true,
      owner_exists: 1,
      'OWNER-EXISTS': 'yes',
      recordFound: true,
      wasFound: true,
      exists: true,
      belongsTo: 'owner-b',
      isOwnedBy: 'owner-b',
      resultMatched: true,
      harmless: 'stays',
    };
    expect(redactForProblemDetails(input)).toEqual({ harmless: 'stays' });
  });

  it('strips health-shaped keys (nested) (I12)', () => {
    const input = {
      entry: {
        weightKg: 82.5,
        glucose_mgdl: 90,
        heartRate: 60,
        macros: { protein: 1 },
        note: 'kept',
      },
      topLevelCalories: 2000,
    };
    expect(redactForProblemDetails(input)).toEqual({ entry: { note: 'kept' } });
  });

  it('strips internal/infrastructure keys', () => {
    const input = {
      stack: new Error('x').stack,
      sql: 'SELECT * FROM weight_log',
      query: 'SELECT 1',
      host: 'db.internal',
      env: { DATABASE_URL: 'postgresql://x' },
      filePath: '/etc/kal/secrets',
      config: {},
      provider: 'some-vendor',
      authorization: 'Bearer abc',
      safe: 'kept',
    };
    expect(redactForProblemDetails(input)).toEqual({ safe: 'kept' });
  });

  it('never mutates the input and survives prototype-pollution attempts', () => {
    const input: Record<string, unknown> = { __proto__: { polluted: true }, prototype: 'x', constructor: 'x', ok: 1 };
    const output = redactForProblemDetails(input) as Record<string, unknown>;
    expect(output).toEqual({ ok: 1 });
    expect(output['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(input['ok']).toBe(1);
  });

  it('caps runaway nesting depth', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 30; i += 1) {
      deep = { nested: deep };
    }
    // Deeper than the cap the structure collapses to a truncation marker —
    // the exact level is an implementation detail; the guarantee is that no
    // unbounded structure survives.
    const redacted = redactForProblemDetails(deep) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).toContain('[truncated]');
  });

  it('does not mistake benign keys for denied shapes', () => {
    const input = { messageId: 'm1', foundation: 'x', portable: true, settings: { theme: 'lagoon' } };
    expect(redactForProblemDetails(input)).toEqual(input);
  });

  it('is conservatively deny-by-key: plausible-but-risky keys like fieldPath are stripped', () => {
    // "fieldPath" normalizes to field_path which contains the denied token
    // "path" — deny-by-key wins over convenience. The errors array's field
    // paths are protected separately by the allowlist projection.
    expect(redactForProblemDetails({ fieldPath: 'a.b', ok: 1 })).toEqual({ ok: 1 });
  });
});

describe('redactErrorEntries (allowlist projection)', () => {
  it('keeps only field + message; received values never survive', () => {
    const entries = [
      { field: 'entries[3].weightKg', message: 'Must be a positive number.', receivedValue: 'evil', stack: 'x' },
      { field: 'q', message: 'Required.' },
      { field: '', message: 'dropped: empty field' },
      { message: 'dropped: no field' },
      'not-an-object',
      null,
    ];
    expect(redactErrorEntries(entries)).toEqual([
      { field: 'entries[3].weightKg', message: 'Must be a positive number.' },
      { field: 'q', message: 'Required.' },
    ]);
  });

  it('returns undefined for absent input (member omitted, not empty array)', () => {
    expect(redactErrorEntries(undefined)).toBeUndefined();
  });

  it('caps pathological lengths', () => {
    const long = 'x'.repeat(1000);
    expect(redactErrorEntries([{ field: long, message: long }])).toEqual([
      { field: 'x'.repeat(256), message: 'x'.repeat(256) },
    ]);
  });
});

describe('redactTextForLog (internal logs only)', () => {
  it('scrubs connection strings and bearer tokens, truncates', () => {
    const text = 'failed: postgresql://user:pass@db:5432/kal via bearer abc.def.ghi';
    const scrubbed = redactTextForLog(text);
    expect(scrubbed).not.toContain('db:5432');
    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).toContain('[redacted-url]');
    expect(redactTextForLog('x'.repeat(900)).length).toBe(500);
  });
});
