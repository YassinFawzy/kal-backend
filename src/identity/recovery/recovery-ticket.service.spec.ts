/**
 * Unit — recovery-ticket secret material (I12; wave-02 contract §2).
 *
 * Pins the ticket format (base64url, 64 chars, embedded v4 UUID prefix), the
 * digest-only storage shape (SHA-256 hex), constant-secret handling, and the
 * malformed-presentation funnel (every malformed class ⇒ null ⇒ one generic
 * 401 at the service boundary).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isUuid } from '../../request-context/user-context.js';
import { RecoveryTicketService } from './recovery-ticket.service.js';

describe('RecoveryTicketService', () => {
  it('mints a 64-char base64url secret with an embedded v4 UUID prefix, and the digest is its SHA-256 hex', () => {
    const service = new RecoveryTicketService();
    const { secret, ticketId, digest } = service.mint();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(isUuid(ticketId)).toBe(true);
    expect(secret.startsWith(ticketId.replace(/-/gu, ''))).toBe(false); // base64url-encoded, not raw hex
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'));
  });

  it('round-trips the ticket id out of the presented secret', () => {
    const service = new RecoveryTicketService();
    const { secret, ticketId } = service.mint();
    expect(service.ticketIdOf(secret)).toBe(ticketId);
  });

  it('two mints never collide (CSPRNG entropy ≥ 256 bits in the suffix)', () => {
    const service = new RecoveryTicketService();
    const first = service.mint();
    const second = service.mint();
    expect(first.secret).not.toBe(second.secret);
    expect(first.ticketId).not.toBe(second.ticketId);
    expect(first.digest).not.toBe(second.digest);
  });

  it('accepts an injected random source (deterministic suffix through the seam)', () => {
    const service = new RecoveryTicketService();
    const fixed = Buffer.alloc(32, 7);
    const { secret } = service.mint(() => fixed);
    const { secret: twin } = service.mint(() => fixed);
    // The id prefix is fresh per mint; the injected 32-byte suffix encodes
    // deterministically into the trailing characters (chars 22+ are suffix bits).
    expect(secret.slice(22)).toBe(twin.slice(22));
    expect(secret).not.toContain('='); // base64url alphabet only
  });

  it('matches() is true only for the exact secret; one flipped char fails', () => {
    const service = new RecoveryTicketService();
    const { secret, digest } = service.mint();
    expect(service.matches(secret, digest)).toBe(true);
    const flipped = (secret[0] === 'A' ? 'B' : 'A') + secret.slice(1);
    expect(service.matches(flipped, digest)).toBe(false);
    expect(service.matches(`${secret}x`, digest)).toBe(false);
  });

  it('every malformed presentation funnels to a null ticket id', () => {
    const service = new RecoveryTicketService();
    const { secret } = service.mint();
    expect(service.ticketIdOf('')).toBeNull();
    expect(service.ticketIdOf('not-a-ticket')).toBeNull();
    expect(service.ticketIdOf(randomBytes(47).toString('base64url'))).toBeNull(); // wrong length
    expect(service.ticketIdOf(randomBytes(49).toString('base64url'))).toBeNull();
    expect(service.ticketIdOf(secret.slice(1))).toBeNull(); // truncated
  });
});
