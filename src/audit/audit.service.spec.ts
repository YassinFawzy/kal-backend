import { describe, expect, it } from 'vitest';
import { AuditAppendInput, AuditEventRecord, AuditService } from './audit.service.js';
import { PrismaService } from '../db/prisma.service.js';


/**
 * In-memory audit-event store emulating transaction scoping: writes made
 * through a tx view stay buffered until commit; a rollback discards them.
 * DB-backed proof (ephemeral PostgreSQL) belongs to s4's harness — this is
 * the unit-level unit-of-work demonstration the contract allows.
 */
class InMemoryAuditStore {
  readonly committed: AuditEventRecord[] = [];
  private nextId = 1;

  allocateId(): string {
    return `mem-${(this.nextId += 1) - 1}`;
  }

  private buildRecord(data: Record<string, unknown>): AuditEventRecord {
    return {
      id: (data['id'] as string | undefined) ?? this.allocateId(),
      actor: data['actor'] as string,
      action: data['action'] as string,
      target: data['target'] as string,
      justification: data['justification'] as string,
      occurredAt: (data['occurredAt'] as Date | undefined) ?? new Date(),
    };
  }

  makeTx(options: { failCreate?: boolean } = {}): {
    auditEvent: { create(args: { data: Record<string, unknown> }): Promise<AuditEventRecord> };
    commit(): void;
    rollback(): void;
  } {
    const buffer: AuditEventRecord[] = [];
    return {
      auditEvent: {
        create: async (args: { data: Record<string, unknown> }) => {
          if (options.failCreate === true) {
            throw new Error('audit write refused');
          }
          const record = this.buildRecord(args.data);
          buffer.push(record);
          return { ...record };
        },
      },
      commit: (): void => {
        this.committed.push(...buffer.splice(0));
      },
      rollback: (): void => {
        buffer.splice(0);
      },
    };
  }
}

interface FakeDbShape {
  client: {
    auditEvent: {
      create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
      findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null>;
    };
  };
  transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}

function makeFakeDb(options: { failDirectCreate?: boolean; failTxCreate?: boolean } = {}): {
  db: FakeDbShape;
  store: InMemoryAuditStore;
} {
  const store = new InMemoryAuditStore();
  const directCreate = async (args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> => {
    if (options.failDirectCreate === true) {
      throw new Error('audit write refused');
    }
    const record: AuditEventRecord = {
      id: (args.data['id'] as string | undefined) ?? store.allocateId(),
      actor: args.data['actor'] as string,
      action: args.data['action'] as string,
      target: args.data['target'] as string,
      justification: args.data['justification'] as string,
      occurredAt: (args.data['occurredAt'] as Date | undefined) ?? new Date(),
    };
    store.committed.push(record);
    return { ...record };
  };
  const db: FakeDbShape = {
    client: {
      auditEvent: {
        create: directCreate,
        findUnique: async (args: { where: { id: string } }) => {
          const found = store.committed.find((record) => record.id === args.where.id);
          return found === undefined ? null : { ...found };
        },
      },
    },
    transaction: async <T,>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      // Emulates Prisma's interactive transaction: buffered writes commit
      // only when the unit of work resolves; a rejection discards them.
      const tx = store.makeTx({ failCreate: options.failTxCreate });
      const result = await work(tx);
      tx.commit();
      return result;
    },
  };
  return { db, store };
}

function serviceOver(db: unknown): AuditService {
  return new AuditService(db as PrismaService);
}

const baseInput: AuditAppendInput = {
  actor: 'fixture:admin',
  action: 'fixture.action.tested',
  target: 'fixture:target:1',
  justification: 'Fixture demonstration of the append path — no real data.',
};

describe('AuditService (I14 append-only)', () => {
  it('appends an event and reads it back', async () => {
    const { db } = makeFakeDb();
    const service = serviceOver(db);
    const record = await service.append({ ...baseInput, id: '00000000-0000-4000-8000-0000000000fe' });
    expect(record.action).toBe(baseInput.action);
    const readBack = await service.findById('00000000-0000-4000-8000-0000000000fe');
    expect(readBack).toEqual(record);
  });

  it('stamps the server clock when occurredAt is omitted and honors explicit instants', async () => {
    const { db } = makeFakeDb();
    const service = serviceOver(db);
    const before = new Date();
    const record = await service.append(baseInput);
    expect(record.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const stamped = await service.append({ ...baseInput, occurredAt: new Date('2026-01-01T00:00:00Z') });
    expect(stamped.occurredAt.getTime()).toBe(new Date('2026-01-01T00:00:00Z').getTime());
  });

  it('refuses to append without a justification (I14/§15) — nothing is written', async () => {
    const { db, store } = makeFakeDb();
    const service = serviceOver(db);
    await expect(service.append({ ...baseInput, justification: '   ' })).rejects.toThrow(
      /justification is mandatory/u,
    );
    expect(store.committed.length).toBe(0);
  });

  it('refuses empty actor/action/target — nothing is written', async () => {
    const { db, store } = makeFakeDb();
    const service = serviceOver(db);
    for (const key of ['actor', 'action', 'target'] as const) {
      await expect(
        service.append({ ...baseInput, [key]: '' }),
      ).rejects.toThrow(new RegExp(`${key} is mandatory`, 'u'));
    }
    expect(store.committed.length).toBe(0);
  });

  it('exposes NO update/delete/purge surface (I14)', () => {
    const mutating = Object.getOwnPropertyNames(AuditService.prototype).filter(
      (name) => name !== 'constructor' && name !== 'append' && name !== 'findById',
    );
    expect(mutating).toEqual([]);
    const service = serviceOver(makeFakeDb().db) as unknown as Record<string, unknown>;
    expect(service['update']).toBeUndefined();
    expect(service['delete']).toBeUndefined();
    expect(service['purge']).toBeUndefined();
  });

  it('rolls the commanding transaction back when it fails after an audit append', async () => {
    const { db, store } = makeFakeDb();
    const service = serviceOver(db);
    const command = (): Promise<void> =>
      db.transaction(async (tx) => {
        await service.append({ ...baseInput, action: 'command.step' }, tx as never);
        throw new Error('command failed after the audit append');
      });
    await expect(command()).rejects.toThrow('command failed after the audit append');
    expect(store.committed.length).toBe(0);
  });

  it('commits audit rows only when the commanding transaction succeeds', async () => {
    const { db, store } = makeFakeDb();
    const service = serviceOver(db);
    const appended = await db.transaction(async (tx) => {
      return service.append({ ...baseInput, action: 'command.ok' }, tx as never);
    });
    expect(store.committed.map((record) => record.action)).toEqual(['command.ok']);
    expect(appended.action).toBe('command.ok');
  });

  it('propagates an audit-append failure inside the unit of work — nothing commits', async () => {
    const { db, store } = makeFakeDb({ failTxCreate: true });
    const service = serviceOver(db);
    const command = (): Promise<void> =>
      db.transaction(async (tx) => {
        await service.append(baseInput, tx as never);
      });
    await expect(command()).rejects.toThrow('audit write refused');
    expect(store.committed.length).toBe(0);
  });

  it('propagates a direct append failure so callers can abort the command', async () => {
    const { db, store } = makeFakeDb({ failDirectCreate: true });
    const service = serviceOver(db);
    await expect(service.append(baseInput)).rejects.toThrow('audit write refused');
    expect(store.committed.length).toBe(0);
  });
});
