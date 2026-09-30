/**
 * Search Phase 3 — every field, pinned three ways:
 *
 *   1. The renewal-state SQL (`renewalStateSql`) agrees with the alert engine:
 *      `resolveRenewalAlertLead` (type -> organization -> 60 days) and
 *      `classifyDaysUntil`, on a grid of lead times, due dates and renewal
 *      types — so "Due within its warning time" in search is exactly what the
 *      renewal mail calls expiring.
 *   2. The scope SQL (`scopeWhere`) and its JS mirror (`scopeHolds`, used by
 *      the coverage path to count facets over the answers) pick the SAME
 *      documents for every new field, included and excluded.
 *   3. Result modes: a Lots / Products / Suppliers view is a view over the
 *      matching documents, a clause that does not apply is reported in
 *      `not_applied` and not run, and nearby candidates never make a row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runSearch } from '../../functions/lib/search/execute';
import {
  compileScope,
  renewalStateSql,
  scopeAttrColumns,
  scopeAttrsFromRow,
  scopeHolds,
  scopeWhere,
  type ScopeAttrs,
} from '../../functions/lib/search/compileScope';
import { classifyDaysUntil, daysBetween } from '../../functions/lib/expirations';
import { resolveRenewalAlertLead } from '../../shared/renewalLeadTime';
import type { Clause, SearchQuery } from '../../shared/searchQuery';
import { CLAIM, CUSTOMER, DOC, DT, GOLDEN_TENANT, P, REQ, SUP, seedGoldenCorpus } from '../fixtures/search-golden/corpus';

const db = env.DB;
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await seedGoldenCorpus(db);
}, 120_000);

// ===========================================================================
// 1. Renewal state == the alert engine
// ===========================================================================

describe('renewal state SQL is the alert engine', () => {
  const R = 'rs-tenant';
  const tenants: Array<[string, number | null]> = [[`${R}-a`, null], [`${R}-b`, 120]];
  const typeLeads: Array<number | null> = [null, 30, 90];
  const types: Array<string | null> = [null, 'hard_expiry', 'renewal_application', 'review_cycle', 'keep_current'];
  const offsets = [-400, -1, 0, 29, 30, 31, 59, 60, 61, 89, 90, 91, 119, 120, 121, 500];
  const expected = new Map<string, string>();

  beforeAll(async () => {
    const stmts: D1PreparedStatement[] = [];
    for (const [tid, tenantLead] of tenants) {
      stmts.push(db.prepare(`INSERT INTO tenants (id, name, slug, active, renewal_alert_lead_days) VALUES (?, ?, ?, 1, ?)`).bind(tid, tid, tid, tenantLead));
      stmts.push(db.prepare(`INSERT INTO users (id, email, name, role, tenant_id, password_hash, active) VALUES (?, ?, 'u', 'org_admin', ?, 'x', 1)`).bind(`${tid}-u`, `${tid}@x.test`, tid));
      for (const [ti, lead] of typeLeads.entries()) {
        stmts.push(db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active, renewal_alert_lead_days) VALUES (?, ?, ?, ?, 1, ?)`)
          .bind(`${tid}-t${ti}`, tid, `Type ${ti}`, `type-${ti}`, lead));
      }
      stmts.push(db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active, renewal_policy) VALUES (?, ?, 'COA', 'coa', 1, 'none')`).bind(`${tid}-coa`, tid));
    }
    await db.batch(stmts);
    const docs: D1PreparedStatement[] = [];
    let n = 0;
    for (const [tid, tenantLead] of tenants) {
      for (const [ti, lead] of typeLeads.entries()) {
        for (const rt of types) {
          for (const off of offsets) {
            const id = `${tid}-d${n++}`;
            const due = day(off);
            docs.push(db.prepare(`INSERT INTO documents (id, tenant_id, title, created_by, document_type_id, renewal_type, renewal_due_date) VALUES (?, ?, 't', ?, ?, ?, ?)`)
              .bind(id, tid, `${tid}-u`, `${tid}-t${ti}`, rt, due));
            const days = daysBetween(today, due)!;
            const status = classifyDaysUntil(rt, days, resolveRenewalAlertLead(lead, tenantLead).days);
            expected.set(id, status === 'expired' || status === 'overdue' ? 'past_due' : status === 'stale' ? 'current' : status);
          }
        }
      }
      // No date: nobody decided / a reviewer cleared it / the type does not renew.
      docs.push(db.prepare(`INSERT INTO documents (id, tenant_id, title, created_by, document_type_id) VALUES (?, ?, 't', ?, ?)`).bind(`${tid}-nodate`, tid, `${tid}-u`, `${tid}-t0`));
      expected.set(`${tid}-nodate`, 'not_set');
      docs.push(db.prepare(`INSERT INTO documents (id, tenant_id, title, created_by, document_type_id, renewal_decision) VALUES (?, ?, 't', ?, ?, 'cleared')`).bind(`${tid}-cleared`, tid, `${tid}-u`, `${tid}-t0`));
      expected.set(`${tid}-cleared`, 'does_not_renew');
      docs.push(db.prepare(`INSERT INTO documents (id, tenant_id, title, created_by, document_type_id) VALUES (?, ?, 't', ?, ?)`).bind(`${tid}-coa`, tid, `${tid}-u`, `${tid}-coa`));
      expected.set(`${tid}-coa`, 'does_not_renew');
    }
    for (let i = 0; i < docs.length; i += 50) await db.batch(docs.slice(i, i + 50));
  }, 120_000);

  it('classifies every (lead time, due date, renewal type) exactly as the mail engine does', async () => {
    const rows = (await db.prepare(`SELECT d.id, ${renewalStateSql(today)} AS s FROM documents d WHERE d.tenant_id IN (?, ?)`)
      .bind(tenants[0][0], tenants[1][0]).all<{ id: string; s: string }>()).results ?? [];
    expect(rows.length).toBe(expected.size);
    const wrong = rows.filter((r) => expected.get(r.id) !== r.s).map((r) => `${r.id}: sql=${r.s} engine=${expected.get(r.id)}`);
    expect(wrong).toEqual([]);
    // The grid actually exercises every state.
    expect(new Set(rows.map((r) => r.s))).toEqual(new Set(['past_due', 'expiring', 'current', 'not_set', 'does_not_renew']));
  });
});

// ===========================================================================
// 2. SQL == its JS mirror, for every new field
// ===========================================================================

describe('scope SQL and its JS mirror agree on every Phase 3 field', () => {
  const c = (field: Clause['field'], values: string[], extra: Partial<Clause> = {}): Clause => ({ id: 'c', field, op: 'in', values, source: 'builder', ...extra });
  const cases: Array<[string, Clause[]]> = [
    ['requirement', [c('requirement', [REQ.coi])]],
    ['requirement excluded', [c('requirement', [REQ.coi], { exclude: true })]],
    ['two requirements', [c('requirement', [REQ.coi, REQ.audit])]],
    ['claim', [c('claim', [CLAIM.kosher])]],
    ['claim excluded', [c('claim', [CLAIM.kosher], { exclude: true })]],
    ['spec out', [c('spec_verdict', ['out_of_spec'])]],
    ['spec not checked or none', [c('spec_verdict', ['not_checked', 'none'])]],
    ['spec excluded', [c('spec_verdict', ['in_spec'], { exclude: true })]],
    ['renewal expiring', [c('renewal_state', ['expiring'])]],
    ['renewal excluded', [c('renewal_state', ['does_not_renew'], { exclude: true })]],
    ['classification', [c('classification', ['needs_review', 'classified'])]],
    ['owner', [c('owner', ['Insurance'])]],
    ['owner none', [c('owner', ['__none__'])]],
    ['owner excluded', [c('owner', ['Insurance', '__none__'], { exclude: true })]],
    ['intake', [c('intake_source', ['email', 'import'])]],
    ['intake none excluded', [c('intake_source', ['__none__'], { exclude: true })]],
    ['approved within', [c('approved', ['30'], { op: 'within' })]],
    ['approved older', [c('approved', ['30'], { op: 'older_than' })]],
    ['approved missing', [c('approved', ['1'], { op: 'missing' })]],
    ['approved between', [c('approved', [day(-200), day(0)], { op: 'between' })]],
    ['mixed', [c('supplier', [SUP.cascade]), c('spec_verdict', ['none'], { exclude: true }), c('owner', ['QA'], { exclude: true })]],
    ['product + renewal', [c('product', [P.butterUnsalted]), c('renewal_state', ['does_not_renew'])]],
  ];

  let docs: Array<{ id: string; attrs: ScopeAttrs }> = [];
  beforeAll(async () => {
    const rows = (await db.prepare(
      `SELECT d.id, d.supplier_id, d.document_type_id, d.status, d.created_at,
              (SELECT GROUP_CONCAT(x, char(31)) FROM (SELECT dp.product_id AS x FROM document_products dp WHERE dp.document_id = d.id
                  UNION SELECT l.product_id FROM document_lots dl JOIN lots l ON l.id = dl.lot_id WHERE dl.document_id = d.id AND l.product_id IS NOT NULL)) AS pids,
              ${scopeAttrColumns(today)}
         FROM documents d WHERE d.tenant_id = ?`,
    ).bind(GOLDEN_TENANT).all<Record<string, unknown>>()).results ?? [];
    docs = rows.map((r) => ({
      id: String(r.id),
      attrs: {
        supplier_id: (r.supplier_id as string) ?? null,
        document_type_id: (r.document_type_id as string) ?? null,
        status: (r.status as string) ?? null,
        created_at: (r.created_at as string) ?? null,
        product_ids: typeof r.pids === 'string' && r.pids ? r.pids.split('\u001f') : [],
        ...scopeAttrsFromRow(r),
      },
    }));
    expect(docs.length).toBeGreaterThan(20);
  });

  for (const [name, clauses] of cases) {
    it(name, async () => {
      const scope = compileScope(clauses.map((x, i) => ({ ...x, id: `c${i}` })));
      const w = scopeWhere(scope, GOLDEN_TENANT);
      const sql = ((await db.prepare(`SELECT d.id FROM documents d WHERE ${w.sql} ORDER BY d.id`).bind(...w.params).all<{ id: string }>()).results ?? []).map((r) => r.id);
      const js = docs.filter((d) => scopeHolds(scope, d.attrs)).map((d) => d.id).sort();
      expect(js).toEqual(sql);
    });
  }
});

// ===========================================================================
// 3. Result modes, facets, columns
// ===========================================================================

const q = (clauses: Clause[], text = '', view: SearchQuery['view'] = { entity: 'documents' }): SearchQuery => ({ v: 1, text, clauses, view });
const run = (query: SearchQuery, interpret = false) => runSearch(db, GOLDEN_TENANT, { query, limit: 200, offset: 0, facets: true, interpret });

describe('result modes', () => {
  it('Suppliers over a scope: one row per supplier, the whole matching set counted', async () => {
    const res = await run(q([{ id: 'c1', field: 'document_type', op: 'in', values: [DT.coi], source: 'builder' }], '', { entity: 'suppliers' }));
    expect(res.groups?.entity).toBe('suppliers');
    expect(res.groups?.rows.map((r) => [r.key, r.document_count]).sort()).toEqual([[SUP.cascade, 1], [SUP.riverside, 1], [SUP.valley, 1]]);
    expect(res.groups?.rows[0].href).toMatch(/^\/admin\/suppliers\//);
  });

  it('Lots over an identifying search: only the ANSWERING lot rows, counted as covering', async () => {
    const res = await run(q([], 'lot 20726107-03', { entity: 'lots' }), true);
    expect(res.coverage).toBe('covered');
    expect(res.groups?.rows.map((r) => r.label)).toEqual(['20726107 · sublot 03']);
    expect(res.groups?.rows[0].covering_count).toBe(1);
  });

  it('Products: lot-linked and directly linked products both count', async () => {
    const res = await run(q([{ id: 'c1', field: 'supplier', op: 'in', values: [SUP.cascade], source: 'builder' }], '', { entity: 'products' }));
    const keys = res.groups?.rows.map((r) => r.key) ?? [];
    expect(keys).toContain(P.butterUnsalted);
    expect(keys).toContain(P.butterSalted);
  });

  it('a clause that does not apply to the mode is named in not_applied and not run', async () => {
    const clauses: Clause[] = [
      { id: 'c1', field: 'supplier', op: 'in', values: [SUP.valley], source: 'builder' },
      { id: 'c2', field: 'owner', op: 'in', values: ['Insurance'], source: 'builder' },
    ];
    const docs = await run(q(clauses));
    expect(docs.not_applied ?? []).toEqual([]);
    const sups = await run(q(clauses, '', { entity: 'suppliers' }));
    expect(sups.not_applied).toEqual(['c2']);
    // Without the owner clause Valley has more than its one insurance certificate.
    expect(sups.groups?.rows[0].document_count).toBeGreaterThan(1);
  });

  it('a customer search in Suppliers mode never lists a nearby supplier', async () => {
    const res = await run(q([{ id: 'c1', field: 'customer', op: 'is', values: [CUSTOMER.harbor], source: 'builder' }], '', { entity: 'suppliers' }));
    expect(res.groups?.rows.map((r) => r.key)).toEqual([SUP.cascade]);
    expect(res.groups?.rows[0]).toMatchObject({ covering_count: 1, likely_count: 1 });
  });
});

describe('every facet, and the Advanced columns', () => {
  it('a scope search returns every Phase 3 facet with words, and sticky exclusion keeps the other values', async () => {
    const res = await run(q([{ id: 'c1', field: 'renewal_state', op: 'in', values: ['expiring'], source: 'facet' }]));
    const f = res.facets!;
    for (const k of ['requirement', 'claim', 'renewal_state', 'spec_verdict', 'classification', 'owner', 'intake_source', 'approved']) {
      expect(f[k as keyof typeof f], k).toBeDefined();
    }
    // Sticky: the renewal facet still offers the states the selection left out.
    expect(f.renewal_state!.map((x) => x.value).sort()).toEqual(['current', 'does_not_renew', 'expiring', 'not_set', 'past_due']);
    expect(f.renewal_state!.find((x) => x.value === 'expiring')!.label).toBe('Due within its warning time');
    // The one expiring COI (Valley's) is only SUGGESTED against the requirement:
    // nobody has confirmed it satisfies it, so the facet must not count it.
    expect(f.requirement!.find((x) => x.value === REQ.coi)).toBeUndefined();
  });

  it('an identifying search counts facets over its ANSWERS only', async () => {
    const res = await run(q([{ id: 'c1', field: 'customer', op: 'is', values: [CUSTOMER.harbor], source: 'builder' }]));
    expect(res.facets!.spec_verdict!.map((x) => [x.value, x.count]).sort()).toEqual([['none', 1], ['out_of_spec', 1]]);
    expect(res.facets!.intake_source!.find((x) => x.value === 'email')?.count).toBe(1);
  });

  it('every row carries its column values', async () => {
    const res = await run(q([{ id: 'c1', field: 'document_type', op: 'in', values: [DT.spec], source: 'builder' }]));
    const cols = res.columns![DOC.cascadeSpec];
    expect(cols).toMatchObject({ document_number: 'SS-820004-R3', shelf_life: '12 months frozen', classification: 'classified', spec_verdict: 'none' });
    const covered = await run(q([], 'PO K145273'), true);
    expect(covered.columns![DOC.cascadeMulti]).toMatchObject({ po: 'K 145273', intake_source: 'email', spec_verdict: 'out_of_spec', renewal_state: 'does_not_renew' });
    expect(covered.columns![DOC.cascadeMulti].lots).toContain('20726107 · 03');
  });
});
