import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { w1FixturesDocument } from './w1.fixtures.js';
import { w2FixturesDocument } from './w2.fixtures.js';

/**
 * w1 document byte-stability golden (task required case: "a migration-
 * integrity test that the `w1` fixtures document is byte-unchanged by the
 * `w2` addition"). SHA-256 over the stable-stringified w1 document — any
 * edit to w1.fixtures.ts changes this hash and fails the suite.
 */
const W1_DOCUMENT_SHA256 = 'cb5c26280ae6c1df8946c19d1ce2b67e60f2ac970b68d164d3a15b6ba798dc34';

describe('w2 contract fixtures (conventions.md §6, additive over w1)', () => {
  it('carries every w1 entry byte-stably, then adds the identity entries', () => {
    const document = w2FixturesDocument();
    const w1Entries = w1FixturesDocument().endpoints;
    expect(document.endpoints.length).toBe(w1Entries.length + 9);
    // Byte-stability: the carried prefix is the SAME object graph, so any
    // content change to a w1 entry would be a change to the w1 document too
    // (pinned separately by the golden hash below).
    for (let index = 0; index < w1Entries.length; index += 1) {
      expect(JSON.stringify(document.endpoints[index])).toBe(JSON.stringify(w1Entries[index]));
    }
    const addedIds = document.endpoints.slice(w1Entries.length).map((endpoint) => endpoint.id);
    expect(addedIds).toEqual([
      'identity.signup',
      'identity.signin',
      'identity.token.refresh',
      'identity.sessions.list',
      'identity.sessions.revoke',
      'identity.profile.get',
      'identity.recovery.request',
      'identity.recovery.complete',
      'contracts.w2',
    ]);
    expect(document.version).toBe('w2');
  });

  it('the w1 document itself is byte-unchanged by the w2 addition (golden hash)', () => {
    expect(createHash('sha256').update(JSON.stringify(w1FixturesDocument())).digest('hex')).toBe(W1_DOCUMENT_SHA256);
  });

  it('every bodySchema uses only the documented subset keywords', () => {
    const allowedKeywords = new Set(['type', 'required', 'properties', 'items', 'const']);
    for (const endpoint of w2FixturesDocument().endpoints) {
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
              walk(child, `${path}.properties.${key}`);
            }
          }
          const items = (node as Record<string, unknown>)['items'];
          if (items !== undefined) {
            walk(items, `${path}[]`);
          }
        };
        if (response.bodySchema !== undefined) {
          walk(response.bodySchema, `${endpoint.id}[${response.status}]`);
        }
      }
    }
  });

  it('every example matches its bodySchema (required keys present, consts exact)', () => {
    for (const endpoint of w2FixturesDocument().endpoints) {
      for (const response of endpoint.responses) {
        if (response.example === undefined) {
          continue;
        }
        const walk = (value: unknown, schema: unknown, path: string): void => {
          const node = schema as { const?: unknown; required?: readonly string[]; properties?: Record<string, unknown> };
          if (node.const !== undefined) {
            expect(value, `${path} const`).toBe(node.const);
            return;
          }
          for (const key of node.required ?? []) {
            expect(value, `${path} has "${key}"`).toHaveProperty(key);
          }
          for (const [key, child] of Object.entries(node.properties ?? {})) {
            walk((value as Record<string, unknown>)[key], child, `${path}.${key}`);
          }
        };
        walk(response.example, response.bodySchema, `${endpoint.id}[${response.status}].example`);
      }
    }
  });

  it('error entries carry exactly one registered registry code at the registry status', () => {
    const registry: Record<string, number> = {
      VALIDATION_FAILED: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
      UNAVAILABLE: 503,
    };
    for (const endpoint of w2FixturesDocument().endpoints) {
      for (const response of endpoint.responses) {
        const code = (response.bodySchema as { properties?: { code?: { const?: string } } } | undefined)?.properties?.['code']?.const;
        if (code === undefined) {
          continue;
        }
        expect(registry[code], `${endpoint.id} uses a frozen registry code`).toBe(response.status);
      }
    }
  });

  it('non-disclosure scan: no secret/identifier/credential material anywhere in the served document', () => {
    const serialized = JSON.stringify(w2FixturesDocument());
    for (const forbidden of [
      '$argon2', // PHC strings (I12/ADR-0003) — never in fixtures
      'Bearer ', // no credentials; the auth field is the declarative "bearer"
      'password', // no credential material or policy hints
      'token ', // no token-looking payloads
      '@', // no email addresses in examples (identifiers never appear)
      'eyJ', // no JWT-shaped strings
    ]) {
      expect(serialized, `fixture document must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});
