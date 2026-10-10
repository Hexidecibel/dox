/**
 * Slugs do not change, and a concept is not created twice (decisions C-154..C-157).
 *
 * The three vocabulary routes -- /api/document-types, /api/requirements,
 * /api/claim-types -- now hold the same two rules:
 *
 *   1. a slug is set once, at create. A document-type rename used to re-derive
 *      it (so a renamed type stopped being the row a starter-pack update was
 *      looking for); requirements and claim types had an explicit `slug` field
 *      on PUT that could move it. Both are gone.
 *   2. creating, or renaming into, a name the organisation already uses -- or
 *      one its starter pack lists as another name for something it has -- is a
 *      409 that names the row. An admin may repeat the request with
 *      `allow_duplicate: true`, and that is audited.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS } from '../../functions/lib/starterPacks.generated';
import { onRequestPost as createType } from '../../functions/api/document-types/index';
import { onRequestPut as updateType } from '../../functions/api/document-types/[id]';
import { onRequestGet as typeBySlug } from '../../functions/api/document-types/by-slug';
import { onRequestPost as createRequirement } from '../../functions/api/requirements/index';
import { onRequestPut as updateRequirement } from '../../functions/api/requirements/[id]';
import { onRequestPost as createClaim } from '../../functions/api/claim-types/index';
import { onRequestPut as updateClaim } from '../../functions/api/claim-types/[id]';

const db = env.DB;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let admin: { id: string; role: 'super_admin'; tenant_id: null };

type Handler = (ctx: never) => Response | Promise<Response>;

async function call(handler: Handler, method: string, body: unknown, id?: string, url = 'http://localhost/api/x') {
  const res = await handler({
    request: new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    env,
    data: { user: admin, authMethod: 'jwt' },
    params: id ? { id } : {},
    waitUntil: () => {},
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function lastAudit(action: string) {
  const r = await db
    .prepare('SELECT details FROM audit_log WHERE tenant_id = ? AND action = ? ORDER BY rowid DESC LIMIT 1')
    .bind(tenantId, action)
    .first<{ details: string }>();
  return r ? (JSON.parse(r.details) as Record<string, any>) : null;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
});

beforeEach(async () => {
  tenantId = generateTestId();
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Slug rules ${tenantId}`, `slugs-${tenantId.slice(0, 8)}`)
    .run();
});

describe('a slug is set once', () => {
  it('renaming a document type leaves its slug alone, and everything that reads the slug still finds it', async () => {
    const created = await call(createType, 'POST', { tenant_id: tenantId, name: 'Vendor Form' });
    expect(created.status).toBe(201);
    const id = created.body.documentType.id as string;
    expect(created.body.documentType.slug).toBe('vendor-form');

    const renamed = await call(updateType, 'PUT', { name: 'Supplier Onboarding Form' }, id);
    expect(renamed.status).toBe(200);
    expect(renamed.body.documentType.name).toBe('Supplier Onboarding Form');
    expect(renamed.body.documentType.slug).toBe('vendor-form');

    // The by-slug route (the one a saved link and the worker use) still answers
    // to the slug it was given, under the new name.
    const found = await call(
      typeBySlug as Handler,
      'GET',
      undefined,
      undefined,
      `http://localhost/api/document-types/by-slug?slug=vendor-form&tenant_id=${tenantId}`,
    );
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.body)).toContain('Supplier Onboarding Form');

    // By NAME it answers to the name it has now (and, through the slug, still
    // to the one it was created with).
    for (const name of ['Supplier Onboarding Form', 'supplier onboarding form', 'Vendor Form']) {
      const byName = await call(
        typeBySlug as Handler,
        'GET',
        undefined,
        undefined,
        `http://localhost/api/document-types/by-slug?name=${encodeURIComponent(name)}&tenant_id=${tenantId}`,
      );
      expect(byName.status, name).toBe(200);
      expect(byName.body.documentType.id, name).toBe(id);
    }

    // The old name cannot be given to a NEW type: its slug is still this row's.
    const reuse = await call(createType, 'POST', { tenant_id: tenantId, name: 'Vendor Form' });
    expect(reuse.status).toBe(409);

    const audit = await lastAudit('document_type_updated');
    expect(audit).toMatchObject({ previous_name: 'Vendor Form', slug_unchanged: 'vendor-form' });
  });

  it('a document-type PUT that sends a different slug is told slugs do not change', async () => {
    const created = await call(createType, 'POST', { tenant_id: tenantId, name: 'Vendor Form' });
    const id = created.body.documentType.id as string;
    const moved = await call(updateType, 'PUT', { slug: 'something-else' }, id);
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe('slug_immutable');
    expect(moved.body.error).toMatch(/does not change/);
    // An editor that posts every field, slug included, is not refused.
    const same = await call(updateType, 'PUT', { slug: 'vendor-form', description: 'x' }, id);
    expect(same.status).toBe(200);
  });

  it('requirements and claim types lost the explicit slug field', async () => {
    const req = await call(createRequirement, 'POST', { tenant_id: tenantId, name: 'Form on file', slug: 'form' });
    expect(req.body.requirement.slug).toBe('form');
    const moved = await call(updateRequirement, 'PUT', { slug: 'form-on-file' }, req.body.requirement.id);
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe('slug_immutable');
    const renamed = await call(updateRequirement, 'PUT', { name: 'Vendor form on file', slug: 'form' }, req.body.requirement.id);
    expect(renamed.status).toBe(200);
    expect(renamed.body.requirement.slug).toBe('form');

    const claim = await call(createClaim, 'POST', { tenant_id: tenantId, name: 'Grass Fed' });
    const movedClaim = await call(updateClaim, 'PUT', { slug: 'pasture-raised' }, claim.body.claimType.id);
    expect(movedClaim.status).toBe(400);
    expect(movedClaim.body.code).toBe('slug_immutable');
    const renamedClaim = await call(updateClaim, 'PUT', { name: 'Pasture Raised' }, claim.body.claimType.id);
    expect(renamedClaim.body.claimType.slug).toBe('grass-fed');
  });
});

describe('a concept is not created twice', () => {
  it('refuses a second document type by a differently punctuated name, naming the first', async () => {
    const first = await call(createType, 'POST', { tenant_id: tenantId, name: 'W-9' });
    expect(first.status).toBe(201);
    // "W 9" slugifies to `w-9` too, which the exact-slug check has always caught.
    const same = await call(createType, 'POST', { tenant_id: tenantId, name: 'W 9' });
    expect(same.status).toBe(409);
    // "W9" does not: its slug is `w9`. This is the case the old check missed.
    const twin = await call(createType, 'POST', { tenant_id: tenantId, name: 'W9' });
    expect(twin.status).toBe(409);
    expect(twin.body.code).toBe('duplicate_concept');
    expect(twin.body.duplicate).toMatchObject({ source: 'existing', id: first.body.documentType.id, slug: 'w-9', active: true });
    expect(twin.body.error).toMatch(/already a document type called "W-9"/);
  });

  it('an inactive row still counts, and the refusal says to reactivate it', async () => {
    const first = await call(createRequirement, 'POST', { tenant_id: tenantId, name: 'Recall Plan' });
    await db.prepare('UPDATE requirements SET active = 0 WHERE id = ?').bind(first.body.requirement.id).run();
    const twin = await call(createRequirement, 'POST', { tenant_id: tenantId, name: 'recall-plan!', slug: 'recall-plan-2' });
    expect(twin.status).toBe(409);
    expect(twin.body.duplicate).toMatchObject({ source: 'existing', active: false });
    expect(twin.body.error).toMatch(/switched off/);
  });

  it('an admin may override, and the override is on the audit row', async () => {
    const first = await call(createClaim, 'POST', { tenant_id: tenantId, name: 'Non GMO' });
    const refused = await call(createClaim, 'POST', { tenant_id: tenantId, name: 'NonGMO' });
    expect(refused.status).toBe(409);
    const forced = await call(createClaim, 'POST', { tenant_id: tenantId, name: 'NonGMO', allow_duplicate: true });
    expect(forced.status).toBe(201);
    expect(forced.body.claimType.slug).toBe('nongmo');
    const audit = await lastAudit('claim_type_created');
    expect(audit!.duplicate_override).toMatchObject({ source: 'existing', id: first.body.claimType.id });
  });

  it('renaming INTO another concept is refused the same way, and overridable', async () => {
    const a = await call(createRequirement, 'POST', { tenant_id: tenantId, name: 'Allergen Matrix' });
    const b = await call(createRequirement, 'POST', { tenant_id: tenantId, name: 'Label Review' });
    const refused = await call(updateRequirement, 'PUT', { name: 'allergen matrix' }, b.body.requirement.id);
    expect(refused.status).toBe(409);
    expect(refused.body.duplicate).toMatchObject({ id: a.body.requirement.id });
    // Re-saving its own name, however spelled, is not a rename into anything.
    const self = await call(updateRequirement, 'PUT', { name: 'Label  Review' }, b.body.requirement.id);
    expect(self.status).toBe(200);
    const forced = await call(updateRequirement, 'PUT', { name: 'Allergen matrix', allow_duplicate: true }, b.body.requirement.id);
    expect(forced.status).toBe(200);
    expect(forced.body.requirement.slug).toBe('label-review');
    expect((await lastAudit('requirement_updated'))!.duplicate_override).toMatchObject({ id: a.body.requirement.id });
  });

  it('an organisation with no pack may use any name a pack happens to use', async () => {
    const res = await call(createType, 'POST', { tenant_id: tenantId, name: 'Spec Sheet' });
    expect(res.status).toBe(201);
  });
});

describe('against the organisation\'s starter pack', () => {
  beforeEach(async () => {
    await applyStarterPack(db, STARTER_PACKS.fsqa, tenantId, `slugs-${tenantId.slice(0, 8)}`, seed.superAdminId);
  });

  it('"Spec Sheet" is refused as the pack\'s Specification Sheet', async () => {
    const res = await call(createType, 'POST', { tenant_id: tenantId, name: 'Spec Sheet' });
    expect(res.status).toBe(409);
    expect(res.body.duplicate).toMatchObject({
      source: 'existing',
      slug: 'specification-sheet',
      matched_on: 'pack_alias',
      pack: 'fsqa',
    });
  });

  it('the real duplicate requirement pairs are refused', async () => {
    for (const [name, canonical] of [
      ['Specification Sheet', 'spec-sheet'],
      ['Allergen Statement', 'allergen-matrix'],
      ['Country of Origin Statement', 'country-of-origin'],
    ]) {
      const res = await call(createRequirement, 'POST', { tenant_id: tenantId, name });
      expect(res.status, name).toBe(409);
      expect(res.body.duplicate.slug, name).toBe(canonical);
    }
  });

  it('a pack item the organisation removed can be created again UNDER THE PACK\'S SLUG', async () => {
    // Hard-delete the pack's COA type, as a cleanup script might.
    const coa = await db
      .prepare(`SELECT id FROM document_types WHERE tenant_id = ? AND slug = 'certificate-of-analysis'`)
      .bind(tenantId)
      .first<{ id: string }>();
    await db.prepare('DELETE FROM document_type_extraction_instructions WHERE document_type_id = ?').bind(coa!.id).run();
    await db.prepare('DELETE FROM document_type_requirements WHERE document_type_id = ?').bind(coa!.id).run();
    await db.prepare('DELETE FROM document_types WHERE id = ?').bind(coa!.id).run();

    const refused = await call(createType, 'POST', { tenant_id: tenantId, name: 'COA' });
    expect(refused.status).toBe(409);
    expect(refused.body.duplicate).toMatchObject({ source: 'pack', slug: 'certificate-of-analysis', matched_on: 'alias' });
    expect(refused.body.error).toMatch(/does not have yet/);

    const adopted = await call(createType, 'POST', { tenant_id: tenantId, name: 'COA', adopt_pack_slug: true });
    expect(adopted.status).toBe(201);
    expect(adopted.body.documentType.slug).toBe('certificate-of-analysis');
    expect(adopted.body.documentType.name).toBe('COA');
    expect((await lastAudit('document_type_created'))!.adopted_pack_slug).toBe('certificate-of-analysis');
  });

  it('the pack\'s own name, typed in full, simply IS the pack item', async () => {
    await db.prepare(`DELETE FROM claim_type_requirements WHERE tenant_id = ?`).bind(tenantId).run();
    await db.prepare(`DELETE FROM claim_types WHERE tenant_id = ? AND slug = 'organic'`).bind(tenantId).run();
    const res = await call(createClaim, 'POST', { tenant_id: tenantId, name: 'Organic' });
    expect(res.status).toBe(201);
    expect(res.body.claimType.slug).toBe('organic');
  });
});
