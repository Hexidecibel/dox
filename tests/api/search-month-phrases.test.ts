/**
 * The owner's bug, end to end: a butter certificate produced in April, and
 * "butter produced in april" typed into search came back with NOTHING — the
 * month was never read, so "produced", "in" and "april" were all required as
 * words. Now the month is a production-date clause (any year), "butter" beside
 * it resolves through the product identifier graph to a product chip, and the
 * certificate is COVERING. March is "nothing covers", with no nearest document
 * offered as the answer.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import { onRequestPost as interpretHandler } from '../../functions/api/search/interpret';
import type { Clause, SearchQuery } from '../../shared/searchQuery';

const db = env.DB;
const T = 'smp-tenant';
const USER = { id: 'smp-user', role: 'org_admin', tenant_id: T };
const SUP = 'smp-sup';
const DT = 'smp-dt-coa';
const BUTTER = 'smp-prod-butter';
const CREAM_A = 'smp-prod-cream-a';
const CREAM_B = 'smp-prod-cream-b';
const DOC_APRIL = 'smp-doc-april';
const DOC_CREAM = 'smp-doc-cream';

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Month Co', 'month-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'smp@test.com', 'Smp', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Valley Creamery', 'smp-valley', 1)`).bind(SUP, T).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT, T).run();
  for (const [id, name, sku] of [[BUTTER, 'Bulk Unsalted Butter', '2235'], [CREAM_A, 'Heavy Cream 40%', '10286'], [CREAM_B, 'Light Cream', '0801']]) {
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
    await db.prepare(
      `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source)
       VALUES (?, ?, ?, 'our_sku', ?, ?, NULL, 0, 1, 'seed')`,
    ).bind(`${id}-sku`, T, id, sku, sku).run();
  }
  const doc = async (id: string, product: string, lot: string, produced: string) => {
    await db.prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    ).bind(id, T, `COA ${lot}`, USER.id, SUP, DT, JSON.stringify({ lot_number: lot })).run();
    await db.prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
       VALUES (?, ?, 1, ?, 10, 'application/pdf', ?, 'x', ?, ?)`,
    ).bind(`${id}-v1`, id, `${lot}.pdf`, `r2/${id}.pdf`, `Certificate of analysis lot ${lot}`, USER.id).run();
    await db.prepare(
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key, production_date, production_date_raw, production_date_source, production_date_status)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'extracted', 'resolved')`,
    ).bind(`${id}-lot`, T, SUP, product, lot, lot, produced, produced).run();
    await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${id}-dl`, id, `${id}-lot`).run();
  };
  await doc(DOC_APRIL, BUTTER, 'B26107', '2026-04-17');
  await doc(DOC_CREAM, CREAM_A, 'C26140', '2026-05-20');
}, 60_000);

function ctx(path: string, body: unknown): any {
  return {
    request: new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: path,
  };
}

async function query(text: string) {
  const q: SearchQuery = { v: 1, text, clauses: [], view: { entity: 'documents' } };
  const res = await queryHandler(ctx('/api/search/query', { query: q, limit: 50, interpret: true }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

async function interpret(text: string) {
  const res = await interpretHandler(ctx('/api/search/interpret', { text }));
  expect(res.status).toBe(200);
  return (await res.json()) as { clauses: Clause[]; residual: string; labels: Record<string, string> };
}

describe('"butter produced in april"', () => {
  it('interprets as a production-date span in any year plus the butter product, nothing left as text', async () => {
    const r = await interpret('butter produced in april');
    expect(r.clauses.map((c) => c.field)).toEqual(['production_date', 'product']);
    expect(r.clauses[0]).toMatchObject({ op: 'between', values: ['--04-01', '--04-30'], raw: 'produced in april' });
    expect(r.clauses[1]).toMatchObject({ op: 'in', values: [BUTTER], raw: 'butter' });
    expect(r.residual).toBe('');
    expect(r.labels[r.clauses[0].id]).toBe('Production date April (any year)');
  });

  it('the April butter certificate is COVERING', async () => {
    const res = await query('butter produced in april');
    expect(res.coverage).toBe('covered');
    const doc = res.documents.find((d: any) => d.id === DOC_APRIL);
    expect(doc.match_status).toBe('covering');
    expect(res.documents.some((d: any) => d.id === DOC_CREAM)).toBe(false);
    expect(res.labels[BUTTER]).toBe('Bulk Unsalted Butter');
    expect(res.interpreted.residual).toBe('');
  });

  it('the same with a year, and with "made"', async () => {
    expect((await query('butter produced April 2026')).coverage).toBe('covered');
    expect((await query('butter made in april')).coverage).toBe('covered');
    expect((await query('butter produced April 2025')).coverage).toBe('none');
  });

  it('"butter produced in march" is nothing covers — no nearest document offered as the answer', async () => {
    const res = await query('butter produced in march');
    expect(res.coverage).toBe('none');
    expect(res.covering_count).toBe(0);
    expect(res.documents.every((d: any) => d.match_status !== 'covering' && d.match_status !== 'likely_covering')).toBe(true);
  });

  it('a phrase fitting two products picks neither', async () => {
    const r = await interpret('cream produced in may');
    const product = r.clauses.find((c) => c.field === 'product')!;
    expect(product.ambiguous).toBe(true);
    expect([...product.values].sort()).toEqual([CREAM_A, CREAM_B].sort());
  });

  it('a year-less span across the year end is read and run', async () => {
    const res = await query('produced Dec 15 to Jan 15');
    expect(res.interpreted.clauses[0]).toMatchObject({ op: 'between', values: ['--12-15', '--01-15'] });
    expect(res.coverage).toBe('none');
    const may = await query('produced May 15 to Jun 15');
    expect(may.documents.find((d: any) => d.id === DOC_CREAM)?.match_status).toBe('covering');
  });
});
