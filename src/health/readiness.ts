/**
 * Kal — health/readiness (conventions.md §6.2 `health.readiness`).
 *
 * Readiness is a set of named checks. All pass → `{"status":"ok"}` exactly;
 * any failure → the generic `UNAVAILABLE` problem-details envelope with NO
 * diagnostic detail in the body (I7/I12) — the failing check's name and the
 * correlation id go to the internal log only. The check set is a DI token
 * so later waves register their checks (identity, sync, …) additively.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service.js';

export interface ReadinessCheck {
  /** Stable internal name (safe for logs; never served). */
  readonly name: string;
  /** Resolves when ready; rejects (any reason) when not. */
  check(): Promise<void>;
}

export const READINESS_CHECKS = Symbol('KAL_READINESS_CHECKS');

@Injectable()
export class DbReadinessCheck implements ReadinessCheck {
  readonly name = 'database';

  constructor(private readonly db: PrismaService) {}

  async check(): Promise<void> {
    await this.db.ping();
  }
}

export function defaultReadinessChecks(db: PrismaService): readonly ReadinessCheck[] {
  return [new DbReadinessCheck(db)];
}

/** Helper for controllers that need the token (interface type, isolatedModules). */
export function injectReadinessChecks(): ParameterDecorator {
  return Inject(READINESS_CHECKS);
}
