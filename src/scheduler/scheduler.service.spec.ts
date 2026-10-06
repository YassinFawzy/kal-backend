import { describe, expect, it, vi, afterEach } from 'vitest';
import { JobDefinition, SchedulerService } from './scheduler.service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SchedulerService (idempotent-job pattern)', () => {
  it('re-registering a job name replaces the definition (no duplicate jobs)', () => {
    const scheduler = new SchedulerService();
    const first: JobDefinition = { name: 'housekeeping', handler: async () => undefined };
    const second: JobDefinition = { name: 'housekeeping', intervalMs: 1000, handler: async () => undefined };
    scheduler.register(first);
    scheduler.register(second);
    expect(scheduler.jobNames()).toEqual(['housekeeping']);
    expect(scheduler.hasJob('housekeeping')).toBe(true);
  });

  it('a job that runs twice applies each effect key exactly once (no duplicate side effects)', async () => {
    const scheduler = new SchedulerService();
    const effects: string[] = [];
    scheduler.register({
      name: 'retention',
      handler: async (context) => {
        await context.applyOnce('2026-10-06', async () => {
          effects.push('swept:2026-10-06');
        });
      },
    });
    await scheduler.runJob('retention');
    await scheduler.runJob('retention'); // re-run (e.g. restart/manual trigger)
    expect(effects).toEqual(['swept:2026-10-06']);
  });

  it('different effect keys each apply once (bucketed idempotency, e.g. per-day sweeps)', async () => {
    const scheduler = new SchedulerService();
    const effects: string[] = [];
    scheduler.register({
      name: 'retention',
      handler: async (context) => {
        for (const day of ['d1', 'd2']) {
          await context.applyOnce(day, async () => {
            effects.push(day);
          });
        }
      },
    });
    await scheduler.runJob('retention');
    await scheduler.runJob('retention');
    expect(effects).toEqual(['d1', 'd2']);
  });

  it('an effect whose handler throws is retried on the next run (not marked applied)', async () => {
    const scheduler = new SchedulerService();
    const effects: string[] = [];
    let failFirst = true;
    scheduler.register({
      name: 'export',
      handler: async (context) => {
        await context.applyOnce('export-1', async () => {
          if (failFirst) {
            failFirst = false;
            throw new Error('transient failure');
          }
          effects.push('export-1-done');
        });
      },
    });
    await expect(scheduler.runJob('export')).rejects.toThrow('transient failure');
    expect(scheduler.lastError('export')).toBe('transient failure');
    await scheduler.runJob('export');
    expect(effects).toEqual(['export-1-done']);
  });

  it('concurrent runs of the same job collapse into one execution', async () => {
    const scheduler = new SchedulerService();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.register({
      name: 'slow-job',
      handler: async () => {
        executions += 1;
        await gate;
      },
    });
    const first = scheduler.runJob('slow-job');
    const second = await scheduler.runJob('slow-job');
    expect(second).toEqual({ outcome: 'skipped-in-flight', jobName: 'slow-job' });
    release();
    const result = await first;
    expect(result.outcome).toBe('ran');
    expect(executions).toBe(1);
  });

  it('unknown jobs are refused', async () => {
    const scheduler = new SchedulerService();
    await expect(scheduler.runJob('nope')).rejects.toThrow(/unknown job/u);
  });

  it('interval ticks fire on schedule and stop cleanly (no real cron infra)', async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerService();
    const effects: string[] = [];
    scheduler.register({
      name: 'ticker',
      intervalMs: 1000,
      handler: async (context) => {
        await context.applyOnce(`tick-${context.runId}`, async () => {
          effects.push('tick');
        });
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3500);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(effects.length).toBe(3); // exactly one per 1s tick; nothing after stop
  });

  it('double start does not duplicate timers', async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerService();
    const effects: string[] = [];
    scheduler.register({
      name: 'ticker',
      intervalMs: 1000,
      handler: async (context) => {
        await context.applyOnce(`tick-${context.runId}`, async () => {
          effects.push('tick');
        });
      },
    });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    expect(effects.length).toBe(1);
  });
});
