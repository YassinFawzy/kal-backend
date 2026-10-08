/**
 * Unit — sync batch envelope parsing and shape validation (wave-03 contract
 * §1.1/§1.2).
 *
 * Pinned: the whole-batch shape matrix (every §1.2 violation class ⇒ errors,
 * zero database involvement by construction), field parity (`localDate`
 * required on diary_entry / absent otherwise; `payload` required on
 * create/update / absent on delete), the day-boundary shape rule (calendar-
 * valid `YYYY-MM-DD`, shape only), UTC-instant strictness, and the I12
 * no-echo contract (errors carry structural paths + generic messages only).
 */
import { describe, expect, it } from 'vitest';
import { parseBatchBody, validateIdempotencyKey } from './op-envelope.js';

const OP_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ENTITY_ID = '9b2f1a65-1c58-4d3a-9b7e-5f6a7b8c9d01';
const FOOD_ID = '00000000-0000-4000-8000-00000000f001';

function validOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: OP_ID,
    kind: 'favorite',
    entityId: ENTITY_ID,
    action: 'create',
    clientUpdatedAt: '2026-10-08T07:00:00Z',
    payload: { foodId: FOOD_ID },
    ...overrides,
  };
}

function diaryOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validOp({
    kind: 'diary_entry',
    localDate: '2026-10-08',
    payload: { mealSlot: 'breakfast', energyKcal: 100 },
    ...overrides,
  });
}

function parse(ops: unknown[], deviceId = 'device-01', max = 100): ReturnType<typeof parseBatchBody> {
  return parseBatchBody({ deviceId, ops }, max);
}

describe('validateIdempotencyKey (conventions §3)', () => {
  it('accepts a client-generated UUID (trimmed)', () => {
    expect(validateIdempotencyKey(` ${OP_ID} `)).toBe(OP_ID);
  });
  it.each([
    [undefined],
    [null],
    [42],
    [''],
    ['not-a-uuid'],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c330'], // truncated
    ['3f2504e0-4f89-41d3-9a0c-0305e82c330Z'], // malformed tail
  ])('rejects malformed header value: %s ⇒ null (whole-batch 400 path)', (value) => {
    expect(validateIdempotencyKey(value)).toBeNull();
  });
});

describe('parseBatchBody — happy shapes (§1.1)', () => {
  it('parses a valid mixed batch', () => {
    const result = parse([diaryOp(), validOp({ action: 'delete', payload: undefined })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deviceId).toBe('device-01');
      expect(result.value.ops.length).toBe(2);
      const [entry, deletion] = result.value.ops;
      expect(entry?.kind).toBe('diary_entry');
      expect(entry?.localDate).toBe('2026-10-08');
      expect(entry?.clientUpdatedAt).toBe('2026-10-08T07:00:00Z'); // the exact client-authored string
      expect(deletion?.action).toBe('delete');
      expect(deletion?.payload).toBeUndefined(); // ABSENT on delete (canonical envelope)
    }
  });

  it('accepts sub-millisecond instants (timestamptz(6) precision preserved in the carried string)', () => {
    const result = parse([validOp({ clientUpdatedAt: '2026-10-08T07:00:00.000123Z' })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ops[0]?.clientUpdatedAt).toBe('2026-10-08T07:00:00.000123Z');
    }
  });

  it('accepts a zero-offset instant and an empty ops array', () => {
    expect(parse([validOp({ clientUpdatedAt: '2026-10-08T07:00:00+00:00' })]).ok).toBe(true);
    expect(parse([]).ok).toBe(true);
  });
});

