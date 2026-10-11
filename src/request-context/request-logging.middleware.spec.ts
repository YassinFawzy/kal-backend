import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { NextFunction, Request, Response } from 'express';
import { RequestLoggingMiddleware } from './request-logging.middleware.js';
import { RequestContextService } from './request-context.service.js';

/** Minimal fake request/response pair with the events the middleware uses. */
function fakeExchange(method: string, path: string): { request: Request; response: Response & EventEmitter } {
  const request = { method, path } as unknown as Request;
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = 200;
  return { request, response };
}

function runMiddleware(
  requestId: string | undefined,
  method = 'POST',
  path = '/identity/signin',
): { response: Response & EventEmitter; nextCalled: boolean } {
  const service = new RequestContextService();
  const middleware = new RequestLoggingMiddleware(service);
  const { request, response } = fakeExchange(method, path);
  let nextCalled = false;
  if (requestId === undefined) {
    middleware.use(request, response, () => {
      nextCalled = true;
    });
    return { response, nextCalled };
  }
  // Run inside an ALS scope the way app.module orders the middlewares.
  service.run({ requestId, requestIdSource: 'client' }, () => {
    middleware.use(request, response, () => {
      nextCalled = true;
    });
  });
  return { response, nextCalled };
}

describe('RequestLoggingMiddleware (access log)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through to next() and logs method/path/status/duration/requestId on finish', () => {
    const { response, nextCalled } = runMiddleware('req-123', 'POST', '/identity/signin');
    expect(nextCalled).toBe(true);

    response.statusCode = 401;
    response.emit('finish');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toContain('POST /identity/signin');
    expect(line).toContain('401');
    expect(line).toContain('requestId=req-123');
    expect(line).toMatch(/\d+ms/);
  });

  it('does NOT emit a second line when the socket closes after a normal finish', () => {
    const { response } = runMiddleware('req-123');
    response.emit('finish');
    response.emit('close');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when the connection closes WITHOUT a response (client abort/hang)', () => {
    const { response } = runMiddleware('req-456', 'GET', '/identity/me');
    response.emit('close');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0]![0] as string;
    expect(line).toContain('GET /identity/me');
    expect(line).toContain('WITHOUT a response');
    expect(line).toContain('requestId=req-456');
  });

  it('survives a missing request scope (defensive dash marker, never throws)', () => {
    const { response } = runMiddleware(undefined);
    response.emit('finish');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toContain('requestId=—');
  });
});
