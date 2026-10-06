import { describe, expect, it } from 'vitest';
import { GENERIC_DETAIL, KAL_PROBLEM_CODES, KAL_PROBLEM_CODE_NAMES } from './error-codes.js';

/**
 * Compatibility fixture: pins the served registry to `docs/api/conventions.md`
 * §4 EXACTLY (conventions are frozen; a drift here is a conventions violation).
 */
describe('error-code registry (conventions.md §4)', () => {
  it('contains exactly the eight registered codes', () => {
    expect([...KAL_PROBLEM_CODE_NAMES].sort()).toEqual(
      [
        'VALIDATION_FAILED',
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'NOT_FOUND',
        'CONFLICT',
        'RATE_LIMITED',
        'INTERNAL_ERROR',
        'UNAVAILABLE',
      ].sort(),
    );
  });

  it('pins status, URN type, and title per the frozen table', () => {
    expect(KAL_PROBLEM_CODES['VALIDATION_FAILED']).toEqual({
      httpStatus: 400,
      urn: 'urn:kal:problem:validation-failed',
      title: 'Validation failed',
    });
    expect(KAL_PROBLEM_CODES['UNAUTHENTICATED']).toEqual({
      httpStatus: 401,
      urn: 'urn:kal:problem:unauthenticated',
      title: 'Unauthenticated',
    });
    expect(KAL_PROBLEM_CODES['FORBIDDEN']).toEqual({
      httpStatus: 403,
      urn: 'urn:kal:problem:forbidden',
      title: 'Forbidden',
    });
    expect(KAL_PROBLEM_CODES['NOT_FOUND']).toEqual({
      httpStatus: 404,
      urn: 'urn:kal:problem:not-found',
      title: 'Not found',
    });
    expect(KAL_PROBLEM_CODES['CONFLICT']).toEqual({
      httpStatus: 409,
      urn: 'urn:kal:problem:conflict',
      title: 'Conflict',
    });
    expect(KAL_PROBLEM_CODES['RATE_LIMITED']).toEqual({
      httpStatus: 429,
      urn: 'urn:kal:problem:rate-limited',
      title: 'Too many requests',
    });
    expect(KAL_PROBLEM_CODES['INTERNAL_ERROR']).toEqual({
      httpStatus: 500,
      urn: 'urn:kal:problem:internal-error',
      title: 'Internal error',
    });
    expect(KAL_PROBLEM_CODES['UNAVAILABLE']).toEqual({
      httpStatus: 503,
      urn: 'urn:kal:problem:unavailable',
      title: 'Service unavailable',
    });
  });

  it('carries a fixed generic detail sentence for every code', () => {
    for (const code of KAL_PROBLEM_CODE_NAMES) {
      expect(GENERIC_DETAIL[code].length).toBeGreaterThan(0);
    }
  });
});
