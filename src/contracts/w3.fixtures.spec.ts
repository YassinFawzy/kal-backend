import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { w1FixturesDocument } from './w1.fixtures.js';
import { w2FixturesDocument } from './w2.fixtures.js';
import { w3FixturesDocument } from './w3.fixtures.js';

/**
 * w1/w2 document byte-stability goldens (task required case: the `w3` wave
 * must not disturb the frozen documents). SHA-256 over the stable-
 * stringified documents — any edit to w1.fixtures.ts / w2.fixtures.ts
 * changes these hashes and fails the suite. The W1 hash is the SAME constant
 * the w2 spec pins (single source for the single history).
 */
const W1_DOCUMENT_SHA256 = 'cb5c26280ae6c1df8946c19d1ce2b67e60f2ac970b68d164d3a15b6ba798dc34';
const W2_DOCUMENT_SHA256 = '3bc5e0735040551fc8dff13c52ad4119ba9b551766b930303440cdf4409b7280';

/**
 * w3 golden (additive evolution pin): the served w3 document as shipped by
 * s1, amended by supervisor amendment 1 (2026-10-08: pull envelope `changes`
 * key per note §1.6 — original hash 29be4bb4… pinned the pre-amendment doc).
 * this wave. Any later wave extending w3 additively updates this hash in the
 * same change package; a drift without a marker change fails here.
 */
const W3_DOCUMENT_SHA256 = '80b2f3a74fddd346221bcb3fb2ad84eb88225ac2ce8213acc0e928f328e3cb4a';

describe('w3 contract fixtures (conventions.md §6, additive over w2)', () => {
  it('carries every w1+w2 entry byte-stably, then adds exactly the w3 entries', () => {
    const document = w3FixturesDocument();
    const carried = w2FixturesDocument().endpoints;
    expect(document.endpoints.length).toBe(carried.length + 8);
    // Byte-stability: the carried prefix is the SAME object graph, so any
    // content change to a carried entry would change the w1/w2 documents too
    // (pinned separately by the golden hashes below).
    for (let index = 0; index < carried.length; index += 1) {
      expect(JSON.stringify(document.endpoints[index])).toBe(JSON.stringify(carried[index]));
    }
    const addedIds = document.endpoints.slice(carried.length).map((endpoint) => endpoint.id);
    expect(addedIds).toEqual([
      'tracking.foods.search',
      'tracking.foods.get',
      'tracking.barcode.resolve',
      'tracking.user-foods.create',
      'tracking.diary.day.get',
      'sync.ops.push',
      'sync.changes.pull',
      'contracts.w3',
    ]);
    expect(document.version).toBe('w3');
  });

  it('the w1 document is byte-unchanged (golden hash, same constant the w2 spec pins)', () => {
    expect(createHash('sha256').update(JSON.stringify(w1FixturesDocument())).digest('hex')).toBe(W1_DOCUMENT_SHA256);
  });

  it('the w2 document is byte-unchanged by the w3 addition (golden hash)', () => {
    expect(createHash('sha256').update(JSON.stringify(w2FixturesDocument())).digest('hex')).toBe(W2_DOCUMENT_SHA256);
  });

  it('the served w3 document matches its own golden hash', () => {
    expect(createHash('sha256').update(JSON.stringify(w3FixturesDocument())).digest('hex')).toBe(W3_DOCUMENT_SHA256);
  });

  it('every bodySchema uses only the documented subset keywords', () => {
    const allowedKeywords = new Set(['type', 'required', 'properties', 'items', 'const']);
    for (const endpoint of w3FixturesDocument().endpoints) {
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
    for (const endpoint of w3FixturesDocument().endpoints) {
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
    for (const endpoint of w3FixturesDocument().endpoints) {
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
    const serialized = JSON.stringify(w3FixturesDocument());
    for (const forbidden of [
      '$argon2', // PHC strings (I12/ADR-0003) — never in fixtures
      'Bearer ', // no credentials; the auth field is the declarative "bearer"
      'password', // no credential material or policy hints
      'token ', // no token-looking payloads
      '@', // no email addresses in examples (identifiers never appear)
      'eyJ', // no JWT-shaped strings
    ]) {
      expect(serialized.includes(forbidden), `forbidden material: ${forbidden}`).toBe(false);
    }
  });

  it('w3 declares no diary REST mutation surface (mutations flow only through sync ingestion)', () => {
    const mutatingMethodsOnDiary = w3FixturesDocument()
      .endpoints.filter((endpoint) => endpoint.path.includes('/diary') && endpoint.method !== 'GET')
      .map((endpoint) => endpoint.id);
    expect(mutatingMethodsOnDiary).toEqual([]);
  });
});
