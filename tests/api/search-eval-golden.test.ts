/**
 * bin/eval-search's probes, run over the golden corpus instead of a server
 * (`bin/eval-search` with no --url runs this file). It samples through the
 * real GET /api/search/eval-sample, generates the questions a person would ask
 * about each document with shared/searchProbes.ts, asks them through the real
 * endpoints and scores them. On this corpus every scorable probe must pass;
 * the scorecard is printed in the failure message when one does not.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as sampleHandler } from '../../functions/api/search/eval-sample';
import {
  DOC, GOLDEN_OTHER_USER, GOLDEN_READER, GOLDEN_SUPER, GOLDEN_TENANT, GOLDEN_USER, GOLDEN_DOC_IDS, seedGoldenCorpus,
} from '../fixtures/search-golden/corpus';
import { ask, monthPhrasesSupported, type TestUser } from '../fixtures/search-golden/run';
import { formatScorecard, sampleProbes, scoreProbe, scorecard, type EvalSample } from '../../shared/searchProbes';

const db = env.DB;

async function sample(user: TestUser, qs = ''): Promise<{ status: number; body: EvalSample & { error?: string } }> {
  const res = await sampleHandler({
    request: new Request(`http://localhost/api/search/eval-sample${qs}`), env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search/eval-sample',
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  await seedGoldenCorpus(db);
}, 60_000);

describe('GET /api/search/eval-sample', () => {
  it('is tenant-scoped, deterministic per seed, and allow-listed', async () => {
    const a = await sample(GOLDEN_USER, '?n=10&seed=s1');
    const b = await sample(GOLDEN_USER, '?n=10&seed=s1');
    const c = await sample(GOLDEN_USER, '?n=10&seed=s2');
    expect(a.status).toBe(200);
    expect(a.body.docs).toHaveLength(10);
    expect(b.body).toEqual(a.body);
    expect(c.body.docs.map((d) => d.id)).not.toEqual(a.body.docs.map((d) => d.id));
    for (const d of a.body.docs) {
      expect(GOLDEN_DOC_IDS).toContain(d.id);
      expect(Object.keys(d).sort()).toEqual(['document_type_name', 'document_type_slug', 'id', 'keys', 'lots', 'printed_product', 'products', 'supplier_id', 'supplier_name', 'title']);
    }
    const other = await sample(GOLDEN_OTHER_USER, '?n=50');
    expect(other.body.docs.map((d) => d.id)).toEqual([DOC.otherTwin]);
  });

  it('org_admin / super_admin only; super_admin names the tenant', async () => {
    expect((await sample(GOLDEN_READER)).status).toBe(403);
    expect((await sample(GOLDEN_SUPER)).status).toBe(400);
    expect((await sample(GOLDEN_SUPER, `?tenant_id=${GOLDEN_TENANT}&n=5`)).status).toBe(200);
    expect((await sample(GOLDEN_USER, '?n=0')).status).toBe(400);
  });

  it('verifies its negatives: an absent day holds no lot, an absent lot is held by nobody', async () => {
    const { body } = await sample(GOLDEN_USER, '?n=200');
    expect(body.negatives.days.length).toBeGreaterThan(5);
    const held = (await db.prepare(`SELECT DISTINCT production_date AS d FROM lots WHERE tenant_id = ?`).bind(GOLDEN_TENANT).all<{ d: string }>()).results.map((r) => r.d);
    for (const n of body.negatives.days) expect(held).not.toContain(n.day);
    const keys = (await db.prepare(`SELECT lot_key FROM lots WHERE tenant_id = ?`).bind(GOLDEN_TENANT).all<{ lot_key: string }>()).results.map((r) => r.lot_key);
    for (const n of body.negatives.lots) expect(keys).not.toContain(n.lot.replace(/[^A-Z0-9]/gi, '').toUpperCase());
    expect(body.lot_prefixes.map((p) => p.prefix)).toContain('207');
  });
});

describe('GET /api/search/eval-sample on a larger tenant', () => {
  it('stays under D1\'s 100-parameter limit however many documents and lots it samples', async () => {
    const T = 'eval-bulk';
    const U = { id: 'eval-bulk-user', role: 'org_admin', tenant_id: T };
    await db.prepare(`INSERT INTO tenants (id, name, slug, active) VALUES (?, 'Bulk', 'eval-bulk', 1)`).bind(T).run();
    await db.prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, 'bulk@test.com', 'Bulk', 'org_admin', ?, 'x', 1, 0)`,
    ).bind(U.id, T).run();
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES ('eb-sup', ?, 'Bulk Dairy', 'eb-sup', 1)`).bind(T).run();
    await db.prepare(`INSERT INTO products (id, tenant_id, name, slug, active) VALUES ('eb-prod', ?, 'Butter', 'eb-prod', 1)`).bind(T).run();
    for (let i = 0; i < 150; i++) {
      const id = `eb-doc-${i}`;
      await db.prepare(
        `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, primary_metadata, created_at, updated_at)
         VALUES (?, ?, ?, '[]', 1, 'active', ?, 'eb-sup', ?, '2026-06-01', '2026-06-01')`,
      ).bind(id, T, `Bulk ${i}`, U.id, JSON.stringify({ po_number: `K9${String(i).padStart(5, '0')}` })).run();
      await db.prepare(`INSERT INTO document_products (id, document_id, product_id) VALUES (?, ?, 'eb-prod')`).bind(`${id}-dp`, id).run();
      await db.prepare(
        `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, sub_lot_code, lot_key, production_date, production_date_source, production_date_status)
         VALUES (?, ?, 'eb-sup', 'eb-prod', ?, '01', ?, '2026-05-01', 'extracted', 'resolved')`,
      ).bind(`${id}-lot`, T, `30${String(i).padStart(6, '0')}`, `30${String(i).padStart(6, '0')}01`).run();
      await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${id}-dl`, id, `${id}-lot`).run();
    }
    const { status, body } = await sample(U, '?n=150');
    expect(status, body.error).toBe(200);
    expect(body.docs).toHaveLength(150);
    expect(body.docs.every((d) => d.products.length === 1 && d.lots.length === 1)).toBe(true);
    expect(body.negatives.lots.length).toBe(150);
  }, 120_000);
});

describe('the eval-search probes over the golden corpus', () => {
  it('every scorable probe passes (the scorecard is printed when one does not)', async () => {
    const { body } = await sample(GOLDEN_USER, '?n=200&seed=golden');
    const probes = sampleProbes(body);
    const months = await monthPhrasesSupported(GOLDEN_USER);
    const results = [];
    for (const p of probes) {
      const r = await ask(GOLDEN_USER, p.text, p.clauses ?? []);
      results.push(scoreProbe(p, r.body, p.needs === 'month_phrases' ? months : true));
    }
    const card = scorecard(results);
    const text = formatScorecard(card);
    expect(card.positives.total).toBeGreaterThan(50);
    expect(card.negatives.total).toBeGreaterThan(20);
    const kinds = card.kinds.map((k) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      'lot_exact', 'lot_composite', 'lot_dash', 'lot_space', 'lot_prefix', 'supplier_po', 'invoice', 'document_number',
      'product_day', 'product_month', 'supplier_type', 'neg_adjacent_day', 'neg_absent_lot', 'neg_wrong_supplier',
    ]));
    expect(card.likely_by_basis['legacy code date read as production']?.total).toBeGreaterThan(0);
    expect(card.likely_by_basis['decoded from the lot code']?.total).toBeGreaterThan(0);
    expect(card.failures, text).toEqual([]);
  }, 120_000);
});
