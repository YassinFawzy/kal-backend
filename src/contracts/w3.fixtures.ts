/**
 * Kal — served contract fixtures, version `w3` (conventions.md §6; wave-03
 * contract: docs/api/wave-03-contract.md).
 *
 * GENERATED-FROM-SOURCE ARTIFACT: this module is the source of truth for the
 * fixture document served at GET /contracts/w3. It evolves ADDITIVELY within
 * the version; breaking changes ship a new version marker (conventions §0).
 *
 * Additive-over-w2 guarantee: every `w1` + `w2` entry is carried BYTE-STABLY
 * by reusing `w2FixturesDocument().endpoints` verbatim — one source of truth
 * per document, no drift; `w1.fixtures.ts` and `w2.fixtures.ts` are untouched
 * by this wave and both documents are pinned by golden hashes (w3 spec).
 *
 * The `w3` entries freeze the tracking + sync surface (wave-03 contract note
 * §2): catalog search/detail, barcode resolution, the REST user-food create
 * (one of the two shared-limiter paths), the diary day READ (diary mutations
 * do NOT exist over REST by design — they flow exclusively through sync
 * ingestion), sync batch ingestion (`Idempotency-Key` required, conventions
 * §3) and the delta pull. Query-parameter shapes (q/limit/cursor) are
 * documented in the contract note §2 — the fixture format pins method/path/
 * auth/responses only (the w2 precedent for sessions.list).
 *
 * Error entries carry exactly the frozen registry codes (conventions §4 —
 * no new codes this wave). Success bodies are schema-only: every `w3` body
 * is dynamic (per-user/per-request data), so shapes are pinned by
 * `bodySchema` alone — the w2 rule for dynamic bodies.
 */
import type { EndpointFixture } from './w1.fixtures.js';
import { w2FixturesDocument } from './w2.fixtures.js';
import type { W2EndpointFixture, W2SchemaSubset } from './w2.fixtures.js';

export const W3_CONTRACT_VERSION = 'w3';

/** A served w3 entry: either a byte-stable carried entry (w1 or w2) or a w3 entry. */
export type ServedW3Endpoint = EndpointFixture | W2EndpointFixture;

export interface W3ContractFixturesDocument {
  readonly version: typeof W3_CONTRACT_VERSION;
  readonly api: 'kal-api';
  readonly endpoints: readonly ServedW3Endpoint[];
}

/** Problem-details envelope schema — pins every member but `requestId`. */
const ENVELOPE_SCHEMA = (status: number, code: string): W2SchemaSubset => ({
  type: 'object',
  required: ['type', 'title', 'status', 'code', 'requestId'],
  properties: {
    status: { const: status },
    code: { const: code },
  },
});

/** Cursor-collection envelope (conventions §2) with item schema. */
const COLLECTION_SCHEMA = (item: W2SchemaSubset): W2SchemaSubset => ({
  type: 'object',
  required: ['data', 'nextCursor'],
  properties: { data: { items: item } },
});

/** A catalog food as surfaced by search/detail (per-100 g macros; EN+AR names). */
const FOOD_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'type', 'provenance', 'nameEn', 'nameAr', 'energyKcal', 'proteinG', 'carbsG', 'fatG'],
};

/** A diary entry as surfaced by the day read (frozen snapshot fields, I11). */
const DIARY_ENTRY_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'localDate', 'mealSlot', 'entryMethod', 'quantity', 'energyKcal', 'proteinG', 'carbsG', 'fatG', 'status'],
};

/** The day rollup (per-note §2: totals only — target comparison is W5). */
const DAY_TOTALS_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['energyKcal', 'proteinG', 'carbsG', 'fatG', 'entryCount'],
};

/** One per-op result in the ingestion ack envelope (note §1: outcomes). */
const OP_RESULT_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['opId', 'outcome'],
};

