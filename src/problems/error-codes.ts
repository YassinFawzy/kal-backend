/**
 * Kal — application error-code registry (frozen contract).
 *
 * Source of truth: `docs/api/conventions.md` §4 (FROZEN by lane w01-s1-schema).
 * Codes are never renamed or repurposed; new codes join only via a written
 * conventions-change request through the wave supervisor. A compatibility
 * fixture (`error-codes.spec.ts`) pins this table byte-for-byte to the doc.
 *
 * `INTERNAL_ERROR` and `UNAVAILABLE` are s1's registered additions to the
 * contract's six codes (rationale recorded in conventions.md §4 inline).
 */

export interface ProblemCodeMetadata {
  readonly httpStatus: number;
  /** URN carried in the problem-details `type` member. */
  readonly urn: string;
  /** Fixed, generic `title` — identical for every response of this code. */
  readonly title: string;
}

export const KAL_PROBLEM_CODES = {
  VALIDATION_FAILED: {
    httpStatus: 400,
    urn: 'urn:kal:problem:validation-failed',
    title: 'Validation failed',
  },
  UNAUTHENTICATED: {
    httpStatus: 401,
    urn: 'urn:kal:problem:unauthenticated',
    title: 'Unauthenticated',
  },
  FORBIDDEN: {
    httpStatus: 403,
    urn: 'urn:kal:problem:forbidden',
    title: 'Forbidden',
  },
  NOT_FOUND: {
    httpStatus: 404,
    urn: 'urn:kal:problem:not-found',
    title: 'Not found',
  },
  CONFLICT: {
    httpStatus: 409,
    urn: 'urn:kal:problem:conflict',
    title: 'Conflict',
  },
  RATE_LIMITED: {
    httpStatus: 429,
    urn: 'urn:kal:problem:rate-limited',
    title: 'Too many requests',
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    urn: 'urn:kal:problem:internal-error',
    title: 'Internal error',
  },
  UNAVAILABLE: {
    httpStatus: 503,
    urn: 'urn:kal:problem:unavailable',
    title: 'Service unavailable',
  },
} as const satisfies Record<string, ProblemCodeMetadata>;

export type KalProblemCode = keyof typeof KAL_PROBLEM_CODES;

export const KAL_PROBLEM_CODE_NAMES = Object.keys(KAL_PROBLEM_CODES) as readonly KalProblemCode[];

/**
 * Fixed, generic `detail` sentences per code — written once here so every
 * response of a code carries the same redaction-contract-bound text. Call
 * sites may override with an equally generic constant; they must never
 * interpolate request data (I7/I12).
 */
export const GENERIC_DETAIL: Readonly<Record<KalProblemCode, string>> = {
  VALIDATION_FAILED: 'One or more fields are invalid.',
  UNAUTHENTICATED: 'Credentials are missing, malformed, expired, or revoked.',
  FORBIDDEN: 'The current context is not permitted to perform this operation.',
  NOT_FOUND: 'The requested resource was not found, or it does not belong to the caller.',
  CONFLICT: 'The request conflicts with the current state.',
  RATE_LIMITED: 'Too many requests; retry later.',
  INTERNAL_ERROR: 'An unexpected internal error occurred.',
  UNAVAILABLE: 'The service is temporarily unable to serve requests.',
};
