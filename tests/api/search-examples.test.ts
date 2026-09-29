/**
 * GET /api/search/examples — "Try" chips built from the requesting tenant's own
 * documents, every one verified by running it before it is offered.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as examplesHandler } from '../../functions/api/search/examples';
import { clearExamplesCache } from '../../functions/lib/search/examples';
import {
  GOLDEN_DOC_IDS, GOLDEN_OTHER_TENANT, GOLDEN_OTHER_USER, GOLDEN_SUPER, GOLDEN_TENANT, GOLDEN_USER, DOC, seedGoldenCorpus,
} from '../fixtures/search-golden/corpus';
import { ask, bands, type TestUser } from '../fixtures/search-golden/run';
import type { SearchExamplesResponse } from '../../shared/types';

const db = env.DB;
const EMPTY_TENANT = 'golden-empty';
const EMPTY_USER = { id: 'golden-empty-user', role: 'org_admin', tenant_id: EMPTY_TENANT };

async function examples(user: TestUser, tenantId?: string): Promise<{ status: number; body: SearchExamplesResponse & { error?: string } }> {
  const url = `http://localhost/api/search/examples${tenantId ? `?tenant_id=${tenantId}` : ''}`;
  const res = await examplesHandler({
    request: new Request(url), env, data: { user }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search/examples',
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  await seedGoldenCorpus(db);
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'Empty Co', 'empty-co', 1)`).bind(EMPTY_TENANT).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'empty@test.com', 'Empty', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(EMPTY_USER.id, EMPTY_TENANT).run();
  clearExamplesCache();
}, 60_000);

describe('GET /api/search/examples', () => {
  it('builds 6-8 examples from the tenant, and every real one covers when run', async () => {
    const { status, body } = await examples(GOLDEN_USER);
    expect(status).toBe(200);
    expect(body.examples.length).toBeGreaterThanOrEqual(6);
    expect(body.examples.length).toBeLessThanOrEqual(8);
    const kinds = body.examples.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['lot_dash', 'lot_prefix', 'supplier_po', 'product_day', 'invoice', 'neg_adjacent_day']));

    for (const ex of body.examples) {
      const r = await ask(GOLDEN_USER, ex.text);
      const b = bands(r.body);
      if (ex.teaching) {
        expect(r.body.coverage, `${ex.text}`).toBe('none');
        expect(b.covering.length + b.likely.length, `${ex.text}`).toBe(0);
        expect(b.nearby.length, `${ex.text}: the near miss is shown`).toBeGreaterThan(0);
        expect(ex.label).toMatch(/nothing on file/);
      } else {
        expect(r.body.coverage, `${ex.text}: ${r.body.coverage_summary}`).toBe('covered');
        // Covered by THIS tenant's documents only.
        for (const id of b.covering) expect(GOLDEN_DOC_IDS).toContain(id);
      }
    }
    expect(body.examples.filter((e) => e.teaching)).toHaveLength(1);
  });

  it('phrases them the way a person talks: "lot X-Y", "PO …", a product word + a day', async () => {
    const { body } = await examples(GOLDEN_USER);
    const byKind = Object.fromEntries(body.examples.map((e) => [e.kind, e]));
    expect(byKind.lot_dash.text).toMatch(/^lot \d{8}-\d{2}$/);
    expect(byKind.lot_prefix.text).toMatch(/^lot \d{3}$/);
    expect(byKind.lot_prefix.label).toBe("every lot from Cascade Creamery Cooperative plant 207 (declared lot format)");
    expect(byKind.supplier_po.text).toMatch(/^PO /);
    expect(byKind.product_day.text).toMatch(/^[a-z ]+ produced [A-Z][a-z]{2} \d{1,2}$/);
    expect(byKind.product_day.text).not.toMatch(/btr|bulk|25kg|\d{4,}/i);
    expect(byKind.invoice.text).toBe('invoice 263518');
  });

  it('is the same set all day — cached, and rebuilt identically from the day seed', async () => {
    const a = await examples(GOLDEN_USER);
    const b = await examples(GOLDEN_USER);
    clearExamplesCache();
    const c = await examples(GOLDEN_USER);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
  });

  it("comes only from the requesting tenant's documents", async () => {
    const { body } = await examples(GOLDEN_OTHER_USER);
    expect(body.examples.length).toBeGreaterThan(0);
    for (const ex of body.examples.filter((e) => !e.teaching)) {
      const r = await ask(GOLDEN_OTHER_USER, ex.text);
      expect(bands(r.body).covering, ex.text).toEqual([DOC.otherTwin]);
    }
    // Nothing only the golden tenant holds leaks into the other tenant's set.
    const texts = body.examples.map((e) => e.text).join(' | ');
    expect(texts).not.toMatch(/263518|SS-820004|K145390|K145612/);
  });

  it('an empty tenant gets [] (the page falls back to its static chips)', async () => {
    const { status, body } = await examples(EMPTY_USER);
    expect(status).toBe(200);
    expect(body.examples).toEqual([]);
  });

  it('super_admin: 400 without a tenant (shown as no examples), 200 naming one', async () => {
    const none = await examples(GOLDEN_SUPER);
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/tenant_id is required/);
    const named = await examples(GOLDEN_SUPER, GOLDEN_TENANT);
    expect(named.status).toBe(200);
    expect(named.body.examples.length).toBeGreaterThan(0);
  });

  it('an org_admin cannot ask for another tenant: the parameter is ignored', async () => {
    const { body } = await examples(GOLDEN_USER, GOLDEN_OTHER_TENANT);
    const mine = await examples(GOLDEN_USER);
    expect(body).toEqual(mine.body);
  });
});
