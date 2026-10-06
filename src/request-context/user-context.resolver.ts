/**
 * Kal — user-context resolution seam (I2).
 *
 * W1 ships no authentication (identity lands in W2), so the default
 * resolver can never VALIDATE anything: it refuses every request as
 * `absent`, which the guard turns into one generic denial. This is the
 * honest fail-closed default — the plumbing exists, is exercised, and
 * cannot be bypassed; W2 replaces this provider with the JWT-session
 * resolver without touching any consumer of the guard.
 */
import { Injectable } from '@nestjs/common';
import { IncomingMessage } from 'node:http';
import { UserResolution } from './user-context.js';

/** DI token for the resolver seam (interface — cannot be a class token). */
export const USER_CONTEXT_RESOLVER = Symbol('USER_CONTEXT_RESOLVER');

export interface UserContextResolver {
  resolve(request: IncomingMessage): UserResolution | Promise<UserResolution>;
}

@Injectable()
export class NoUserContextResolver implements UserContextResolver {
  resolve(_request: IncomingMessage): UserResolution {
    // W1: no identity plane exists — no request can present a validated
    // user context, so every guarded route fails closed (I2).
    return { status: 'absent' };
  }
}
