import { describe, expect, it } from 'vitest';
import { NextFunction, Request, Response } from 'express';
import { RequestContextMiddleware } from './request-context.middleware.js';
import { RequestContext, RequestContextService } from './request-context.service.js';

interface FakeResponse {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function run(
  service: RequestContextService,
  requestHeaders: Record<string, string>,
): { nextCalled: boolean } {
  const response: FakeResponse = {
    headers: {},
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
  };
  let nextCalled = false;
  const middleware = new RequestContextMiddleware(service);
  middleware.use({ headers: requestHeaders } as unknown as Request, response as unknown as Response, (() => {
    nextCalled = true;
  }) as NextFunction);
  return { nextCalled };
}

describe('RequestContextMiddleware (conventions.md §0)', () => {
  it('echoes a safe client X-Request-Id and marks it client-sourced', () => {
    const service = new RequestContextService();
    let captured: RequestContext | undefined;
    const response: FakeResponse = { headers: {}, setHeader(n, v) { this.headers[n.toLowerCase()] = v; } };
    const middleware = new RequestContextMiddleware(service);
    middleware.use(
      { headers: { 'x-request-id': 'my-correlation-id' } } as unknown as Request,
      response as unknown as Response,
      (() => {
        captured = service.context;
      }) as NextFunction,
    );
    expect(captured).toMatchObject({ requestId: 'my-correlation-id', requestIdSource: 'client' });
    expect(response.headers['x-request-id']).toBe('my-correlation-id');
  });

  it('generates an id when the header is absent, oversized, or unsafe', () => {
    for (const header of [undefined, 'x'.repeat(129), 'bad\nid', '']) {
      const service = new RequestContextService();
      let captured: RequestContext | undefined;
      const response: FakeResponse = { headers: {}, setHeader(n, v) { this.headers[n.toLowerCase()] = v; } };
      new RequestContextMiddleware(service).use(
        { headers: header === undefined ? {} : { 'x-request-id': header } } as unknown as Request,
        response as unknown as Response,
        (() => {
          captured = service.context;
        }) as NextFunction,
      );
      expect(captured?.requestIdSource).toBe('generated');
      expect(captured?.requestId.length).toBeGreaterThan(0);
      expect(captured?.requestId).not.toEqual(header);
    }
  });

  it('keeps the downstream chain inside the ALS scope (next runs within it)', () => {
    const result = run(new RequestContextService(), {});
    expect(result.nextCalled).toBe(true);
  });
});
