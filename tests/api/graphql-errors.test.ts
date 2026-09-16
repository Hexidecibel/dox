/**
 * GraphQL error masking — the permission boundary must say the same thing over
 * both transports.
 *
 * `createYoga` masks every non-`GraphQLError` down to "Unexpected error.".
 * The resolvers throw the SAME classes the REST handlers do
 * (`ForbiddenError`, `NotFoundError`, ... from functions/lib/permissions.ts),
 * which REST answers with the error's own message and status. So a reader
 * querying a field they may not have, or someone reaching across tenants, got
 * an honest 403 over REST and "Unexpected error." over GraphQL — which reads
 * as OUR fault, invites a retry that can never succeed, and destroys the only
 * signal distinguishing "not found" from "not yours".
 *
 * These drive the REAL yoga handler, because the property under test only
 * exists end to end: the mask runs after execution, on errors graphql-js has
 * already wrapped.
 *
 * The other half matters just as much: a GENUINE server error must still be
 * masked, with nothing of the original message, so the last test here plants a
 * failing D1 and asserts the internals do not escape.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { createTestToken } from '../helpers/auth';
import { onRequestPost as graphqlPost } from '../../functions/api/graphql';
import { maskGraphQLError } from '../../functions/lib/graphql/errors';
import {
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from '../../functions/lib/permissions';
import { GraphQLError } from 'graphql';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

interface GraphQLResponse {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; extensions?: Record<string, unknown>; path?: unknown[] }>;
}

async function gql(
  query: string,
  opts: { token?: string; envOverride?: unknown } = {},
): Promise<GraphQLResponse & { httpStatus: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const request = new Request('https://portal.example.com/api/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  const res = await graphqlPost({
    request,
    env: opts.envOverride ?? env,
    data: {},
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/graphql',
  } as never);

  const body = (await res.json()) as GraphQLResponse;
  return { ...body, httpStatus: res.status };
}

function tokenFor(userId: string, role: string, tenantId: string | null): Promise<string> {
  return createTestToken(role, { userId, email: `${userId}@test.com`, tenantId });
}

async function seedDocument(tenantId: string, title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
       VALUES (?, ?, ?, 1, 'active', ?)`,
    )
    .bind(id, tenantId, title, seed.orgAdminId)
    .run();
  return id;
}

/**
 * An env whose D1 throws — with a message carrying something that must never
 * reach a client — for any statement mentioning `fragment`. Everything else
 * (including the context's own user lookup) goes to the real database, so the
 * request authenticates normally and fails only where we want it to.
 */
