/**
 * Kal — RFC 9457-style problem-details envelope builder (conventions.md §5).
 *
 * Members are fixed: type, title, status, code (always, registry values);
 * detail (optional, generic constants only); requestId (always); errors
 * (only VALIDATION_FAILED, allowlist-projected). Extensions beyond these
 * members require a conventions-change request — so there is deliberately
 * NO channel here for arbitrary payloads.
 */
import {
  GENERIC_DETAIL,
  KAL_PROBLEM_CODES,
  KalProblemCode,
} from './error-codes.js';
import { redactErrorEntries, RedactedErrorEntry } from './redact.js';

export interface ProblemDetailsBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: KalProblemCode;
  readonly detail?: string;
  readonly requestId: string;
  readonly errors?: readonly RedactedErrorEntry[];
}

export interface BuildProblemDetailsInput {
  readonly code: KalProblemCode;
  readonly requestId: string;
  /** Optional generic detail; defaults to the registry's fixed sentence. */
  readonly detail?: string;
  /** Only honored (and projected) for VALIDATION_FAILED. */
  readonly errors?: readonly unknown[];
}

export function buildProblemDetails(input: BuildProblemDetailsInput): ProblemDetailsBody {
  const metadata = KAL_PROBLEM_CODES[input.code];
  const body: {
    type: string;
    title: string;
    status: number;
    code: KalProblemCode;
    detail?: string;
    requestId: string;
    errors?: readonly RedactedErrorEntry[];
  } = {
    type: metadata.urn,
    title: metadata.title,
    status: metadata.httpStatus,
    code: input.code,
    requestId: input.requestId,
  };
  const detail = input.detail ?? GENERIC_DETAIL[input.code];
  if (detail.length > 0) {
    body.detail = detail;
  }
  if (input.code === 'VALIDATION_FAILED' && input.errors !== undefined) {
    body.errors = redactErrorEntries(input.errors) ?? [];
  }
  return body;
}
