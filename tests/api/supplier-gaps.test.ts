/**
 * Integration tests for GET /api/supplier-gaps — the D1 half of gap detection.
 *
 * The arithmetic is unit-tested in tests/unit/requirementGap.test.ts. What is
 * tested HERE is everything the SQL can get wrong: which link statuses count,
 * which document states count, that a claim resolves through
 * claim_type_requirements, and that no join path walks out of the tenant.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet as gapsGet } from '../../functions/api/supplier-gaps/index';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };
let superAdmin: { id: string; role: 'super_admin'; tenant_id: null };
let otherAdmin: { id: string; role: 'org_admin'; tenant_id: string };

let supplierA: string;
let supplierB: string;
let reqAllergen: string;
let reqNutrition: string;
let reqOrganic: string;
let claimOrganic: string;
let foreignSupplier: string;
let foreignRequirement: string;

async function makeSupplier(tenantId: string, name: string): Promise<string> {
  const id = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeRequirement(tenantId: string, name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function makeClaimType(tenantId: string, name: string): Promise<string> {
  const id = `ct-${generateTestId()}`;
  await db
    .prepare('INSERT INTO claim_types (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function applies(
  supplierId: string,
  requirementId: string,
  tier: 'required' | 'recommended' = 'required',
  tenantId = seed.tenantId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`sr-${generateTestId()}`, tenantId, supplierId, requirementId, tier)
    .run();
}

async function makeDocument(
  supplierId: string,
  title: string,
  opts: {
    tenantId?: string;
    status?: string;
    classification?: string;
  } = {},
): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, current_version, status, created_by, supplier_id, classification_status)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.tenantId ?? seed.tenantId,
      title,
      opts.status ?? 'active',
      seed.userId,
      supplierId,
      opts.classification ?? 'classified',
    )
    .run();
  return id;
}

async function closes(
  documentId: string,
  requirementId: string,
  status: 'suggested' | 'confirmed' | 'rejected' = 'confirmed',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_requirements (id, document_id, requirement_id, status)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(`dr-${generateTestId()}`, documentId, requirementId, status)
    .run();
}

async function claims(
  documentId: string,
  claimTypeId: string,
  status: 'suggested' | 'confirmed' | 'rejected' = 'confirmed',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_claims (id, document_id, claim_type_id, status)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(`dc-${generateTestId()}`, documentId, claimTypeId, status)
    .run();
}

async function claimOpens(
  claimTypeId: string,
  requirementId: string,
  isRequired = 1,
  tenantId = seed.tenantId,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id, is_required)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(`ctr-${generateTestId()}`, tenantId, claimTypeId, requirementId, isRequired)
    .run();
}

async function gaps(query: string, as: unknown = admin) {
  const res = await gapsGet({
    request: new Request(`http://localhost/api/supplier-gaps${query}`),
    env,
    data: { user: as },
    params: {},
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

/** The one supplier a single-supplier query is about. */
function only(body: any) {
  expect(body.gaps).toHaveLength(1);
  return body.gaps[0];
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin' as const, tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader' as const, tenant_id: seed.tenantId };
  superAdmin = { id: seed.superAdminId, role: 'super_admin' as const, tenant_id: null };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin' as const, tenant_id: seed.tenantId2 };

  supplierA = await makeSupplier(seed.tenantId, 'Alpha Dairy');
  supplierB = await makeSupplier(seed.tenantId, 'Beta Foods');
  reqAllergen = await makeRequirement(seed.tenantId, 'Allergen Matrix');
  reqNutrition = await makeRequirement(seed.tenantId, '100g Nutritionals');
  reqOrganic = await makeRequirement(seed.tenantId, 'Organic Certificate');
  claimOrganic = await makeClaimType(seed.tenantId, 'Organic');

  foreignSupplier = await makeSupplier(seed.tenantId2, 'Other Corp Supplier');
  foreignRequirement = await makeRequirement(seed.tenantId2, 'Other Corp Line Item');
}, 30_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM supplier_requirements').run();
  await db.prepare('DELETE FROM document_requirements').run();
  await db.prepare('DELETE FROM document_claims').run();
  await db.prepare('DELETE FROM claim_type_requirements').run();
  await db.prepare('DELETE FROM documents').run();
});

