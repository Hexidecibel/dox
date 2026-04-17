/**
 * API tests for GET /api/activity and /api/activity/event.
 *
 * Drives the onRequestGet handlers directly with a fake PagesFunction
 * context — the vitest-pool-workers config in this project doesn't wire up
 * SELF.fetch, so we use the same pattern as connector-discover-schema.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as listActivity } from '../../functions/api/activity/index';
import { onRequestGet as getActivityEvent } from '../../functions/api/activity/event';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

let tenantConnectorId = '';
let tenantRunId = '';
let tenantOrderId = '';
let tenantQueueId = '';

let otherConnectorId = '';
let otherRunId = '';

function makeContext(
  url: string,
  user: { id: string; role: string; tenant_id: string | null },
): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/activity',
  };
}

async function fetchList(
  user: { id: string; role: string; tenant_id: string | null },
  qs = '',
): Promise<any> {
  const url = `http://localhost/api/activity${qs ? `?${qs}` : ''}`;
  const res = await listActivity(makeContext(url, user));
  return { status: res.status, body: await res.json() };
}

/**
 * Build a "last 2 days" from/to window. All test seed rows live within the
 * last ~30 minutes so this catches them without tripping the 90-day guard.
 */
function recentWindow(): string {
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 24 * 3600 * 1000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

beforeAll(async () => {
  seed = await seedTestData(db);

  // Seed a connector + run + processing queue + order for tenant 1
  tenantConnectorId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'email', 'erp', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(tenantConnectorId, seed.tenantId, 'Test Activity Connector', seed.orgAdminId)
    .run();

  tenantRunId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, started_at, completed_at,
         records_found, records_created, records_updated, records_errored, details)
       VALUES (?, ?, ?, 'success', datetime('now', '-10 minutes'), datetime('now', '-9 minutes'),
         5, 5, 0, 0, '{"errors":[],"info":["processed 5"]}')`,
    )
    .bind(tenantRunId, tenantConnectorId, seed.tenantId)
    .run();

  // Also a failed run
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, started_at, completed_at,
         records_found, records_created, records_updated, records_errored, error_message, details)
       VALUES (?, ?, ?, 'error', datetime('now', '-20 minutes'), datetime('now', '-19 minutes'),
         0, 0, 0, 0, 'boom', '{}')`,
    )
    .bind(generateTestId(), tenantConnectorId, seed.tenantId)
    .run();

  // Ensure a default document_type exists for queue row
  const dtId = generateTestId();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, created_at, updated_at)
       VALUES (?, ?, 'COA', 'coa', datetime('now'), datetime('now'))`,
    )
    .bind(dtId, seed.tenantId)
    .run();

  tenantQueueId = generateTestId();
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          processing_status, status, source, source_detail, confidence_score, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'pending', 'email',
               '{"sender":"erp@medosweet.test","subject":"COA attached"}',
               0.87, ?, datetime('now', '-5 minutes'))`,
    )
    .bind(
      tenantQueueId, seed.tenantId, dtId, `r2/${tenantQueueId}`,
      'coa-sample.pdf', 12345, 'application/pdf', seed.orgAdminId,
    )
    .run();

  tenantOrderId = generateTestId();
  await db
    .prepare(
      `INSERT INTO orders (id, tenant_id, connector_id, connector_run_id, order_number,
         customer_name, customer_number, status, source_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Acme Corp', 'K00123', 'pending',
         '{"order":"raw"}', datetime('now', '-3 minutes'), datetime('now', '-3 minutes'))`,
    )
    .bind(tenantOrderId, seed.tenantId, tenantConnectorId, tenantRunId, `ACT-ORD-${tenantOrderId.slice(0, 8)}`)
    .run();

  // Seed a connector + run for tenant 2 (isolation check)
  otherConnectorId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connectors (id, tenant_id, name, connector_type, system_type, config, field_mappings, active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'email', 'erp', '{}', '{}', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(otherConnectorId, seed.tenantId2, 'Other Tenant Connector', seed.orgAdmin2Id)
    .run();

  otherRunId = generateTestId();
  await db
    .prepare(
      `INSERT INTO connector_runs (id, connector_id, tenant_id, status, started_at, completed_at,
         records_found, records_created, records_updated, records_errored, details)
       VALUES (?, ?, ?, 'success', datetime('now', '-15 minutes'), datetime('now', '-14 minutes'),
         3, 3, 0, 0, '{}')`,
    )
    .bind(otherRunId, otherConnectorId, seed.tenantId2)
    .run();
}, 30_000);

