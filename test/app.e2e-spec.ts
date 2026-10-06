/**
 * Kal API e2e — boots the real AppModule and proves the W1 contract surface:
 * health/readiness, the problem-details fixtures, fail-closed user-context
 * (I2), the served contract fixtures (round-trip per conventions.md §6.3),
 * and the boot-path refusal on placeholder credentials (I15).
 *
 * No database is required: the Prisma connection is lazy, and readiness
 * checks are overridden per case. DB-backed suites belong to s4's harness.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { READINESS_CHECKS } from '../src/health/readiness.js';
import { ProblemDetailsBody } from '../src/problems/problem-details.js';
import { assertConformsToSchema, assertSchemaUsesSubsetOnly, SchemaNode } from './support/contract-schema.js';

/** Fixture-shaped local env — synthetic, placeholder-free (I15-compliant). */
const E2E_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://kal_dev:local_fixture_only@localhost:5432/kal',
  NODE_ENV: 'test',
  PORT: '3990',
};

interface ReadinessChecksFixture {
  readonly name: string;
  readonly check: () => Promise<void>;
}

async function makeApp(overrides: { readinessChecks?: readonly ReadinessChecksFixture[] } = {}): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(READINESS_CHECKS)
    .useValue(
      overrides.readinessChecks ?? [
        {
          name: 'always-ready-fixture',
          check: async () => undefined,
        },
      ],
    )
    .compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

let app: INestApplication<App>;

beforeAll(async () => {
  Object.assign(process.env, E2E_ENV);
  app = await makeApp();
});

afterAll(async () => {
  await app?.close();
});

describe('health (conventions.md §6.2)', () => {
  it('GET /health → 200 {"status":"ok"} exactly', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → 200 {"status":"ok"} exactly when checks pass', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready → 503 UNAVAILABLE problem-details, no diagnostic detail, when a check fails', async () => {
    const failingApp = await makeApp({
      readinessChecks: [{ name: 'fixture-failing', check: async () => { throw new Error('fixture-only failure'); } }],
    });
    try {
      const response = await request(failingApp.getHttpServer()).get('/health/ready').expect(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const body = response.body as ProblemDetailsBody;
      expect(body.code).toBe('UNAVAILABLE');
      expect(body.status).toBe(503);
      // Generic sentence only — no diagnostic detail (I7/I12).
      expect(body.detail).toBe('The service is temporarily unable to serve requests.');
      expect(body.requestId).toBeDefined();
      expect(response.headers['x-request-id']).toBe(body.requestId);
      expect(JSON.stringify(body)).not.toContain('fixture-only failure');
    } finally {
      await failingApp.close();
    }
  });
});

describe('problem-details probes (conventions.md §5/§6.2)', () => {
  it('GET /probe/problem-details → 400, byte-stable envelope with registered code', async () => {
    const response = await request(app.getHttpServer()).get('/probe/problem-details').expect(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.body as ProblemDetailsBody;
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.type).toBe('urn:kal:problem:validation-failed');
    expect(body.title).toBe('Validation failed');
    expect(body.detail).toBe('One or more fields are invalid.');
    expect(body.errors).toEqual([{ field: 'q', message: 'Required.' }]);
    // Byte-stability across calls (the pinned fixture correlation id).
    const second = await request(app.getHttpServer()).get('/probe/problem-details').expect(400);
    expect(second.body).toEqual(body);
  });

  it('GET /probe/problem-details → 404-shaped genericity does not leak; unknown routes are generic NOT_FOUND', async () => {
    const response = await request(app.getHttpServer()).get('/definitely/not/here').expect(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body['code']).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain('/definitely/not/here');
  });

  it('wrong-method requests map to the same generic NOT_FOUND envelope (registry-complete)', async () => {
    const response = await request(app.getHttpServer()).post('/health').expect(404);
    expect(response.body['code']).toBe('NOT_FOUND');
  });

  it('a client X-Request-Id is echoed (wins over the pinned fixture id)', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/problem-details')
      .set('X-Request-Id', 'client-correlation-42')
      .expect(400);
    expect(response.body['requestId']).toBe('client-correlation-42');
    expect(response.headers['x-request-id']).toBe('client-correlation-42');
  });

  it('an oversized client X-Request-Id is replaced with a generated one', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe/problem-details')
      .set('X-Request-Id', 'x'.repeat(200))
      .expect(400);
    expect(response.body['requestId']).not.toBe('x'.repeat(200));
    expect((response.body['requestId'] as string).length).toBeLessThanOrEqual(128);
  });
});

