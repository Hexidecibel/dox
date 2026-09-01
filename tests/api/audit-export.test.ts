/**
 * API tests for the audit CSV export:
 *   - GET /api/audit/export  (functions/api/audit/export.ts)
 *
 * Drives onRequestGet directly with a fake PagesFunction context, mirroring
 * tests/api/spec-limits.test.ts and tests/api/reports-coa-fulfillment.test.ts
 * (this project's vitest-pool-workers config doesn't wire up SELF.fetch).
 *
 * The assertions that carry weight are the ones an IT reviewer would actually
 * test at sign-off:
 *   - a reader / user cannot export at all
 *   - an org_admin cannot widen scope to another tenant by passing tenant_id
 *   - the export honours the SAME filters as the screen it came from
 *   - a `details` blob containing a comma, a double quote and a newline
 *     survives the round trip intact
 *   - the export exceeds the 200-row page cap of the list endpoint
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { onRequestGet as exportAudit } from '../../functions/api/audit/export';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

const asUser = (id: string, role: string, tenant_id: string | null) => ({ id, role, tenant_id });

function ctx(url: string, user: ReturnType<typeof asUser>): any {
  return {
    request: new Request(url, { method: 'GET' }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/audit/export',
  };
}

async function runExport(user: ReturnType<typeof asUser>, qs = '') {
  const res = await exportAudit(ctx(`http://localhost/api/audit/export${qs ? `?${qs}` : ''}`, user));
  const text = await res.text();
  return { res, status: res.status, text };
}

/** Minimal RFC 4180 parser — proves the CSV is machine-readable, not just eyeballed. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const col = (header: string[], row: string[], name: string) => row[header.indexOf(name)];

async function insertAudit(
  userId: string | null,
  tenantId: string | null,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  details: string | null,
  createdAt: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, tenantId, action, resourceType, resourceId, details, '10.0.0.1', createdAt)
    .run();
}

/**
 * The payload that breaks a naive CSV writer: it carries a comma, a double
 * quote AND a genuine raw newline. Pretty-printed on purpose — `JSON.stringify`
 * with an indent is how a real details blob ends up with literal newlines in
 * it, and a compact one would only ever contain the escaped `\\n` sequence,
 * which is not actually a test of newline handling.
 */
const NASTY_DETAILS = JSON.stringify(
  {
    note: 'a, b "quoted"',
    changes: { title: { from: 'Old, "One"', to: 'New Two' } },
  },
  null,
  2
);

beforeAll(async () => {
  seed = await seedTestData(db);

  await db.prepare('DELETE FROM audit_log').run();

  // Tenant 1 — the rows an org_admin of tenant 1 is allowed to see.
  await insertAudit(seed.orgAdminId, seed.tenantId, 'document_created', 'document', 'doc-1', '{"a":1}', '2026-01-10T09:00:00');
  await insertAudit(seed.userId, seed.tenantId, 'document_deleted', 'document', 'doc-2', NASTY_DETAILS, '2026-02-15T09:00:00');
  await insertAudit(seed.userId, seed.tenantId, 'login', 'user', seed.userId, null, '2026-03-20T09:00:00');
  await insertAudit(null, seed.tenantId, 'document_downloaded', 'document', 'doc-3', '{"v":2}', '2026-04-25T09:00:00');

  // Tenant 2 — must never appear in a tenant-1 export.
  await insertAudit(seed.orgAdmin2Id, seed.tenantId2, 'document_created', 'document', 'other-doc', '{"secret":"tenant2"}', '2026-02-01T09:00:00');
  await insertAudit(seed.orgAdmin2Id, seed.tenantId2, 'login', 'user', seed.orgAdmin2Id, null, '2026-03-01T09:00:00');
});

// Every successful export writes its own `audit.export` row (that is the
// point). Clear those between tests so the fixture row counts below stay
// exact rather than drifting with test order.
beforeEach(async () => {
  await db.prepare("DELETE FROM audit_log WHERE action = 'audit.export'").run();
});