describe('GET /api/activity', () => {
  const orgAdmin = { id: 'user-org-admin', role: 'org_admin', tenant_id: 'test-tenant-001' };
  const orgAdmin2 = { id: 'user-org-admin-2', role: 'org_admin', tenant_id: 'test-tenant-002' };
  const superAdmin = { id: 'user-super-admin', role: 'super_admin', tenant_id: null };

  it('returns events for org_admin scoped to their tenant', async () => {
    const { status, body } = await fetchList(orgAdmin, `${recentWindow()}&limit=100`);
    expect(status).toBe(200);
    expect(body.total_count).toBeGreaterThanOrEqual(3);
    const ids = body.events.map((e: any) => e.id);
    expect(ids).toContain(tenantRunId);
    expect(ids).toContain(tenantQueueId);
    expect(ids).toContain(tenantOrderId);
    // Other tenant's run must not leak
    expect(ids).not.toContain(otherRunId);
    // Every event must belong to the user's tenant
    for (const e of body.events) {
      if (e.type !== 'audit') expect(e.tenant_id).toBe('test-tenant-001');
    }
  });

  it('enforces tenant isolation for a second tenant', async () => {
    const { body } = await fetchList(orgAdmin2, `${recentWindow()}&limit=100`);
    const ids = body.events.map((e: any) => e.id);
    expect(ids).toContain(otherRunId);
    expect(ids).not.toContain(tenantRunId);
  });

  it('super_admin sees their configured tenant when tenant_id omitted but can opt-in to all', async () => {
    // Without tenant_id → defaults to 'all' for super_admin
    const { body } = await fetchList(superAdmin, `${recentWindow()}&limit=200`);
    const ids = body.events.map((e: any) => e.id);
    expect(ids).toContain(tenantRunId);
    expect(ids).toContain(otherRunId);

    // Explicit tenant_id filter restricts
    const { body: filtered } = await fetchList(
      superAdmin,
      `${recentWindow()}&tenant_id=test-tenant-001&limit=200`,
    );
    const filteredIds = filtered.events.map((e: any) => e.id);
    expect(filteredIds).toContain(tenantRunId);
    expect(filteredIds).not.toContain(otherRunId);
  });

  it('filters by event_type=connector_run', async () => {
    const { body } = await fetchList(
      orgAdmin,
      `${recentWindow()}&event_type=connector_run&limit=100`,
    );
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) {
      expect(e.type).toBe('connector_run');
    }
  });

  it('filters by event_type=document_ingest', async () => {
    const { body } = await fetchList(
      orgAdmin,
      `${recentWindow()}&event_type=document_ingest&limit=100`,
    );
    for (const e of body.events) {
      expect(e.type).toBe('document_ingest');
    }
    expect(body.events.some((e: any) => e.id === tenantQueueId)).toBe(true);
  });

  it('filters by event_type=order_created', async () => {
    const { body } = await fetchList(
      orgAdmin,
      `${recentWindow()}&event_type=order_created&limit=100`,
    );
    for (const e of body.events) {
      expect(e.type).toBe('order_created');
    }
    expect(body.events.some((e: any) => e.id === tenantOrderId)).toBe(true);
  });

  it('filters by connector_id', async () => {
    const { body } = await fetchList(
      orgAdmin,
      `${recentWindow()}&connector_id=${tenantConnectorId}&limit=100`,
    );
    const runs = body.events.filter((e: any) => e.type === 'connector_run');
    for (const r of runs) {
      expect(r.connector_id).toBe(tenantConnectorId);
    }
  });

  it('paginates via limit + offset', async () => {
    const page1 = await fetchList(orgAdmin, `${recentWindow()}&limit=2&offset=0`);
    expect(page1.body.events.length).toBeLessThanOrEqual(2);
    const page2 = await fetchList(orgAdmin, `${recentWindow()}&limit=2&offset=2`);
    // Different pages mustn't overlap
    const ids1 = page1.body.events.map((e: any) => `${e.type}:${e.id}`);
    const ids2 = page2.body.events.map((e: any) => `${e.type}:${e.id}`);
    for (const id of ids2) expect(ids1).not.toContain(id);
  });

  it('rejects date ranges greater than 90 days', async () => {
    const { status, body } = await fetchList(
      orgAdmin,
      'from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z',
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/90 days/);
  });

  it('rejects invalid date strings', async () => {
    const { status } = await fetchList(orgAdmin, 'from=not-a-date');
    expect(status).toBe(400);
  });

  it('clamps limit to MAX_LIMIT (200)', async () => {
    const { body } = await fetchList(orgAdmin, `${recentWindow()}&limit=9999`);
    expect(body.limit).toBe(200);
  });

  it('sorts events by timestamp DESC', async () => {
    const { body } = await fetchList(orgAdmin, `${recentWindow()}&limit=100`);
    const tss = body.events.map((e: any) => e.timestamp);
    const parse = (s: string) => Date.parse(
      /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes(' ') ? s.replace(' ', 'T') + 'Z' : `${s}Z`),
    );
    for (let i = 1; i < tss.length; i++) {
      expect(parse(tss[i - 1])).toBeGreaterThanOrEqual(parse(tss[i]));
    }
  });
});

