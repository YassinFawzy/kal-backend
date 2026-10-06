/**
 * Kal — the single exception type that carries a registry code.
 *
 * Services throw this; the global filter serializes it. `requestIdOverride`
 * exists ONLY for the static contract-fixture probe (conventions.md §6: the
 * served example must be byte-stable) and is honored just when the client
 * supplied no X-Request-Id of its own. No other call site may set it.
 */
import { KalProblemCode } from './error-codes.js';

export class KalProblemException extends Error {
  readonly code: KalProblemCode;
  readonly detail?: string;
  readonly errors?: readonly unknown[];
  readonly retryAfterSeconds?: number;
  readonly requestIdOverride?: string;

  constructor(
    code: KalProblemCode,
    options: {
      detail?: string;
      errors?: readonly unknown[];
      retryAfterSeconds?: number;
      requestIdOverride?: string;
    } = {},
  ) {
    super(`kal-problem:${code}`);
    this.name = 'KalProblemException';
    this.code = code;
    this.detail = options.detail;
    this.errors = options.errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.requestIdOverride = options.requestIdOverride;
  }
}