describe('GET /api/audit/export — permissions', () => {
  it('403s a reader (matches canViewAudit on the read path)', async () => {
    const { status } = await runExport(asUser(seed.readerId, 'reader', seed.tenantId));
    expect(status).toBe(403);
  });

  it('403s a regular user', async () => {
    const { status } = await runExport(asUser(seed.userId, 'user', seed.tenantId));
    expect(status).toBe(403);
  });

  it('a reader gets no CSV body at all — not an empty CSV', async () => {
    const { res, text } = await runExport(asUser(seed.readerId, 'reader', seed.tenantId));
    expect(res.headers.get('Content-Type')).not.toContain('text/csv');
    expect(text).not.toContain('timestamp');
  });

  it('org_admin CANNOT widen scope to another tenant via tenant_id', async () => {
    const { status, text } = await runExport(
      asUser(seed.orgAdminId, 'org_admin', seed.tenantId),
      `tenant_id=${seed.tenantId2}`
    );
    expect(status).toBe(200);

    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);

    // The tenant_id param is ignored, NOT honoured — still their own tenant.
    expect(data.length).toBe(4);
    for (const r of data) {
      expect(col(header, r, 'tenant_id')).toBe(seed.tenantId);
    }
    expect(text).not.toContain('tenant2');
  });

  it('org_admin export contains only their own tenant by default', async () => {
    const { text } = await runExport(asUser(seed.orgAdminId, 'org_admin', seed.tenantId));
    const rows = parseCsv(text);
    const header = rows[0];
    for (const r of rows.slice(1)) {
      expect(col(header, r, 'tenant_id')).toBe(seed.tenantId);
    }
  });

  it('super_admin sees all tenants, and can narrow with tenant_id', async () => {
    const all = await runExport(asUser(seed.superAdminId, 'super_admin', null));
    expect(parseCsv(all.text).slice(1).length).toBe(6);

    const narrowed = await runExport(asUser(seed.superAdminId, 'super_admin', null), `tenant_id=${seed.tenantId2}`);
    const rows = parseCsv(narrowed.text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(2);
    for (const r of data) {
      expect(col(header, r, 'tenant_id')).toBe(seed.tenantId2);
    }
  });
});

describe('GET /api/audit/export — filter pass-through', () => {
  it('filters by a single action', async () => {
    const { text } = await runExport(asUser(seed.superAdminId, 'super_admin', null), 'action=login');
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(2);
    for (const r of data) expect(col(header, r, 'action')).toBe('login');
  });

  it('filters by a comma-separated action list', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'action=login,document_deleted'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const actions = rows.slice(1).map((r) => col(header, r, 'action')).sort();
    expect(actions).toEqual(['document_deleted', 'login', 'login']);
  });

  it('filters by userId', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      `userId=${seed.userId}`
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(2);
    for (const r of data) expect(col(header, r, 'user_id')).toBe(seed.userId);
  });

  it('filters by resourceType', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'resourceType=user'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(2);
    for (const r of data) expect(col(header, r, 'resource_type')).toBe('user');
  });

  it('filters by dateFrom / dateTo, inclusive of the whole end day', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'dateFrom=2026-02-01&dateTo=2026-03-20'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    const stamps = data.map((r) => col(header, r, 'timestamp')).sort();
    expect(stamps).toEqual([
      '2026-02-01T09:00:00',
      '2026-02-15T09:00:00',
      '2026-03-01T09:00:00',
      '2026-03-20T09:00:00',
    ]);
  });

  it('combines filters (tenant + action + date) the way the screen does', async () => {
    const { text } = await runExport(
      asUser(seed.orgAdminId, 'org_admin', seed.tenantId),
      'action=document_created,document_deleted&dateFrom=2026-02-01'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(1);
    expect(col(header, data[0], 'resource_id')).toBe('doc-2');
  });
});

describe('GET /api/audit/export — CSV correctness', () => {
  it('emits a header row', async () => {
    const { text } = await runExport(asUser(seed.superAdminId, 'super_admin', null));
    const header = parseCsv(text)[0];
    expect(header).toEqual([
      'id', 'timestamp', 'user_id', 'user_name', 'user_email', 'tenant_id',
      'action', 'resource_type', 'resource_id', 'ip_address', 'details',
    ]);
  });

  it('round-trips a details payload with a comma, a double quote and a newline', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'action=document_deleted'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);
    expect(data.length).toBe(1);

    const details = col(header, data[0], 'details');
    expect(details).toBe(NASTY_DETAILS);

    // and it is still valid JSON after the round trip
    // the payload genuinely contained all three hazards
    expect(NASTY_DETAILS).toContain(',');
    expect(NASTY_DETAILS).toContain('"');
    expect(NASTY_DETAILS).toContain('\n');

    const parsed = JSON.parse(details);
    expect(parsed.note).toBe('a, b "quoted"');
    expect(parsed.changes.title.from).toBe('Old, "One"');
  });

  it('a newline inside details does NOT split the record into two CSV rows', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'action=document_deleted'
    );
    // The raw text contains a literal newline (inside the quoted field)...
    expect(text.split('\n').length).toBeGreaterThan(3);
    // ...but a conformant parser still sees exactly one data record.
    expect(parseCsv(text).slice(1).length).toBe(1);
  });

  it('renders NULL columns as empty fields and joins users for name/email', async () => {
    const { text } = await runExport(
      asUser(seed.superAdminId, 'super_admin', null),
      'action=document_downloaded'
    );
    const rows = parseCsv(text);
    const header = rows[0];
    const r = rows.slice(1)[0];
    expect(col(header, r, 'user_id')).toBe('');
    expect(col(header, r, 'user_name')).toBe('');
    expect(col(header, r, 'details')).toBe('{"v":2}');

    const named = await runExport(asUser(seed.superAdminId, 'super_admin', null), 'action=login');
    const nrows = parseCsv(named.text);
    const nheader = nrows[0];
    const emails = nrows.slice(1).map((x) => col(nheader, x, 'user_email'));
    expect(emails).toContain('user@test.com');
  });

  it('sets a CSV content type and an attachment filename', async () => {
    const { res } = await runExport(asUser(seed.superAdminId, 'super_admin', null));
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
  });
});

