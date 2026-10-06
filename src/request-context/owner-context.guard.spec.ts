import { describe, expect, it } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { OwnerContextGuard } from './owner-context.guard.js';
import { OwnerResolution } from './owner-context.js';
import { OwnerContextResolver } from './owner-context.resolver.js';
import { RequestContextService } from './request-context.service.js';

function fakeResolver(resolution: OwnerResolution): OwnerContextResolver {
  return { resolve: () => resolution };
}

function fakeExecutionContext(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

/** Extracts the JSON body the filter would serialize for a thrown problem. */
async function denialFor(resolution: OwnerResolution): Promise<{ code: string; detail?: string }> {
  const service = new RequestContextService();
  const guard = new OwnerContextGuard(fakeResolver(resolution), service);
  let thrown: unknown;
  try {
    await guard.canActivate(fakeExecutionContext({ headers: {} }));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(KalProblemException);
  const problem = thrown as KalProblemException;
  return { code: problem.code, detail: problem.detail };
}

describe('OwnerContextGuard (I2 fail-closed)', () => {
  it('refuses absent context with the generic FORBIDDEN_OWNER denial', async () => {
    const denial = await denialFor({ status: 'absent' });
    expect(denial.code).toBe('FORBIDDEN_OWNER');
  });

  it('refuses invalid context with the SAME generic denial', async () => {
    const denial = await denialFor({ status: 'invalid', reason: 'malformed token' });
    expect(denial.code).toBe('FORBIDDEN_OWNER');
  });

  it('refuses ambiguous context with the SAME generic denial', async () => {
    const denial = await denialFor({ status: 'ambiguous', reason: 'two ids' });
    expect(denial.code).toBe('FORBIDDEN_OWNER');
  });

  it('denials carry no reason detail — byte-identical modulo requestId (I7)', async () => {
    const absent = await denialFor({ status: 'absent' });
    const invalid = await denialFor({ status: 'invalid', reason: 'uuid shape' });
    const ambiguous = await denialFor({ status: 'ambiguous', reason: 'conflict' });
    expect(JSON.stringify(absent)).toBe(JSON.stringify(invalid));
    expect(JSON.stringify(invalid)).toBe(JSON.stringify(ambiguous));
    expect(absent.detail).toBeUndefined();
  });

  it('stores the resolved context in the request scope', async () => {
    const service = new RequestContextService();
    const ownerId = '00000000-0000-4000-8000-0000000000a1';
    const guard = new OwnerContextGuard(
      fakeResolver({ status: 'resolved', context: { kind: 'consumer', ownerId } }),
      service,
    );
    await service.run({ requestId: 'req-1', requestIdSource: 'generated' }, async () => {
      const allowed = await guard.canActivate(fakeExecutionContext({ headers: {} }));
      expect(allowed).toBe(true);
      expect(service.getOwnerContext()).toEqual({ kind: 'consumer', ownerId });
    });
  });

  it('refuses to store a context when no request scope exists (defense in depth)', async () => {
    const service = new RequestContextService();
    const guard = new OwnerContextGuard(
      fakeResolver({ status: 'resolved', context: { kind: 'consumer', ownerId: '00000000-0000-4000-8000-0000000000a1' } }),
      service,
    );
    await expect(guard.canActivate(fakeExecutionContext({ headers: {} }))).rejects.toThrow(
      /no active request scope/u,
    );
    expect(service.getOwnerContext()).toBeUndefined();
  });
});
