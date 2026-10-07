/**
 * Unit — dev/no-op mail adapter (wave-02 contract §4).
 *
 * Proves the dev adapter's sink contract: the payload shape crossing the
 * `KalMailPort` seam, bounded retention, and the absence of any delivery
 * side effect beyond the in-memory sink (no provider anywhere — founder
 * decision E2 stays open behind the port).
 */
import { describe, expect, it } from 'vitest';
import { DevMailAdapter } from './dev-mail.adapter.js';
import type { KalMailPort } from './mail.port.js';

const RECIPIENT = 'kalila@example.com';

describe('DevMailAdapter (KalMailPort dev/no-op adapter)', () => {
  it('implements the port and records the exact payload shape it is handed', async () => {
    const adapter: KalMailPort = new DevMailAdapter();
    const expiresAt = new Date('2026-10-07T12:00:00.000Z');
    await adapter.sendAccountRecoveryMail(RECIPIENT, { secret: 'a'.repeat(64), expiresAt });
    expect(adapter).toBeInstanceOf(DevMailAdapter);
    expect(adapter.records.length).toBe(1);
    const record = adapter.records[0] as NonNullable<(typeof adapter.records)[number]>;
    expect(record.recipient).toBe(RECIPIENT);
    expect(record.ticket.secret).toBe('a'.repeat(64));
    expect(record.ticket.expiresAt).toBe(expiresAt);
    expect(record.sentAt).toBeInstanceOf(Date);
  });

  it('preserves the handed-in expiry instant exactly (no clock rounding)', async () => {
    const adapter = new DevMailAdapter();
    const expiresAt = new Date(Date.now() + 1_800_000);
    await adapter.sendAccountRecoveryMail(RECIPIENT, { secret: 'b'.repeat(64), expiresAt });
    expect((adapter.records[0] as { ticket: { expiresAt: Date } }).ticket.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('keeps FIFO order and bounds the sink (oldest entries fall off)', async () => {
    const adapter = new DevMailAdapter();
    for (let index = 0; index < 130; index += 1) {
      await adapter.sendAccountRecoveryMail(`${String(index).padStart(3, '0')}-${RECIPIENT}`, {
        secret: 'c'.repeat(64),
        expiresAt: new Date(0),
      });
    }
    expect(adapter.records.length).toBe(100);
    expect(adapter.records[0]?.recipient).toBe('030-kalila@example.com');
    expect(adapter.records[99]?.recipient).toBe('129-kalila@example.com');
  });

  it('clear() empties the sink for test isolation', async () => {
    const adapter = new DevMailAdapter();
    await adapter.sendAccountRecoveryMail(RECIPIENT, { secret: 'd'.repeat(64), expiresAt: new Date(0) });
    expect(adapter.records.length).toBe(1);
    adapter.clear();
    expect(adapter.records.length).toBe(0);
  });

  it('satisfies the port structurally (assignable to KalMailPort)', () => {
    const adapter = new DevMailAdapter();
    const asPort: KalMailPort = adapter;
    expect(typeof asPort.sendAccountRecoveryMail).toBe('function');
  });
});
