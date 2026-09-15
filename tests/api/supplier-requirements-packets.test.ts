/**
 * Requirement packets from the admin screens, and the worklist of rows that
 * need a person (migration 0112):
 *
 *   GET  /api/supplier-requirements/packets
 *   POST /api/supplier-requirements/apply-packet   (named suppliers, preview first)
 *   POST /api/supplier-requirements/review         (confirm / remove)
 *   GET  /api/supplier-requirements?review=...
 *   POST/PUT /api/supplier-requirements            (a person's write stamps 'human')
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { getStarterPack } from '../../functions/lib/starterPacks.generated';
import { onRequestGet as packetsGet } from '../../functions/api/supplier-requirements/packets';
import { onRequestPost as applyPost } from '../../functions/api/supplier-requirements/apply-packet';
import { onRequestPost as reviewPost } from '../../functions/api/supplier-requirements/review';
import { onRequestGet as listGet, onRequestPost as attachPost } from '../../functions/api/supplier-requirements/index';
import { onRequestPut as updatePut } from '../../functions/api/supplier-requirements/[id]';
import type { BulkApplyPacketResponse, RequirementPacketCatalogResponse } from '../../shared/types';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
type Actor = { id: string; role: string; tenant_id: string | null };
let admin: Actor;
let admin2: Actor;
let reader: Actor;

const req = (slug: string, tenantSlug = 'test-corp') => `req_${tenantSlug}_${slug}`;

async function call(handler: (ctx: never) => Promise<Response>, body: unknown, as: Actor = admin, params = {}) {
  const res = await handler({
    request: new Request('http://localhost/api/x', { method: 'POST', body: JSON.stringify(body) }),
    env,
    data: { user: as },
    params,
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function row(id: string) {
  return db
    .prepare('SELECT id, tier, source, packet_slug, review_flag FROM supplier_requirements WHERE id = ?')
    .bind(id)
    .first<{ id: string; tier: string; source: string | null; packet_slug: string | null; review_flag: string | null }>();
}

async function supplierRows(supplierId: string) {
  const res = await db
    .prepare(
      `SELECT sr.id, r.slug, sr.tier, sr.source, sr.packet_slug FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id WHERE sr.supplier_id = ? ORDER BY r.slug`,
    )
    .bind(supplierId)
    .all<{ id: string; slug: string; tier: string; source: string | null; packet_slug: string | null }>();
  return res.results ?? [];
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  admin2 = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  const pack = getStarterPack('fsqa')!;
  await applyStarterPack(db, pack, seed.tenantId, 'test-corp');
  await applyStarterPack(db, pack, seed.tenantId2, 'other-corp');
});

beforeEach(async () => {
  await db.prepare('DELETE FROM supplier_requirements').run();
  await db.prepare("DELETE FROM audit_log WHERE action LIKE 'supplier_requirement%' OR action = 'requirement_packet.apply'").run();
  await db.prepare('DELETE FROM suppliers').run();
  await db
    .prepare(
      `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES
         ('sup_a', ?, 'Alpha Dairy', 'alpha-dairy'),
         ('sup_b', ?, 'Bravo Butter', 'bravo-butter'),
         ('sup_other', ?, 'Other Tenant Co', 'other-tenant-co')`,
    )
    .bind(seed.tenantId, seed.tenantId, seed.tenantId2)
    .run();
  // Alpha carries the kind of rows the live tenant has: an unconfirmed seed
  // row the packet names (at the wrong tier), an unconfirmed one it does not,
  // and a person's deliberate downgrade.
  await db
    .prepare(
      `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier, source) VALUES
         ('sr_seed_named', ?, 'sup_a', ?, 'recommended', NULL),
         ('sr_seed_other', ?, 'sup_a', ?, 'required', NULL),
         ('sr_human', ?, 'sup_a', ?, 'recommended', 'human')`,
    )
    .bind(
      seed.tenantId, req('haccp-plan'),
      seed.tenantId, req('w9-on-file'),
      seed.tenantId, req('spec-sheet'),
    )
    .run();
});

describe('GET /api/supplier-requirements/packets', () => {
  it('lists the tenant pack\'s packets', async () => {
    const res = await packetsGet({ request: new Request('http://localhost/api/supplier-requirements/packets'), env, data: { user: admin }, params: {} } as never);
    const body = (await res.json()) as RequirementPacketCatalogResponse;
    expect(body.pack).toBe('fsqa');
    expect(body.packets.map((p) => p.slug)).toEqual(['baseline', 'ingredient-supplier', 'chemical-sanitation']);
  });
});

describe('POST /api/supplier-requirements/apply-packet', () => {
  it('previews per supplier and writes nothing on a dry run (the default)', async () => {
    const before = await supplierRows('sup_a');
    const { status, body } = await call(applyPost, { packet: 'ingredient-supplier', supplier_ids: ['sup_a', 'sup_b'] });
    expect(status).toBe(200);
    const res = body as unknown as BulkApplyPacketResponse;
    expect(res.dry_run).toBe(true);
    const alpha = res.suppliers.find((s) => s.supplier_id === 'sup_a')!;
    expect(alpha.lines.find((l) => l.requirement_slug === 'haccp-plan')).toMatchObject({
      action: 'adopt_unconfirmed',
      from_tier: 'recommended',
      tier: 'required',
    });
    expect(alpha.lines.find((l) => l.requirement_slug === 'spec-sheet')).toMatchObject({
      action: 'already_present',
      tier: 'recommended',
      packet_tier: 'required',
      existing_source: 'human',
    });
    expect(alpha.counts.tier_kept_different).toBe(1);
    const bravo = res.suppliers.find((s) => s.supplier_id === 'sup_b')!;
    expect(bravo.counts.add).toBe(15);
    expect(await supplierRows('sup_a')).toEqual(before);
    expect(await supplierRows('sup_b')).toEqual([]);
  });

  it('applies: adds with packet provenance, adopts seed rows, never touches a person\'s row, audits per supplier, and is idempotent', async () => {
    const { body } = await call(applyPost, { packet: 'ingredient-supplier', supplier_ids: ['sup_a', 'sup_b'], dry_run: false });
    expect((body as unknown as BulkApplyPacketResponse).totals).toMatchObject({ add: 15 + 13, adopt_unconfirmed: 1, already_present: 1 });

    expect(await row('sr_human')).toMatchObject({ tier: 'recommended', source: 'human', packet_slug: null });
    expect(await row('sr_seed_named')).toMatchObject({ tier: 'required', source: 'packet', packet_slug: 'ingredient-supplier' });
    expect(await row('sr_seed_other')).toMatchObject({ source: null }); // not named, not replacing
    const bravo = await supplierRows('sup_b');
    expect(bravo).toHaveLength(15);
    expect(bravo.every((r) => r.source === 'packet' && r.packet_slug === 'ingredient-supplier')).toBe(true);

    const audits = await db
      .prepare("SELECT resource_id, details FROM audit_log WHERE action = 'requirement_packet.apply' ORDER BY resource_id")
      .all<{ resource_id: string; details: string }>();
    expect(audits.results.map((a) => a.resource_id)).toEqual(['sup_a', 'sup_b']);
    expect(JSON.parse(audits.results[0].details).adopted_unconfirmed).toEqual([
      { slug: 'haccp-plan', from_tier: 'recommended', tier: 'required' },
    ]);

    const again = await call(applyPost, { packet: 'ingredient-supplier', supplier_ids: ['sup_a', 'sup_b'], dry_run: false });
    expect((again.body as unknown as BulkApplyPacketResponse).totals).toMatchObject({ add: 0, adopt_unconfirmed: 0, remove_unconfirmed: 0 });
    expect(await supplierRows('sup_b')).toHaveLength(15);
    const auditCount = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'requirement_packet.apply'").first<{ n: number }>();
    expect(auditCount?.n).toBe(2);
  });

  it('replace_unconfirmed removes only unconfirmed rows the packet does not name', async () => {
    const { body } = await call(applyPost, {
      packet: 'chemical-sanitation',
      supplier_ids: ['sup_a'],
      replace_unconfirmed: true,
      dry_run: false,
    });
    const res = body as unknown as BulkApplyPacketResponse;
    expect(res.suppliers[0].lines.filter((l) => l.action === 'remove_unconfirmed').map((l) => l.requirement_slug).sort()).toEqual([
      'haccp-plan',
      'w9-on-file',
    ]);
    expect(await row('sr_seed_named')).toBeNull();
    expect(await row('sr_seed_other')).toBeNull();
    expect(await row('sr_human')).toMatchObject({ source: 'human', tier: 'recommended' });
  });

  it('refuses another tenant\'s supplier, an empty list, an unknown packet, and non-admins', async () => {
    expect((await call(applyPost, { packet: 'baseline', supplier_ids: ['sup_a', 'sup_other'] })).status).toBe(400);
    expect((await call(applyPost, { packet: 'baseline', supplier_ids: [] })).status).toBe(400);
    expect((await call(applyPost, { packet: 'baseline' })).status).toBe(400);
    expect((await call(applyPost, { packet: 'nope', supplier_ids: ['sup_a'] })).status).toBe(404);
    expect((await call(applyPost, { packet: 'baseline', supplier_ids: ['sup_a'] }, reader)).status).toBe(403);
  });
});

describe('the worklist', () => {
  async function list(query: string, as: Actor = admin) {
    const res = await listGet({ request: new Request(`http://localhost/api/supplier-requirements?${query}`), env, data: { user: as }, params: {} } as never);
    return (await res.json()) as { supplierRequirements: Array<{ id: string }>; total: number };
  }

  it('filters unconfirmed, flagged, and either', async () => {
    await db.prepare("UPDATE supplier_requirements SET source = 'derived', review_flag = 'not_on_verified_list' WHERE id = 'sr_seed_other'").run();
    expect((await list('review=unconfirmed')).supplierRequirements.map((r) => r.id)).toEqual(['sr_seed_named']);
    expect((await list('review=flagged')).supplierRequirements.map((r) => r.id)).toEqual(['sr_seed_other']);
    expect((await list('review=any')).total).toBe(2);
    expect((await list('source=human')).supplierRequirements.map((r) => r.id)).toEqual(['sr_human']);
    const bad = await listGet({ request: new Request('http://localhost/api/supplier-requirements?review=nope'), env, data: { user: admin }, params: {} } as never);
    expect(bad.status).toBe(400);
  });

  it('confirm stamps human and clears a flag; rows needing no review are skipped', async () => {
    await db.prepare("UPDATE supplier_requirements SET source = 'derived', review_flag = 'not_on_verified_list' WHERE id = 'sr_seed_other'").run();
    const { body } = await call(reviewPost, { action: 'confirm', ids: ['sr_seed_named', 'sr_seed_other', 'sr_human', 'nope'] });
    expect(body).toMatchObject({ action: 'confirm', applied: 2, not_found: ['nope'] });
    expect(await row('sr_seed_named')).toMatchObject({ source: 'human', review_flag: null });
    expect(await row('sr_seed_other')).toMatchObject({ source: 'human', review_flag: null });
    const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supplier_requirement_confirmed'").first<{ n: number }>();
    expect(audits?.n).toBe(2);
    expect((await list('review=any')).total).toBe(0);
  });

  it('remove deletes unconfirmed rows with the whole row in the audit, and refuses a person\'s row', async () => {
    const refused = await call(reviewPost, { action: 'remove', ids: ['sr_seed_named', 'sr_human'] });
    expect(refused.status).toBe(400);
    expect(await row('sr_seed_named')).not.toBeNull();

    const { body } = await call(reviewPost, { action: 'remove', ids: ['sr_seed_named'] });
    expect(body).toMatchObject({ applied: 1 });
    expect(await row('sr_seed_named')).toBeNull();
    const audit = await db
      .prepare("SELECT details FROM audit_log WHERE action = 'supplier_requirement_deleted' AND resource_id = 'sr_seed_named'")
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toMatchObject({ reason: 'worklist_unconfirmed', tier: 'recommended', source: null, supplier_id: 'sup_a' });
  });

  it('cannot reach another tenant\'s rows', async () => {
    const { body } = await call(reviewPost, { action: 'confirm', ids: ['sr_seed_named'] }, admin2);
    expect(body).toMatchObject({ applied: 0, not_found: ['sr_seed_named'] });
    expect(await row('sr_seed_named')).toMatchObject({ source: null });
  });
});

describe('a person\'s write is a person\'s row', () => {
  it('POST stamps source human (new and re-attach), PUT tier stamps human and clears a review flag', async () => {
    const created = await call(attachPost, { supplier_id: 'sup_b', requirement_id: req('w9-on-file'), tier: 'required' });
    expect(created.status).toBe(201);
    const createdId = (created.body as unknown as { supplierRequirement: { id: string } }).supplierRequirement.id;
    expect(await row(createdId)).toMatchObject({ source: 'human' });

    await call(attachPost, { supplier_id: 'sup_a', requirement_id: req('haccp-plan'), tier: 'required' });
    expect(await row('sr_seed_named')).toMatchObject({ source: 'human', tier: 'required' });

    await db.prepare("UPDATE supplier_requirements SET source = 'derived', review_flag = 'not_on_verified_list' WHERE id = 'sr_seed_other'").run();
    const put = await updatePut({
      request: new Request('http://localhost/', { method: 'PUT', body: JSON.stringify({ tier: 'recommended' }) }),
      env,
      data: { user: admin },
      params: { id: 'sr_seed_other' },
    } as never);
    expect(put.status).toBe(200);
    expect(await row('sr_seed_other')).toMatchObject({ source: 'human', tier: 'recommended', review_flag: null });
  });
});
