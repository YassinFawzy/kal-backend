/**
 * Kal API e2e — the served `w3` contract document (conventions.md §6, wave
 * 03). Pins: the document parses with version marker `w3`, carries every w1
 * + w2 entry byte-stably, uses subset-only schemas, and round-trips its
 * live-executable entry (GET /contracts/w3 itself). The served `w1` and
 * `w2` documents are asserted UNCHANGED (source goldens + served-body deep
 * equality) — the w3 addition must not disturb the frozen surfaces.
 *
 * Tracking/sync endpoints themselves are "declared" fixture entries at this
 * stage (Stage-2 lanes implement to the frozen note; their round-trips land
 * with those lanes) — the w3 fixtures spec (unit) pins structural
 * consistency; the implementing lanes pin their responses against it.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { w1FixturesDocument } from '../src/contracts/w1.fixtures.js';
import { w2FixturesDocument } from '../src/contracts/w2.fixtures.js';
import { w3FixturesDocument } from '../src/contracts/w3.fixtures.js';
import { assertConformsToSchema, assertSchemaUsesSubsetOnly, SchemaNode } from './support/contract-schema.js';

/** Fixture-shaped local env — synthetic, placeholder-free (I15-compliant). */
const E2E_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://kal_dev:syntheticfixturepw@localhost:5432/kal',
  NODE_ENV: 'test',
  PORT: '3993',
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

describe('served w3 contract document (conventions.md §6)', () => {
  it('GET /contracts/w3 → 200, parses, version marker w3', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w3').expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body['version']).toBe('w3');
    expect(response.body['api']).toBe('kal-api');
    expect(Array.isArray(response.body['endpoints'])).toBe(true);
  });

  it('retains every w1+w2 entry byte-stably and adds exactly the w3 entries', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w3').expect(200);
    const endpoints = response.body['endpoints'] as EndpointFixtureShape[];
    const carried = w2FixturesDocument().endpoints;
    const servedById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
    for (const entry of carried) {
      const served = servedById.get(entry.id);
      expect(served, `carried entry ${entry.id} is retained`).toBeDefined();
      expect(JSON.stringify(served)).toBe(JSON.stringify(entry));
    }
    const expectedAdded = w3FixturesDocument()
      .endpoints.slice(carried.length)
      .map((endpoint) => endpoint.id);
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      ...carried.map((endpoint) => endpoint.id),
      ...expectedAdded,
    ]);
    expect(servedById.get('contracts.w3')).toBeDefined();
  });

  it('served w1 and w2 documents are unchanged (source golden + served deep equality)', async () => {
    const w1 = await request(app.getHttpServer()).get('/contracts/w1').expect(200);
    expect(JSON.stringify(w1.body)).toBe(JSON.stringify(w1FixturesDocument()));
    const w2 = await request(app.getHttpServer()).get('/contracts/w2').expect(200);
    expect(JSON.stringify(w2.body)).toBe(JSON.stringify(w2FixturesDocument()));
  });

  it('every served bodySchema uses only the documented subset keywords', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w3').expect(200);
    for (const endpoint of response.body['endpoints'] as EndpointFixtureShape[]) {
      for (const entry of endpoint.responses) {
        if (entry.bodySchema !== undefined) {
          assertSchemaUsesSubsetOnly(entry.bodySchema, `${endpoint.id}[${entry.status}]`);
        }
      }
    }
  });

  it('every served example conforms to its bodySchema', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w3').expect(200);
    for (const endpoint of response.body['endpoints'] as EndpointFixtureShape[]) {
      for (const entry of endpoint.responses) {
        if (entry.example !== undefined && entry.bodySchema !== undefined) {
          assertConformsToSchema(entry.example, entry.bodySchema, `${endpoint.id}[${entry.status}].example`);
        }
      }
    }
  });
});
