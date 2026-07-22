/**
 * API tests for the renewal engine endpoints:
 *   - GET  /api/expirations         (functions/api/expirations/index.ts)
 *   - POST /api/expirations/notify  (functions/api/expirations/notify.ts)
 *
 * Drives the handlers directly with hand-rolled contexts — SELF.fetch isn't
 * wired in this project's vitest-pool-workers config (same pattern as
 * reports-coa-fulfillment.test.ts). The Resend HTTP call is stubbed via
 * vi.stubGlobal('fetch', ...) for the notify tests.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet as expirationsGet } from '../../functions/api/expirations/index';
import { onRequestPost as expirationsNotify } from '../../functions/api/expirations/notify';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const AS_OF = '2026-07-22';

function makeContext(
  url: string,
  method: 'GET' | 'POST',
  user: { id: string; role: string; tenant_id: string | null },
  body?: unknown,
  envOverride?: Record<string, unknown>,
): any {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request(url, init),
    env: envOverride ?? env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/expirations',
  };
}

async function runGet(user: any, qs = '') {
  const res = await expirationsGet(makeContext(`http://localhost/api/expirations${qs ? `?${qs}` : ''}`, 'GET', user));
  return { status: res.status, body: (await res.json()) as any };
}

async function runNotify(user: any, body?: unknown, envOverride?: Record<string, unknown>) {
  const res = await expirationsNotify(
    makeContext('http://localhost/api/expirations/notify', 'POST', user, body ?? {}, envOverride),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function makeDoc(
  tenantId: string,
  title: string,
  fields: {
    renewalType?: string | null;
    renewalDueDate?: string | null;
    renewalIntervalMonths?: number | null;
    owner?: string | null;
    documentTypeId?: string | null;
    primaryMetadata?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, tags, current_version, status, created_by,
          document_type_id, owner, renewal_type, renewal_interval_months,
          renewal_due_date, primary_metadata)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      title,
      seed.userId,
      fields.documentTypeId ?? null,
      fields.owner ?? null,
      fields.renewalType ?? null,
      fields.renewalIntervalMonths ?? null,
      fields.renewalDueDate ?? null,
      fields.primaryMetadata ? JSON.stringify(fields.primaryMetadata) : null,
    )
    .run();
  return id;
}

let docTypeId = '';

beforeAll(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);

  docTypeId = generateTestId();
  await db
    .prepare(`INSERT INTO document_types (id, tenant_id, name, slug, created_at) VALUES (?, ?, ?, ?, datetime('now'))`)
    .bind(docTypeId, seed.tenantId, 'Business License', 'business-license')
    .run();

  // Tenant 1 — one doc per relevant state.
  // A: hard_expiry, past → expired (alerts)
  await makeDoc(seed.tenantId, 'A Expired License', {
    renewalType: 'hard_expiry', renewalDueDate: '2026-06-01', owner: 'Alice', documentTypeId: docTypeId,
  });
  // B: renewal_application, within window → expiring (alerts)
  await makeDoc(seed.tenantId, 'B Organic Application', {
    renewalType: 'renewal_application', renewalDueDate: '2026-08-01', owner: 'Bob',
  });
  // C: review_cycle, interval-derived past → overdue (alerts)
  await makeDoc(seed.tenantId, 'C Audit Review', {
    renewalType: 'review_cycle', renewalIntervalMonths: 6, owner: 'Carol',
    primaryMetadata: { effective_date: '2025-01-01' },
  });
  // D: keep_current, very old → stale (NEVER alerts)
  await makeDoc(seed.tenantId, 'D Spec Sheet', {
    renewalType: 'keep_current', renewalDueDate: '2025-01-01', owner: 'Dave',
  });
  // E: hard_expiry, far future → current (NOT in alert set)
  await makeDoc(seed.tenantId, 'E Future COI', {
    renewalType: 'hard_expiry', renewalDueDate: '2027-01-01', owner: 'Erin',
  });
  // F: no resolvable date → excluded entirely
  await makeDoc(seed.tenantId, 'F No Dates', { renewalType: 'hard_expiry' });

  // Tenant 2 — one alerting doc, for scoping.
  await makeDoc(seed.tenantId2, 'Other Tenant Expired', {
    renewalType: 'hard_expiry', renewalDueDate: '2026-06-01', owner: 'Zed',
  });
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/expirations — classification + summary', () => {
  it('classifies each renewal_type and excludes docs with no resolvable date', async () => {
    const { status, body } = await runGet(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    expect(status).toBe(200);
    const byTitle = (t: string) => body.rows.find((r: any) => r.title === t);

    expect(byTitle('A Expired License')?.status).toBe('expired');
    expect(byTitle('B Organic Application')?.status).toBe('expiring');
    expect(byTitle('C Audit Review')?.status).toBe('overdue');
    expect(byTitle('D Spec Sheet')?.status).toBe('stale');
    expect(byTitle('E Future COI')?.status).toBe('current');
    // F has no resolvable date → not present.
    expect(byTitle('F No Dates')).toBeUndefined();

    // review_cycle due was derived from effective_date + interval.
    expect(byTitle('C Audit Review')?.renewal_due_date).toBe('2025-07-01');
    // primary_category_name joined from document_types.
    expect(byTitle('A Expired License')?.primary_category_name).toBe('Business License');
    // owner surfaced.
    expect(byTitle('A Expired License')?.owner).toBe('Alice');
  });

  it('summarizes counts by status and by renewal_type, plus the alert count', async () => {
    const { body } = await runGet(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    const s = body.summary;
    expect(s.total).toBe(5); // A,B,C,D,E (F excluded)
    expect(s.by_status.expired).toBe(1);
    expect(s.by_status.expiring).toBe(1);
    expect(s.by_status.overdue).toBe(1);
    expect(s.by_status.stale).toBe(1);
    expect(s.by_status.current).toBe(1);
    // Alert set = expiring + expired + overdue = 3 (stale + current excluded).
    expect(s.alerting).toBe(3);
    expect(s.by_renewal_type.hard_expiry).toBe(2);
    expect(s.by_renewal_type.renewal_application).toBe(1);
    expect(s.by_renewal_type.review_cycle).toBe(1);
    expect(s.by_renewal_type.keep_current).toBe(1);
    expect(body.window_days).toBe(60);
    expect(body.as_of).toBe(AS_OF);
  });

  it('respects a narrower window_days (B falls out of the window)', async () => {
    // B is due 2026-08-01, 10 days out. window=5 → B becomes current.
    const { body } = await runGet(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}&window_days=5`,
    );
    const b = body.rows.find((r: any) => r.title === 'B Organic Application');
    expect(b.status).toBe('current');
  });

  it('org_admin is scoped to their own tenant', async () => {
    const { body } = await runGet(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      `as_of=${AS_OF}`,
    );
    expect(body.rows.some((r: any) => r.title === 'Other Tenant Expired')).toBe(false);
  });

  it('super_admin can scope to a tenant via tenant_id', async () => {
    const { body } = await runGet(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      `tenant_id=${seed.tenantId2}&as_of=${AS_OF}`,
    );
    const titles = body.rows.map((r: any) => r.title);
    expect(titles).toEqual(['Other Tenant Expired']);
  });

  it('requires tenant_id for super_admin (400 when absent)', async () => {
    const { status } = await runGet(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      `as_of=${AS_OF}`,
    );
    expect(status).toBe(400);
  });
});

describe('POST /api/expirations/notify — selection + single send', () => {
  it('selects the alert set, sends ONE email to org_admins + super_admins', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { status, body } = await runNotify(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { as_of: AS_OF },
    );
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    // A (expired) + B (expiring) + C (overdue). D (stale) + E (current) excluded.
    expect(body.document_count).toBe(3);
    // sendEmail hit the Resend endpoint exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, reqInit] = fetchMock.mock.calls[0];
    expect(String(urlArg)).toContain('resend.com');
    // Recipients: tenant-1 org_admin + super_admin, deduped.
    expect(body.recipients).toContain('orgadmin@test.com');
    expect(body.recipients).toContain('admin@test.com');
    // Tenant-2 org_admin must NOT be included.
    expect(body.recipients).not.toContain('orgadmin2@test.com');
    // Payload lists the alerting docs, not the keep_current/current ones.
    const payload = JSON.parse((reqInit as RequestInit).body as string);
    expect(payload.to).toEqual(expect.arrayContaining(['orgadmin@test.com', 'admin@test.com']));
    expect(payload.html).toContain('A Expired License');
    expect(payload.html).not.toContain('D Spec Sheet');
    expect(payload.html).not.toContain('E Future COI');
  });

  it('degrades to a no-op (no 500) when RESEND_API_KEY is unset', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { status, body } = await runNotify(
      { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId },
      { as_of: AS_OF },
      { DB: env.DB, RESEND_API_KEY: undefined },
    );
    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.reason).toBe('email_not_configured');
    expect(body.document_count).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no_documents (no send) when nothing is in the alert set', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // A future window start via a tiny window on tenant with only current docs:
    // scope super_admin to tenant2 but use a window/as_of where its one doc is
    // NOT alerting — set as_of far in the past so the 2026-06-01 doc is future.
    const { body } = await runNotify(
      { id: seed.superAdminId, role: 'super_admin', tenant_id: null },
      { tenant_id: seed.tenantId2, as_of: '2020-01-01', window_days: 5 },
    );
    expect(body.sent).toBe(false);
    expect(body.reason).toBe('no_documents');
    expect(body.document_count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a reader (403)', async () => {
    const res = await expirationsNotify(
      makeContext('http://localhost/api/expirations/notify', 'POST',
        { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId }, {}),
    );
    expect(res.status).toBe(403);
  });
});