describe('user-context fail-closed proof (I2)', () => {
  it('GET /probe/user-context → 403 FORBIDDEN for every caller shape in W1', async () => {
    for (const headers of [
      {},
      { Authorization: 'Bearer not.a.jwt' },
      { Authorization: 'Basic dXNlcjpwYXNz' },
      { Authorization: 'Bearer' },
    ]) {
      const response = await request(app.getHttpServer()).get('/probe/user-context').set(headers).expect(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body['code']).toBe('FORBIDDEN');
      expect(response.body['status']).toBe(403);
      // Generic sentence only — the denial never says which failure class (I7).
      expect(response.body['detail']).toBe('The current context is not permitted to perform this operation.');
    }
  });

  it('denials are byte-identical modulo requestId across caller shapes (no oracle)', async () => {
    const bodies: ProblemDetailsBody[] = [];
    for (const headers of [{}, { Authorization: 'Bearer aaa.bbb.ccc' }, { Authorization: 'weird' }]) {
      const response = await request(app.getHttpServer()).get('/probe/user-context').set(headers).expect(403);
      bodies.push(response.body as ProblemDetailsBody);
    }
    const normalized = bodies.map((body) => JSON.stringify({ ...body, requestId: '<normalized>' }));
    expect(new Set(normalized).size).toBe(1);
    expect(bodies[0]?.detail).toBe('The current context is not permitted to perform this operation.');
  });
});

describe('contract fixtures round-trip (conventions.md §6.3, backend side)', () => {
  interface EndpointFixtureShape {
    id: string;
    method: string;
    path: string;
    auth: string;
    responses: { status: number; contentType: string; bodySchema?: SchemaNode; example?: unknown }[];
  }

  async function servedDocument(): Promise<Record<string, unknown>> {
    const response = await request(app.getHttpServer()).get('/contracts/w1').expect(200);
    return response.body as Record<string, unknown>;
  }

  it('GET /contracts/w1 → 200, version w1, subset-only schemas', async () => {
    const document = await servedDocument();
    expect(document['version']).toBe('w1');
    expect(document['api']).toBe('kal-api');
    const endpoints = document['endpoints'] as EndpointFixtureShape[];
    expect(endpoints.length).toBeGreaterThanOrEqual(4);
    for (const endpoint of endpoints) {
      for (const responseSpec of endpoint.responses) {
        if (responseSpec.bodySchema !== undefined) {
          assertSchemaUsesSubsetOnly(responseSpec.bodySchema, `${endpoint.id}.bodySchema`);
        }
      }
    }
  });

  it('every fixture endpoint matches its served status, content-type, schema — and its example exactly', async () => {
    const document = await servedDocument();
    const endpoints = document['endpoints'] as EndpointFixtureShape[];
    for (const endpoint of endpoints) {
      const response = await request(app.getHttpServer()).get(endpoint.path);
      const spec = endpoint.responses.find((candidate) => candidate.status === response.status);
      expect(spec, `${endpoint.id}: served status ${response.status} matches a fixture response entry`).toBeDefined();
      expect(response.headers['content-type'], `${endpoint.id} content-type`).toContain((spec?.contentType ?? '').split(';')[0] as string);
      if (spec?.bodySchema !== undefined) {
        assertConformsToSchema(response.body, spec.bodySchema, endpoint.id);
      }
      if (spec?.example !== undefined) {
        expect(response.body, `${endpoint.id} example deep-equal`).toEqual(spec.example);
      }
    }
  });

  it('unknown contract versions get the generic NOT_FOUND envelope', async () => {
    const response = await request(app.getHttpServer()).get('/contracts/w999').expect(404);
    expect(response.body['code']).toBe('NOT_FOUND');
  });
});

describe('boot-path refusal (I15)', () => {
  it('a placeholder-class credential refuses module initialization with a non-leaking message', async () => {
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://kal_dev:changeme@localhost:5432/kal';
    try {
      await expect(makeApp()).rejects.toThrow(/refusing to start.*DATABASE_URL/su);
    } finally {
      if (previous === undefined) {
        delete process.env['DATABASE_URL'];
      } else {
        process.env['DATABASE_URL'] = previous;
      }
    }
  });

  it('the refusal message never contains the refused value', async () => {
    const previous = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://kal_dev:super-secret-value@localhost:5432/kal';
    try {
      let message = '';
      try {
        await makeApp();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain('super-secret-value');
      expect(message).toContain('DATABASE_URL');
    } finally {
      if (previous === undefined) {
        delete process.env['DATABASE_URL'];
      } else {
        process.env['DATABASE_URL'] = previous;
      }
    }
  });
});