describe('parseBatchBody — whole-batch shape violations (§1.2: 400 VALIDATION_FAILED, nothing recorded)', () => {
  it('refuses a non-object body', () => {
    expect(parseBatchBody(null, 100).ok).toBe(false);
    expect(parseBatchBody('x', 100).ok).toBe(false);
    expect(parseBatchBody([1], 100).ok).toBe(false);
  });

  it('refuses unexpected top-level fields', () => {
    const result = parseBatchBody({ deviceId: 'd', ops: [], extra: 1 }, 100);
    expect(result.ok).toBe(false);
  });

  it.each([
    [undefined, 'missing'],
    [null, 'null'],
    ['', 'empty'],
    ['x'.repeat(129), '129 chars'],
    [42, 'non-string'],
  ])('refuses deviceId: %s (%s)', (deviceId) => {
    const result = parseBatchBody({ deviceId, ops: [] }, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === 'deviceId')).toBe(true);
    }
  });

  it('accepts deviceId at the 128-char bound', () => {
    expect(parseBatchBody({ deviceId: 'x'.repeat(128), ops: [] }, 100).ok).toBe(true);
  });

  it('refuses a non-array ops field', () => {
    const result = parseBatchBody({ deviceId: 'd', ops: 'nope' }, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === 'ops')).toBe(true);
    }
  });

  it('refuses an over-cap batch (the configured batch cap — database-free)', () => {
    const ops = Array.from({ length: 5 }, (_v, i) =>
      validOp({ opId: `3f2504e0-4f89-41d3-9a0c-0305e82c330${i}`, entityId: ENTITY_ID }),
    );
    const result = parseBatchBody({ deviceId: 'd', ops }, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === 'ops' && e.message === 'Exceeds the maximum.')).toBe(true);
    }
  });
});

describe('parseBatchBody — op-level envelope violations (field parity, §1.1)', () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['opId not a uuid', { opId: 'nope' }],
    ['opId missing', { opId: undefined }],
    ['unknown kind string (layer 1: not in the frozen enum)', { kind: 'nonsense' }],
    ['kind missing', { kind: undefined }],
    ['entityId not a uuid', { entityId: '123' }],
    ['unknown action', { action: 'upsert' }],
    ['action missing', { action: undefined }],
    ['clientUpdatedAt not UTC (offset)', { clientUpdatedAt: '2026-10-08T09:00:00+03:00' }],
    ['clientUpdatedAt missing designator', { clientUpdatedAt: '2026-10-08T07:00:00' }],
    ['clientUpdatedAt non-calendar', { clientUpdatedAt: '2026-02-30T07:00:00Z' }],
    ['clientUpdatedAt malformed', { clientUpdatedAt: 'yesterday' }],
    ['localDate on a non-diary kind (must be ABSENT)', { localDate: '2026-10-08' }],
    ['localDate malformed on diary_entry', { ...diaryOpRaw(), localDate: '10/08/2026' }],
    ['localDate non-calendar on diary_entry', { ...diaryOpRaw(), localDate: '2026-02-30' }],
    ['payload missing on create', { payload: undefined }],
    ['payload missing on update', { action: 'update', payload: undefined }],
    ['payload present on delete', { action: 'delete', payload: { foodId: FOOD_ID } }],
    ['payload is an array', { payload: ['foodId'] }],
  ];
  function diaryOpRaw(): Record<string, unknown> {
    return validOp({ kind: 'diary_entry', localDate: '2026-10-08' });
  }
  for (const [label, override] of cases) {
    it(`refuses: ${label}`, () => {
      const result = parse([validOp(override)]);
      expect(result.ok, label).toBe(false);
    });
  }

  it('refuses a diary_entry op with localDate ABSENT (required, §1.1)', () => {
    const result = parse([validOp({ kind: 'diary_entry' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.endsWith('.localDate'))).toBe(true);
    }
  });

  it('canonical diary shape: payload localDate in parity with the envelope field is accepted', () => {
    const result = parse([
      validOp({
        kind: 'diary_entry',
        localDate: '2026-10-08',
        payload: { mealSlot: 'breakfast', localDate: '2026-10-08' },
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('canonical diary shape: a payload localDate DISAGREEING with the envelope field is a whole-batch shape error', () => {
    const result = parse([
      validOp({
        kind: 'diary_entry',
        localDate: '2026-10-08',
        payload: { mealSlot: 'breakfast', localDate: '2026-10-09' },
      }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.endsWith('.localDate'))).toBe(true);
    }
  });

  it('refuses a non-object op element with a structural path', () => {
    const result = parse(['nope']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('ops[0].');
    }
  });
});

describe('I12 — shape errors never echo received values', () => {
  it('errors carry only structural fields and generic messages', () => {
    const hostilePayload = { secretHealth: 'weight-98.7kg-diary-content' };
    const result = parseBatchBody(
      {
        deviceId: 'leaky-device-value',
        ops: [validOp({ payload: hostilePayload, action: 'delete' })],
      },
      100,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.errors);
      expect(serialized).not.toContain('weight-98.7kg-diary-content');
      expect(serialized).not.toContain('leaky-device-value');
      for (const error of result.errors) {
        expect(Object.keys(error).sort()).toEqual(['field', 'message']);
      }
    }
  });
});
