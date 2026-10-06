import { describe, expect, it } from 'vitest';
import { probeProblemDetailsExample, w1FixturesDocument } from './w1.fixtures.js';

describe('w1 contract fixtures (conventions.md §6)', () => {
  it('carries the four lane-owned entries plus the additive owner-context probe', () => {
    const endpoints = w1FixturesDocument().endpoints.map((endpoint) => endpoint.id).sort();
    expect(endpoints).toEqual(['contracts.self', 'health.liveness', 'health.readiness', 'probe.owner-context', 'probe.problem-details']);
  });

  it('the probe example is the pinned VALIDATION_FAILED body (byte-stable)', () => {
    expect(probeProblemDetailsExample()).toEqual({
      type: 'urn:kal:problem:validation-failed',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'One or more fields are invalid.',
      requestId: '00000000-0000-4000-8000-0000000000c0',
      errors: [{ field: 'q', message: 'Required.' }],
    });
  });

  it('every example matches its bodySchema and uses only the documented subset keywords', () => {
    const allowedKeywords = new Set(['type', 'required', 'properties', 'items', 'const']);
    for (const endpoint of w1FixturesDocument().endpoints) {
      for (const response of endpoint.responses) {
        const walk = (node: unknown, path: string): void => {
          if (node === null || typeof node !== 'object') {
            throw new Error(`non-object schema at ${path}`);
          }
          for (const key of Object.keys(node)) {
            if (!allowedKeywords.has(key)) {
              throw new Error(`non-subset keyword "${key}" at ${path}`);
            }
          }
          const properties = (node as Record<string, unknown>)['properties'];
          if (properties !== undefined) {
            for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
              walk(child, `${path}.${key}`);
            }
          }
          const items = (node as Record<string, unknown>)['items'];
          if (items !== undefined) {
            walk(items, `${path}[]`);
          }
        };
        if (response.bodySchema !== undefined) {
          walk(response.bodySchema, `${endpoint.id}`);
        }
        if (response.example !== undefined) {
          // The example must satisfy the required keys of its schema.
          const schema = response.bodySchema as { required?: readonly string[] } | undefined;
          for (const key of schema?.required ?? []) {
            expect(response.example, `${endpoint.id} example has "${key}"`).toHaveProperty(key);
          }
        }
      }
    }
  });
});