describe('the subtraction, over D1', () => {
  it('subtracts confirmed closures from configured applicability', async () => {
    await applies(supplierA, reqAllergen);
    await applies(supplierA, reqNutrition);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await closes(doc, reqAllergen);

    const { status, body } = await gaps(`?supplier_id=${supplierA}`);
    expect(status).toBe(200);

    const gap = only(body);
    expect(gap.supplier_name).toBe('Alpha Dairy');
    expect(gap.status).toBe('open');
    expect(gap.counts.required).toEqual({ applicable: 2, satisfied: 1, open: 1 });
    expect(gap.open.map((o: any) => o.name)).toEqual(['100g Nutritionals']);
    expect(gap.open[0].requirement_id).toBe(reqNutrition);
    expect(gap.open[0].summary).toContain('100g Nutritionals (required)');
  });

  it('only "confirmed" closes — suggested and rejected do not', async () => {
    await applies(supplierA, reqAllergen);
    await applies(supplierA, reqNutrition);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await closes(doc, reqAllergen, 'suggested');
    await closes(doc, reqNutrition, 'rejected');

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.counts.required.satisfied).toBe(0);
    expect(gap.counts.required.open).toBe(2);
  });

  it('a closure from a DIFFERENT supplier does not count', async () => {
    await applies(supplierA, reqAllergen);
    const otherDoc = await makeDocument(supplierB, 'Beta Spec Sheet');
    await closes(otherDoc, reqAllergen);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.counts.required.open).toBe(1);
  });

  it('an archived document closes nothing', async () => {
    await applies(supplierA, reqAllergen);
    const doc = await makeDocument(supplierA, 'Old Spec Sheet', { status: 'archived' });
    await closes(doc, reqAllergen);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('open');
    expect(gap.documents.total).toBe(0);
  });

  it('a deactivated requirement stops generating a gap', async () => {
    await applies(supplierA, reqAllergen);
    await applies(supplierA, reqNutrition);
    await db.prepare('UPDATE requirements SET active = 0 WHERE id = ?').bind(reqNutrition).run();

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.counts.required.applicable).toBe(1);

    await db.prepare('UPDATE requirements SET active = 1 WHERE id = ?').bind(reqNutrition).run();
  });
});

describe('tier filtering', () => {
  beforeEach(async () => {
    await applies(supplierA, reqAllergen, 'required');
    await applies(supplierA, reqNutrition, 'recommended');
  });

  it('defaults to required only, and says so in the response', async () => {
    const { body } = await gaps(`?supplier_id=${supplierA}`);
    expect(body.include_recommended).toBe(false);
    expect(body.tiers_counted).toEqual(['required']);

    const gap = only(body);
    expect(gap.open.map((o: any) => o.name)).toEqual(['Allergen Matrix']);
    expect(gap.counts.recommended.open).toBe(1);
    expect(gap.caveats.map((c: any) => c.code)).toContain('recommended_excluded');
  });

  it('opts in to the recommended tier', async () => {
    const { body } = await gaps(`?supplier_id=${supplierA}&include_recommended=1`);
    expect(body.tiers_counted).toEqual(['required', 'recommended']);
    expect(only(body).open).toHaveLength(2);
  });
});

describe('claims opening requirements', () => {
  it('a confirmed claim opens a requirement through claim_type_requirements', async () => {
    await claimOpens(claimOrganic, reqOrganic);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await claims(doc, claimOrganic);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('open');
    expect(gap.open[0].requirement_id).toBe(reqOrganic);
    expect(gap.open[0].origins).toEqual(['claim']);
    expect(gap.open[0].opened_by[0].claim_type_name).toBe('Organic');
    expect(gap.open[0].opened_by[0].document_title).toBe('Spec Sheet');
    // Nothing was configured, so it is still flagged as unconfigured.
    expect(gap.configured).toBe(false);
  });

  it('an unconfirmed claim opens nothing', async () => {
    await claimOpens(claimOrganic, reqOrganic);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await claims(doc, claimOrganic, 'suggested');

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('not_configured');
    expect(gap.counts.required.applicable).toBe(0);
  });

  it('an advisory mapping lands in the recommended tier', async () => {
    await claimOpens(claimOrganic, reqOrganic, 0);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await claims(doc, claimOrganic);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.counts.recommended.applicable).toBe(1);
    expect(gap.counts.required.applicable).toBe(0);
  });

  it('a claim-opened requirement closes like any other', async () => {
    await claimOpens(claimOrganic, reqOrganic);
    const spec = await makeDocument(supplierA, 'Spec Sheet');
    await claims(spec, claimOrganic);
    const cert = await makeDocument(supplierA, 'Organic Certificate 2026');
    await closes(cert, reqOrganic);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('satisfied');
    expect(gap.applicable[0].satisfied_by[0].document_title).toBe('Organic Certificate 2026');
  });
});