describe('GET /api/audit/export — volume', () => {
  it('exports far past the 200-row page cap of GET /api/audit, across batch boundaries', async () => {
    const marker = 'bulk_export_probe';
    const stmts = [];
    for (let i = 0; i < 1200; i++) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(seed.userId, seed.tenantId, marker, 'document', `bulk-${i}`, `{"i":${i}}`, '10.0.0.9', '2026-05-01T09:00:00')
      );
    }
    await db.batch(stmts);

    const { text } = await runExport(asUser(seed.orgAdminId, 'org_admin', seed.tenantId), `action=${marker}`);
    const rows = parseCsv(text);
    const header = rows[0];
    const data = rows.slice(1);

    expect(data.length).toBe(1200);

    // No duplicates and no dropped rows across the keyset batch boundaries.
    const ids = new Set(data.map((r) => col(header, r, 'id')));
    expect(ids.size).toBe(1200);
    const resourceIds = new Set(data.map((r) => col(header, r, 'resource_id')));
    expect(resourceIds.size).toBe(1200);
    expect(resourceIds.has('bulk-0')).toBe(true);
    expect(resourceIds.has('bulk-1199')).toBe(true);

    // Strictly descending id order — the keyset walk never goes backwards.
    const idNums = data.map((r) => Number(col(header, r, 'id')));
    for (let i = 1; i < idNums.length; i++) {
      expect(idNums[i]).toBeLessThan(idNums[i - 1]);
    }
  });

  it('reports the matched row count and truncation state in headers', async () => {
    const { res } = await runExport(asUser(seed.orgAdminId, 'org_admin', seed.tenantId), 'action=bulk_export_probe');
    expect(res.headers.get('X-Audit-Export-Matched')).toBe('1200');
    expect(res.headers.get('X-Audit-Export-Truncated')).toBe('false');
  });
});

describe('GET /api/audit/export — the export is itself audited', () => {
  it('the CSV is a snapshot taken before the export logs itself, so it never contains its own row', async () => {
    await db.prepare("DELETE FROM audit_log WHERE action = 'audit.export'").run();
    const { res, text } = await runExport(asUser(seed.superAdminId, 'super_admin', null));
    const data = parseCsv(text).slice(1);
    expect(text).not.toContain('audit.export');
    // body length agrees exactly with the count we advertised
    expect(String(data.length)).toBe(res.headers.get('X-Audit-Export-Matched'));
  });

  it('writes an audit.export row carrying the filters and the row count', async () => {
    await db.prepare("DELETE FROM audit_log WHERE action = 'audit.export'").run();

    await runExport(asUser(seed.orgAdminId, 'org_admin', seed.tenantId), 'action=login&dateFrom=2026-01-01');

    const row = await db
      .prepare("SELECT * FROM audit_log WHERE action = 'audit.export' ORDER BY id DESC LIMIT 1")
      .first<{ user_id: string; tenant_id: string; resource_type: string; details: string }>();

    expect(row).toBeTruthy();
    expect(row!.user_id).toBe(seed.orgAdminId);
    expect(row!.tenant_id).toBe(seed.tenantId);
    expect(row!.resource_type).toBe('audit');

    const details = JSON.parse(row!.details);
    expect(details.format).toBe('csv');
    expect(details.filters.actions).toEqual(['login']);
    expect(details.filters.dateFrom).toBe('2026-01-01');
    expect(details.filters.tenantId).toBe(seed.tenantId);
    expect(details.truncated).toBe(false);
    expect(typeof details.matched).toBe('number');
  });

  it('does NOT write an audit.export row when the caller is forbidden', async () => {
    await db.prepare("DELETE FROM audit_log WHERE action = 'audit.export'").run();
    await runExport(asUser(seed.readerId, 'reader', seed.tenantId));
    const row = await db
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE action = 'audit.export'")
      .first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
