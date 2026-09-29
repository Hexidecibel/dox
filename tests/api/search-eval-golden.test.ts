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
