/**
 * Kal — request-context middleware.
 *
 * Opens the AsyncLocalStorage scope around the whole downstream chain and
 * resolves the correlation id (conventions.md §0): the client's
 * X-Request-Id is echoed when it is a safe opaque value (≤128 printable
 * ASCII chars); otherwise one is generated. The resolved id is also set as
 * a response header so support conversations can correlate any exchange.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { RequestContext, RequestContextService } from './request-context.service.js';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const { requestId, source } = RequestContextService.resolveRequestId(
      request.headers?.['x-request-id'],
    );
    const context: RequestContext = { requestId, requestIdSource: source };
    response.setHeader('X-Request-Id', requestId);
    this.requestContext.run(context, () => next());
  }
}
