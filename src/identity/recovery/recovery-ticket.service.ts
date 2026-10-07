/**
 * Kal — recovery-ticket secret material (wave-02 contract §2; I12).
 *
 * The ticket's only storage form is its SHA-256 hex digest in
 * `recovery_tickets.token_hash` (schema CHECK `^[0-9a-f]{64}$`) — the secret
 * itself is NEVER stored, logged, or returned after issuance. Format (the
 * frozen-shape analog of the refresh token, within implementation discretion):
 *
 *     base64url(16-byte ticket UUID || 32-byte random secret)  — 64 chars
 *
 * The embedded UUID is what makes verification a single indexed lookup by
 * primary key; the digest comparison is constant-time (never short-circuits
 * on content). Ticket TTL is NOT decided here — the commanding service stamps
 * `expires_at` from the validated `identity.recoveryTicketTtlSeconds` config
 * point (contract note §6; no threshold is hardcoded, HD-23-tunable).
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../../request-context/user-context.js';

@Injectable()
export class RecoveryTicketService {
  /** Mints one single-use recovery ticket: the presented secret plus its digest. */
  mint(randomSource: (size: number) => Buffer = randomBytes): { secret: string; ticketId: string; digest: string } {
    const ticketId = randomUUID();
    const secret = Buffer.concat([uuidToBytes(ticketId), randomSource(32)]).toString('base64url');
    return { secret, ticketId, digest: this.digestOf(secret) };
  }

  /** SHA-256 hex — the only stored form of a ticket secret (I12). */
  digestOf(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  /**
   * Extracts the bound ticket id from a presented secret. Returns null for
   * every malformed presentation (wrong length, bad base64url, bad uuid) —
   * the caller maps all of them to the ONE generic 401 (contract §2/§3).
   */
  ticketIdOf(secret: string): string | null {
    let raw: Buffer;
    try {
      raw = Buffer.from(secret, 'base64url');
    } catch {
      return null;
    }
    if (raw.length !== 48) {
      return null;
    }
    const hex = raw.subarray(0, 16).toString('hex');
    const ticketId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    return isUuid(ticketId) ? ticketId : null;
  }

  /** Constant-time digest comparison (never short-circuits on content). */
  matches(presented: string, storedHexDigest: string): boolean {
    const presentedDigest = Buffer.from(this.digestOf(presented), 'hex');
    const storedDigest = Buffer.from(storedHexDigest, 'hex');
    return presentedDigest.length === storedDigest.length && timingSafeEqual(presentedDigest, storedDigest);
  }
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/gu, ''), 'hex');
}
