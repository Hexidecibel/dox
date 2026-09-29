/**
 * Search Phase 2 — the omnibox's server half.
 *
 *   - POST /api/search/interpret reads typed text against the tenant's own data
 *     and returns the clauses, never applying them.
 *   - A detection the person REJECTED is a text clause, and a text clause is
 *     never read again: it cannot come back as a lot, a date or a PO by itself.
 *   - An identifying answer carries every lot row on the certificate
 *     (`doc_lots`), so the page can mark the rows that answer and dim the rest.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import { onRequestPost as interpretHandler } from '../../functions/api/search/interpret';
import { clauseAsText, commitInterpretation, type Clause, type SearchQuery } from '../../shared/searchQuery';
import { LOT_SCHEME_TEMPLATES } from '../../shared/lotScheme';

const db = env.DB;
const T = 'sip-tenant';
const USER = { id: 'sip-user', role: 'org_admin', tenant_id: T };
const SUP = 'sip-sup-dg';
const DT = 'sip-dt-coa';
const DOC = 'sip-doc-multi';

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Interpret Co', 'interpret-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'sip@test.com', 'Sip', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, 'Darigold, Inc.', 'sip-dg', 1)`).bind(SUP, T).run();
  await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, 'COA', 'coa', 1)`).bind(DT, T).run();
  await db.prepare(
    `INSERT INTO supplier_lot_schemes (id, tenant_id, supplier_id, version, spec, source) VALUES ('sip-scheme', ?, ?, 1, ?, 'seed')`,
  ).bind(T, SUP, JSON.stringify(LOT_SCHEME_TEMPLATES.plant_yy_julian.spec)).run();
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, 'Butter COA', '[]', 1, 'active', ?, ?, ?, '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(DOC, T, USER.id, SUP, DT).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, 'butter.pdf', 10, 'application/pdf', 'r2/sip.pdf', 'x', 'Lot 10426203 02 Lot 10426203 03 Lot 10426244 01', ?)`,
  ).bind(`${DOC}-v1`, DOC, USER.id).run();
  for (const [lot, sub] of [['10426203', '02'], ['10426203', '03'], ['10426244', '01']]) {
    const id = `sip-lot-${lot}${sub}`;
    await db.prepare(`INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, T, SUP, lot, sub, `${lot}${sub}`).run();
    await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${id}-dl`, DOC, id).run();
  }
}, 60_000);

function ctx(path: string, body: unknown): any {
  return {
    request: new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: path,
  };
}

async function interpret(text: string) {
  const res = await interpretHandler(ctx('/api/search/interpret', { text }));
  expect(res.status).toBe(200);
  return (await res.json()) as { clauses: Clause[]; residual: string; labels: Record<string, string> };
}

async function query(q: SearchQuery) {
  const res = await queryHandler(ctx('/api/search/query', { query: q, limit: 50, interpret: true }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe('POST /api/search/interpret', () => {
  it('reads a lot prefix, a PO and a role-dated date, and returns what is left', async () => {
    const r = await interpret('butter lot 104 PO K555000 produced Sep 2');
    const byField = Object.fromEntries(r.clauses.map((c) => [c.field, c]));
    expect(byField.lot).toMatchObject({ op: 'starts', values: ['104'], source: 'detected' });
    expect(byField.lot.note).toMatch(/Darigold, Inc\. plant/);
    expect(byField.po).toMatchObject({ op: 'is', values: ['K555000'] });
    expect(byField.production_date).toMatchObject({ op: 'on', values: ['--09-02'] });
    expect(r.residual).toBe('butter');
    for (const c of r.clauses) expect(r.labels[c.id]).toBeTruthy();
  });

  it('plain words read as nothing and come back whole', async () => {
    const r = await interpret('unsalted butter');
    expect(r.clauses).toEqual([]);
    expect(r.residual).toBe('unsalted butter');
  });

  it('refuses a body without text', async () => {
    const res = await interpretHandler(ctx('/api/search/interpret', {}));
    expect(res.status).toBe(400);
  });
});

describe('a rejected detection is never re-applied', () => {
  it('committed then kept as text: the lot is matched as words, not judged as a lot', async () => {
    const detected = await interpret('lot 10426203');
    expect(detected.clauses[0]).toMatchObject({ field: 'lot' });
    const committed = commitInterpretation({ v: 1, text: '', clauses: [], view: { entity: 'documents' } }, detected.clauses, detected.residual);
    const rejected = clauseAsText(committed.query, committed.ids[0]);
    expect(rejected.clauses).toEqual([
      expect.objectContaining({ field: 'text', source: 'typed', values: ['lot 10426203'] }),
    ]);

    const res = await query(rejected);
    expect(res.interpreted).toBeUndefined();
    expect(res.constraints ?? []).not.toContainEqual(expect.objectContaining({ kind: 'lot' }));
    expect(res.coverage === undefined || res.coverage === 'unconstrained').toBe(true);
  });

  it('the same words typed in the box ARE read (the rule is about the chip, not the words)', async () => {
    const res = await query({ v: 1, text: 'lot 10426203', clauses: [], view: { entity: 'documents' } });
    expect(res.interpreted.clauses[0]).toMatchObject({ field: 'lot' });
    expect(res.coverage).toBe('covered');
  });
});

describe('doc_lots: every row on the certificate', () => {
  it('names the answering row and still lists the other lots on the same certificate', async () => {
    const res = await query({
      v: 1, text: '', view: { entity: 'documents' },
      clauses: [{ id: 'c1', field: 'lot', op: 'is', values: ['10426203'], sublot: '03', source: 'builder' }],
    });
    const doc = res.documents.find((d: any) => d.id === DOC);
    expect(doc.match_status).toBe('covering');
    expect(doc.matched_lot).toMatchObject({ lot_number: '10426203', sub_lot_code: '03' });
    expect(doc.doc_lots.map((l: any) => `${l.lot_number}-${l.sub_lot_code}`).sort()).toEqual(['10426203-02', '10426203-03', '10426244-01']);
  });
});
