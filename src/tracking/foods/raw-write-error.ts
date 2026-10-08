/**
 * Kal — raw-write constraint-error classification for the tracking foods
 * handlers. Entity writes are explicit raw SQL (see foods.repository.ts), so
 * database constraint violations surface as Prisma's raw-query failure
 * (P2010) carrying the PostgreSQL error — NOT as the model-API P2002/P2003
 * codes. This module extracts the PostgreSQL code from the adapter error
 * shape so handlers can map:
 *
 *   23505 (unique_violation)  ⇒ rejected_conflict
 *   23503 (foreign_key_violation) ⇒ rejected_validation (broken reference)
 *
 * Everything else is NOT an op outcome: it rethrows and aborts the batch
 * (§1.2 — a database failure aborts the whole batch; the client retries).
 */
import { Prisma } from '../../../generated/prisma/client.ts';

interface RawAdapterErrorMeta {
  readonly driverAdapterError?: {
    readonly cause?: {
      readonly code?: string;
      readonly originalCode?: string;
    };
  };
}

/** The PostgreSQL error code behind a failed raw write, when classifiable. */
export function pgErrorCodeOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') {
    return null;
  }
  const cause = (error.meta as RawAdapterErrorMeta | undefined)?.driverAdapterError?.cause;
  return cause?.code ?? cause?.originalCode ?? null;
}

/** `unique` | `foreign_key` | null — the constraint classes handlers map to outcomes. */
export function rawWriteConstraintClass(error: unknown): 'unique' | 'foreign_key' | null {
  const code = pgErrorCodeOf(error);
  if (code === '23505') {
    return 'unique';
  }
  if (code === '23503') {
    return 'foreign_key';
  }
  return null;
}
