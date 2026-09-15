/**
 * Supplier watch across the write path, the review payload and the register
 * (migration 0107).
 *
 * Worth a database:
 *   1. REQUIRED ANALYTES are tenant-scoped configuration: CRUD writes audit
 *      rows, refuses another tenant's supplier, and another tenant's admin can
 *      neither read nor change them.
 *   2. review_by belongs to a SUPPLIER watch limit, and passing it never loosens
 *      anything — the limit still judges and the payload flags the watch.
 *   3. What was NOT judged is written down at approval (document_spec_gaps),
 *      and a missing required analyte reaches the owner through the SAME one
 *      email per document — while flows that find nothing, and the
 *      configuration endpoints themselves, send no email at all.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as listRequired,
  onRequestPost as createRequired,
} from '../../functions/api/spec-required-analytes/index';
import {
  onRequestPut as updateRequired,
  onRequestDelete as deleteRequired,
} from '../../functions/api/spec-required-analytes/[id]';
import { onRequestPost as createLimit } from '../../functions/api/spec-limits/index';
import { onRequestPut as updateLimit } from '../../functions/api/spec-limits/[id]';
import { onRequestGet as listGaps } from '../../functions/api/spec-gaps/index';
import { loadSpecConfig, specResultsWithConfig } from '../../functions/lib/spec-warnings';
import { registerAndNotifyForApproval } from '../../functions/lib/spec-register';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
type TestUser = { id: string; role: string; tenant_id: string | null };
let orgAdmin: TestUser;
let otherAdmin: TestUser;
let regularUser: TestUser;
let supplierId = '';
let otherTenantSupplierId = '';
let docTypeId = '';
let coliformId = '';
let spcId = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(user: TestUser, url: string, method: string, body?: unknown, params: Record<string, string> = {}): any {
  return {
    request: new Request(url, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    }),
    env,
    data: { user },
    params,
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/spec-required-analytes',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(fn: any, c: any) {
  const res = await fn(c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function auditCount(action: string, resourceId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND resource_id = ?')
    .bind(action, resourceId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
function spyOnEmail() {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'email_1' }), { status: 200 }));
  return () => (fetchSpy!.mock.calls as unknown[][]).filter((c) => String(c[0]).includes('resend.com'));
}
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
  regularUser = { id: seed.userId, role: 'user', tenant_id: seed.tenantId };

  supplierId = generateTestId();
  otherTenantSupplierId = generateTestId();
  docTypeId = generateTestId();
  coliformId = generateTestId();
  spcId = generateTestId();
  await db.batch([
    db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-${supplierId.slice(0, 6)}`),
    db.prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)').bind(otherTenantSupplierId, seed.tenantId2, 'Elsewhere Dairy', `elsewhere-${otherTenantSupplierId.slice(0, 6)}`),
    db.prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)').bind(docTypeId, seed.tenantId, 'Certificate of Analysis', `coa-${docTypeId.slice(0, 6)}`),
    db.prepare('INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit) VALUES (?, ?, ?, ?, ?)').bind(coliformId, seed.tenantId, 'Coliform', '["Total Coliform"]', 'CFU/g'),
    db.prepare('INSERT INTO spec_tests (id, tenant_id, name, aliases, default_unit) VALUES (?, ?, ?, ?, ?)').bind(spcId, seed.tenantId, 'Standard Plate Count', '["SPC","Aerobic"]', 'CFU/g'),
  ]);
}, 30_000);

const URL_RA = 'http://localhost/api/spec-required-analytes';

describe('required analytes — CRUD, audit and tenant isolation', () => {
  let createdId = '';

  it('creates one, with an audit row and no email', async () => {
    const emails = spyOnEmail();
    const r = await call(
      createRequired,
      ctx(orgAdmin, URL_RA, 'POST', {
        supplier_id: supplierId,
        document_type_id: docTypeId,
        spec_test_id: coliformId,
        review_by: '2026-12-31',
        reason: 'Sanitation watch after the August finding',
      })
    );
    expect(r.status).toBe(201);
    createdId = r.body.requiredAnalyte.id;
    expect(r.body.requiredAnalyte).toMatchObject({ review_by: '2026-12-31', tenant_id: seed.tenantId, created_by: orgAdmin.id });
    expect(await auditCount('spec_required_analyte.created', createdId)).toBe(1);
    expect(emails()).toHaveLength(0);
  });

  it('refuses a duplicate with a 409 naming the existing row', async () => {
    const r = await call(
      createRequired,
      ctx(orgAdmin, URL_RA, 'POST', { supplier_id: supplierId, document_type_id: docTypeId, spec_test_id: coliformId })
    );
    expect(r.status).toBe(409);
    expect(r.body.existing_id).toBe(createdId);
  });

  it('refuses another tenant’s supplier, a missing key and a malformed date', async () => {
    expect(
      (await call(createRequired, ctx(orgAdmin, URL_RA, 'POST', { supplier_id: otherTenantSupplierId, document_type_id: docTypeId, spec_test_id: spcId }))).status
    ).toBe(400);
    expect((await call(createRequired, ctx(orgAdmin, URL_RA, 'POST', { supplier_id: supplierId, spec_test_id: spcId }))).status).toBe(400);
    const bad = await call(
      createRequired,
      ctx(orgAdmin, URL_RA, 'POST', { supplier_id: supplierId, document_type_id: docTypeId, spec_test_id: spcId, review_by: '12/31/2026' })
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('is admin-only to write', async () => {
    const r = await call(
      createRequired,
      ctx(regularUser, URL_RA, 'POST', { supplier_id: supplierId, document_type_id: docTypeId, spec_test_id: spcId })
    );
    expect(r.status).toBe(403);
  });

  it('lists only the caller’s tenant', async () => {
    const mine = await call(listRequired, ctx(orgAdmin, URL_RA, 'GET'));
    expect(mine.body.requiredAnalytes.map((x: { id: string }) => x.id)).toContain(createdId);
    expect(mine.body.requiredAnalytes[0]).toMatchObject({ test_name: 'Coliform', supplier_name: 'Andersen Dairy' });
    const theirs = await call(listRequired, ctx(otherAdmin, URL_RA, 'GET'));
    expect(theirs.body.requiredAnalytes).toEqual([]);
  });

  it('another tenant’s admin can neither extend nor remove it', async () => {
    const put = await call(updateRequired, ctx(otherAdmin, `${URL_RA}/${createdId}`, 'PUT', { review_by: '2030-01-01' }, { id: createdId }));
    expect(put.status).toBe(403);
    const del = await call(deleteRequired, ctx(otherAdmin, `${URL_RA}/${createdId}`, 'DELETE', undefined, { id: createdId }));
    expect(del.status).toBe(403);
  });

  it('extends the watch (audited) but will not turn the row into a different requirement', async () => {
    const put = await call(updateRequired, ctx(orgAdmin, `${URL_RA}/${createdId}`, 'PUT', { review_by: '2027-03-31' }, { id: createdId }));
    expect(put.status).toBe(200);
    expect(put.body.requiredAnalyte.review_by).toBe('2027-03-31');
    expect(await auditCount('spec_required_analyte.updated', createdId)).toBe(1);

    const swap = await call(updateRequired, ctx(orgAdmin, `${URL_RA}/${createdId}`, 'PUT', { spec_test_id: spcId }, { id: createdId }));
    expect(swap.status).toBe(400);
  });

  it('removes it, audited', async () => {
    const tmp = await call(
      createRequired,
      ctx(orgAdmin, URL_RA, 'POST', { supplier_id: supplierId, document_type_id: docTypeId, spec_test_id: spcId })
    );
    const del = await call(deleteRequired, ctx(orgAdmin, `${URL_RA}/${tmp.body.requiredAnalyte.id}`, 'DELETE', undefined, { id: tmp.body.requiredAnalyte.id }));
    expect(del.status).toBe(200);
    expect(await auditCount('spec_required_analyte.deleted', tmp.body.requiredAnalyte.id)).toBe(1);
    const row = await db.prepare('SELECT id FROM supplier_required_analytes WHERE id = ?').bind(tmp.body.requiredAnalyte.id).first();
    expect(row).toBeNull();
  });
});

describe('spec_limits.review_by — a supplier watch only', () => {
  const URL_L = 'http://localhost/api/spec-limits';
  let watchLimitId = '';

  it('stores a review-by on a supplier-scoped limit', async () => {
    const r = await call(
      createLimit,
      ctx(orgAdmin, URL_L, 'POST', {
        spec_test_id: coliformId,
        supplier_id: supplierId,
        operator: '<=',
        value_max: 1,
        unit: 'CFU/g',
        review_by: '2026-09-01',
      })
    );
    expect(r.status).toBe(201);
    watchLimitId = r.body.specLimit.id;
    expect(r.body.specLimit.review_by).toBe('2026-09-01');
  });

  it('refuses a review-by on a tenant-wide limit, and a malformed one', async () => {
    const wide = await call(createLimit, ctx(orgAdmin, URL_L, 'POST', { spec_test_id: spcId, operator: '<=', value_max: 20000, review_by: '2026-09-01' }));
    expect(wide.status).toBe(400);
    expect(wide.body.error).toMatch(/supplier-specific/);
    const bad = await call(createLimit, ctx(orgAdmin, URL_L, 'POST', { spec_test_id: spcId, supplier_id: supplierId, operator: '<=', value_max: 5, review_by: 'soon' }));
    expect(bad.status).toBe(400);
  });

  it('will not move a watch limit off its supplier while it still carries the date', async () => {
    const r = await call(updateLimit, ctx(orgAdmin, `${URL_L}/${watchLimitId}`, 'PUT', { supplier_id: null }, { id: watchLimitId }));
    expect(r.status).toBe(400);
    const extend = await call(updateLimit, ctx(orgAdmin, `${URL_L}/${watchLimitId}`, 'PUT', { review_by: '2026-09-01' }, { id: watchLimitId }));
    expect(extend.status).toBe(200);
  });

  it('after review-by passes the watch STILL judges, and the payload flags it', async () => {
    // Company default ≤10 plus the Andersen watch ≤1 (review-by 2026-09-01).
    await call(createLimit, ctx(orgAdmin, URL_L, 'POST', { spec_test_id: coliformId, operator: '<=', value_max: 10, unit: 'CFU/g' }));
    const config = await loadSpecConfig(db, seed.tenantId);
    expect(config.limits.find((l) => l.id === watchLimitId)?.review_by).toBe('2026-09-01');
    expect(config.required?.length).toBeGreaterThan(0);

    const row = {
      tables: JSON.stringify([
        { name: 'micro', headers: ['Test', 'Result', 'Units'], rows: [['Coliform', '5', 'CFU/g'], ['Somatic Cell Count', '180000', 'per ml']] },
      ]),
    };
    const out = specResultsWithConfig(row, config, { supplier_id: supplierId, document_type_id: docTypeId, product_ids: [] }, { asOf: '2026-09-15' });
    const coliform = out.results.find((v) => v.test_name_raw === 'Coliform');
    expect(coliform).toMatchObject({ verdict: 'out_of_spec', limit_id: watchLimitId, watch: { review_by: '2026-09-01', review_overdue: true } });
    expect(out.summary.watch_overdue).toBe(1);
    expect(out.watch_overdue[0]).toMatchObject({ kind: 'limit', id: watchLimitId, analyte_name: 'Coliform' });
    expect(out.unjudged.map((u) => u.test_name_raw)).toEqual(['Somatic Cell Count']);
    expect(out.summary.unjudged).toBe(1);
    // Coliform is required (from the CRUD block) and IS reported, so nothing is missing.
    expect(out.missing_required).toEqual([]);
  });
});

async function makeDocument(title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id, document_type_id)
       VALUES (?, ?, ?, 1, 'active', ?, ?, ?)`
    )
    .bind(id, seed.tenantId, title, seed.orgAdminId, supplierId, docTypeId)
    .run();
  return id;
}

const BASE = () => ({
  tenantId: seed.tenantId,
  tenantName: 'Test Corp',
  queueItemId: generateTestId(),
  supplierId,
  supplierName: 'Andersen Dairy',
  documentTypeId: docTypeId,
  approvedBy: seed.orgAdminId,
  appUrl: 'https://example.test',
});

describe('approval writes what was not judged, and tells the owner once', () => {
  it('writes missing_required and unjudged gaps, and one email naming the missing analyte', async () => {
    const emails = spyOnEmail();
    const config = await loadSpecConfig(db, seed.tenantId);
    const ctxDoc = { supplier_id: supplierId, document_type_id: docTypeId, product_ids: [] };
    // Reports SPC (company has no SPC limit) but NOT the required Coliform.
    const row = {
      tables: JSON.stringify([{ name: 'micro', headers: ['Test', 'Result', 'Units'], rows: [['SPC', '120', 'CFU/g']] }]),
    };
    const out = specResultsWithConfig(row, config, ctxDoc, { includePasses: true, asOf: '2026-09-15' });
    expect(out.missing_required.map((m) => m.analyte_name)).toEqual(['Coliform']);

    const doc = await makeDocument('Andersen COA missing coliform');
    await registerAndNotifyForApproval(db, 're_test_key', BASE(), out.results, config.limits, [
      { documentId: doc, title: 'Andersen COA missing coliform', recordIndex: null },
    ], { unjudged: out.unjudged, missing_required: out.missing_required });

    const gaps = await db
      .prepare('SELECT kind, test_name_raw, spec_test_id, result_key, reason, snapshot, judgement_origin, notified_at FROM document_spec_gaps WHERE document_id = ? ORDER BY kind')
      .bind(doc)
      .all<Record<string, string | null>>();
    expect(gaps.results.map((g) => [g.kind, g.test_name_raw])).toEqual([
      ['missing_required', 'Coliform'],
      ['unjudged', 'SPC'],
    ]);
    const missing = gaps.results[0];
    expect(missing).toMatchObject({ spec_test_id: coliformId, result_key: null, judgement_origin: 'approval' });
    expect(JSON.parse(missing.snapshot!)).toMatchObject({ analyte: 'Coliform', why: 'not_on_certificate', review_by: '2027-03-31', review_overdue: false });
    expect(missing.notified_at).not.toBeNull();
    expect(gaps.results[1].result_key).toBe('ai_fields::t0r0');

    const sent = emails();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(String((sent[0][1] as RequestInit).body));
    expect(body.subject).toMatch(/required Coliform not reported/);
    expect(body.html).toContain('not on the certificate');

    // The document view reads them back, tenant-scoped.
    const mine = await call(listGaps, ctx(orgAdmin, `http://localhost/api/spec-gaps?document_id=${doc}`, 'GET'));
    expect(mine.body.specGaps).toHaveLength(2);
    const theirs = await call(listGaps, ctx(otherAdmin, `http://localhost/api/spec-gaps?document_id=${doc}`, 'GET'));
    expect(theirs.body.specGaps).toEqual([]);
    const badKind = await call(listGaps, ctx(orgAdmin, 'http://localhost/api/spec-gaps?kind=nope', 'GET'));
    expect(badKind.status).toBe(400);
  });

  it('re-approval replaces the gaps rather than piling them up', async () => {
    spyOnEmail();
    const config = await loadSpecConfig(db, seed.tenantId);
    const ctxDoc = { supplier_id: supplierId, document_type_id: docTypeId, product_ids: [] };
    const row = { tables: JSON.stringify([{ name: 'm', headers: ['Test', 'Result'], rows: [['SPC', '120']] }]) };
    const out = specResultsWithConfig(row, config, ctxDoc, { includePasses: true, asOf: '2026-09-15' });
    const doc = await makeDocument('Re-approved COA');
    for (let i = 0; i < 2; i++) {
      await registerAndNotifyForApproval(db, undefined, BASE(), out.results, config.limits, [
        { documentId: doc, title: 'Re-approved COA', recordIndex: null },
      ], { unjudged: out.unjudged, missing_required: out.missing_required });
    }
    const n = await db.prepare('SELECT COUNT(*) AS n FROM document_spec_gaps WHERE document_id = ?').bind(doc).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it('sends NO email when every required analyte is reported and nothing failed', async () => {
    const emails = spyOnEmail();
    const config = await loadSpecConfig(db, seed.tenantId);
    const ctxDoc = { supplier_id: supplierId, document_type_id: docTypeId, product_ids: [] };
    // Coliform <1 against the watch ≤1: in spec; nothing missing.
    const row = { tables: JSON.stringify([{ name: 'm', headers: ['Test', 'Result', 'Units'], rows: [['Total Coliform', '<1', 'CFU/g']] }]) };
    const out = specResultsWithConfig(row, config, ctxDoc, { includePasses: true, asOf: '2026-09-15' });
    expect(out.missing_required).toEqual([]);
    expect(out.results.every((v) => v.verdict === 'in_spec')).toBe(true);

    const doc = await makeDocument('Clean Andersen COA');
    await registerAndNotifyForApproval(db, 're_test_key', BASE(), out.results, config.limits, [
      { documentId: doc, title: 'Clean Andersen COA', recordIndex: null },
    ], { unjudged: out.unjudged, missing_required: out.missing_required });
    expect(emails()).toHaveLength(0);
  });

  it('sends NO email for a supplier with no requirements whose COA reports little', async () => {
    const emails = spyOnEmail();
    const config = await loadSpecConfig(db, seed.tenantId);
    const out = specResultsWithConfig(
      { tables: JSON.stringify([{ name: 'm', headers: ['Test', 'Result'], rows: [['Fat', '3.5']] }]) },
      config,
      { supplier_id: 'some-other-supplier', document_type_id: docTypeId, product_ids: [] },
      { includePasses: true, asOf: '2026-09-15' }
    );
    // Complete by default: no requirement, no finding.
    expect(out.missing_required).toEqual([]);
    const doc = await makeDocument('Unwatched supplier COA');
    await registerAndNotifyForApproval(db, 're_test_key', BASE(), out.results, config.limits, [
      { documentId: doc, title: 'Unwatched supplier COA', recordIndex: null },
    ], { unjudged: out.unjudged, missing_required: out.missing_required });
    expect(emails()).toHaveLength(0);
  });

  it('computing the review payload never sends email', async () => {
    const emails = spyOnEmail();
    const config = await loadSpecConfig(db, seed.tenantId);
    specResultsWithConfig(
      { tables: JSON.stringify([{ name: 'm', headers: ['Test', 'Result'], rows: [['SPC', '99999']] }]) },
      config,
      { supplier_id: supplierId, document_type_id: docTypeId, product_ids: [] }
    );
    expect(emails()).toHaveLength(0);
  });
});
