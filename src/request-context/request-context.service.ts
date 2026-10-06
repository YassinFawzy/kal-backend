/**
 * Kal — request-scoped context over AsyncLocalStorage.
 *
 * Holds the correlation id (conventions.md §0: echoed or generated
 * X-Request-Id) and, once a user is resolved, the validated UserContext
 * (I2). The middleware opens the ALS scope around the whole downstream
 * chain, so guards, handlers, and the problem-details filter all observe
 * the same request context without threading parameters.
 */
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { UserContext } from './user-context.js';

export interface RequestContext {
  readonly requestId: string;
  /** Whether the id was supplied by the client or generated here. */
  readonly requestIdSource: 'client' | 'generated';
}

const MAX_REQUEST_ID_LENGTH = 128;
/** Opaque printable ASCII only; anything else ⇒ generate a fresh id. */
const SAFE_REQUEST_ID_PATTERN = /^[\x20-\x7E]{1,128}$/u;

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  get context(): RequestContext | undefined {
    return this.storage.getStore();
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /** The id to carry into a problem-details body (conventions.md §5). */
  requestIdForError(): string {
    return this.getRequestId() ?? randomUUID();
  }

  getUserContext(): UserContext | undefined {
    const store = this.storage.getStore() as (RequestContext & { userContext?: UserContext }) | undefined;
    return store?.userContext;
  }

  setUserContext(context: UserContext): void {
    const store = this.storage.getStore() as (RequestContext & { userContext?: UserContext }) | undefined;
    if (store === undefined) {
      // Fail closed: no ALS scope means no request context — refuse instead
      // of silently storing a context nobody can retrieve (I2).
      throw new Error('request-context: no active request scope; cannot store user context');
    }
    Object.defineProperty(store, 'userContext', {
      value: context,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  /** Resolves the effective X-Request-Id for an inbound request (§0). */
  static resolveRequestId(headerValue: unknown): { requestId: string; source: 'client' | 'generated' } {
    if (typeof headerValue === 'string' && SAFE_REQUEST_ID_PATTERN.test(headerValue)) {
      return { requestId: headerValue, source: 'client' };
    }
    if (Array.isArray(headerValue)) {
      const first = headerValue[0];
      if (typeof first === 'string' && SAFE_REQUEST_ID_PATTERN.test(first)) {
        return { requestId: first, source: 'client' };
      }
    }
    return { requestId: randomUUID(), source: 'generated' };
  }

  static get maxRequestIdLength(): number {
    return MAX_REQUEST_ID_LENGTH;
  }
}
