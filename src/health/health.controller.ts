/**
 * Kal — liveness, readiness, and the contract probes (conventions.md §6.2).
 *
 * - GET /health            → liveness: `{"status":"ok"}` exactly.
 * - GET /health/ready      → readiness: all checks pass → `{"status":"ok"}`;
 *                            any failure → 503 UNAVAILABLE problem-details,
 *                            no diagnostic detail in the body (I7/I12).
 * - GET /probe/problem-details → the documented VALIDATION_FAILED fixture:
 *                            byte-stable (fixed correlation id unless the
 *                            client supplies its own X-Request-Id).
 * - GET /probe/owner-context   → guarded by @RequireOwnerContext; in W1 the
 *                            resolver refuses every request, so this is the
 *                            live fail-closed proof (I2): always 403
 *                            FORBIDDEN_OWNER, never disclosing why.
 *
 * The probes are contract fixtures, not debug surfaces: they carry no
 * runtime data, echo nothing about the process, and are safe in production.
 */
import { Controller, Get, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { KalProblemException } from '../problems/kal-problem.exception.js';
import { redactTextForLog } from '../problems/redact.js';
import { RequireOwnerContext } from '../request-context/owner-context.guard.js';
import { RequestContextService } from '../request-context/request-context.service.js';
import { ReadinessCheck, injectReadinessChecks } from './readiness.js';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @injectReadinessChecks() private readonly checks: readonly ReadinessCheck[],
    private readonly requestContext: RequestContextService,
  ) {}

  @Get('health')
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async readiness(): Promise<{ readonly status: 'ok' }> {
    for (const check of this.checks) {
      try {
        await check.check();
      } catch (error) {
        // Internal log only: check name + correlation id + scrubbed cause.
        // The response body carries no diagnostic detail whatsoever (I7/I12).
        this.logger.warn(
          `readiness: check "${check.name}" failed requestId=${this.requestContext.requestIdForError()} cause=${redactTextForLog(
            error instanceof Error ? error.message : 'unknown',
          )}`,
        );
        throw new KalProblemException('UNAVAILABLE');
      }
    }
    return { status: 'ok' };
  }
}

/** Shared with the served fixture document — single source of truth. */
export const PROBE_FIXTURE_REQUEST_ID = '00000000-0000-4000-8000-0000000000c0';

@Controller('probe')
export class ProbeController {
  @Get('problem-details')
  problemDetails(): never {
    // Documented validation failure of the fixture's `q` parameter. The
    // pinned correlation id makes the served example byte-stable per
    // conventions §6.1 (deep-equal client check); a client-supplied
    // X-Request-Id still wins (the filter honors the echo first).
    throw new KalProblemException('VALIDATION_FAILED', {
      errors: [{ field: 'q', message: 'Required.' }],
      requestIdOverride: PROBE_FIXTURE_REQUEST_ID,
    });
  }

  @Get('owner-context')
  @RequireOwnerContext()
  ownerContext(_request: Request): void {
    // Unreachable in W1: the OwnerContextResolver refuses every request
    // (no identity plane exists yet), so the guard fails closed with 403
    // FORBIDDEN_OWNER before this handler runs. W2 swaps the resolver and
    // this probe starts admitting validated contexts.
  }
}
