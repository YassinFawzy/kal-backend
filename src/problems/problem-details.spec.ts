import { describe, expect, it } from 'vitest';
import { buildProblemDetails } from './problem-details.js';

const REQUEST_ID = '00000000-0000-4000-8000-0000000000c0';

describe('buildProblemDetails (conventions.md §5)', () => {
  it('always carries type, title, status, code, requestId', () => {
    const body = buildProblemDetails({ code: 'NOT_FOUND', requestId: REQUEST_ID });
    expect(body).toEqual({
      type: 'urn:kal:problem:not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'The requested resource was not found, or it does not belong to the caller.',
      requestId: REQUEST_ID,
    });
  });

  it('includes errors ONLY on VALIDATION_FAILED', () => {
    const withErrors = buildProblemDetails({
      code: 'VALIDATION_FAILED',
      requestId: REQUEST_ID,
      errors: [{ field: 'entries[3].weightKg', message: 'Must be a positive number.' }],
    });
    expect(withErrors.errors).toEqual([
      { field: 'entries[3].weightKg', message: 'Must be a positive number.' },
    ]);

    const withoutErrors = buildProblemDetails({ code: 'VALIDATION_FAILED', requestId: REQUEST_ID });
    expect(withoutErrors.errors).toBeUndefined();

    // errors on any other code are ignored, not serialized
    const wrongCode = buildProblemDetails({
      code: 'CONFLICT',
      requestId: REQUEST_ID,
      errors: [{ field: 'x', message: 'y' }],
    });
    expect(wrongCode.errors).toBeUndefined();
  });

  it('uses the registry generic detail when none is supplied', () => {
    const body = buildProblemDetails({ code: 'UNAVAILABLE', requestId: REQUEST_ID });
    expect(body.detail).toBe('The service is temporarily unable to serve requests.');
  });

  it('is deterministic per (code, situation class) — same inputs, identical body', () => {
    const a = buildProblemDetails({ code: 'FORBIDDEN_OWNER', requestId: REQUEST_ID });
    const b = buildProblemDetails({ code: 'FORBIDDEN_OWNER', requestId: REQUEST_ID });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
