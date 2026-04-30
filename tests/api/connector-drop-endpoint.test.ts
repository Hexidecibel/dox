/**
 * Tests for `POST /api/connectors/:id/drop` — the Phase B2 HTTP POST
 * intake door.
 *
 * Covers:
 *   - Missing bearer header -> 401
 *   - Wrong bearer value -> 401
 *   - Connector not found -> 401 (NOT 404 — we don't leak existence)
 *   - Inactive connector -> 401
 *   - Right bearer + missing file -> 400
 *   - Right bearer + oversized text file -> 413
 *   - Right bearer + unsupported extension -> 415
 *   - Right bearer + valid CSV -> 200 with run_id + file_key, R2 object
 *     written, dedup row inserted, run row created with source='api'.
 *   - Same file dropped twice -> second still 200; dedup row stays at
 *     one (INSERT OR IGNORE on the unique index).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as dropPost } from '../../functions/api/connectors/[id]/drop';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
const r2 = env.FILES;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function defaultMappings() {
  return {
    version: 2,
    core: {
      order_number: {
        enabled: true,
        required: true,
        source_labels: ['Order #', 'order_number'],
      },
      customer_number: {
        enabled: true,
        required: false,
        source_labels: ['Cust #', 'customer_number'],
      },
      customer_name: {
        enabled: true,
        required: false,
        source_labels: ['Customer Name', 'customer_name'],
      },
    },
    extended: [],
  };
}

async function insertConnector(opts: {
  tenantId: string;
  apiToken?: string | null;
  active?: number;
  deletedAt?: string | null;
  slug?: string | null;
}): Promise<{ id: string; slug: string | null }> {
  const id = generateTestId();
  // Phase B0.5: tests now also persist a slug. Default to a unique
  // shape so unrelated tests don't collide on the unique index.
  const slug = opts.slug === undefined ? `drop-test-${id.slice(0, 8)}` : opts.slug;
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, slug,
                               config, field_mappings, active,
                               api_token, deleted_at,
                               created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?,
               datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      opts.tenantId,
      `drop-test-${id}`,
      slug,
      JSON.stringify(defaultMappings()),
      opts.active ?? 1,
      opts.apiToken === undefined ? `tok-${id}` : opts.apiToken,
      opts.deletedAt ?? null,
    )
    .run();
  return { id, slug };
}

function makeContext(connectorId: string, request: Request) {
  return {
    request,
    env,
    data: {},
    params: { id: connectorId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/connectors/${connectorId}/drop`,
  } as any;
}

function multipartRequest(
  connectorId: string,
  file: File | null,
  options: { authorization?: string | null } = {},
): Request {
  const form = new FormData();
  if (file) form.append('file', file);
  const headers: Record<string, string> = {};
  if (options.authorization !== null && options.authorization !== undefined) {
    headers.authorization = options.authorization;
  }
  return new Request(`http://localhost/api/connectors/${connectorId}/drop`, {
    method: 'POST',
    headers,
    body: form,
  });
}

function csvFile(content: string, name = 'orders.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

describe('POST /api/connectors/:id/drop — auth gate', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId });
    const req = multipartRequest(id, csvFile('Order #\nSO-1'));
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the bearer value is wrong', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId, apiToken: 'right-token' });
    const req = multipartRequest(id, csvFile('Order #\nSO-1'), {
      authorization: 'Bearer wrong-token',
    });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the connector does not exist (does not 404)', async () => {
    const fakeId = generateTestId();
    const req = multipartRequest(fakeId, csvFile('Order #\nSO-1'), {
      authorization: 'Bearer any-token',
    });
    const resp = await dropPost(makeContext(fakeId, req));
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error?: string };
    // Generic message — we don't tell the caller "no such connector".
    expect(body.error).toBe('Invalid bearer token');
  });

  it('returns 401 when the connector is inactive', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'good-token',
      active: 0,
    });
    const req = multipartRequest(id, csvFile('Order #\nSO-1'), {
      authorization: 'Bearer good-token',
    });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the connector is soft-deleted', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'good-token',
      deletedAt: new Date().toISOString(),
    });
    const req = multipartRequest(id, csvFile('Order #\nSO-1'), {
      authorization: 'Bearer good-token',
    });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });

  it('returns 401 when the connector has no api_token set', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: null,
    });
    const req = multipartRequest(id, csvFile('Order #\nSO-1'), {
      authorization: 'Bearer anything',
    });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(401);
  });
});

describe('POST /api/connectors/:id/drop — body validation', () => {
  it('returns 400 when the file field is missing', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId, apiToken: 't1' });
    const req = multipartRequest(id, null, { authorization: 'Bearer t1' });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(400);
  });

  it('returns 415 for an unsupported extension', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId, apiToken: 't2' });
    const file = new File(['hello'], 'evil.exe', { type: 'application/octet-stream' });
    const req = multipartRequest(id, file, { authorization: 'Bearer t2' });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(415);
  });

  it('returns 413 when the file exceeds the per-kind size cap', async () => {
    const { id } = await insertConnector({ tenantId: seed.tenantId, apiToken: 't3' });
    // 6 MB of CSV — over the 5 MB text cap.
    const big = 'a,'.repeat(3 * 1024 * 1024);
    const file = csvFile(big, 'big.csv');
    const req = multipartRequest(id, file, { authorization: 'Bearer t3' });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(413);
  });
});

describe('POST /api/connectors/:id/drop — happy path', () => {
  it('accepts a CSV, writes R2, dispatches a run with source=api, and dedupes', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'happy-token',
    });

    const csv = [
      'Order #,Cust #,Customer Name',
      'SO-API-1,K-1,Acme',
      'SO-API-2,K-2,Beta',
    ].join('\n');

    const req = multipartRequest(id, csvFile(csv, 'orders.csv'), {
      authorization: 'Bearer happy-token',
    });
    const resp = await dropPost(makeContext(id, req));
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as {
      run_id: string;
      file_key: string;
      accepted_at: string;
      status: string;
      orders_created: number;
      customers_created: number;
    };
    expect(body.run_id).toMatch(/^[a-f0-9]+$/);
    expect(body.file_key).toMatch(new RegExp(`^connector-drops/${id}/`));
    expect(body.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.orders_created).toBe(2);

    // R2 object exists at the returned key.
    const obj = await r2.get(body.file_key);
    expect(obj).toBeTruthy();

    // connector_runs row exists with source='api'.
    const run = await db
      .prepare(`SELECT id, status, source FROM connector_runs WHERE id = ?`)
      .bind(body.run_id)
      .first<{ id: string; status: string; source: string | null }>();
    expect(run).toBeTruthy();
    expect(run!.source).toBe('api');

    // Dedup row written for this (connector, r2_key) pair.
    const dedup = await db
      .prepare(
        `SELECT COUNT(*) as count FROM connector_processed_keys
          WHERE connector_id = ? AND r2_key = ?`,
      )
      .bind(id, body.file_key)
      .first<{ count: number }>();
    expect(dedup?.count).toBe(1);
  });

  it('produces a unique R2 key per drop so re-uploading the same filename does not collide', async () => {
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'dup-token',
    });
    const csv = 'Order #\nSO-DUP-1';

    const r1 = await dropPost(
      makeContext(
        id,
        multipartRequest(id, csvFile(csv, 'same.csv'), { authorization: 'Bearer dup-token' }),
      ),
    );
    expect(r1.status).toBe(200);

    // Force a non-zero clock advance so the ISO-stamped key differs.
    await new Promise((r) => setTimeout(r, 5));

    const r2resp = await dropPost(
      makeContext(
        id,
        multipartRequest(id, csvFile(csv, 'same.csv'), { authorization: 'Bearer dup-token' }),
      ),
    );
    expect(r2resp.status).toBe(200);

    const b1 = (await r1.json()) as { file_key: string; run_id: string };
    const b2 = (await r2resp.json()) as { file_key: string; run_id: string };
    expect(b1.file_key).not.toEqual(b2.file_key);
    expect(b1.run_id).not.toEqual(b2.run_id);

    // Two distinct dedup rows.
    const count = await db
      .prepare(`SELECT COUNT(*) as count FROM connector_processed_keys WHERE connector_id = ?`)
      .bind(id)
      .first<{ count: number }>();
    expect(count?.count).toBeGreaterThanOrEqual(2);
  });
});

// Phase B0.5 — slug-based lookup. Vendors hit the slug URL; the
// resolver should find the connector and produce a 200 with the
// random-hex id baked into file_key (slug is the address; id remains
// the internal primary key).
describe('POST /api/connectors/:id/drop — slug-based lookup', () => {
  it('accepts a drop addressed by slug instead of id', async () => {
    const slug = `slug-drop-${generateTestId().slice(0, 8)}`;
    const { id } = await insertConnector({
      tenantId: seed.tenantId,
      apiToken: 'slug-token',
      slug,
    });
    const req = multipartRequest(slug, csvFile('Order #\nSO-SLUG-1', 'orders.csv'), {
      authorization: 'Bearer slug-token',
    });
    // makeContext takes the path-param value; for a slug-routed drop
    // the param resolves to the slug itself.
    const resp = await dropPost(makeContext(slug, req));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { run_id: string; file_key: string };
    // file_key uses the canonical id, not the slug, since the R2
    // prefix is keyed by the connector's stable primary key.
    expect(body.file_key.startsWith(`connector-drops/${id}/`)).toBe(true);
  });
});
