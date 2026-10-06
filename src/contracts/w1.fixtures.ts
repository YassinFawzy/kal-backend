/**
 * Kal — served contract fixtures, version `w1` (conventions.md §6).
 *
 * GENERATED-FROM-SOURCE ARTIFACT: this module is the source of truth for
 * the fixture document served at GET /contracts/w1. Clients never hand-edit
 * it; the document evolves additively within the version, and breaking
 * changes ship a new version marker (conventions.md §0/§6.1).
 *
 * The probe's problem-details example is produced by the SAME builder the
 * filter uses, so the served example and the served response cannot drift.
 */
import { buildProblemDetails } from '../problems/problem-details.js';
import { PROBE_FIXTURE_REQUEST_ID } from '../health/health.controller.js';

export const W1_CONTRACT_VERSION = 'w1';

/** The documented JSON-Schema subset (conventions.md §6.1) — nothing else. */
export type SchemaSubset =
  | {
      readonly type: 'object';
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, SchemaSubset>>;
    }
  | { readonly items: SchemaSubset }
  | { readonly const: unknown };

export interface ResponseFixture {
  readonly status: number;
  readonly contentType: string;
  readonly bodySchema?: SchemaSubset;
  readonly example?: unknown;
}

export interface EndpointFixture {
  readonly id: string;
  readonly method: 'GET';
  readonly path: string;
  readonly auth: 'none' | 'jwt-bearer';
  readonly responses: readonly ResponseFixture[];
}

export interface ContractFixturesDocument {
  readonly version: typeof W1_CONTRACT_VERSION;
  readonly api: 'kal-api';
  readonly endpoints: readonly EndpointFixture[];
}

const OK_SCHEMA: SchemaSubset = {
  type: 'object',
  required: ['status'],
  properties: { status: { const: 'ok' } },
};

const OK_EXAMPLE: Readonly<{ status: 'ok' }> = { status: 'ok' };

const ENVELOPE_SCHEMA = (status: number, code: string): SchemaSubset => ({
  type: 'object',
  required: ['type', 'title', 'status', 'code', 'requestId'],
  properties: {
    status: { const: status },
    code: { const: code },
  },
});

/** Byte-stable probe example — served by /probe/problem-details verbatim. */
export function probeProblemDetailsExample(): ReturnType<typeof buildProblemDetails> {
  return buildProblemDetails({
    code: 'VALIDATION_FAILED',
    requestId: PROBE_FIXTURE_REQUEST_ID,
    errors: [{ field: 'q', message: 'Required.' }],
  });
}

export function w1FixturesDocument(): ContractFixturesDocument {
  return {
    version: W1_CONTRACT_VERSION,
    api: 'kal-api',
    endpoints: [
      {
        id: 'health.liveness',
        method: 'GET',
        path: '/health',
        auth: 'none',
        responses: [{ status: 200, contentType: 'application/json; charset=utf-8', bodySchema: OK_SCHEMA, example: OK_EXAMPLE }],
      },
      {
        id: 'health.readiness',
        method: 'GET',
        path: '/health/ready',
        auth: 'none',
        responses: [
          { status: 200, contentType: 'application/json; charset=utf-8', bodySchema: OK_SCHEMA, example: OK_EXAMPLE },
          { status: 503, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(503, 'UNAVAILABLE') },
        ],
      },
      {
        id: 'probe.problem-details',
        method: 'GET',
        path: '/probe/problem-details',
        auth: 'none',
        responses: [
          {
            status: 400,
            contentType: 'application/problem+json',
            bodySchema: ENVELOPE_SCHEMA(400, 'VALIDATION_FAILED'),
            example: probeProblemDetailsExample(),
          },
        ],
      },
      {
        // Additive entry (conventions.md §6.1 allows additive fixture
        // evolution): the live fail-closed proof (I2) — always 403 in W1.
        id: 'probe.owner-context',
        method: 'GET',
        path: '/probe/owner-context',
        auth: 'none',
        responses: [
          { status: 403, contentType: 'application/problem+json', bodySchema: ENVELOPE_SCHEMA(403, 'FORBIDDEN_OWNER') },
        ],
      },
      {
        id: 'contracts.self',
        method: 'GET',
        path: '/contracts/w1',
        auth: 'none',
        responses: [
          {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            bodySchema: {
              type: 'object',
              required: ['version', 'api', 'endpoints'],
              properties: { version: { const: 'w1' }, api: { const: 'kal-api' } },
            },
          },
        ],
      },
    ],
  };
}
