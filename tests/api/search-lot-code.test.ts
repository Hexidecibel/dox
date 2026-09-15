/**
 * Search reading a supplier's DECLARED lot format (migration 0109).
 *
 * AJ §6: "King and Prince asked for production date 7/31/2026. That is Julian
 * day 212, so the lot base is 10426212." With Darigold's format declared, a
 * certificate for lot 10426212 that states no production date is found and
 * labelled "lot code implies production Jul 31, 2026" — LIKELY, never covering.
 * Only a stated production date covers. Without a declaration nothing is decoded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations } from '../helpers/db';
import { onRequestGet as universalSearch } from '../../functions/api/search/index';
import { declareLotScheme } from '../../functions/lib/lot-schemes';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';

const db = env.DB;
const T = 'lotcode-tenant';
const USER = { id: 'lotcode-user', role: 'org_admin', tenant_id: T };
const SUP_DG = 'lotcode-sup-dg';
const SUP_OTHER = 'lotcode-sup-other';
const DT = 'lotcode-dt-coa';

async function doc(id: string, supplierId: string, metadata: Record<string, unknown>) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
  ).bind(id, T, id, USER.id, supplierId, DT, JSON.stringify(metadata)).run();
}

async function lot(docId: string, supplierId: string, lotNumber: string, sub: string, pd: { iso: string; raw: string; source: string } | null) {
  const lotId = `${docId}-lot`;
  await db.prepare(
    `INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key,
                       production_date, production_date_raw, production_date_source, production_date_status, production_date_document_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(lotId, T, supplierId, lotNumber, sub, `${lotNumber}${sub}`, pd?.iso ?? null, pd?.raw ?? null, pd?.source ?? null, pd ? 'resolved' : null, pd ? docId : null).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${lotId}-dl`, docId, lotId).run();
}

function ctx(url: string): any {
  return {
    request: new Request(url), env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '',
  };
}

async function search(q: string) {
  const res = await universalSearch(ctx(`http://localhost/api/search?q=${encodeURIComponent(q)}&limit=50`));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const result = (body: any, id: string) => body.documents.results.find((r: any) => r.id === id);

beforeAll(async () => {
  await runMigrations(db);
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Lot Code Co', 'lot-code-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'lotcode@test.com', 'Lc', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Darigold, Inc.', 'lc-dg', 1)`).bind(SUP_DG, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Westfield Creamery', 'lc-wf', 1)`).bind(SUP_OTHER, T).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT, T).run();
  await declareLotScheme(db, { tenantId: T, supplierId: SUP_DG, spec: LOT_SCHEME_TEMPLATES.plant_yy_julian.spec, source: 'seed' });

  // The King and Prince lot: states no production date.
  await doc('lc-undated-212', SUP_DG, { lot_number: '10426212', product_name: 'SWEET CREAM BUTTER' });
  await lot('lc-undated-212', SUP_DG, '10426212', '', null);
  // A stated production date.
  await doc('lc-stated-203', SUP_DG, { lot_number: '10426203', sub_lot_code: '03', production_date: '2026-07-22' });
  await lot('lc-stated-203', SUP_DG, '10426203', '03', { iso: '2026-07-22', raw: '22-Jul-2026', source: 'extracted' });
  // A lot row the write path already filled from the lot code.
  await doc('lc-decoded-213', SUP_DG, { lot_number: '10426213' });
  await lot('lc-decoded-213', SUP_DG, '10426213', '', { iso: '2026-08-01', raw: 'lot 10426213 decodes to 2026-08-01', source: 'lot_decode' });
  // The same lot shape from a supplier with NO declared format.
  await doc('lc-undeclared', SUP_OTHER, { lot_number: '10426212' });
  await lot('lc-undeclared', SUP_OTHER, '10426212', '', null);
});

describe('a production date implied by a declared lot format', () => {
  it('"darigold produced 7/31/2026": the undated 10426212 certificate is likely, never covering, and says why', async () => {
    const body = await search('darigold produced 7/31/2026');
    expect(body.coverage).toBe('likely');
    expect(body.covering_count).toBe(0);
    const r = result(body, 'lc-undated-212');
    expect(r.match_status).toBe('likely_covering');
    const check = r.match_checks.find((c: any) => c.field === 'production_date');
    expect(check.outcome).toBe('likely');
    expect(check.provenance).toBe('lot_decode');
    expect(check.message).toContain('Lot code implies production Jul 31, 2026');
    expect(check.message).toContain("decoded from the lot code using Darigold, Inc.'s declared format (plant · YY · Julian day)");
    expect(r.matched_lot.lot_code_implies).toMatchObject({ date: '2026-07-31', role: 'production' });

    const date = body.constraints.find((c: any) => c.kind === 'date');
    expect(date.note).toContain('puts a Jul 31, 2026 production in lot codes like ???26212');
    expect(date.note).toContain('1 lot on file decodes to that day');
  });

  it('never decodes for a supplier with no declared format', async () => {
    const body = await search('westfield produced 7/31/2026');
    const r = result(body, 'lc-undeclared');
    expect(r?.match_status).not.toBe('likely_covering');
    expect(body.coverage).toBe('none');
  });

  it('a stored lot_decode row is likely too, labelled the same way', async () => {
    const body = await search('darigold produced 8/1/2026');
    const r = result(body, 'lc-decoded-213');
    expect(r.match_status).toBe('likely_covering');
    expect(r.matched_lot.production_date_source).toBe('lot_decode');
    expect(r.match_checks.find((c: any) => c.field === 'production_date').message).toContain('Lot code implies production Aug 1, 2026');
  });

  it('only a stated production date covers', async () => {
    const body = await search('darigold produced 7/22/2026');
    expect(body.coverage).toBe('covered');
    expect(result(body, 'lc-stated-203').match_status).toBe('covering');
    const undated = result(body, 'lc-undated-212');
    if (undated) {
      expect(undated.match_status).toBe('candidate_not_matching');
      expect(undated.match_reason).toContain('Lot code implies production Jul 31, 2026');
    }
  });
});
