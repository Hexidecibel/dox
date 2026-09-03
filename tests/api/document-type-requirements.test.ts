/**
 * /api/document-type-requirements — both sides of migration 0100.
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
 *
 * PUT is the writer the setup wizard's teaching screen needed, and it REPLACES
 * a type's whole set. That makes three things load-bearing rather than
 * incidental: a replace really does subtract (the screen's whole lesson is that
 * this mapping is what makes an approved document mean something), a caller can
 * never reach another tenant's checklist through it, and no human write may
 * claim `source = 'pack'` — the column exists to tell the seeder's decisions
 * apart from a person's, and one lying row makes the whole column unusable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestGet, onRequestPut } from '../../functions/api/document-type-requirements/index';

const db = env.DB;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let admin: { id: string; role: 'org_admin'; tenant_id: string };
let reader: { id: string; role: 'reader'; tenant_id: string };
let otherAdmin: { id: string; role: 'org_admin'; tenant_id: string };

let typeId: string;
let foreignTypeId: string;

async function put(
  body: unknown,
  as: { id: string; role: string; tenant_id: string } = admin,
) {
  const res = await onRequestPut({
    request: new Request('http://localhost/api/document-type-requirements', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user: as },
    params: {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function mappedSlugs(documentTypeId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT r.slug AS slug FROM document_type_requirements dtr
         JOIN requirements r ON r.id = dtr.requirement_id
        WHERE dtr.document_type_id = ? ORDER BY r.slug`,
    )
    .bind(documentTypeId)
    .all<{ slug: string }>();
  return (rows.results ?? []).map((r) => r.slug);
}

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

describe('PUT /api/document-type-requirements', () => {
  let putType: string;
  let alpha: string;
  let beta: string;
  let gamma: string;
  let foreignRequirement: string;

  beforeAll(async () => {
    putType = await makeType(seed.tenantId, 'Replaceable Type');
    alpha = await makeRequirement(seed.tenantId, 'Alpha');
    beta = await makeRequirement(seed.tenantId, 'Beta');
    gamma = await makeRequirement(seed.tenantId, 'Gamma');
    foreignRequirement = await makeRequirement(seed.tenantId2, 'Somebody else’s item');
    await map(seed.tenantId, putType, alpha);
  });

  it('replaces the whole set — what is absent is removed, not kept', async () => {
    const { status, body } = await put({
      document_type_id: putType,
      requirement_ids: [beta, gamma],
      source: 'wizard',
    });
    expect(status).toBe(200);
    // Alpha was mapped and is not in the new list, so it is gone. A merge here
    // would leave a box somebody deliberately unticked still proposing itself
    // on every future document of this type.
    expect(await mappedSlugs(putType)).toHaveLength(2);
    expect(body.added).toBe(2);
    expect(body.removed).toBe(1);
    const rows = await db
      .prepare('SELECT source, created_by FROM document_type_requirements WHERE document_type_id = ?')
      .bind(putType)
      .all<{ source: string; created_by: string | null }>();
    for (const row of rows.results ?? []) {
      expect(row.source).toBe('wizard');
      expect(row.created_by).toBe(seed.orgAdminId);
    }
  });

  it('is idempotent, and reports a no-op as one', async () => {
    const { body } = await put({
      document_type_id: putType,
      requirement_ids: [beta, gamma],
      source: 'wizard',
    });
    expect(body.added).toBe(0);
    expect(body.removed).toBe(0);
    expect(await mappedSlugs(putType)).toHaveLength(2);
  });

  it('accepts a repeated id rather than failing the batch on the unique index', async () => {
    const { status } = await put({
      document_type_id: putType,
      requirement_ids: [beta, beta, gamma],
      source: 'wizard',
    });
    expect(status).toBe(200);
    expect(await mappedSlugs(putType)).toHaveLength(2);
  });

  it('audits the diff, not just the new count', async () => {
    await put({ document_type_id: putType, requirement_ids: [alpha], source: 'wizard' });
    const row = await db
      .prepare(
        `SELECT details FROM audit_log
          WHERE action = 'document_type_requirements.replaced' AND resource_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(putType)
      .first<{ details: string }>();
    const details = JSON.parse(row!.details) as {
      before: number;
      after: number;
      added: string[];
      removed: string[];
    };
    expect(details.before).toBe(2);
    expect(details.after).toBe(1);
    expect(details.added).toEqual([alpha]);
    expect(details.removed).toHaveLength(2);
  });

  it('accepts an empty list — "this type closes nothing" is a real answer', async () => {
    // The wizard never sends it (see StepTeach.tsx), but the endpoint must not
    // be the thing that makes a mapping impossible to undo.
    const bare = await makeType(seed.tenantId, 'Cleared Type');
    await map(seed.tenantId, bare, alpha);
    const { status, body } = await put({ document_type_id: bare, requirement_ids: [] });
    expect(status).toBe(200);
    expect(body.removed).toBe(1);
    expect(await mappedSlugs(bare)).toEqual([]);
  });

  it('refuses a requirement belonging to another tenant', async () => {
    // Both foreign keys point at their own tables and neither one checks that
    // the type and the requirement share a tenant, so this rule lives here or
    // nowhere.
    const { status } = await put({
      document_type_id: putType,
      requirement_ids: [alpha, foreignRequirement],
    });
    expect(status).toBe(400);
    // And the rejection is total: the DELETE must not have run on its own.
    expect(await mappedSlugs(putType)).toHaveLength(1);
  });

  it('refuses to let a human write claim the pack made the decision', async () => {
    const { status } = await put({
      document_type_id: putType,
      requirement_ids: [alpha],
      source: 'pack',
    });
    expect(status).toBe(400);
  });

  it('refuses a reader, another tenant’s type, and a missing document_type_id', async () => {
    expect((await put({ document_type_id: putType, requirement_ids: [] }, reader)).status).toBe(403);
    expect((await put({ document_type_id: foreignTypeId, requirement_ids: [] })).status).toBe(403);
    expect((await put({ requirement_ids: [] })).status).toBe(400);
    expect((await put({ document_type_id: putType })).status).toBe(400);
  });
});