describe('GET /api/activity/event', () => {
  const orgAdmin = { id: 'user-org-admin', role: 'org_admin', tenant_id: 'test-tenant-001' };
  const orgAdmin2 = { id: 'user-org-admin-2', role: 'org_admin', tenant_id: 'test-tenant-002' };

  async function fetchDetail(
    user: { id: string; role: string; tenant_id: string | null },
    type: string,
    id: string,
  ) {
    const url = `http://localhost/api/activity/event?type=${type}&id=${id}`;
    const res = await getActivityEvent(makeContext(url, user));
    return { status: res.status, body: await res.json() };
  }

  it('returns a connector_run with parsed details and attached orders', async () => {
    const { status, body } = await fetchDetail(orgAdmin, 'connector_run', tenantRunId);
    expect(status).toBe(200);
    expect(body.event.id).toBe(tenantRunId);
    expect(body.event.connector_name).toBe('Test Activity Connector');
    expect(body.event.details).toEqual({ errors: [], info: ['processed 5'] });
    expect(Array.isArray(body.event.orders)).toBe(true);
    const orderIds = body.event.orders.map((o: any) => o.id);
    expect(orderIds).toContain(tenantOrderId);
  });

  it('returns a document_ingest with parsed source_detail', async () => {
    const { status, body } = await fetchDetail(orgAdmin, 'document_ingest', tenantQueueId);
    expect(status).toBe(200);
    expect(body.event.file_name).toBe('coa-sample.pdf');
    expect(body.event.source_detail).toEqual({
      sender: 'erp@medosweet.test',
      subject: 'COA attached',
    });
  });

  it('returns an order with parsed source_data and connector run back-link', async () => {
    const { status, body } = await fetchDetail(orgAdmin, 'order_created', tenantOrderId);
    expect(status).toBe(200);
    expect(body.event.order_number).toBeTruthy();
    expect(body.event.connector_run).toBeTruthy();
    expect(body.event.connector_run.id).toBe(tenantRunId);
    expect(body.event.source_data).toEqual({ order: 'raw' });
  });

  it('returns 404 when another tenant tries to read an event', async () => {
    const { status } = await fetchDetail(orgAdmin2, 'connector_run', tenantRunId);
    expect(status).toBe(404);
  });

  it('rejects missing type/id', async () => {
    const url = `http://localhost/api/activity/event`;
    const res = await getActivityEvent(makeContext(url, orgAdmin));
    expect(res.status).toBe(400);
  });

  it('rejects unknown type', async () => {
    const url = `http://localhost/api/activity/event?type=wat&id=123`;
    const res = await getActivityEvent(makeContext(url, orgAdmin));
    expect(res.status).toBe(400);
  });
});
