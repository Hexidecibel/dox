/**
 * "lot 104" is a lot PREFIX, never free text (owner review of the search
 * mockup, 2026-09-29).
 *
 * As free text, "104" matched every Darigold certificate: 104 is Darigold's
 * plant code (declared lot format plant(3) · YY · Julian day · sublot) and it
 * is also in the plant's street address. Typed after the word "lot" it is a
 * lot clause with op `starts`; the declared format says what the prefix IS;
 * a certificate covers it on the lot ROWS that start with it, and the response
 * names those rows so the page can highlight them instead of every lot.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import type { Clause, SearchQuery } from '../../shared/searchQuery';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';

const db = env.DB;
const T = 'slp-tenant';
const USER = { id: 'slp-user', role: 'org_admin', tenant_id: T };
const SUP_DG = 'slp-sup-dg';
const SUP_WP = 'slp-sup-wp';
const DT = 'slp-dt-coa';

const DOC = {
  twoRows: 'slp-doc-two-rows',
  mixed: 'slp-doc-mixed',
  otherPlant: 'slp-doc-plant-105',
  address: 'slp-doc-address',
};

async function insertDoc(id: string, supplierId: string, text: string) {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(id, T, `Certificate ${id}`, USER.id, supplierId, DT).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, ?, 10, 'application/pdf', ?, 'x', ?, ?)`,
  ).bind(`${id}-v1`, id, `${id}.pdf`, `r2/${id}.pdf`, text, USER.id).run();
}

async function linkLot(docId: string, supplierId: string, lotNumber: string, sub: string) {
  const lotId = `${docId}-${lotNumber}${sub}`;
  await db.prepare(`INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(lotId, T, supplierId, lotNumber, sub, `${lotNumber}${sub}`).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${lotId}-dl`, docId, lotId).run();
}

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Prefix Co', 'prefix-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'slp@test.com', 'Slp', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  for (const [id, name] of [[SUP_DG, 'Darigold, Inc.'], [SUP_WP, 'West Point Dairy Products']]) {
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
  }
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT, T).run();
  await db.prepare(
    `INSERT INTO supplier_lot_schemes (id, tenant_id, supplier_id, version, spec, source) VALUES ('slp-scheme', ?, ?, 1, ?, 'seed')`,
  ).bind(T, SUP_DG, JSON.stringify(LOT_SCHEME_TEMPLATES.plant_yy_julian.spec)).run();

  const address = 'Darigold, Inc. 104 Main Street Seattle WA';
  await insertDoc(DOC.twoRows, SUP_DG, `${address} Lot 10426203 Sub Lot 02 Lot 10426203 Sub Lot 03`);
  await linkLot(DOC.twoRows, SUP_DG, '10426203', '02');
  await linkLot(DOC.twoRows, SUP_DG, '10426203', '03');
  await insertDoc(DOC.mixed, SUP_DG, `${address} Lot 10426203 Sub Lot 04 Lot 20526001 Sub Lot 01`);
  await linkLot(DOC.mixed, SUP_DG, '10426203', '04');
  await linkLot(DOC.mixed, SUP_DG, '20526001', '01');
  await insertDoc(DOC.otherPlant, SUP_DG, `${address} Lot 10526001 Sub Lot 01`);
  await linkLot(DOC.otherPlant, SUP_DG, '10526001', '01');
  await insertDoc(DOC.address, SUP_WP, 'West Point Dairy Products 104 Industrial Way lot WP-A7');
}, 60_000);

function ctx(body: unknown): any {
  return {
    request: new Request('http://localhost/api/search/query', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search/query',
  };
}

async function run(text: string, clauses: Clause[] = []) {
  const query: SearchQuery = { v: 1, text, clauses, view: { entity: 'documents' } };
  const res = await queryHandler(ctx({ query, limit: 50, interpret: true }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const covering = (body: any) => body.documents.filter((d: any) => d.match_status === 'covering').map((d: any) => d.id).sort();

describe('lot prefix', () => {
  it('free text "104" is still only text — which is exactly why "lot 104" must not be', async () => {
    const body = await run('104');
    expect(body.coverage).toBe('unconstrained');
    expect(body.documents.map((d: any) => d.id)).toContain(DOC.address);
  });

  it('"lot 104" is a lot clause with op starts, and the declared format says what 104 is', async () => {
    const body = await run('lot 104');
    expect(body.interpreted.clauses).toMatchObject([{ field: 'lot', op: 'starts', values: ['104'] }]);
    expect(body.interpreted.clauses[0].note).toBe(
      '104 = Darigold, Inc. plant (declared lot format: plant · YY · Julian day) · every lot from plant 104',
    );
    expect(body.clauses[0].label).toMatch(/^Lot starts with 104 · 104 = Darigold, Inc\. plant/);
    expect(body.coverage).toBe('covered');
    expect(covering(body)).toEqual([DOC.mixed, DOC.twoRows].sort());
    // Neither the street address nor plant 105 is in the answer, or anywhere in the list.
    const listed = body.documents.map((d: any) => d.id);
    expect(listed).not.toContain(DOC.address);
    expect(listed).not.toContain(DOC.otherPlant);
  });

  it('names the lot ROWS that start with it — both rows on one certificate, one row on the other', async () => {
    const body = await run('lot 104');
    const two = body.documents.find((d: any) => d.id === DOC.twoRows);
    expect(two.matched_lots.map((l: any) => `${l.lot_number}-${l.sub_lot_code}`).sort()).toEqual(['10426203-02', '10426203-03']);
    const mixed = body.documents.find((d: any) => d.id === DOC.mixed);
    // Only one of its two rows starts with 104: that row is named, the other is not.
    expect(mixed.matched_lots ?? null).toBeNull();
    expect(`${mixed.matched_lot.lot_number}-${mixed.matched_lot.sub_lot_code}`).toBe('10426203-04');
  });

  it('a builder clause lot.starts:104 gives the same answer and the same note', async () => {
    const body = await run('', [{ id: 'c1', field: 'lot', op: 'starts', values: ['104'], source: 'builder' }]);
    expect(covering(body)).toEqual([DOC.mixed, DOC.twoRows].sort());
    expect(body.constraints[0].note).toMatch(/104 = Darigold, Inc\. plant/);
  });

  it('a whole lot on file typed after "lot" stays a whole-lot clause; a longer partial one is a prefix', async () => {
    const whole = await run('lot 10426203');
    expect(whole.interpreted.clauses).toMatchObject([{ field: 'lot', op: 'is' }]);
    const partial = await run('lot 1042620');
    expect(partial.interpreted.clauses).toMatchObject([{ field: 'lot', op: 'starts', values: ['1042620'] }]);
    expect(covering(partial)).toEqual([DOC.mixed, DOC.twoRows].sort());
  });

  it('a prefix no lot starts with says so — and lists nothing as if it were close', async () => {
    const body = await run('lot 999');
    expect(body.coverage).toBe('none');
    expect(body.coverage_summary).toBe('No document on file covers lot starting 999.');
    expect(body.documents).toEqual([]);
  });
});
