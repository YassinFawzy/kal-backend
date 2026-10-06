/**
 * Kal — append-only audit-log service over `audit_events` (I14).
 *
 * Privileged actions are recorded as (actor, action, target, timestamp,
 * justification) — justification is mandatory (ARCHITECTURE §15). The
 * service surface is append + read-back ONLY: there is no update, delete,
 * or purge method, matching the database's structural guarantees (no
 * UPDATE/DELETE grants for any role, plus a BEFORE UPDATE/DELETE trigger —
 * see the s1 roles/RLS migration).
 *
 * Appends accept an optional transaction client: the commanding unit-of-work
 * passes its `tx` so an audit failure rolls the whole command back (and a
 * failed command never leaves an orphan audit row).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.ts';
import { PrismaService } from '../db/prisma.service.js';

export interface AuditAppendInput {
  /** Privileged-plane actor identifier (opaque; W1 has no admin tables). */
  readonly actor: string;
  /** Stable, registered action code (e.g. a moderation or lifecycle action). */
  readonly action: string;
  /** Target reference as an opaque internal identifier (never user-facing PII). */
  readonly target: string;
  /** Why the privileged action was taken — mandatory (I14 / §15). */
  readonly justification: string;
  /** Server clock instant; defaults to now. Set once, never rewritten. */
  readonly occurredAt?: Date;
  /** Reserved for fixture replays with stable synthetic ids. */
  readonly id?: string;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly justification: string;
  readonly occurredAt: Date;
}

@Injectable()
export class AuditService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Appends one audit event inside the given unit-of-work (or its own
   * implicit transaction when no `tx` is supplied).
   */
  async append(input: AuditAppendInput, tx?: Prisma.TransactionClient): Promise<AuditEventRecord> {
    const actor = requireField(input.actor, 'actor');
    const action = requireField(input.action, 'action');
    const target = requireField(input.target, 'target');
    const justification = requireField(input.justification, 'justification');
    if (input.occurredAt !== undefined && !(input.occurredAt instanceof Date)) {
      throw new Error('audit: occurredAt must be a Date');
    }
    const delegate = (tx ?? this.db.client).auditEvent;
    const row = await delegate.create({
      data: {
        ...(input.id === undefined ? {} : { id: input.id }),
        actor,
        action,
        target,
        justification,
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      },
    });
    return toRecord(row);
  }

  /** Platform-scope read-back (verification and the future audit view). */
  async findById(id: string): Promise<AuditEventRecord | null> {
    const row = await this.db.client.auditEvent.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }
}

function requireField(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`audit: ${name} is mandatory (I14)`);
  }
  return trimmed;
}

type RawAuditEventRow = {
  id: string;
  actor: string;
  action: string;
  target: string;
  justification: string;
  occurredAt: Date;
};

function toRecord(row: RawAuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    justification: row.justification,
    occurredAt: row.occurredAt,
  };
}