describe('nothing open vs nothing configured', () => {
  it('a supplier with no applicability reads not_configured, never satisfied', async () => {
    await makeDocument(supplierA, 'Some COA');

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('not_configured');
    expect(gap.configured).toBe(false);
    expect(gap.caveats.map((c: any) => c.code)).toContain('no_requirements_configured');
  });

  it('a genuinely satisfied supplier is a different status', async () => {
    await applies(supplierA, reqAllergen);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await closes(doc, reqAllergen);

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('satisfied');
    expect(gap.configured).toBe(true);
  });

  it('the rollup keeps the three states apart', async () => {
    await applies(supplierA, reqAllergen); // open
    // supplierB: configured and closed
    await applies(supplierB, reqNutrition);
    const doc = await makeDocument(supplierB, 'Beta Spec');
    await closes(doc, reqNutrition);

    const { body } = await gaps('');
    const forA = body.gaps.find((g: any) => g.supplier_id === supplierA);
    const forB = body.gaps.find((g: any) => g.supplier_id === supplierB);
    expect(forA.status).toBe('open');
    expect(forB.status).toBe('satisfied');
    expect(body.rollup.open).toBe(1);
    expect(body.rollup.satisfied).toBe(1);
    expect(body.rollup.open_requirements).toBe(1);
  });

  it('filters the list by status', async () => {
    await applies(supplierA, reqAllergen);

    const open = await gaps('?status=open');
    expect(open.body.gaps.map((g: any) => g.supplier_id)).toEqual([supplierA]);

    const unconfigured = await gaps('?status=not_configured');
    expect(unconfigured.body.gaps.map((g: any) => g.supplier_id)).toEqual([supplierB]);

    expect((await gaps('?status=whatever')).status).toBe(400);
  });
});

describe('the countable unclassified state', () => {
  it('counts unreviewed documents and caveats a clean-looking result', async () => {
    await applies(supplierA, reqAllergen);
    const doc = await makeDocument(supplierA, 'Spec Sheet');
    await closes(doc, reqAllergen);
    await makeDocument(supplierA, 'Untouched Scan', { classification: 'unclassified' });
    await makeDocument(supplierA, 'AI-Proposed', { classification: 'needs_review' });
    await makeDocument(supplierA, 'Genuinely Odd', { classification: 'unclassifiable' });

    const gap = only((await gaps(`?supplier_id=${supplierA}`)).body);
    expect(gap.status).toBe('satisfied');
    expect(gap.documents.total).toBe(4);
    expect(gap.documents.classification).toEqual({
      unclassified: 1,
      needs_review: 1,
      classified: 1,
      unclassifiable: 1,
    });

    // 'unclassifiable' is a terminal human ruling and does NOT inflate the
    // backlog; the other two do.
    const caveat = gap.caveats.find((c: any) => c.code === 'unclassified_documents');
    expect(caveat.count).toBe(2);
  });

  it('rolls unreviewed documents up across suppliers', async () => {
    await makeDocument(supplierA, 'A1', { classification: 'unclassified' });
    await makeDocument(supplierB, 'B1', { classification: 'needs_review' });

    const { body } = await gaps('');
    expect(body.rollup.unclassified_documents).toBe(2);
  });
});

describe('tenant isolation and access', () => {
  beforeEach(async () => {
    await applies(supplierA, reqAllergen);
    await applies(foreignSupplier, foreignRequirement, 'required', seed.tenantId2);
  });

  it('an org_admin never sees another tenant\'s suppliers', async () => {
    const { body } = await gaps('');
    const ids = body.gaps.map((g: any) => g.supplier_id);
    expect(ids).toContain(supplierA);
    expect(ids).not.toContain(foreignSupplier);
  });

  it('naming another tenant\'s supplier returns nothing, not that tenant\'s data', async () => {
    const { status, body } = await gaps(`?supplier_id=${foreignSupplier}`);
    expect(status).toBe(200);
    expect(body.gaps).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('passing tenant_id as an org_admin is ignored', async () => {
    const { body } = await gaps(`?tenant_id=${seed.tenantId2}`);
    expect(body.gaps.every((g: any) => g.supplier_id !== foreignSupplier)).toBe(true);
    expect(body.gaps.map((g: any) => g.supplier_id)).toContain(supplierA);
  });

  it('the other tenant sees only its own', async () => {
    const { body } = await gaps('', otherAdmin);
    expect(body.gaps.map((g: any) => g.supplier_id)).toEqual([foreignSupplier]);
    expect(body.gaps[0].status).toBe('open');
  });

  it('a reader may read the report — it is evidence, not configuration', async () => {
    const { status, body } = await gaps(`?supplier_id=${supplierA}`, reader);
    expect(status).toBe(200);
    expect(only(body).status).toBe('open');
  });

  it('a super_admin must name a tenant, or a supplier that implies one', async () => {
    expect((await gaps('', superAdmin)).status).toBe(400);

    const byTenant = await gaps(`?tenant_id=${seed.tenantId}`, superAdmin);
    expect(byTenant.status).toBe(200);
    expect(byTenant.body.gaps.map((g: any) => g.supplier_id)).toContain(supplierA);

    const bySupplier = await gaps(`?supplier_id=${foreignSupplier}`, superAdmin);
    expect(bySupplier.status).toBe(200);
    expect(only(bySupplier.body).supplier_id).toBe(foreignSupplier);
  });
});