const LEAKY_MESSAGE = 'D1_ERROR: no such column: secret_internal_column_0xdeadbeef';
function envFailingOn(fragment: string) {
  return {
    ...env,
    DB: {
      ...env.DB,
      prepare(sql: string) {
        if (sql.includes(fragment)) throw new Error(LEAKY_MESSAGE);
        return env.DB.prepare(sql);
      },
    },
  };
}

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('GraphQL errors — a refusal says what it is', () => {
  it('a reader asking for users gets the REST message and a FORBIDDEN code', async () => {
    const token = await tokenFor(seed.readerId, 'reader', seed.tenantId);
    const res = await gql('query { users { id email } }', { token });

    expect(res.errors?.[0]?.message).toBe('Insufficient permissions');
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // `extensions.http` is CONSUMED by yoga to set the response status and is
    // stripped from the body — so the status is where it is observable.
    expect(res.httpStatus).toBe(403);
    // And it is NOT the mask.
    expect(res.errors?.[0]?.message).not.toBe('Unexpected error.');
  });

  it('a cross-tenant document fetch is refused, not reported as missing', async () => {
    const otherDoc = await seedDocument(seed.tenantId2, 'Not yours');
    const token = await tokenFor(seed.orgAdminId, 'org_admin', seed.tenantId);

    const res = await gql(`query { document(id: "${otherDoc}") { id title } }`, { token });

    expect(res.errors?.[0]?.message).toBe('Access denied to this tenant');
    expect(res.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(res.httpStatus).toBe(403);
    // The title must not leak through the error either.
    expect(JSON.stringify(res)).not.toContain('Not yours');
  });

  it('an id that does not exist is a not-found error, with its own code', async () => {
    const token = await tokenFor(seed.orgAdminId, 'org_admin', seed.tenantId);
    const res = await gql(
      'mutation { updateDocument(id: "no-such-document", title: "x") { id } }',
      { token },
    );

    expect(res.errors?.[0]?.message).toBe('Document not found');
    expect(res.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(res.httpStatus).toBe(404);
  });

  it('no token is UNAUTHENTICATED, not a generic failure', async () => {
    const res = await gql('query { users { id } }');

    expect(res.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(res.httpStatus).toBe(401);
    expect(res.errors?.[0]?.message).not.toBe('Unexpected error.');
  });

  it('the error still names the field it came from', async () => {
    const token = await tokenFor(seed.readerId, 'reader', seed.tenantId);
    const res = await gql('query { users { id } }', { token });
    expect(res.errors?.[0]?.path).toEqual(['users']);
  });
});

describe('GraphQL errors — a genuine server error is still masked', () => {
  it('a D1 failure reveals nothing of itself', async () => {
    const token = await tokenFor(seed.orgAdminId, 'org_admin', seed.tenantId);

    const res = await gql('query { documents { id title } }', {
      token,
      envOverride: envFailingOn('FROM documents'),
    });
    // Sanity: the failure has to actually happen for this test to mean
    // anything.
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(res.errors?.[0]?.message).toBe('Unexpected error.');
    expect(res.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');

    const body = JSON.stringify(res);
    expect(body).not.toContain('secret_internal_column');
    expect(body).not.toContain('D1_ERROR');
  });

  it('an authenticated caller hitting a broken query gets the same nothing', async () => {
    const token = await tokenFor(seed.orgAdminId, 'org_admin', seed.tenantId);
    const res = await gql('query { documents { id } }', {
      token,
      envOverride: envFailingOn('FROM documents'),
    });
    expect(res.errors?.[0]?.message).toBe('Unexpected error.');
    expect(JSON.stringify(res)).not.toContain('secret_internal_column');
  });
});

/**
 * The pure function, so the allow-list can be asserted exhaustively without
 * building a query for every branch.
 */
describe('maskGraphQLError', () => {
  const wrap = (err: Error) =>
    new GraphQLError(err.message, { originalError: err, path: ['field'] });

  it('passes through each of the five deliberate errors with REST-matching codes', () => {
    const cases: Array<[Error, string, number]> = [
      [new UnauthorizedError('Authentication required'), 'UNAUTHENTICATED', 401],
      [new ForbiddenError('Nope'), 'FORBIDDEN', 403],
      [new NotFoundError('Gone'), 'NOT_FOUND', 404],
      [new BadRequestError('Bad'), 'BAD_REQUEST', 400],
      [new ConflictError('Approve it first'), 'CONFLICT', 409],
    ];
    for (const [err, code, status] of cases) {
      const masked = maskGraphQLError(wrap(err), 'Unexpected error.') as GraphQLError;
      expect(masked.message).toBe(err.message);
      expect(masked.extensions.code).toBe(code);
      expect(masked.extensions.http).toEqual({ status });
      expect(masked.path).toEqual(['field']);
    }
  });

  it('masks anything else, keeping no part of the original', () => {
    const masked = maskGraphQLError(
      wrap(new Error('connection to 10.0.0.4 refused')),
      'Unexpected error.',
    ) as GraphQLError;
    expect(masked.message).toBe('Unexpected error.');
    expect(masked.extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(masked)).not.toContain('10.0.0.4');
  });

  it('a deliberate GraphQLError (the module gate) survives with its extensions', () => {
    const gate = new GraphQLError('Order Fulfillment is turned off for your company.', {
      extensions: { code: 'module_disabled', module: 'fulfillment' },
    });
    const masked = maskGraphQLError(
      new GraphQLError(gate.message, { originalError: gate, extensions: gate.extensions }),
      'Unexpected error.',
    ) as GraphQLError;
    expect(masked.message).toContain('turned off');
    expect(masked.extensions.code).toBe('module_disabled');
    expect(masked.extensions.module).toBe('fulfillment');
  });

  it('will not unmask an impostor: the name alone is not enough', () => {
    const impostor = new Error('you may not see the admin table');
    impostor.name = 'ForbiddenError'; // no `status`
    const masked = maskGraphQLError(wrap(impostor), 'Unexpected error.') as GraphQLError;
    expect(masked.message).toBe('Unexpected error.');
  });

  it('will not unmask a class whose status disagrees with REST', () => {
    const drifted = Object.assign(new Error('secret'), { name: 'NotFoundError', status: 200 });
    const masked = maskGraphQLError(wrap(drifted), 'Unexpected error.') as GraphQLError;
    expect(masked.message).toBe('Unexpected error.');
  });
});
