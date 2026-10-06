import { describe, expect, it } from 'vitest';
import { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KalProblemException } from './kal-problem.exception.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { RequestContextService } from '../request-context/request-context.service.js';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeHost(): { host: ArgumentsHost; response: CapturedResponse } {
  const response: CapturedResponse = { status: 0, headers: {}, body: '' };
  const chain = {
    status(status: number): typeof chain {
      response.status = status;
      return chain;
    },
    header(name: string, value: string): typeof chain {
      response.headers[name.toLowerCase()] = value;
      return chain;
    },
    send(body: string): void {
      response.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => chain,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('ProblemDetailsFilter (I7)', () => {
  it('serializes KalProblemException per the registry with problem+json', () => {
    const filter = new ProblemDetailsFilter(new RequestContextService());
    const { host, response } = fakeHost();
    filter.catch(new KalProblemException('FORBIDDEN'), host);
    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toBe('application/problem+json');
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      title: 'Forbidden',
      type: 'urn:kal:problem:forbidden',
    });
    expect(typeof body['requestId']).toBe('string');
  });

  it('maps route 404 to a generic NOT_FOUND without echoing the path', () => {
    const filter = new ProblemDetailsFilter(new RequestContextService());
    const { host, response } = fakeHost();
    filter.catch(new NotFoundException('Cannot GET /users/abc/entries'), host);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('Cannot GET');
    expect(response.body).not.toContain('/users/abc/entries');
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['code']).toBe('NOT_FOUND');
  });

  it('maps wrong-method 405 to the same generic NOT_FOUND (registry-complete)', () => {
    const filter = new ProblemDetailsFilter(new RequestContextService());
    const { host, response } = fakeHost();
    filter.catch(new BadRequestException('framework validation'), host);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)['code']).toBe('VALIDATION_FAILED');
  });

  it('maps unhandled errors to a generic INTERNAL_ERROR, never echoing the cause', () => {
    const filter = new ProblemDetailsFilter(new RequestContextService());
    const { host, response } = fakeHost();
    filter.catch(new Error('SQLSTATE 42601 near weight_log'), host);
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('SQLSTATE');
    expect(response.body).not.toContain('weight_log');
    expect(JSON.parse(response.body)['code']).toBe('INTERNAL_ERROR');
  });

  it('sets Retry-After on RATE_LIMITED', () => {
    const filter = new ProblemDetailsFilter(new RequestContextService());
    const { host, response } = fakeHost();
    filter.catch(new KalProblemException('RATE_LIMITED', { retryAfterSeconds: 42 }), host);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
  });

  it('honors requestIdOverride only when the client supplied no X-Request-Id', () => {
    const service = new RequestContextService();
    const filter = new ProblemDetailsFilter(service);
    const pinned = '00000000-0000-4000-8000-0000000000c0';

    // No client header: the fixture override applies.
    const { host: h1, response: r1 } = fakeHost();
    filter.catch(new KalProblemException('VALIDATION_FAILED', { requestIdOverride: pinned }), h1);
    expect(JSON.parse(r1.body)['requestId']).toBe(pinned);

    // Client-supplied id: echo wins, the override is ignored.
    const { host: h2, response: r2 } = fakeHost();
    service.run({ requestId: 'client-id-123', requestIdSource: 'client' }, () => {
      filter.catch(new KalProblemException('VALIDATION_FAILED', { requestIdOverride: pinned }), h2);
    });
    expect(JSON.parse(r2.body)['requestId']).toBe('client-id-123');
  });
});
