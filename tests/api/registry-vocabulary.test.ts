/**
 * API tests for the P2 registry vocabulary admin (migration 0080):
 *
 *   /api/requirements     layer-2 vocabulary — what a document SATISFIES
 *   /api/claim-types      layer-3 vocabulary — what a document TRIGGERS
 *   /api/claim-rules      claim -> requirement mapping (the QA manager's
 *                         "conditional triggers", the unlock for P4)
 *
 * Handlers are driven directly with hand-rolled contexts — SELF.fetch is not
 * wired in this project's vitest-pool-workers config (same pattern as
 * documents-registry.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  onRequestGet as reqList,
  onRequestPost as reqCreate,
} from '../../functions/api/requirements/index';
import {
  onRequestGet as reqGet,
  onRequestPut as reqPut,
  onRequestDelete as reqDelete,
} from '../../functions/api/requirements/[id]';
import {
  onRequestGet as claimList,
  onRequestPost as claimCreate,
} from '../../functions/api/claim-types/index';
import {
  onRequestGet as claimGet,
  onRequestPut as claimPut,
  onRequestDelete as claimDelete,
} from '../../functions/api/claim-types/[id]';
import {
  onRequestGet as rulesGet,
  onRequestPut as rulesPut,
} from '../../functions/api/claim-rules/index';
import { requirementsOpenedByClaims } from '../../functions/lib/registry';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

type Role = 'super_admin' | 'org_admin' | 'user' | 'reader';
interface TestUser {
  id: string;
  role: Role;
  tenant_id: string | null;
}

let orgAdmin: TestUser;
let orgAdmin2: TestUser;
let reader: TestUser;
let superAdmin: TestUser;

async function call(
  handler: PagesFunction<any>,
  opts: {
    user: TestUser;
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    params?: Record<string, string>;
  },
) {
  const url = new URL('http://localhost/api/x');
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);
  const init: RequestInit = { method: opts.method || 'GET' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await handler({
    request: new Request(url.toString(), init),
    env,
    data: { user: opts.user },
    params: opts.params || {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/x',
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

/** Create a requirement directly, for fixtures that are not under test. */
async function seedRequirement(tenantId: string, name: string, checklist?: string) {
  const id = `req-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO requirements (id, tenant_id, slug, name, checklist, sort_order, active)
       VALUES (?, ?, ?, ?, ?, 0, 1)`,
    )
    .bind(id, tenantId, `slug-${id}`, name, checklist ?? null)
    .run();
  return id;
}

async function seedClaimType(tenantId: string, name: string) {
  const id = `clm-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO claim_types (id, tenant_id, slug, name, subject_grain, sort_order, active)
       VALUES (?, ?, ?, ?, 'any', 0, 1)`,
    )
    .bind(id, tenantId, `slug-${id}`, name)
    .run();
  return id;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  orgAdmin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  orgAdmin2 = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  superAdmin = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
}, 30_000);

