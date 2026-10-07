/**
 * Kal — served contract fixtures, version `w2` (conventions.md §6; identity
 * wave contract: docs/api/wave-02-contract.md).
 *
 * GENERATED-FROM-SOURCE ARTIFACT: this module is the source of truth for the
 * fixture document served at GET /contracts/w2. It evolves ADDITIVELY within
 * the version; breaking changes ship a new version marker (conventions §0).
 *
 * Additive-over-w1 guarantee (contract task, "fixtures additive"): every `w1`
 * entry is carried BYTE-STABLY by reusing `w1FixturesDocument().endpoints`
 * verbatim — there is exactly one source for the w1 document, so the two
 * served documents cannot drift. `w1.fixtures.ts` itself is untouched by this
 * wave; a golden hash spec pins its bytes against accidental edits.
 *
 * Document-format additions frozen for w2 (docs/api/wave-02-contract.md §0):
 *   - `method` widens from "GET" to also "POST" | "DELETE" on new entries
 *     (carried w1 entries keep their exact values; bodySchema remains inside
 *     the documented JSON-Schema subset — conventions §6.1).
 *   - `auth` value "bearer" = the request MUST present a Bearer credential in
 *     the Authorization header; WHICH credential class each endpoint accepts
 *     is stated in the contract note §2 (access JWT, refresh token, or
 *     recovery ticket — all travel only in that header, conventions §1).
 *   - `contentType` is omitted on bodiless responses (204) only.
 *
 * Non-GET and bearer entries are "declared" entries: they pin response shapes
 * for client type authoring and backend round-trip tests. The client checker
 * live-executes only entries it can run without credentials or side effects
 * (GET + auth "none") per the contract note §7 — the backend asserts the rest
 * by round-trip as its implementations land (s2/s2b).
 */
import { w1FixturesDocument } from './w1.fixtures.js';
import type { EndpointFixture } from './w1.fixtures.js';

export const W2_CONTRACT_VERSION = 'w2';

/** The documented JSON-Schema subset (conventions.md §6.1) — nothing else. */
export type W2SchemaSubset =
  | {
      readonly type: 'object';
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, W2SchemaSubset>>;
    }
  | { readonly items: W2SchemaSubset }
  | { readonly const: unknown };

export interface W2ResponseFixture {
  readonly status: number;
  /** Omitted only for bodiless responses (204). */
  readonly contentType?: string;
  readonly bodySchema?: W2SchemaSubset;
  readonly example?: unknown;
}

export interface W2EndpointFixture {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path template; `{name}` segments are positional placeholders. */
  readonly path: string;
  readonly auth: 'none' | 'bearer';
  readonly responses: readonly W2ResponseFixture[];
}

/** A served w2 entry: either a byte-stable carried w1 entry or a w2 entry. */
export type ServedW2Endpoint = EndpointFixture | W2EndpointFixture;

export interface W2ContractFixturesDocument {
  readonly version: typeof W2_CONTRACT_VERSION;
  readonly api: 'kal-api';
  readonly endpoints: readonly ServedW2Endpoint[];
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

/** One "signed-in device" item in session listings (note §2). */
const SESSION_ITEM_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['id', 'deviceLabel', 'createdAt', 'expiresAt'],
};

/** The token-pair body shared by sign-in, refresh, and recovery completion. */
const SESSION_PAIR_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['accessToken', 'refreshToken', 'session'],
  properties: { session: SESSION_ITEM_SCHEMA },
};

/** Generic signup/recovery-request success body — byte-identical for every
 * outcome class (fresh, duplicate, unknown identifier — note §3). */
const ACCEPTED_SCHEMA: W2SchemaSubset = {
  type: 'object',
  required: ['status'],
  properties: { status: { const: 'accepted' } },
};

const ACCEPTED_EXAMPLE: Readonly<{ status: 'accepted' }> = { status: 'accepted' };

export function w2FixturesDocument(): W2ContractFixturesDocument {
  return {
    version: W2_CONTRACT_VERSION,
    api: 'kal-api',
    endpoints: [
      // --- carried verbatim from w1 (byte-stable; single source of truth) ---
      ...w1FixturesDocument().endpoints,
      // --- identity endpoints frozen by docs/api/wave-02-contract.md ---
      {
        id: 'identity.signup',
        method: 'POST',
        path: '/identity/signup',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: ACCEPTED_SCHEMA,
            example: ACCEPTED_EXAMPLE,
          },
        ],
      },
      {
        id: 'identity.signin',
        method: 'POST',
        path: '/identity/signin',
        auth: 'none',
        responses: [
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: SESSION_PAIR_SCHEMA },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          { status: 429, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(429, 'RATE_LIMITED') },
        ],
      },
      {
        id: 'identity.token.refresh',
        method: 'POST',
        path: '/identity/token/refresh',
        auth: 'bearer',
        responses: [
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: SESSION_PAIR_SCHEMA },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'identity.sessions.list',
        method: 'GET',
        path: '/identity/sessions',
        auth: 'bearer',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['data', 'nextCursor'],
              properties: { data: { items: SESSION_ITEM_SCHEMA } },
            },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'identity.sessions.revoke',
        method: 'DELETE',
        path: '/identity/sessions/{sessionId}',
        auth: 'bearer',
        responses: [
          // 204 is bodiless: no contentType, no bodySchema (note §0).
          { status: 204 },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
          { status: 404, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(404, 'NOT_FOUND') },
        ],
      },
      {
        id: 'identity.profile.get',
        method: 'GET',
        path: '/identity/me',
        auth: 'bearer',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['user'],
              properties: {
                user: {
                  type: 'object',
                  required: ['id', 'username', 'email', 'phone', 'createdAt'],
                },
              },
            },
          },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'identity.recovery.request',
        method: 'POST',
        path: '/identity/recovery/request',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: ACCEPTED_SCHEMA,
            example: ACCEPTED_EXAMPLE,
          },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 429, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(429, 'RATE_LIMITED') },
        ],
      },
      {
        id: 'identity.recovery.complete',
        method: 'POST',
        path: '/identity/recovery/complete',
        auth: 'bearer',
        responses: [
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: SESSION_PAIR_SCHEMA },
          { status: 400, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED') },
          { status: 401, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(401, 'UNAUTHENTICATED') },
        ],
      },
      {
        id: 'contracts.w2',
        method: 'GET',
        path: '/contracts/w2',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['version', 'api', 'endpoints'],
              properties: { version: { const: 'w2' }, api: { const: 'kal-api' } },
            },
          },
        ],
      },
    ],
  };
}
