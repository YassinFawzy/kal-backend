/**
 * Kal — served contract fixtures, version `w4` (conventions.md §6; wave-04
 * contract: docs/api/wave-04-contract.md).
 *
 * GENERATED-FROM-SOURCE ARTIFACT: this module is the source of truth for the
 * fixture document served at GET /contracts/w4. It evolves ADDITIVELY within
 * the version; breaking changes ship a new version marker (conventions §0).
 *
 * Additive-over-w3 guarantee: every `w1` + `w2` + `w3` entry is carried
 * BYTE-STABLY by reusing `w3FixturesDocument().endpoints` verbatim — one
 * source of truth per document, no drift; `w1.fixtures.ts`, `w2.fixtures.ts`
 * and `w3.fixtures.ts` are untouched by this wave and all three documents
 * are pinned by golden hashes (w4 spec).
 *
 * The `w4` entries freeze the journal READ surface (w4 contract note §2):
 * exercise-catalog search/detail (the w3 foods search pattern, reusing the
 * frozen normalization pipeline), the session day read and session detail
 * (journal mutations do NOT exist over REST by design — they flow
 * exclusively through sync ingestion as the `journal_session` and
 * `journal_routine` kinds, note §1), and the per-exercise PR read (server
 * derivation, Epley formula, note §1). The sync envelope is UNCHANGED by
 * this wave — the new kinds ride the existing `POST /sync/ops` and
 * `GET /sync/changes` entries (w3), so no sync fixture entries are added
 * ("sync fixture entries if shapes changed" — they did not).
 *
 * Error entries carry exactly the frozen registry codes (conventions §4 —
 * no new codes this wave). Success bodies are schema-only: every `w4` body
 * is dynamic (per-user/per-request data), so shapes are pinned by
 * `bodySchema` alone — the w3 rule for dynamic bodies.
 */
import type { W2EndpointFixture, W2SchemaSubset } from './w2.fixtures.js';
import { w3FixturesDocument } from './w3.fixtures.js';
import type { EndpointFixture } from './w1.fixtures.js';

export const W4_CONTRACT_VERSION = 'w4';

/** A served w4 entry: either a byte-stable carried entry (w1/w2/w3) or a w4 entry. */
export type ServedW4Endpoint = EndpointFixture | W2EndpointFixture | ReturnType<typeof w3FixturesDocument>['endpoints'][number];

export interface W4ContractFixturesDocument {
  readonly version: typeof W4_CONTRACT_VERSION;
  readonly api: 'kal-api';
  readonly endpoints: readonly ServedW4Endpoint[];
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

/** A catalog exercise as surfaced by search/detail (w4 note §2). */
const EXERCISE_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'provenance', 'nameEn', 'nameAr', 'muscleGroups', 'tags'],
};

/** One ordered set as projected inside a session's exercise entries (§2). */
const SET_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'position', 'format'],
};

/** One ordered exercise entry as projected inside a session read (§2) —
 * carries the frozen-at-log-time name snapshot (I11-analog). */
const SESSION_EXERCISE_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'position', 'exerciseId', 'nameSnapshotEn', 'sets'],
  properties: { sets: { items: SET_ITEM_SCHEMA } },
};

/** A session as projected by the day read / detail read (§2). */
const SESSION_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'localDate', 'exercises'],
  properties: { exercises: { items: SESSION_EXERCISE_ITEM_SCHEMA } },
};

/** The per-exercise PR read payload (§2 — server-derived, Epley). */
const PR_PAYLOAD_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['exerciseId', 'estimatedOneRepMaxKg', 'sourceSet', 'achievedOn'],
};

export function w4FixturesDocument(): W4ContractFixturesDocument {
  return {
    version: W4_CONTRACT_VERSION,
    api: 'kal-api',
    endpoints: [
      // --- carried verbatim from w1 + w2 + w3 (byte-stable; single source of truth) ---
      ...w3FixturesDocument().endpoints,
      // --- journal read surface frozen by docs/api/wave-04-contract.md ---
      {
        id: 'journal.exercises.search',
        method: 'GET',
        path: '/journal/exercises',
        auth: 'bearer',
        responses: [
          // Normalized search over the platform exercise catalog (w3 §7
          // pipeline + matching model REUSED); q/limit/cursor per the note
          // §2 (the w3 foods.search precedent — query-parameter shapes are
          // documented in the note, not fixture-pinned).
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: COLLECTION_SCHEMA(EXERCISE_ITEM_SCHEMA) },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'journal.exercises.get',
        method: 'GET',
        path: '/journal/exercises/{exerciseId}',
        auth: 'bearer',
        responses: [
          // Catalog detail incl. AR/EN text instructions (HD-26 — no media).
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: { type: 'object', required: ['exercise'], properties: { exercise: EXERCISE_ITEM_SCHEMA } },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          // Generic 404: absent, malformed, or foreign — byte-identical (I7;
          // the catalog is public to authenticated users, so 404 here means
          // "no such catalog row", the w3 foods.get precedent).
          { status: 404, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(404, 'NOT_FOUND') },
        ],
      },
      {
        id: 'journal.exercises.pr.get',
        method: 'GET',
        path: '/journal/exercises/{exerciseId}/pr',
        auth: 'bearer',
        responses: [
          // Server-derived PR/1RM for the CALLER (Epley over the caller's
          // own applied sessions; owning-user-only — I7). `result` is `pr`
          // (with the payload) or `none` (no qualifying set yet) — a miss
          // is success-shaped, never an error.
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: { type: 'object', required: ['result'], properties: { pr: PR_PAYLOAD_SCHEMA } },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          { status: 404, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(404, 'NOT_FOUND') },
        ],
      },
      {
        id: 'journal.sessions.day.get',
        method: 'GET',
        path: '/journal/sessions/days/{localDate}',
        auth: 'bearer',
        responses: [
          // The journal day READ (the w3 diary-day pattern): client-local
          // date shape-validated; a day with no sessions is an EMPTY 200.
          // Journal mutations do NOT exist over REST (note §1 — freeze).
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['localDate', 'sessions'],
              properties: { sessions: { items: SESSION_ITEM_SCHEMA } },
            },
          },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'journal.sessions.get',
        method: 'GET',
        path: '/journal/sessions/{sessionId}',
        auth: 'bearer',
        responses: [
          // Session detail — the owning user's full projection.
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: { type: 'object', required: ['session'], properties: { session: SESSION_ITEM_SCHEMA } },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          // Generic 404: absent, malformed, deleted/tombstoned, or foreign —
          // byte-identical in all cases (I7; A/B/C-matrixed).
          { status: 404, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(404, 'NOT_FOUND') },
        ],
      },
      {
        id: 'contracts.w4',
        method: 'GET',
        path: '/contracts/w4',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['version', 'api', 'endpoints'],
              properties: { version: { const: 'w4' }, api: { const: 'kal-api' } },
            },
          },
        ],
      },
    ],
  };
}
