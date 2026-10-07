/**
 * Kal — dev/no-op `KalMailPort` adapter (wave-02 contract §4).
 *
 * The single SHIPPED adapter behind the `KalMailPort` seam: it "delivers" by
 * appending the payload to a bounded IN-MEMORY sink and discarding it — no
 * network, no filesystem, no console output, no persistence of any kind (the
 * sink dies with the process). It exists so tests can prove the mail payload
 * shape end-to-end without any mail infrastructure.
 *
 * Selecting a real transactional-email provider is founder decision E2 and is
 * OPEN: no provider is named, implied, or stubbed toward anywhere in this
 * codebase. A future adapter implements the same one-method port and is bound
 * by a provider-line change in `identity.module.ts` — nothing else moves.
 *
 * Redaction posture (I12): records live only in process memory, are bounded
 * (oldest entries fall off), and are never logged or serialized anywhere by
 * this adapter. Test suites that read the sink consume it directly.
 */
import { Injectable } from '@nestjs/common';
import type { AccountRecoveryTicket, EmailAddress, KalMailPort } from './mail.port.js';

/** One delivered (i.e., sinked) recovery mail. */
export interface DevMailRecord {
  readonly recipient: EmailAddress;
  readonly ticket: AccountRecoveryTicket;
  /** Server instant the adapter was called (informational; never logged). */
  readonly sentAt: Date;
}

/** Sink bound: enough for any test suite, small enough to never grow unbounded. */
const MAX_SINK_RECORDS = 100;

@Injectable()
export class DevMailAdapter implements KalMailPort {
  private readonly sink: DevMailRecord[] = [];

  /** The port method: record, then discard (no side effect beyond the sink). */
  async sendAccountRecoveryMail(recipient: EmailAddress, ticket: AccountRecoveryTicket): Promise<void> {
    this.sink.push({ recipient, ticket: { secret: ticket.secret, expiresAt: ticket.expiresAt }, sentAt: new Date() });
    if (this.sink.length > MAX_SINK_RECORDS) {
      this.sink.splice(0, this.sink.length - MAX_SINK_RECORDS);
    }
  }

  /** Read-only view of what was "delivered" (test/verification consumption). */
  get records(): readonly DevMailRecord[] {
    return this.sink;
  }

  /** Clears the sink (test isolation between cases). */
  clear(): void {
    this.sink.length = 0;
  }
}
