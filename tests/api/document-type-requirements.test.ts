/**
 * GET /api/document-type-requirements — the READ side of migration 0100.
 *
 * `functions/lib/requirement-defaults.ts` turns these mappings into 'suggested'
 * links, but only once a `documents` row exists — which is at approve time. The
 * setup wizard's last screen has to state the consequence BEFORE anybody
 * approves anything ("approving this will propose three line items"), and the
 * only honest way to do that is to read the mapping. Anything else is a number
 * the screen made up.
 *
 * Two behaviours are worth pinning beyond "it lists rows": the tenant comes off
 * the TYPE rather than off a query parameter (a type belongs to exactly one
 * tenant, so trusting the caller's `tenant_id` would be strictly weaker), and a
 * retired checklist item is excluded — a preview that over-counts is worse than
 * one that under-counts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet } from '../../functions/api/document-type-requirements/index';

const db = env.DB;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };
let otherAdmin: { id: string; role: 'org_admin'; tenant_id: string };

let typeId: string;
let foreignTypeId: string;

async function get(query: string, as: { id: string; role: string; tenant_id: string } = admin) {
  const res = await onRequestGet({
    request: new Request(`http://localhost/api/document-type-requirements${query}`),
    env,
    data: { user: as },
    params: {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function makeType(tenantId: string, name: string): Promise<string> {
  const id = `dt-${generateTestId()}`;
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`)
    .run();
  return id;
}

async function makeRequirement(tenantId: string, name: string, active = 1): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name, active) VALUES (?, ?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name, active)
    .run();
  return id;
}

async function map(tenantId: string, documentTypeId: string, requirementId: string) {
  await db
    .prepare(
      `INSERT INTO document_type_requirements (id, tenant_id, document_type_id, requirement_id, source)
       VALUES (?, ?, ?, ?, 'pack')`,
    )
    .bind(`dtr-${generateTestId()}`, tenantId, documentTypeId, requirementId)
    .run();
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  otherAdmin = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };

  typeId = await makeType(seed.tenantId, 'Specification Sheet');
  foreignTypeId = await makeType(seed.tenantId2, 'Specification Sheet');

  await map(seed.tenantId, typeId, await makeRequirement(seed.tenantId, 'Allergen matrix'));
  await map(seed.tenantId, typeId, await makeRequirement(seed.tenantId, 'Micro limits'));
  // Retired: mapped, but no approval will ever close it.
  await map(seed.tenantId, typeId, await makeRequirement(seed.tenantId, 'Old item', 0));
});

describe('GET /api/document-type-requirements', () => {
  it('lists what a document of this type would be proposed to close', async () => {
    const { status, body } = await get(`?document_type_id=${typeId}`);
    expect(status).toBe(200);
    const names = (body.requirements as unknown as Array<{ requirement_name: string }>).map(
      (r) => r.requirement_name,
    );
    expect(names).toContain('Allergen matrix');
    expect(names).toContain('Micro limits');
  });

  it('excludes a retired checklist item — a preview must not over-count', async () => {
    const { body } = await get(`?document_type_id=${typeId}`);
    const names = (body.requirements as unknown as Array<{ requirement_name: string }>).map(
      (r) => r.requirement_name,
    );
    expect(names).not.toContain('Old item');
    expect(names).toHaveLength(2);
  });

  it('reports an unmapped type as an empty list, not an error', async () => {
    // "Closes nothing" is a real answer and the screen renders it as a
    // configuration gap. A 404 here would be indistinguishable from a failure.
    const bare = await makeType(seed.tenantId, 'Unmapped Type');
    const { status, body } = await get(`?document_type_id=${bare}`);
    expect(status).toBe(200);
    expect(body.requirements).toEqual([]);
  });

  it('takes the tenant off the type, so another tenant’s type is refused', async () => {
    const { status } = await get(`?document_type_id=${foreignTypeId}`);
    expect(status).toBe(403);
    // And the owner of that type can read it without naming a tenant at all.
    expect((await get(`?document_type_id=${foreignTypeId}`, otherAdmin)).status).toBe(200);
  });

  it('requires document_type_id, and refuses a reader', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get(`?document_type_id=${typeId}`, reader)).status).toBe(403);
  });
});
