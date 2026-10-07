/**
 * Kal API e2e — the served `w2` contract document (conventions.md §6, identity
 * wave). Pins: the document parses with version marker `w2`, carries every w1
 * entry byte-stably, uses subset-only schemas, and round-trips its one
 * live-executable entry (GET /contracts/w2 itself). The served `w1` document
 * is asserted UNCHANGED (byte-level via its source golden + deep-equality of
 * the served body) — the w2 addition must not disturb the frozen w1 surface.
 *
 * Identity endpoints themselves are "declared" fixture entries at this stage
 * (s2/s2b implement to the frozen note; their round-trips land with those
 * lanes) — the w2 fixtures spec (unit) pins their structural consistency.
 */
import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w1FixturesDocument } from '../src/contracts/w1.fixtures.js';
import { w2FixturesDocument } from '../src/contracts/w2.fixtures.js';
import { assertConformsToSchema, assertSchemaUsesSubsetOnly, SchemaNode } from './support/contract-schema.js';

/** Fixture-shaped local env — synthetic, placeholder-free (I15-compliant). */
const E2E_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://kal_dev:local_fixture_only@localhost:5432/kal',
  NODE_ENV: 'test',
  PORT: '3991',
};

interface EndpointFixtureShape {
  id: string;
  method: string;
  path: string;
  auth: string;
  responses: { status: number; contentType?: string; bodySchema?: SchemaNode; example?: unknown }[];
}

let app: INestApplication<App>;

beforeAll(async () => {
  Object.assign(process.env, E2E_ENV);
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(READINESS_CHECKS)
    .useValue([{ name: 'always-ready-fixture', check: async () => undefined }])
    .compile();
  app = moduleFixture.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('served w2 contract document (conventions.md §6)', () => {
  it('GET /contracts/w2 → 200, parses, version marker w2', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w2').expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body['version']).toBe('w2');
    expect(response.body['api']).toBe('kal-api');
    expect(Array.isArray(response.body['endpoints'])).toBe(true);
  });

  it('retains every w1 entry byte-stably and adds exactly the identity entries', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w2').expect(200);
    const endpoints = response.body['endpoints'] as EndpointFixtureShape[];
    const w1Ids = w1FixturesDocument().endpoints.map((endpoint) => endpoint.id);
    const servedById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const id of w1Ids) {
      const carried = servedById.get(id);
      expect(carried, `w1 entry ${id} is retained`).toBeDefined();
      expect(JSON.stringify(carried)).toBe(
        JSON.stringify(w1FixturesDocument().endpoints.find((endpoint) => endpoint.id === id)),
      );
    }
    expect(endpoints.filter((endpoint) => endpoint.id.startsWith('identity.'))).toHaveLength(8);
    expect(servedById.get('contracts.w2')).toBeDefined();
  });

  it('every served bodySchema uses only the documented subset keywords', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w2').expect(200);
    for (const endpoint of response.body['endpoints'] as EndpointFixtureShape[]) {
      for (const responseSpec of endpoint.responses) {
        if (responseSpec.bodySchema !== undefined) {
          assertSchemaUsesSubsetOnly(responseSpec.bodySchema, `${endpoint.id}[${responseSpec.status}].bodySchema`);
        }
      }
    }
  });

  it('round-trips the live-executable entry (contracts.w2 self-probe)', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w2').expect(200);
    const spec = w2FixturesDocument().endpoints.find((endpoint) => endpoint.id === 'contracts.w2')?.responses.find((candidate) => candidate.status === 200);
    expect(spec?.bodySchema).toBeDefined();
    assertConformsToSchema(response.body, spec?.bodySchema as SchemaNode, 'contracts.w2');
    expect(response.body).toEqual(w2FixturesDocument());
  });

  it('the served w1 document is untouched by the w2 addition (deep-equal to source; source golden-pinned)', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w1').expect(200);
    expect(response.body).toEqual(w1FixturesDocument());
    // The source-of-truth bytes are pinned by the unit spec golden; assert the
    // same hash here so a served/source divergence cannot hide behind the
    // deep-equal above (both sides would have to change in lockstep).
    expect(createHash('sha256').update(JSON.stringify(response.body)).digest('hex')).toBe(
      createHash('sha256').update(JSON.stringify(w1FixturesDocument())).digest('hex'),
    );
  });
});
