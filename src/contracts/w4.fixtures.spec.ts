import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { w1FixturesDocument } from './w1.fixtures.js';
import { w2FixturesDocument } from './w2.fixtures.js';
import { w3FixturesDocument } from './w3.fixtures.js';
import { w4FixturesDocument } from './w4.fixtures.js';

/**
 * w1/w2/w3 document byte-stability goldens (task required case: the `w4`
 * wave must not disturb the frozen documents). SHA-256 over the stable-
 * stringified documents — any edit to w1.fixtures.ts / w2.fixtures.ts /
 * w3.fixtures.ts changes these hashes and fails the suite. The W1/W2/W3
 * constants are the SAME values the earlier specs pin (single source for
 * the single history); W3 carries the in-wave amendment-1 hash from the w3
 * spec.
 */
const W1_DOCUMENT_SHA256 = 'cb5c26280ae6c1df8946c19d1ce2b67e60f2ac970b68d164d3a15b6ba798dc34';
const W2_DOCUMENT_SHA256 = '3bc5e0735040551fc8dff13c52ad4119ba9b551766b930303440cdf4409b7280';
const W3_DOCUMENT_SHA256 = '80b2f3a74fddd346221bcb3fb2ad84eb88225ac2ce8213acc0e928f328e3cb4a';

/**
 * w4 golden (additive evolution pin): the served w4 document as shipped by
 * s1. Any later additive extension of w4 updates this hash in the same
 * change package; a drift without a marker change fails here.
 */
const W4_DOCUMENT_SHA256 = 'f885c9621429d4e539531dd0bb729d6e569ebc37bfaee253f69fdef18cb6ce25';

describe('w4 contract fixtures (conventions.md §6, additive over w3)', () => {
  it('carries every w1+w2+w3 entry byte-stably, then adds exactly the w4 entries', () => {
    const document = w4FixturesDocument();
    const carried = w3FixturesDocument().endpoints;
    expect(document.endpoints.length).toBe(carried.length + 6);
    // Byte-stability: the carried prefix is the SAME object graph, so any
    // content change to a carried entry would change the w1/w2/w3 documents
    // too (pinned separately by the golden hashes below).
    for (let index = 0; index < carried.length; index += 1) {
      expect(JSON.stringify(document.endpoints[index])).toBe(JSON.stringify(carried[index]));
    }
    const addedIds = document.endpoints.slice(carried.length).map((endpoint) => endpoint.id);
    expect(addedIds).toEqual([
      'journal.exercises.search',
      'journal.exercises.get',
      'journal.exercises.pr.get',
      'journal.sessions.day.get',
      'journal.sessions.get',
      'contracts.w4',
    ]);
    expect(document.version).toBe('w4');
  });

  it('the w1 document is byte-unchanged (golden hash, same constant the w2/w3 specs pin)', () => {
    expect(createHash('sha256').update(JSON.stringify(w1FixturesDocument())).digest('hex')).toBe(W1_DOCUMENT_SHA256);
  });

  it('the w2 document is byte-unchanged by the w4 addition (golden hash)', () => {
    expect(createHash('sha256').update(JSON.stringify(w2FixturesDocument())).digest('hex')).toBe(W2_DOCUMENT_SHA256);
  });

  it('the w3 document is byte-unchanged by the w4 addition (golden hash, same constant the w3 spec pins)', () => {
    expect(createHash('sha256').update(JSON.stringify(w3FixturesDocument())).digest('hex')).toBe(W3_DOCUMENT_SHA256);
  });

  it('the served w4 document matches its own golden hash', () => {
    expect(createHash('sha256').update(JSON.stringify(w4FixturesDocument())).digest('hex')).toBe(W4_DOCUMENT_SHA256);
  });

  it('every bodySchema uses only the documented subset keywords', () => {
    const allowedKeywords = new Set(['type', 'required', 'properties', 'items', 'const']);
    for (const endpoint of w4FixturesDocument().endpoints) {
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

  it('every `example` (none today — dynamic bodies) matches its bodySchema', () => {
    for (const endpoint of w4FixturesDocument().endpoints) {
      for (const response of endpoint.responses) {
        if ('example' in response && response.example !== undefined) {
          const required = (response.bodySchema as { required?: readonly string[] }).required ?? [];
          for (const key of required) {
            expect(response.example, `${endpoint.id}[${response.status}].${key}`).toHaveProperty(key);
          }
        }
      }
    }
  });

  it('the w4 entries carry exactly the frozen registry error codes — no new codes (w4 note §0)', () => {
    const document = w4FixturesDocument();
    const added = document.endpoints.slice(w3FixturesDocument().endpoints.length);
    for (const endpoint of added) {
      for (const response of endpoint.responses) {
        if (response.status >= 400) {
          const codeSchema = (response.bodySchema as { properties?: { code?: { const?: string } } } | undefined)?.properties?.code;
          if (codeSchema?.const !== undefined) {
            expect(['VALIDATION_FAILED', 'UNAUTHENTICATED', 'NOT_FOUND'], `${endpoint.id}[${response.status}]`).toContain(codeSchema.const);
          }
        }
      }
    }
  });
});
