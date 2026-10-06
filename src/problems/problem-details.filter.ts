/**
 * Kal — global problem-details exception filter (conventions.md §4/§5).
 *
 * Every error response the API emits comes through here:
 *  - `KalProblemException` → its registered code (status per the registry).
 *  - Nest's route-level 404/405 → generic `NOT_FOUND` (no method/route
 *    disclosure; the registry has no other client-facing shape).
 *  - Anything else (unhandled) → generic `INTERNAL_ERROR`; details are
 *    logged internally, scrubbed, keyed by correlation id — never in the
 *    response (I7/I12).
 *
 * Bodies carry only the fixed envelope members; `detail` strings are the
 * registry's generic sentences. Content-Type is `application/problem+json`.
 */
import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { HttpArgumentsHost } from '@nestjs/common/interfaces';
import { Response } from 'express';
import { KAL_PROBLEM_CODES, KalProblemCode } from './error-codes.js';
import { KalProblemException } from './kal-problem.exception.js';
import { buildProblemDetails, ProblemDetailsBody } from './problem-details.js';
import { redactTextForLog } from './redact.js';
import { RequestContextService } from '../request-context/request-context.service.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly requestContext: RequestContextService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http: HttpArgumentsHost = host.switchToHttp();
    const response = http.getResponse<Response>();

    const body = this.toProblemDetails(exception);
    const metadata = KAL_PROBLEM_CODES[body.code];

    response
      .status(metadata.httpStatus)
      .header('Content-Type', 'application/problem+json')
      .header('X-Request-Id', body.requestId);
    if (body.code === 'RATE_LIMITED') {
      const retryAfter = exception instanceof KalProblemException ? exception.retryAfterSeconds : undefined;
      response.header('Retry-After', String(retryAfter ?? 1));
    }
    response.send(JSON.stringify(body));
  }

  private toProblemDetails(exception: unknown): ProblemDetailsBody {
    const requestId = this.resolveRequestId(exception);

    if (exception instanceof KalProblemException) {
      this.maybeLogInternal(exception.code, exception);
      return buildProblemDetails({
        code: exception.code,
        requestId,
        detail: exception.detail,
        errors: exception.errors,
      });
    }

    // Route-level misses and wrong-method hits: one generic NOT_FOUND.
    if (
      exception instanceof NotFoundException ||
      (exception instanceof HttpException && exception.getStatus() === HttpStatus.NOT_FOUND) ||
      (exception instanceof HttpException && exception.getStatus() === HttpStatus.METHOD_NOT_ALLOWED)
    ) {
      return buildProblemDetails({ code: 'NOT_FOUND', requestId });
    }

    // Nest BadRequest (framework validation surfaces we have not mapped):
    // generic VALIDATION_FAILED without echoing framework messages.
    if (exception instanceof BadRequestException) {
      return buildProblemDetails({ code: 'VALIDATION_FAILED', requestId });
    }

    this.logUnhandled(exception);
    return buildProblemDetails({ code: 'INTERNAL_ERROR', requestId });
  }

  /**
   * The fixture probe pins a stable correlation id (conventions §6: the
   * served example is byte-stable) — honored only when the client supplied
   * no X-Request-Id of its own.
   */
  private resolveRequestId(exception: unknown): string {
    const context = this.requestContext.context;
    if (context?.requestIdSource === 'client') {
      return context.requestId;
    }
    if (exception instanceof KalProblemException && exception.requestIdOverride !== undefined) {
      return exception.requestIdOverride;
    }
    return this.requestContext.requestIdForError();
  }

  /** Registered codes may still carry sensitive causes; log only scrubbed internals. */
  private maybeLogInternal(code: KalProblemCode, exception: KalProblemException): void {
    if (code === 'INTERNAL_ERROR' || code === 'UNAVAILABLE') {
      this.logger.warn(
        `problem-details: code=${code} requestId=${this.resolveRequestId(exception)} detail=${redactTextForLog(
          exception.cause instanceof Error ? exception.cause.message : (exception.detail ?? ''),
        )}`,
      );
    }
  }

  private logUnhandled(exception: unknown): void {
    const requestId = this.requestContext.requestIdForError();
    if (exception instanceof HttpException) {
      this.logger.warn(
        `unhandled http exception requestId=${requestId} status=${String(exception.getStatus())} message=${redactTextForLog(exception.message)}`,
      );
      return;
    }
    if (exception instanceof Error) {
      this.logger.error(
        `unhandled exception requestId=${requestId} name=${exception.name} message=${redactTextForLog(exception.message)}`,
      );
      return;
    }
    this.logger.error(`unhandled non-error throw requestId=${requestId}`);
  }
}
