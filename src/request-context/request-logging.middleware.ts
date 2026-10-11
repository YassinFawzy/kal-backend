/**
 * Kal — request/response access log (2026-10-10 founder debugging session).
 *
 * One line per request reaches the dev console:
 *
 *   [RequestLoggingMiddleware] POST /identity/signin 200 45ms requestId=ab12…
 *   [RequestLoggingMiddleware] POST /identity/signin — closed WITHOUT a
 *     response after 15000ms (client aborted or hung) requestId=ab12…
 *
 * Why it exists: the app renders one generic offline message for EVERY
 * transport failure (offline / DNS / TLS / refused / timeout / CORS). This
 * log is the arrival proof that disambiguates them —
 *   - request NOT logged here ⇒ it never reached the API (wrong base URL,
 *     offline, DNS, TLS, or browser CORS blocked before send);
 *   - logged 200 but the app still says offline ⇒ the response is not
 *     making it back (most commonly CORS on the response);
 *   - logged `closed WITHOUT a response` after ~15s ⇒ the client's timeout
 *     guard fired while the API was still working (slow endpoint).
 *
 * Privacy (project conventions): logs carry ONLY method, path (route
 * pattern values only — opaque ids, no health data ever appears in a
 * path), status, duration, and the correlation id. Never query strings,
 * headers, bodies, tokens, or identifiers from payloads.
 */
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { RequestContextService } from './request-context.service.js';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggingMiddleware.name);

  constructor(private readonly requestContext: RequestContextService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    // Captured eagerly: this middleware runs inside the request-context ALS
    // scope (app.module registers it right after RequestContextMiddleware),
    // so the correlation id is already resolved here.
    const requestId = this.requestContext.getRequestId() ?? '—';
    const startedAt = Date.now();
    const label = `${request.method} ${request.path}`;
    let finished = false;

    response.on('finish', () => {
      finished = true;
      this.logger.log(`${label} ${response.statusCode} ${Date.now() - startedAt}ms requestId=${requestId}`);
    });

    response.on('close', () => {
      if (!finished) {
        // The socket ended without a complete response: the client went
        // away (abort/timeout on its side) or the connection hung — the
        // exact fingerprint of the app's 15s offline-timeout case.
        this.logger.warn(
          `${label} — closed WITHOUT a response after ${Date.now() - startedAt}ms (client aborted or hung) requestId=${requestId}`,
        );
      }
    });

    next();
  }
}
