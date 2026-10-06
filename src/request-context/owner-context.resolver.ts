/**
 * Kal — owner-context resolution seam (I2).
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
import { OwnerResolution } from './owner-context.js';

export interface OwnerContextResolver {
  resolve(request: IncomingMessage): OwnerResolution | Promise<OwnerResolution>;
}

@Injectable()
export class NoOwnerContextResolver implements OwnerContextResolver {
  resolve(_request: IncomingMessage): OwnerResolution {
    // W1: no identity plane exists — no request can present a validated
    // owner context, so every guarded route fails closed (I2).
    return { status: 'absent' };
  }
}
