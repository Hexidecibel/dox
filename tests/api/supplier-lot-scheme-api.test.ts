/**
 * /api/suppliers/:id/lot-scheme (migration 0109): declare a lot format, audited,
 * validated, tenant-isolated, and previewed against the lots on file.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { onRequestGet, onRequestPut } from '../../functions/api/suppliers/[id]/lot-scheme';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId: string;

function ctx(user: { id: string; role: string; tenant_id: string | null }, init: RequestInit = {}): any {
  return {
    request: new Request(`http://localhost/api/suppliers/${supplierId}/lot-scheme`, init),
    env, data: { user }, params: { id: supplierId },
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '',
  };
}

const put = (user: { id: string; role: string; tenant_id: string | null }, body: unknown) =>
  onRequestPut(ctx(user, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
  supplierId = generateTestId();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, 'Darigold, Inc.', ?)`).bind(supplierId, seed.tenantId, `dg-${supplierId.slice(0, 6)}`).run();
  const lots: Array<[string, string, string | null]> = [
    ['10426203', '03', '2026-07-22'],
    ['10426204', '13', '2026-07-22'], // decodes to Jul 23: a disagreement to preview
    ['22026217', '12', '2026-08-05'],
    ['K134889', '', null],
  ];
  for (const [lot, sub, pd] of lots) {
    await db.prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key, production_date, production_date_source, production_date_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(generateTestId(), seed.tenantId, supplierId, lot, sub, `${lot}${sub}`, pd, pd ? 'extracted' : null, pd ? 'resolved' : null).run();
  }
});

const orgAdmin = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

describe('GET', () => {
  it('shows the legacy format in force and every lot on file', async () => {
    const res = await onRequestGet(ctx(orgAdmin()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.current).toBeNull();
    expect(body.effective).toMatchObject({ source: 'legacy', version: null });
    expect(body.lots).toHaveLength(4);
    expect(body.preview.total).toBe(4);
  });

  it("is a 404 for another tenant's admin, and readable by a reader in the tenant", async () => {
    const other = await onRequestGet(ctx({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 }));
    expect(other.status).toBe(404);
    const reader = await onRequestGet(ctx({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId }));
    expect(reader.status).toBe(200);
  });
});

describe('PUT', () => {
  it('declares a version, previews the fit, and audits it with the previous spec', async () => {
    const res = await put(orgAdmin(), { spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, note: 'Verified on 45 lots' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.unchanged).toBe(false);
    expect(body.current).toMatchObject({ version: 1, source: 'admin', note: 'Verified on 45 lots' });
    expect(body.effective.source).toBe('declared');
    expect(body.preview).toMatchObject({ total: 4, fits: 3 });
    expect(body.preview.not_fitting.map((l: any) => l.lot_number)).toEqual(['K134889']);
    expect(body.preview.date_disagreements).toEqual([
      expect.objectContaining({ lot_number: '10426204', on_file: '2026-07-22', decoded: '2026-07-23' }),
    ]);

    const audit = await db.prepare(`SELECT * FROM audit_log WHERE action = 'supplier.lot_scheme_declared' AND resource_id = ?`).bind(supplierId).all<any>();
    expect(audit.results).toHaveLength(1);
    const details = JSON.parse(audit.results[0].details);
    expect(details).toMatchObject({ version: 1, previous_version: null, previous_spec: null, fit: { total: 4, fits: 3, not_fitting: 1, date_disagreements: 1 } });
    expect(audit.results[0].user_id).toBe(seed.orgAdminId);

    // No stored lot changed.
    const k = await db.prepare(`SELECT lot_key, production_date FROM lots WHERE lot_number = '10426204'`).first<any>();
    expect(k).toEqual({ lot_key: '1042620413', production_date: '2026-07-22' });
  });

  it('writes nothing and audits nothing for a save of the format already in force', async () => {
    await put(orgAdmin(), { spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec });
    const again = (await (await put(orgAdmin(), { spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec })).json()) as any;
    expect(again.unchanged).toBe(true);
    expect(again.versions).toHaveLength(1);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier.lot_scheme_declared'`).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('refuses a declaration that cannot mean one thing, with the reasons', async () => {
    const res = await put(orgAdmin(), { spec: { ...LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, date_role: null } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.errors.join(' ')).toContain('Say which date');
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM supplier_lot_schemes`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('is refused to a user or reader, and a 404 across tenants', async () => {
    expect((await put({ id: seed.userId, role: 'user', tenant_id: seed.tenantId }, { spec: LOT_SCHEME_TEMPLATES.none.spec })).status).toBe(403);
    expect((await put({ id: seed.readerId, role: 'reader', tenant_id: seed.tenantId }, { spec: LOT_SCHEME_TEMPLATES.none.spec })).status).toBe(403);
    expect((await put({ id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 }, { spec: LOT_SCHEME_TEMPLATES.none.spec })).status).toBe(404);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM supplier_lot_schemes`).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('declares none (Andersen) as a real declaration', async () => {
    const body = (await (await put(orgAdmin(), { spec: LOT_SCHEME_TEMPLATES.none.spec })).json()) as any;
    expect(body.current.spec.kind).toBe('none');
    expect(body.effective.source).toBe('declared');
    expect(body.preview.fits).toBe(0);
    expect(body.preview.not_fitting).toEqual([]);
  });
});
