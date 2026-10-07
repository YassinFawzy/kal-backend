/**
 * Kal — `KalMailPort` seam (wave-02 contract §4; owned by lane w02-s2b-recovery).
 *
 * The ONLY path by which recovery tickets leave the server. The seam is
 * provider-neutral by design: NO transactional-email provider is selected —
 * that is founder decision E2 (open behind this seam). Nothing in this file,
 * its adapters, config keys, comments, or tests may name or imply a provider;
 * the single shipped adapter is the dev/no-op adapter (`dev-mail.adapter.ts`),
 * whose sink exists so tests can prove the payload shape.
 *
 * Delivery contract: exactly one call per issued recovery ticket, awaited by
 * the commanding service AFTER its unit of work commits. Implementations must
 * NEVER log the ticket secret (I12) and must never persist it anywhere — the
 * secret's only storage form is its SHA-256 digest in `recovery_tickets`.
 */

/**
 * A canonical RFC-shaped email address (validated and lowercased by
 * `identity-validation` before it is ever stored or sent to). A plain string
 * alias: the validation boundary is identity validation, not this type.
 */
export type EmailAddress = string;

/** The ticket payload a mail adapter is trusted to deliver. */
export interface AccountRecoveryTicket {
  /** The single-use secret — base64url; only its SHA-256 digest is stored. */
  readonly secret: string;
  /** Absolute expiry instant (UTC); the ticket is dead after it, server-side. */
  readonly expiresAt: Date;
}

/** The port every outbound account-recovery mail goes through (contract §4). */
export interface KalMailPort {
  sendAccountRecoveryMail(recipient: EmailAddress, ticket: AccountRecoveryTicket): Promise<void>;
}

/** DI token for the port (the adapter behind it is swappable by providers). */
export const KAL_MAIL_PORT = Symbol('KAL_MAIL_PORT');