/** One change record in the delta-pull envelope (note §1). */
const CHANGE_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['kind', 'entityId', 'change', 'updatedAt'],
};

export function w3FixturesDocument(): W3ContractFixturesDocument {
  return {
    version: W3_CONTRACT_VERSION,
    api: 'kal-api',
    endpoints: [
      // --- carried verbatim from w1 + w2 (byte-stable; single source of truth) ---
      ...w2FixturesDocument().endpoints,
      // --- tracking + sync surface frozen by docs/api/wave-03-contract.md ---
      {
        id: 'tracking.foods.search',
        method: 'GET',
        path: '/tracking/foods',
        auth: 'bearer',
        responses: [
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: COLLECTION_SCHEMA(FOOD_ITEM_SCHEMA) },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'tracking.foods.get',
        method: 'GET',
        path: '/tracking/foods/{foodId}',
        auth: 'bearer',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['food', 'servingVariants'],
              properties: { food: FOOD_ITEM_SCHEMA, servingVariants: { items: { type: 'object', required: ['id', 'labelEn', 'labelAr', 'grams', 'isDefault'] } } },
            },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          // Generic 404: absent, malformed, or foreign — byte-identical (I7).
          { status: 404, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(404, 'NOT_FOUND') },
        ],
      },
      {
        id: 'tracking.barcode.resolve',
        method: 'GET',
        path: '/tracking/barcode/{barcode}',
        auth: 'bearer',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            // `result` is `resolved` (with the food payload) or `not_found`
            // (the guided label-create entry point, FR-017) — never an error.
            bodySchema: { type: 'object', required: ['result'] },
          },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'tracking.user-foods.create',
        method: 'POST',
        path: '/tracking/user-foods',
        auth: 'bearer',
        responses: [
          // Success codes in use: 201 (created, body = created resource).
          { status: 201, contentType: 'application/json; charset=utf-8', bodySchema: { type: 'object', required: ['userFood'] } },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          // The shared user-food create limiter (PRD §8 ≤20/h ≤100/d) — the
          // same limiter the sync-apply path ticks (note §1).
          { status: 429, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(429, 'RATE_LIMITED') },
        ],
      },
      {
        id: 'tracking.diary.day.get',
        method: 'GET',
        path: '/tracking/diary/days/{localDate}',
        auth: 'bearer',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            // A day with no entries is an EMPTY 200 (a date is not an object;
            // there is no 404 for absent days). Target comparison is W5 —
            // this surface carries totals only (ledger §7-E3).
            bodySchema: {
              type: 'object',
              required: ['localDate', 'totals', 'entries'],
              properties: { totals: DAY_TOTALS_SCHEMA, entries: { items: DIARY_ENTRY_ITEM_SCHEMA } },
            },
          },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'sync.ops.push',
        method: 'POST',
        path: '/sync/ops',
        auth: 'bearer',
        responses: [
          // The per-op ack envelope (note §1): results in request order; a
          // rejected op never aborts the batch. Request-level
          // `Idempotency-Key` REQUIRED (conventions §3) — replay ⇒ recorded
          // outcome, key + changed payload ⇒ 409.
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: { type: 'object', required: ['results'], properties: { results: { items: OP_RESULT_ITEM_SCHEMA } } },
          },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          { status: 409, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(409, 'CONFLICT') },
        ],
      },
      {
        id: 'sync.changes.pull',
        method: 'GET',
        path: '/sync/changes',
        auth: 'bearer',
        responses: [
          // The delta feed (note §1): opaque user-bound cursors (conventions
          // §2) — a foreign/expired/malformed cursor is the SAME generic 400.
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: COLLECTION_SCHEMA(CHANGE_ITEM_SCHEMA) },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'contracts.w3',
        method: 'GET',
        path: '/contracts/w3',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['version', 'api', 'endpoints'],
              properties: { version: { const: 'w3' }, api: { const: 'kal-api' } },
            },
          },
        ],
      },
    ],
  };
}
