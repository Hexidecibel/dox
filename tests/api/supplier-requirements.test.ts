/**
 * Integration tests for /api/supplier-requirements (migration 0087) — the
 * applicability table that makes "this supplier owes us N documents"
 * representable at all.
 *
 * Before 0087 a requirement had no supplier dimension whatsoever, so the
 * left-hand side of gap detection (what SHOULD be on file) did not exist and
 * only the right-hand side (what IS on file, via document_requirements) did.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as listGet,
  onRequestPost as attachPost,
} from '../../functions/api/supplier-requirements/index';
import {
  onRequestGet as oneGet,
  onRequestPut as onePut,
  onRequestDelete as oneDelete,
} from '../../functions/api/supplier-requirements/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };

let supplierA: string;
let supplierB: string;
let reqAllergen: string;
let reqNutrition: string;
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

async function list(query: string, as = admin) {
  const res = await listGet({
    request: new Request(`http://localhost/api/supplier-requirements${query}`),
    env,
    data: { user: as },
    params: {},
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function attach(body: Record<string, unknown>, as = admin) {
  const res = await attachPost({
    request: new Request('http://localhost/api/supplier-requirements', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user: as },
    params: {},
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function getOne(id: string, as = admin) {
  const res = await oneGet({
    request: new Request(`http://localhost/api/supplier-requirements/${id}`),
    env,
    data: { user: as },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function setTier(id: string, body: Record<string, unknown>, as = admin) {
  const res = await onePut({
    request: new Request(`http://localhost/api/supplier-requirements/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user: as },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function detach(id: string, as = admin) {
  const res = await oneDelete({
    request: new Request(`http://localhost/api/supplier-requirements/${id}`, {
      method: 'DELETE',
    }),
    env,
    data: { user: as },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin' as const, tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader' as const, tenant_id: seed.tenantId };

  supplierA = await makeSupplier(seed.tenantId, 'Alpha Dairy');
  supplierB = await makeSupplier(seed.tenantId, 'Beta Foods');
  reqAllergen = await makeRequirement(seed.tenantId, 'Allergen Matrix');
  reqNutrition = await makeRequirement(seed.tenantId, '100g Nutritionals');

  foreignSupplier = await makeSupplier(seed.tenantId2, 'Other Corp Supplier');
  foreignRequirement = await makeRequirement(seed.tenantId2, 'Other Corp Line Item');
}, 30_000);

beforeEach(async () => {
  await db.prepare('DELETE FROM supplier_requirements').run();
});

describe('POST /api/supplier-requirements — attach', () => {
  it('attaches a requirement to a supplier, defaulting to tier "required"', async () => {
    const { status, body } = await attach({
      supplier_id: supplierA,
      requirement_id: reqAllergen,
    });
    expect(status).toBe(201);
    expect(body.supplierRequirement.tier).toBe('required');
    expect(body.supplierRequirement.tenant_id).toBe(seed.tenantId);
    expect(body.supplierRequirement.created_by).toBe(seed.orgAdminId);
  });

  it('accepts the recommended tier and rejects anything else', async () => {
    const ok = await attach({
      supplier_id: supplierA,
      requirement_id: reqNutrition,
      tier: 'recommended',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.supplierRequirement.tier).toBe('recommended');

    const bad = await attach({
      supplier_id: supplierB,
      requirement_id: reqNutrition,
      tier: 'nice_to_have',
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/required, recommended/);
  });

  it('re-attaching the same pair converges instead of duplicating', async () => {
    const first = await attach({ supplier_id: supplierA, requirement_id: reqAllergen });
    expect(first.status).toBe(201);

    const again = await attach({
      supplier_id: supplierA,
      requirement_id: reqAllergen,
      tier: 'recommended',
    });
    // 200, not 409: attaching states applicability, and a re-run of a bulk
    // apply-a-checklist call must converge rather than half-fail.
    expect(again.status).toBe(200);
    expect(again.body.supplierRequirement.id).toBe(first.body.supplierRequirement.id);
    expect(again.body.supplierRequirement.tier).toBe('recommended');

    const count = await db
      .prepare(
        'SELECT COUNT(*) AS n FROM supplier_requirements WHERE supplier_id = ? AND requirement_id = ?',
      )
      .bind(supplierA, reqAllergen)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('the DB itself refuses a duplicate (tenant, supplier, requirement)', async () => {
    // The uniqueness guard is a plain UNIQUE and not an expression index
    // because all three key columns are NOT NULL — there is no NULL to make
    // rows compare distinct. This asserts the constraint is really there,
    // independently of the API's own convergence logic.
    await attach({ supplier_id: supplierA, requirement_id: reqAllergen });
    await expect(
      db
        .prepare(
          `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier)
           VALUES (?, ?, ?, ?, 'required')`,
        )
        .bind(`sr-${generateTestId()}`, seed.tenantId, supplierA, reqAllergen)
        .run(),
    ).rejects.toThrow();
  });

  it('rejects a cross-tenant supplier or requirement', async () => {
    const badSupplier = await attach({
      supplier_id: foreignSupplier,
      requirement_id: reqAllergen,
    });
    expect(badSupplier.status).toBe(400);
    expect(String(badSupplier.body.error)).toMatch(/supplier/i);

    const badRequirement = await attach({
      supplier_id: supplierA,
      requirement_id: foreignRequirement,
    });
    expect(badRequirement.status).toBe(400);
    expect(String(badRequirement.body.error)).toMatch(/requirement/i);
  });

  it('requires both ids', async () => {
    expect((await attach({ requirement_id: reqAllergen })).status).toBe(400);
    expect((await attach({ supplier_id: supplierA })).status).toBe(400);
  });

  it('refuses a reader', async () => {
    const { status } = await attach(
      { supplier_id: supplierA, requirement_id: reqAllergen },
      reader as any,
    );
    expect(status).toBe(403);
  });
});

describe('GET /api/supplier-requirements — list', () => {
  beforeEach(async () => {
    await attach({ supplier_id: supplierA, requirement_id: reqAllergen });
    await attach({
      supplier_id: supplierA,
      requirement_id: reqNutrition,
      tier: 'recommended',
    });
    await attach({ supplier_id: supplierB, requirement_id: reqAllergen });
  });

  it('lists what one supplier owes, with the requirement joined in', async () => {
    const { status, body } = await list(`?supplier_id=${supplierA}`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const names = body.supplierRequirements.map((r: any) => r.requirement_name).sort();
    expect(names).toEqual(['100g Nutritionals', 'Allergen Matrix']);
    expect(body.supplierRequirements[0].supplier_name).toBe('Alpha Dairy');
  });

  it('narrows to the "required" tier — the gap-report default', async () => {
    const { body } = await list(`?supplier_id=${supplierA}&tier=required`);
    expect(body.total).toBe(1);
    expect(body.supplierRequirements[0].requirement_name).toBe('Allergen Matrix');
  });

  it('answers the inverse question: which suppliers owe this line item', async () => {
    const { body } = await list(`?requirement_id=${reqAllergen}`);
    expect(body.total).toBe(2);
    expect(body.supplierRequirements.map((r: any) => r.supplier_name).sort()).toEqual([
      'Alpha Dairy',
      'Beta Foods',
    ]);
  });

  it('rejects an unknown tier filter rather than silently returning nothing', async () => {
    const { status } = await list('?tier=urgent');
    expect(status).toBe(400);
  });

  it('never leaks another tenant\'s rows', async () => {
    await db
      .prepare(
        `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier)
         VALUES (?, ?, ?, ?, 'required')`,
      )
      .bind(`sr-${generateTestId()}`, seed.tenantId2, foreignSupplier, foreignRequirement)
      .run();

    const { body } = await list('');
    expect(body.total).toBe(3);
    expect(
      body.supplierRequirements.every((r: any) => r.tenant_id === seed.tenantId),
    ).toBe(true);
  });
});

describe('/api/supplier-requirements/:id — read, retier, detach', () => {
  let rowId: string;

  beforeEach(async () => {
    const { body } = await attach({ supplier_id: supplierA, requirement_id: reqAllergen });
    rowId = body.supplierRequirement.id;
  });

  it('reads one row with both ends joined in', async () => {
    const { status, body } = await getOne(rowId);
    expect(status).toBe(200);
    expect(body.supplierRequirement.requirement_name).toBe('Allergen Matrix');
    expect(body.supplierRequirement.supplier_name).toBe('Alpha Dairy');
  });

  it('changes the tier', async () => {
    const { status, body } = await setTier(rowId, { tier: 'recommended' });
    expect(status).toBe(200);
    expect(body.supplierRequirement.tier).toBe('recommended');
    expect(body.supplierRequirement.updated_by).toBe(seed.orgAdminId);
  });

  it('rejects an invalid tier and an empty body', async () => {
    expect((await setTier(rowId, { tier: 'critical' })).status).toBe(400);
    expect((await setTier(rowId, {})).status).toBe(400);
  });

  it('detaches with a hard delete — no tombstone for the gap query to exclude', async () => {
    expect((await detach(rowId)).status).toBe(200);
    const row = await db
      .prepare('SELECT id FROM supplier_requirements WHERE id = ?')
      .bind(rowId)
      .first();
    expect(row).toBeNull();
    expect((await getOne(rowId)).status).toBe(404);
  });

  it('refuses cross-tenant access and reader writes', async () => {
    const otherAdmin = {
      id: seed.orgAdmin2Id,
      role: 'org_admin' as const,
      tenant_id: seed.tenantId2,
    };
    expect((await getOne(rowId, otherAdmin as any)).status).toBe(403);
    expect((await setTier(rowId, { tier: 'recommended' }, otherAdmin as any)).status).toBe(403);
    expect((await detach(rowId, reader as any)).status).toBe(403);
  });
});

describe('the gap query 0087 unblocks', () => {
  it('subtracts what a supplier CLOSED from what applies to them', async () => {
    // This is the sentence that was structurally unrepresentable before 0087.
    // It joins the new applicability table (left side) against the facet
    // junction wired up in the same change (right side).
    await attach({ supplier_id: supplierA, requirement_id: reqAllergen });
    await attach({ supplier_id: supplierA, requirement_id: reqNutrition });
    await attach({
      supplier_id: supplierA,
      requirement_id: await makeRequirement(seed.tenantId, 'Advisory Only'),
      tier: 'recommended',
    });

    const docId = `doc-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
         VALUES (?, ?, 'COA', 1, 'active', ?, ?)`,
      )
      .bind(docId, seed.tenantId, seed.userId, supplierA)
      .run();
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status)
         VALUES (?, ?, ?, 'confirmed')`,
      )
      .bind(`dr-${generateTestId()}`, docId, reqAllergen)
      .run();

    const open = await db
      .prepare(
        `SELECT r.name
           FROM supplier_requirements sr
           JOIN requirements r ON r.id = sr.requirement_id
          WHERE sr.tenant_id = ? AND sr.supplier_id = ? AND sr.tier = 'required'
            AND NOT EXISTS (
                  SELECT 1 FROM document_requirements dr
                    JOIN documents d ON d.id = dr.document_id
                   WHERE dr.requirement_id = sr.requirement_id
                     AND dr.status = 'confirmed'
                     AND d.supplier_id = sr.supplier_id
                     AND d.status = 'active')
          ORDER BY r.name`,
      )
      .bind(seed.tenantId, supplierA)
      .all<{ name: string }>();

    // Allergen Matrix is closed; Nutritionals is the open gap. The
    // 'recommended' row is excluded by the tier filter, as gap reports default.
    expect(open.results.map((r) => r.name)).toEqual(['100g Nutritionals']);
  });
});