describe('requirements — create', () => {
  it('creates with a slug derived from the name', async () => {
    const res = await call(reqCreate, {
      user: orgAdmin,
      method: 'POST',
      body: { name: 'Allergen Matrix', checklist: 'SOP 102.2' },
    });
    expect(res.status).toBe(201);
    expect(res.body.requirement.slug).toBe('allergen-matrix');
    expect(res.body.requirement.tenant_id).toBe(seed.tenantId);
    expect(res.body.requirement.checklist).toBe('SOP 102.2');
    expect(res.body.requirement.active).toBe(1);
  });

  it('honours an explicit slug (importers and starter packs need stable ids)', async () => {
    const res = await call(reqCreate, {
      user: orgAdmin,
      method: 'POST',
      body: { name: '3rd Party Audit REPORT on file', slug: 'third-party-audit-report' },
    });
    expect(res.status).toBe(201);
    expect(res.body.requirement.slug).toBe('third-party-audit-report');
  });

  it('rejects a duplicate slug within the tenant', async () => {
    const res = await call(reqCreate, {
      user: orgAdmin,
      method: 'POST',
      body: { name: 'Allergen Matrix' },
    });
    expect(res.status).toBe(409);
  });

  it('allows the same slug in a different tenant', async () => {
    const res = await call(reqCreate, {
      user: orgAdmin2,
      method: 'POST',
      body: { name: 'Allergen Matrix' },
    });
    expect(res.status).toBe(201);
    expect(res.body.requirement.tenant_id).toBe(seed.tenantId2);
  });

  it('requires a name', async () => {
    const res = await call(reqCreate, { user: orgAdmin, method: 'POST', body: { name: '  ' } });
    expect(res.status).toBe(400);
  });

  it('denies a reader', async () => {
    const res = await call(reqCreate, { user: reader, method: 'POST', body: { name: 'Nope' } });
    expect(res.status).toBe(403);
  });

  it('makes super_admin name the tenant explicitly', async () => {
    const res = await call(reqCreate, { user: superAdmin, method: 'POST', body: { name: 'Orphan' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenant_id is required/);
  });

  it('lets super_admin create into a named tenant', async () => {
    const res = await call(reqCreate, {
      user: superAdmin,
      method: 'POST',
      body: { name: 'Super Seeded', tenant_id: seed.tenantId },
    });
    expect(res.status).toBe(201);
    expect(res.body.requirement.tenant_id).toBe(seed.tenantId);
  });
});

describe('requirements — list', () => {
  it('returns only the caller tenant rows', async () => {
    const res = await call(reqList, { user: orgAdmin });
    expect(res.status).toBe(200);
    expect(res.body.requirements.length).toBeGreaterThan(0);
    for (const r of res.body.requirements) expect(r.tenant_id).toBe(seed.tenantId);
  });

  it('hides inactive rows by default and shows them with active=0', async () => {
    const id = await seedRequirement(seed.tenantId, 'Retired Item');
    await db.prepare('UPDATE requirements SET active = 0 WHERE id = ?').bind(id).run();

    const active = await call(reqList, { user: orgAdmin });
    expect(active.body.requirements.find((r: any) => r.id === id)).toBeUndefined();

    const inactive = await call(reqList, { user: orgAdmin, query: { active: '0' } });
    expect(inactive.body.requirements.find((r: any) => r.id === id)).toBeDefined();
  });

  it('filters by checklist grouping', async () => {
    await seedRequirement(seed.tenantId, 'Grouped A', 'Group X');
    await seedRequirement(seed.tenantId, 'Grouped B', 'Group X');
    const res = await call(reqList, { user: orgAdmin, query: { checklist: 'Group X' } });
    expect(res.body.requirements.length).toBe(2);
    for (const r of res.body.requirements) expect(r.checklist).toBe('Group X');
  });

  it('reports how many documents satisfy and how many claims require each item', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Counted Item');
    const claimId = await seedClaimType(seed.tenantId, 'Counted Claim');

    const docId = `doc-${generateTestId()}`;
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, created_by, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .bind(docId, seed.tenantId, 'Counted Doc', seed.userId)
      .run();
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id, status)
         VALUES (?, ?, ?, 'confirmed')`,
      )
      .bind(generateTestId(), docId, reqId)
      .run();
    await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [reqId] },
    });

    const res = await call(reqList, { user: orgAdmin });
    const row = res.body.requirements.find((r: any) => r.id === reqId);
    expect(row.document_count).toBe(1);
    expect(row.claim_type_count).toBe(1);
  });
});

describe('requirements — read / update / delete', () => {
  it('blocks reading another tenant row', async () => {
    const otherId = await seedRequirement(seed.tenantId2, 'Other Tenant Item');
    const res = await call(reqGet, { user: orgAdmin, params: { id: otherId } });
    expect(res.status).toBe(403);
  });

  it('404s an unknown id', async () => {
    const res = await call(reqGet, { user: orgAdmin, params: { id: 'nope' } });
    expect(res.status).toBe(404);
  });

  it('renames without changing the slug', async () => {
    const id = await seedRequirement(seed.tenantId, 'Original Name');
    const before = await db.prepare('SELECT slug FROM requirements WHERE id = ?').bind(id).first<any>();
    const res = await call(reqPut, {
      user: orgAdmin,
      method: 'PUT',
      params: { id },
      body: { name: 'Renamed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.requirement.name).toBe('Renamed');
    expect(res.body.requirement.slug).toBe(before!.slug);
  });

  it('rejects a slug change that collides', async () => {
    const a = await seedRequirement(seed.tenantId, 'Collide A');
    const aSlug = (await db.prepare('SELECT slug FROM requirements WHERE id = ?').bind(a).first<any>())!.slug;
    const b = await seedRequirement(seed.tenantId, 'Collide B');
    const res = await call(reqPut, {
      user: orgAdmin,
      method: 'PUT',
      params: { id: b },
      body: { slug: aSlug },
    });
    expect(res.status).toBe(409);
  });

  it('rejects an empty update', async () => {
    const id = await seedRequirement(seed.tenantId, 'No Change');
    const res = await call(reqPut, { user: orgAdmin, method: 'PUT', params: { id }, body: {} });
    expect(res.status).toBe(400);
  });

  it('blocks updating another tenant row', async () => {
    const otherId = await seedRequirement(seed.tenantId2, 'Not Yours');
    const res = await call(reqPut, {
      user: orgAdmin,
      method: 'PUT',
      params: { id: otherId },
      body: { name: 'Hijacked' },
    });
    expect(res.status).toBe(403);
  });

  it('soft-deletes rather than removing the row', async () => {
    const id = await seedRequirement(seed.tenantId, 'To Deactivate');
    const res = await call(reqDelete, { user: orgAdmin, method: 'DELETE', params: { id } });
    expect(res.status).toBe(200);
    const row = await db.prepare('SELECT active FROM requirements WHERE id = ?').bind(id).first<any>();
    expect(row).not.toBeNull();
    expect(row!.active).toBe(0);
  });

  it('denies a reader deleting', async () => {
    const id = await seedRequirement(seed.tenantId, 'Reader Cannot Delete');
    const res = await call(reqDelete, { user: reader, method: 'DELETE', params: { id } });
    expect(res.status).toBe(403);
  });
});

describe('claim types — CRUD', () => {
  it('creates with a subject grain', async () => {
    const res = await call(claimCreate, {
      user: orgAdmin,
      method: 'POST',
      body: { name: 'Organic', subject_grain: 'product' },
    });
    expect(res.status).toBe(201);
    expect(res.body.claimType.slug).toBe('organic');
    expect(res.body.claimType.subject_grain).toBe('product');
  });

  it('defaults the grain to any', async () => {
    const res = await call(claimCreate, { user: orgAdmin, method: 'POST', body: { name: 'Kosher' } });
    expect(res.status).toBe(201);
    expect(res.body.claimType.subject_grain).toBe('any');
  });

  it('rejects an unknown grain', async () => {
    const res = await call(claimCreate, {
      user: orgAdmin,
      method: 'POST',
      body: { name: 'Bad Grain', subject_grain: 'lot' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subject_grain/);
  });

  it('rejects a duplicate slug in the tenant', async () => {
    const res = await call(claimCreate, { user: orgAdmin, method: 'POST', body: { name: 'Organic' } });
    expect(res.status).toBe(409);
  });

  it('denies a reader', async () => {
    const res = await call(claimCreate, { user: reader, method: 'POST', body: { name: 'Nope' } });
    expect(res.status).toBe(403);
  });

  it('lists only the caller tenant rows', async () => {
    await seedClaimType(seed.tenantId2, 'Other Tenant Claim');
    const res = await call(claimList, { user: orgAdmin });
    for (const c of res.body.claimTypes) expect(c.tenant_id).toBe(seed.tenantId);
  });

  it('updates and soft-deletes', async () => {
    const id = await seedClaimType(seed.tenantId, 'Editable Claim');
    const upd = await call(claimPut, {
      user: orgAdmin,
      method: 'PUT',
      params: { id },
      body: { name: 'Edited Claim', subject_grain: 'supplier' },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.claimType.name).toBe('Edited Claim');
    expect(upd.body.claimType.subject_grain).toBe('supplier');

    const del = await call(claimDelete, { user: orgAdmin, method: 'DELETE', params: { id } });
    expect(del.status).toBe(200);
    const row = await db.prepare('SELECT active FROM claim_types WHERE id = ?').bind(id).first<any>();
    expect(row!.active).toBe(0);
  });

  it('blocks cross-tenant access', async () => {
    const otherId = await seedClaimType(seed.tenantId2, 'Foreign Claim');
    expect((await call(claimGet, { user: orgAdmin, params: { id: otherId } })).status).toBe(403);
    expect(
      (await call(claimPut, { user: orgAdmin, method: 'PUT', params: { id: otherId }, body: { name: 'x' } }))
        .status,
    ).toBe(403);
  });
});

describe('claim rules — the claim -> requirement mapping', () => {
  it('saves a rule and reads it back with both names joined in', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Organic Certificate on file', 'Claims');
    const claimId = await seedClaimType(seed.tenantId, 'Organic Claim');

    const put = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [reqId] },
    });
    expect(put.status).toBe(200);
    expect(put.body.rules).toHaveLength(1);
    expect(put.body.rules[0].requirement_name).toBe('Organic Certificate on file');
    expect(put.body.rules[0].claim_type_name).toBe('Organic Claim');
    expect(put.body.rules[0].is_required).toBe(1);
    expect(put.body.rules[0].checklist).toBe('Claims');

    const get = await call(rulesGet, { user: orgAdmin, query: { claim_type_id: claimId } });
    expect(get.body.rules).toHaveLength(1);
  });

  it('accepts full objects with is_required and notes', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Advisory Item');
    const claimId = await seedClaimType(seed.tenantId, 'Advisory Claim');
    const put = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: {
        claim_type_id: claimId,
        requirements: [{ requirement_id: reqId, is_required: 0, notes: 'advisory only' }],
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.rules[0].is_required).toBe(0);
    expect(put.body.rules[0].notes).toBe('advisory only');
  });

  it('replaces the whole set — what you see ticked is what is saved', async () => {
    const a = await seedRequirement(seed.tenantId, 'Rule Req A');
    const b = await seedRequirement(seed.tenantId, 'Rule Req B');
    const claimId = await seedClaimType(seed.tenantId, 'Replacing Claim');

    await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [a, b] },
    });
    const second = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [b] },
    });
    expect(second.body.rules).toHaveLength(1);
    expect(second.body.rules[0].requirement_id).toBe(b);
  });

  it('treats an empty array as "clear the rule"', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Clearable Req');
    const claimId = await seedClaimType(seed.tenantId, 'Clearable Claim');
    await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [reqId] },
    });
    const cleared = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [] },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.rules).toHaveLength(0);
  });

  it('deduplicates a repeated requirement', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Duped Req');
    const claimId = await seedClaimType(seed.tenantId, 'Duped Claim');
    const put = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [reqId, reqId] },
    });
    expect(put.body.rules).toHaveLength(1);
  });

  it('refuses a requirement from another tenant', async () => {
    const foreignReq = await seedRequirement(seed.tenantId2, 'Foreign Req');
    const claimId = await seedClaimType(seed.tenantId, 'Leaky Claim');
    const put = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [foreignReq] },
    });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/Invalid requirement/);
    const rows = await db
      .prepare('SELECT COUNT(*) c FROM claim_type_requirements WHERE claim_type_id = ?')
      .bind(claimId)
      .first<any>();
    expect(rows!.c).toBe(0);
  });

  it('refuses to configure another tenant claim', async () => {
    const foreignClaim = await seedClaimType(seed.tenantId2, 'Foreign Claim For Rules');
    const put = await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: foreignClaim, requirements: [] },
    });
    expect(put.status).toBe(403);
  });

  it('404s an unknown claim and 400s a missing claim_type_id', async () => {
    expect(
      (await call(rulesPut, { user: orgAdmin, method: 'PUT', body: { claim_type_id: 'ghost' } })).status,
    ).toBe(404);
    expect((await call(rulesPut, { user: orgAdmin, method: 'PUT', body: {} })).status).toBe(400);
  });

  it('denies a reader', async () => {
    const claimId = await seedClaimType(seed.tenantId, 'Reader Blocked Claim');
    const put = await call(rulesPut, {
      user: reader,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [] },
    });
    expect(put.status).toBe(403);
  });

  it('makes super_admin name the tenant when listing', async () => {
    const res = await call(rulesGet, { user: superAdmin });
    expect(res.status).toBe(400);
    const scoped = await call(rulesGet, { user: superAdmin, query: { tenant_id: seed.tenantId } });
    expect(scoped.status).toBe(200);
  });

  it('surfaces the rule count on the claim type list', async () => {
    const reqId = await seedRequirement(seed.tenantId, 'Counted Rule Req');
    const claimId = await seedClaimType(seed.tenantId, 'Counted Rule Claim');
    await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: { claim_type_id: claimId, requirements: [reqId] },
    });
    const list = await call(claimList, { user: orgAdmin });
    const row = list.body.claimTypes.find((c: any) => c.id === claimId);
    expect(row.requirement_count).toBe(1);

    const single = await call(claimGet, { user: orgAdmin, params: { id: claimId } });
    expect(single.body.rules).toHaveLength(1);
  });
});

describe('claim rules — feed P4 gap detection', () => {
  it('requirementsOpenedByClaims reads back exactly what the editor saved', async () => {
    const required = await seedRequirement(seed.tenantId, 'Gap Required Req');
    const advisory = await seedRequirement(seed.tenantId, 'Gap Advisory Req');
    const claimId = await seedClaimType(seed.tenantId, 'Gap Claim');

    await call(rulesPut, {
      user: orgAdmin,
      method: 'PUT',
      body: {
        claim_type_id: claimId,
        requirements: [
          { requirement_id: required, is_required: 1 },
          { requirement_id: advisory, is_required: 0 },
        ],
      },
    });

    const requiredOnly = await requirementsOpenedByClaims(db, seed.tenantId, [claimId]);
    expect(requiredOnly).toEqual([required]);

    const all = await requirementsOpenedByClaims(db, seed.tenantId, [claimId], false);
    expect(all.sort()).toEqual([required, advisory].sort());

    // Tenant isolation: the same claim id resolves to nothing for another tenant.
    expect(await requirementsOpenedByClaims(db, seed.tenantId2, [claimId])).toEqual([]);
  });
});
