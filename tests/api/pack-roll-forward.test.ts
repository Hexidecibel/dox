/**
 * Rolling a starter pack forward, end to end.
 *
 * The story this file tells once, in order: an organisation is seeded from
 * pack v1; it then does the things organisations do -- edits a row, switches
 * one off, deletes a link, makes a row of its own; a v2 of the pack ships with
 * a changed column, a new item, a removed item and a few traps; the
 * organisation rolls forward. Every outcome in shared/packRollForward.ts is
 * asserted against the DATABASE, not against the plan, and then the same
 * roll-forward is run again and must write nothing at all.
 *
 * v1 is the real fsqa pack. v2 is that pack with the edits below applied in
 * memory -- no pack CONTENT changes ship in this release.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { STARTER_PACKS, type StarterPack } from '../../functions/lib/starterPacks.generated';
import { runPackRollForward, loadPackLedger, currentPackVersion } from '../../functions/lib/pack-roll-forward';
import { onRequestPost as rollForwardRoute } from '../../functions/api/starter-packs/roll-forward';
import { onRequestGet as statusRoute } from '../../functions/api/starter-packs/status';
import { packFieldDiff } from '../../shared/packRollForward';
import { packItems } from '../../shared/packItems';
import { defaultSharingRuleForTypeName } from '../../shared/sharingRule';
import type { PackRollForwardResponse } from '../../shared/types';

const db = env.DB;
const v1: StarterPack = STARTER_PACKS.fsqa;

let seed: Awaited<ReturnType<typeof seedTestData>>;
let tenantId: string;
let tenantSlug: string;
let v2: StarterPack;

/** Ids of the organisation's rows, looked up by slug the way everything now does. */
async function idOf(table: string, slug: string): Promise<string> {
  const row = await db
    .prepare(`SELECT id FROM ${table} WHERE tenant_id = ? AND slug = ?`)
    .bind(tenantId, slug)
    .first<{ id: string }>();
  if (!row) throw new Error(`no ${table} row for ${slug}`);
  return row.id;
}

async function row<T = Record<string, unknown>>(table: string, slug: string): Promise<T | null> {
  return db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ? AND slug = ?`).bind(tenantId, slug).first<T>();
}

async function ledgerOf(kind: string, key: string) {
  return db
    .prepare(`SELECT * FROM pack_applied_items WHERE tenant_id = ? AND pack = 'fsqa' AND kind = ? AND item_key = ?`)
    .bind(tenantId, kind, key)
    .first<{ row_id: string | null; pack_version: number; written: string; differing: string; state: string }>();
}

/** Everything a roll-forward could touch, as one comparable string. */
async function snapshot(): Promise<string> {
  const tables = [
    'owner_labels',
    'document_types',
    'requirements',
    'claim_types',
    'claim_type_requirements',
    'document_type_requirements',
    'document_type_extraction_instructions',
    'spec_tests',
    'spec_limits',
    'tenant_modules',
    'pack_applied_items',
    'tenant_packs',
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const res = await db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?`).bind(tenantId).all();
    const rows = (res.results ?? []).map((r) => JSON.stringify(r)).sort();
    parts.push(`${table}:${rows.length}\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function auditCount(action: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = ?')
    .bind(tenantId, action)
    .first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/**
 * A dry run, or an apply OF A PREVIEW: an apply is refused without the
 * fingerprint of the plan that was read, so the helper reads it first, exactly
 * as the screen does.
 */
async function roll(pack: StarterPack, opts: { dryRun: boolean; accept?: Array<{ kind: string; key: string; field?: string }> }) {
  const base = { tenantId, tenantSlug, pack, actorId: seed.superAdminId, ip: null };
  if (opts.dryRun) return runPackRollForward(db, { ...base, dryRun: true, accept: opts.accept ?? [] });
  const preview = await runPackRollForward(db, { ...base, dryRun: true, accept: [] });
  return runPackRollForward(db, {
    ...base,
    dryRun: false,
    accept: opts.accept ?? [],
    fingerprint: preview.plan_fingerprint,
  });
}

const find = (res: PackRollForwardResponse, kind: string, key: string) =>
  res.items.find((i) => i.kind === kind && i.key === key);

// The pieces of the real pack the story leans on, checked before anything runs
// so a later pack edit fails HERE with a reason rather than three screens down.
const limitTest = v1.spec_tests.find((t) => t.limit && t.limit.value_max !== null)!;
const LOOSENED = 'process-flow-diagram';
const TIGHTENED = 'allergen-statement';
const OWNER_MOVED = 'product-label';

function buildV2(): StarterPack {
  const p: StarterPack = structuredClone(v1);
  p.version = 2;
  const req = (slug: string) => p.requirements.find((r) => r.slug === slug)!;
  const dt = (slug: string) => p.document_types.find((d) => d.slug === slug)!;

  // (a) a column changed on a row nobody touched
  req('pack-size').description = 'v2: pack size and case configuration, per SKU.';
  // (b) two columns changed on a row whose DESCRIPTION the organisation edited
  req('gtin').description = 'v2: the GTIN-14 of the case.';
  req('gtin').checklist = 'Commercial & Legal';
  // (c) a column changed on a row the organisation switched off
  req('shelf-life').description = 'v2: shelf life from the date of manufacture.';
  // (d) a new item, a new type that closes it, and a new link from an old type
  p.requirements.push({
    name: 'Supplier Questionnaire on file',
    slug: 'supplier-questionnaire',
    aliases: [],
    description: 'A completed supplier questionnaire.',
    checklist: 'Commercial & Legal',
    sort_order: 9000,
    scope: 'supplier',
  });
  p.document_types.push({
    name: 'Supplier Questionnaire',
    slug: 'supplier-questionnaire',
    aliases: [],
    description: 'The questionnaire a new supplier fills in.',
    sort_order: 9000,
    owner: 'QA',
    closes: ['supplier-questionnaire'],
    extraction_instructions: null,
  });
  // (e) a new item whose SLUG a hand-made row already holds
  p.requirements.push({
    name: 'Traceability Exercise on file',
    slug: 'traceability-exercise',
    aliases: [],
    description: 'The most recent mock recall.',
    checklist: 'Food Safety Plans & Programs',
    sort_order: 9010,
    scope: 'supplier',
  });
  // (f) a new item the organisation already has under ANOTHER slug (by alias)
  p.requirements.push({
    name: 'Lot Coding Explanation on file',
    slug: 'lot-code-key',
    aliases: ['Lot Code Key'],
    description: 'How to read the supplier lot code.',
    checklist: 'Product Specification',
    sort_order: 9020,
    scope: 'supplier',
  });
  // (g) an item removed from the pack, with the rules that named it
  p.claim_types = p.claim_types.filter((c) => c.slug !== 'made-in-usa');
  p.claim_rules = p.claim_rules.filter((r) => r.claim !== 'made-in-usa');
  // (h) a threshold moved
  const test = p.spec_tests.find((t) => t.slug === limitTest.slug)!;
  test.limit!.value_max = Number(limitTest.limit!.value_max) + 5;
  // (i) a rename that would LOOSEN the sharing rule, and one that tightens it
  dt(LOOSENED).name = 'Process Allergen Statement';
  dt(TIGHTENED).name = 'Allergen Control Program';
  // (j) a default owner moved on a type whose description the organisation edited
  dt(OWNER_MOVED).owner = 'Food Safety';
  return p;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  tenantId = generateTestId();
  tenantSlug = `roll-${tenantId.slice(0, 8)}`;
  await db
    .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
    .bind(tenantId, `Roll forward ${tenantSlug}`, tenantSlug)
    .run();
  v2 = buildV2();
});

describe('the story: v1, the organisation lives in it, v2 arrives', () => {
  it('the fixtures mean what the story says they mean', () => {
    expect(limitTest).toBeTruthy();
    expect(defaultSharingRuleForTypeName(v1.document_types.find((d) => d.slug === LOOSENED)!.name)).toBe('qa');
    expect(defaultSharingRuleForTypeName('Process Allergen Statement')).toBe('free');
    expect(defaultSharingRuleForTypeName(v1.document_types.find((d) => d.slug === TIGHTENED)!.name)).toBe('free');
    expect(defaultSharingRuleForTypeName('Allergen Control Program')).toBe('qa');
    expect(v1.document_types.find((d) => d.slug === OWNER_MOVED)!.owner).not.toBe('Food Safety');
    expect(v1.document_types.find((d) => d.slug === 'specification-sheet')!.closes).toContain('micro-limits');
    expect(v1.owner_labels.map((o) => o.label)).toContain('Food Safety');
  });

  it('v1 is applied: every item is ledgered as the pack\'s, at version 1', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(1);

    const ledger = await loadPackLedger(db, tenantId, 'fsqa');
    expect(ledger).toHaveLength(packItems(v1).length);
    expect(ledger.every((e) => e.state === 'pack' && e.pack_version === 1)).toBe(true);
    expect(ledger.every((e) => Object.keys(e.differing).length === 0)).toBe(true);
    // `written` is exactly what the pack writes.
    const item = packItems(v1).find((i) => i.kind === 'requirement' && i.key === 'gtin')!;
    expect(ledger.find((e) => e.kind === 'requirement' && e.item_key === 'gtin')!.written).toEqual(item.fields);
  });

  it('applying again changes nothing, and reports zero', async () => {
    const before = await snapshot();
    const again = await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    expect(again.inserted).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it('the organisation lives in it', async () => {
    // edits one row
    await db
      .prepare(`UPDATE requirements SET description = 'OUR wording for the GTIN' WHERE tenant_id = ? AND slug = 'gtin'`)
      .bind(tenantId)
      .run();
    await db
      .prepare(`UPDATE document_types SET description = 'OUR label notes' WHERE tenant_id = ? AND slug = ?`)
      .bind(tenantId, OWNER_MOVED)
      .run();
    // switches one off
    await db
      .prepare(`UPDATE requirements SET active = 0 WHERE tenant_id = ? AND slug = 'shelf-life'`)
      .bind(tenantId)
      .run();
    // hard-deletes one link
    const del = await db
      .prepare(`DELETE FROM document_type_requirements WHERE tenant_id = ? AND document_type_id = ? AND requirement_id = ?`)
      .bind(tenantId, await idOf('document_types', 'specification-sheet'), await idOf('requirements', 'micro-limits'))
      .run();
    expect(del.meta.changes).toBe(1);
    // makes two rows of its own: one under a slug v2 will use, one that is a
    // v2 item by another name
    await db
      .prepare(
        `INSERT INTO requirements (id, tenant_id, slug, name, description, checklist, sort_order, scope)
         VALUES (?, ?, 'traceability-exercise', 'Mock recall (ours)', 'made by hand', 'Ours', 5, 'supplier')`,
      )
      .bind(generateTestId(), tenantId)
      .run();
    await db
      .prepare(
        `INSERT INTO requirements (id, tenant_id, slug, name, sort_order, scope)
         VALUES (?, ?, 'our-lot-code-key', 'Lot Code Key', 6, 'supplier')`,
      )
      .bind(generateTestId(), tenantId)
      .run();
  });

  it('re-applying v1 does NOT put back the link the organisation deleted', async () => {
    await applyStarterPack(db, v1, tenantId, tenantSlug, seed.superAdminId);
    const link = await db
      .prepare(`SELECT id FROM document_type_requirements WHERE tenant_id = ? AND document_type_id = ? AND requirement_id = ?`)
      .bind(tenantId, await idOf('document_types', 'specification-sheet'), await idOf('requirements', 'micro-limits'))
      .first();
    expect(link).toBeNull();
  });

  let preview: PackRollForwardResponse;

  it('the dry run writes nothing and says everything', async () => {
    const before = await snapshot();
    preview = await roll(v2, { dryRun: true });
    expect(await snapshot()).toBe(before);
    expect(await auditCount('starter_pack.roll_forward')).toBe(0);

    expect(preview.dry_run).toBe(true);
    expect(preview.from_version).toBe(1);
    expect(preview.to_version).toBe(2);
    expect(preview.up_to_date).toBe(false);

    // (a) untouched row, changed column
    const packSize = find(preview, 'requirement', 'pack-size')!;
    expect(packSize.outcome).toBe('update');
    expect(packSize.fields).toEqual([
      {
        field: 'description',
        action: 'update',
        reason: 'pack_wrote',
        base: v1.requirements.find((r) => r.slug === 'pack-size')!.description,
        current: v1.requirements.find((r) => r.slug === 'pack-size')!.description,
        target: 'v2: pack size and case configuration, per SKU.',
      },
    ]);

    // (b) PER COLUMN: the edited description is kept with both values on show,
    // and the checklist the organisation never touched still moves.
    const gtin = find(preview, 'requirement', 'gtin')!;
    const byField = Object.fromEntries(gtin.fields.map((f) => [f.field, f]));
    expect(byField.description).toMatchObject({
      action: 'keep',
      reason: 'edited',
      current: 'OUR wording for the GTIN',
      target: 'v2: the GTIN-14 of the case.',
    });
    expect(byField.description.base).toBe(v1.requirements.find((r) => r.slug === 'gtin')!.description);
    expect(byField.checklist).toMatchObject({ action: 'update', target: 'Commercial & Legal' });

    // (c) switched off: stays off, untouched
    expect(find(preview, 'requirement', 'shelf-life')).toMatchObject({ outcome: 'inactive', news: true, fields: [] });
    // the deleted link: stays gone
    expect(find(preview, 'type_requirement', 'specification-sheet__micro-limits')).toMatchObject({
      outcome: 'deleted',
      news: true,
    });
    // (d) new items
    expect(find(preview, 'requirement', 'supplier-questionnaire')!.outcome).toBe('insert');
    expect(find(preview, 'document_type', 'supplier-questionnaire')!.outcome).toBe('insert');
    expect(find(preview, 'type_requirement', 'supplier-questionnaire__supplier-questionnaire')!.outcome).toBe('insert');
    // (e) the slug is taken by a hand-made row: adopted, with what differs
    const adopted = find(preview, 'requirement', 'traceability-exercise')!;
    expect(adopted.outcome).toBe('adopt');
    expect(adopted.fields.map((f) => f.field).sort()).toEqual(['checklist', 'description', 'name', 'sort_order']);
    expect(adopted.fields.every((f) => f.action === 'keep' && f.reason === 'unknown')).toBe(true);
    // (f) the same concept under another slug: a conflict naming the row
    expect(find(preview, 'requirement', 'lot-code-key')).toMatchObject({
      outcome: 'conflict',
      conflict: { slug: 'our-lot-code-key', name: 'Lot Code Key', active: true },
    });
    // (g) removed from the pack: flagged
    expect(find(preview, 'claim_type', 'made-in-usa')).toMatchObject({ outcome: 'removed_from_pack', news: true });
    // (h) the threshold
    const limit = find(preview, 'spec_limit', limitTest.slug)!;
    expect(limit.fields).toEqual([
      expect.objectContaining({ field: 'value_max', action: 'update', target: Number(limitTest.limit!.value_max) + 5 }),
    ]);
    // (i) a looser rule needs a person; the rename itself is the pack's to make
    const loosened = Object.fromEntries(find(preview, 'document_type', LOOSENED)!.fields.map((f) => [f.field, f]));
    expect(loosened.name).toMatchObject({ action: 'update', target: 'Process Allergen Statement' });
    expect(loosened.sharing_rule).toMatchObject({ action: 'needs_person', reason: 'loosens', current: 'qa', target: 'free' });
    const tightened = Object.fromEntries(find(preview, 'document_type', TIGHTENED)!.fields.map((f) => [f.field, f]));
    expect(tightened.sharing_rule).toMatchObject({ action: 'update', current: 'free', target: 'qa' });
    // (j) the owner moves; the organisation's description is its own and the
    // pack has nothing new to say about it
    const owner = Object.fromEntries(find(preview, 'document_type', OWNER_MOVED)!.fields.map((f) => [f.field, f]));
    expect(owner.default_owner).toMatchObject({ action: 'update', target: 'Food Safety' });
    expect(owner.description).toMatchObject({ action: 'customised', reason: 'edited', current: 'OUR label notes' });

    expect(preview.summary.conflicts).toBe(1);
    expect(preview.summary.needs_person).toBe(1);
    expect(preview.summary.removed_from_pack).toBeGreaterThanOrEqual(1);
  });

  it('the apply does exactly that, in the database', async () => {
    const limitBefore = await db
      .prepare(
        `SELECT l.* FROM spec_limits l JOIN spec_tests t ON t.id = l.spec_test_id
          WHERE l.tenant_id = ? AND t.name = ? AND l.supplier_id IS NULL`,
      )
      .bind(tenantId, limitTest.name)
      .first<{ id: string; version: number; value_max: number }>();
    const slugsBefore = await db
      .prepare(
        `SELECT 'dt' AS k, id, slug FROM document_types WHERE tenant_id = ?1
         UNION ALL SELECT 'req', id, slug FROM requirements WHERE tenant_id = ?1
         UNION ALL SELECT 'clm', id, slug FROM claim_types WHERE tenant_id = ?1`,
      )
      .bind(tenantId)
      .all<{ k: string; id: string; slug: string }>();

    const applied = await roll(v2, { dryRun: false });
    expect(applied.dry_run).toBe(false);
    expect(applied.not_applied).toEqual([]);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(2);

    // (a) updated
    expect((await row<{ description: string }>('requirements', 'pack-size'))!.description).toBe(
      'v2: pack size and case configuration, per SKU.',
    );
    expect(await ledgerOf('requirement', 'pack-size')).toMatchObject({ pack_version: 2, state: 'pack', differing: '{}' });

    // (b) kept where edited, moved where not
    const gtin = (await row<{ description: string; checklist: string }>('requirements', 'gtin'))!;
    expect(gtin.description).toBe('OUR wording for the GTIN');
    expect(gtin.checklist).toBe('Commercial & Legal');
    const gtinLedger = (await ledgerOf('requirement', 'gtin'))!;
    expect(gtinLedger.state).toBe('differs');
    expect(JSON.parse(gtinLedger.differing)).toEqual({ description: 'edited' });

    // (c) switched off: nothing about the row moved
    const shelf = (await row<{ description: string; active: number }>('requirements', 'shelf-life'))!;
    expect(shelf.active).toBe(0);
    expect(shelf.description).toBe(v1.requirements.find((r) => r.slug === 'shelf-life')!.description);
    // ...and its ledger still holds what v1 wrote, so the comparison is right
    // on the day it is switched back on.
    expect(await ledgerOf('requirement', 'shelf-life')).toMatchObject({ state: 'inactive', pack_version: 1 });

    // the deleted link stays gone, and the ledger says the organisation removed it
    const link = await db
      .prepare(`SELECT id FROM document_type_requirements WHERE tenant_id = ? AND document_type_id = ? AND requirement_id = ?`)
      .bind(tenantId, await idOf('document_types', 'specification-sheet'), await idOf('requirements', 'micro-limits'))
      .first();
    expect(link).toBeNull();
    expect(await ledgerOf('type_requirement', 'specification-sheet__micro-limits')).toMatchObject({
      state: 'deleted',
      row_id: null,
    });

    // (d) inserted, link and all
    const newReq = await idOf('requirements', 'supplier-questionnaire');
    const newType = await idOf('document_types', 'supplier-questionnaire');
    const newLink = await db
      .prepare(`SELECT source FROM document_type_requirements WHERE tenant_id = ? AND document_type_id = ? AND requirement_id = ?`)
      .bind(tenantId, newType, newReq)
      .first<{ source: string }>();
    expect(newLink?.source).toBe('pack');
    expect(await ledgerOf('requirement', 'supplier-questionnaire')).toMatchObject({ state: 'pack', pack_version: 2, row_id: newReq });

    // (e) adopted: ONE row for the slug, still the organisation's own
    const adopted = await db
      .prepare(`SELECT id, name, description FROM requirements WHERE tenant_id = ? AND slug = 'traceability-exercise'`)
      .bind(tenantId)
      .all<{ id: string; name: string; description: string }>();
    expect(adopted.results).toHaveLength(1);
    expect(adopted.results[0].name).toBe('Mock recall (ours)');
    const adoptedLedger = (await ledgerOf('requirement', 'traceability-exercise'))!;
    expect(adoptedLedger.row_id).toBe(adopted.results[0].id);
    expect(adoptedLedger.state).toBe('differs');
    // The JavaScript comparison and the SQL one in the appliers are the same rule.
    const adoptedItem = packItems(v2).find((i) => i.kind === 'requirement' && i.key === 'traceability-exercise')!;
    expect(JSON.parse(adoptedLedger.differing)).toEqual(
      packFieldDiff(adoptedItem.fields, {
        name: 'Mock recall (ours)',
        description: 'made by hand',
        checklist: 'Ours',
        sort_order: 5,
        scope: 'supplier',
      }),
    );

    // (f) the conflict was not settled for the organisation
    expect(await row('requirements', 'lot-code-key')).toBeNull();
    expect(await ledgerOf('requirement', 'lot-code-key')).toBeNull();

    // (g) flagged, and the row is exactly where it was
    const removed = (await row<{ active: number }>('claim_types', 'made-in-usa'))!;
    expect(removed.active).toBe(1);
    expect((await ledgerOf('claim_type', 'made-in-usa'))!.state).toBe('removed_from_pack');
    const removedRules = await db
      .prepare(`SELECT COUNT(*) AS n FROM claim_type_requirements WHERE tenant_id = ? AND claim_type_id = ?`)
      .bind(tenantId, await idOf('claim_types', 'made-in-usa'))
      .first<{ n: number }>();
    expect(removedRules!.n).toBe(v1.claim_rules.filter((r) => r.claim === 'made-in-usa').reduce((n, r) => n + r.requires.length + r.recommends.length, 0));

    // (h) the threshold moved THROUGH THE VERSION RULE: version + 1, audited
    const limitAfter = await db
      .prepare('SELECT version, value_max FROM spec_limits WHERE id = ?')
      .bind(limitBefore!.id)
      .first<{ version: number; value_max: number }>();
    expect(limitAfter!.value_max).toBe(Number(limitTest.limit!.value_max) + 5);
    expect(limitAfter!.version).toBe(limitBefore!.version + 1);
    const limitAudit = await db
      .prepare(`SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'spec_limit.updated' AND resource_id = ?`)
      .bind(tenantId, limitBefore!.id)
      .first<{ details: string }>();
    expect(JSON.parse(limitAudit!.details)).toMatchObject({ via: 'pack_roll_forward', version_bumped: true });

    // (i) renamed, but NOT loosened; the other one tightened, with its audit row
    const loosened = (await row<{ name: string; sharing_rule: string }>('document_types', LOOSENED))!;
    expect(loosened.name).toBe('Process Allergen Statement');
    expect(loosened.sharing_rule).toBe('qa');
    const tightened = (await row<{ id: string; name: string; sharing_rule: string }>('document_types', TIGHTENED))!;
    expect(tightened.name).toBe('Allergen Control Program');
    expect(tightened.sharing_rule).toBe('qa');
    const ruleAudit = await db
      .prepare(
        `SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'document_type.sharing_rule_updated' AND resource_id = ?`,
      )
      .bind(tenantId, tightened.id)
      .first<{ details: string }>();
    expect(JSON.parse(ruleAudit!.details)).toMatchObject({ via: 'pack_roll_forward', sharing_rule: 'qa', previous_sharing_rule: 'free' });

    // (j) per column again
    const label = (await row<{ default_owner: string; description: string }>('document_types', OWNER_MOVED))!;
    expect(label.default_owner).toBe('Food Safety');
    expect(label.description).toBe('OUR label notes');

    // NEVER A SLUG: every row that existed still has the slug it had.
    const slugsAfter = await db
      .prepare(
        `SELECT 'dt' AS k, id, slug FROM document_types WHERE tenant_id = ?1
         UNION ALL SELECT 'req', id, slug FROM requirements WHERE tenant_id = ?1
         UNION ALL SELECT 'clm', id, slug FROM claim_types WHERE tenant_id = ?1`,
      )
      .bind(tenantId)
      .all<{ k: string; id: string; slug: string }>();
    const after = new Map(slugsAfter.results.map((r) => [`${r.k}:${r.id}`, r.slug]));
    for (const r of slugsBefore.results) expect(after.get(`${r.k}:${r.id}`)).toBe(r.slug);

    // One audit row, carrying the whole plan.
    expect(await auditCount('starter_pack.roll_forward')).toBe(1);
    const audit = await db
      .prepare(`SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'starter_pack.roll_forward'`)
      .bind(tenantId)
      .first<{ details: string }>();
    const details = JSON.parse(audit!.details) as { from_version: number; to_version: number; plan: unknown[] };
    expect(details).toMatchObject({ pack: 'fsqa', from_version: 1, to_version: 2 });
    expect(details.plan.length).toBe(preview.items.length);
  });

  it('a second roll-forward is a no-op: nothing written, nothing audited', async () => {
    const before = await snapshot();
    const again = await roll(v2, { dryRun: false });
    expect(again.up_to_date).toBe(true);
    expect(again.summary.writes).toBe(0);
    expect(again.not_applied).toEqual([]);
    expect(await snapshot()).toBe(before);
    expect(await auditCount('starter_pack.roll_forward')).toBe(1);

    // What is still open is still SAID -- a no-op is not silence.
    expect(find(again, 'requirement', 'lot-code-key')!.outcome).toBe('conflict');
    expect(find(again, 'document_type', LOOSENED)!.fields.find((f) => f.field === 'sharing_rule')).toMatchObject({
      action: 'needs_person',
    });
    // ...and what was already recorded is listed as no longer news.
    expect(find(again, 'claim_type', 'made-in-usa')).toMatchObject({ outcome: 'removed_from_pack', news: false });
    expect(find(again, 'requirement', 'shelf-life')).toMatchObject({ outcome: 'inactive', news: false });
    // The kept description is now simply the organisation's own.
    expect(find(again, 'requirement', 'gtin')!.fields).toEqual([
      expect.objectContaining({ field: 'description', action: 'customised' }),
    ]);
  });

  it('re-applying the pack still does not resurrect what the organisation removed', async () => {
    const before = await snapshot();
    const res = await applyStarterPack(db, v2, tenantId, tenantSlug, seed.superAdminId);
    // The one thing an apply may add is the conflicting item nobody settled:
    // it is not in the ledger, and apply is additive. Everything else holds.
    expect(res.counts.document_type_requirements).toBe(0);
    expect(res.counts.claim_types).toBe(0);
    expect(res.inserted).toBe(1);
    await db.prepare(`DELETE FROM requirements WHERE tenant_id = ? AND slug = 'lot-code-key'`).bind(tenantId).run();
    await db
      .prepare(`DELETE FROM pack_applied_items WHERE tenant_id = ? AND kind = 'requirement' AND item_key = 'lot-code-key'`)
      .bind(tenantId)
      .run();
    expect(await snapshot()).toBe(before);
  });

  it('a NEWER version does not come in through apply: nothing is written, and the route says where to go', async () => {
    const v3: StarterPack = structuredClone(v2);
    v3.version = 3;
    v3.requirements.push({
      name: 'Only in version three',
      slug: 'only-in-v3',
      aliases: [],
      description: null,
      checklist: 'Commercial & Legal',
      sort_order: 9100,
      scope: 'supplier',
    });
    const before = await snapshot();
    await expect(applyStarterPack(db, v3, tenantId, tenantSlug, seed.superAdminId)).rejects.toMatchObject({
      code: 'roll_forward_required',
    });
    expect(await snapshot()).toBe(before);
    expect(await currentPackVersion(db, tenantId, 'fsqa')).toBe(2);
  });

  it('a person accepts the pack\'s value for one kept column, and settles the conflict', async () => {
    const res = await roll(v2, {
      dryRun: false,
      accept: [
        { kind: 'requirement', key: 'gtin', field: 'description' },
        { kind: 'requirement', key: 'lot-code-key' },
        // Accepting a looser sharing rule changes nothing: it is not this route's to give.
        { kind: 'document_type', key: LOOSENED },
      ],
    });
    expect(res.not_applied).toEqual([]);
    expect((await row<{ description: string }>('requirements', 'gtin'))!.description).toBe('v2: the GTIN-14 of the case.');
    expect(await ledgerOf('requirement', 'gtin')).toMatchObject({ state: 'pack', differing: '{}' });
    expect(await row('requirements', 'lot-code-key')).not.toBeNull();
    expect((await row<{ sharing_rule: string }>('document_types', LOOSENED))!.sharing_rule).toBe('qa');
    expect(await auditCount('starter_pack.roll_forward')).toBe(2);
  });

  it('a row edited between the preview and the apply wins', async () => {
    // v3 changes one column; somebody edits that column after the plan is made.
    const v3: StarterPack = structuredClone(v2);
    v3.version = 3;
    v3.requirements.find((r) => r.slug === 'pack-size')!.description = 'v3 wording';
    const plan = await roll(v3, { dryRun: true });
    expect(find(plan, 'requirement', 'pack-size')!.outcome).toBe('update');

    // The guard is in SQL, so the race is staged at the statement. The helper
    // previews first (batch 1, a read); the apply then reads the rows again
    // (batch 2) and finds the plan unchanged; the edit lands just before batch
    // 3, which is the UPDATEs planned from that read.
    const original = db.batch.bind(db);
    const patched = db as unknown as { batch: typeof db.batch };
    let calls = 0;
    patched.batch = (async (stmts: D1PreparedStatement[]) => {
      calls += 1;
      if (calls === 3) {
        await db
          .prepare(`UPDATE requirements SET description = 'edited in between' WHERE tenant_id = ? AND slug = 'pack-size'`)
          .bind(tenantId)
          .run();
      }
      return original(stmts);
    }) as typeof db.batch;
    let res: PackRollForwardResponse;
    try {
      res = await roll(v3, { dryRun: false });
    } finally {
      patched.batch = original;
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(res.not_applied).toEqual([
      expect.objectContaining({ kind: 'requirement', key: 'pack-size', reason: 'changed_since_preview' }),
    ]);
    expect((await row<{ description: string }>('requirements', 'pack-size'))!.description).toBe('edited in between');
    // Its ledger entry was left alone, so the NEXT run sees the edit for what it is.
    const next = await roll(v3, { dryRun: true });
    expect(find(next, 'requirement', 'pack-size')!.fields).toEqual([
      expect.objectContaining({ field: 'description', action: 'keep', reason: 'edited', current: 'edited in between' }),
    ]);
  });
});

describe('POST /api/starter-packs/roll-forward and GET /status', () => {
  const call = async (body: unknown, user: unknown) => {
    const res = await rollForwardRoute({
      request: new Request('http://localhost/api/starter-packs/roll-forward', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      env,
      data: { user },
      params: {},
    } as never);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const superAdmin = () => ({ id: seed.superAdminId, role: 'super_admin', tenant_id: null });

  it('refuses a user and a reader', async () => {
    for (const role of ['user', 'reader']) {
      const { status } = await call({}, { id: seed.userId, role, tenant_id: seed.tenantId });
      expect(status).toBe(403);
    }
  });

  it('refuses an organisation with no ledger, dry run included, and says why', async () => {
    const { status, body } = await call({}, { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });
    expect(status).toBe(409);
    expect(body.code).toBe('not_ledgered');
    expect(body.error).toMatch(/baseline/);
  });

  it('is a dry run unless told otherwise, and reports up to date on the shipped version', async () => {
    const fresh = generateTestId();
    await db
      .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
      .bind(fresh, 'Fresh', `fresh-${fresh.slice(0, 8)}`)
      .run();
    await applyStarterPack(db, v1, fresh, `fresh-${fresh.slice(0, 8)}`, seed.superAdminId);

    const { status, body } = await call({ tenant_id: fresh }, superAdmin());
    expect(status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(body.pack).toBe('fsqa');
    expect(body.from_version).toBe(STARTER_PACKS.fsqa.version);
    expect(body.to_version).toBe(STARTER_PACKS.fsqa.version);
    expect(body.up_to_date).toBe(true);
    expect(body.items).toEqual([]);

    const bad = await call({ tenant_id: fresh, accept: [{ kind: 'nonsense', key: 'x' }] }, superAdmin());
    expect(bad.status).toBe(400);

    const status2 = await statusRoute({
      request: new Request(`http://localhost/api/starter-packs/status?tenant_id=${fresh}`),
      env,
      data: { user: superAdmin() },
      params: {},
    } as never);
    const s = (await status2.json()) as Record<string, any>;
    expect(s.not_ledgered).toBeNull();
    expect(s.packs).toHaveLength(1);
    expect(s.packs[0]).toMatchObject({
      pack: 'fsqa',
      version: STARTER_PACKS.fsqa.version,
      available_version: STARTER_PACKS.fsqa.version,
      update_available: false,
      source: 'apply',
    });
  });

  it('POST /apply refuses an organisation on another version and points at the roll-forward', async () => {
    const other = generateTestId();
    await db
      .prepare('INSERT INTO tenants (id, name, slug, active) VALUES (?, ?, ?, 1)')
      .bind(other, `Other version ${other}`, `other-${other.slice(0, 8)}`)
      .run();
    // On record as a version this build does not ship (an older one, in real life).
    await db
      .prepare(
        `INSERT INTO tenant_packs (id, tenant_id, pack, version, source) VALUES (?, ?, 'fsqa', ?, 'apply')`,
      )
      .bind(generateTestId(), other, STARTER_PACKS.fsqa.version + 1)
      .run();
    const { onRequestPost: applyRoute } = await import('../../functions/api/starter-packs/apply');
    const res = await applyRoute({
      request: new Request('http://localhost/api/starter-packs/apply', {
        method: 'POST',
        body: JSON.stringify({ tenant_id: other, pack: 'fsqa' }),
      }),
      env,
      data: { user: superAdmin() },
      params: {},
    } as never);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(409);
    expect(body.code).toBe('roll_forward_required');
    expect(body.error).toMatch(/Settings > Starter pack/);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM requirements WHERE tenant_id = ?').bind(other).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('status tells an unledgered organisation what it is', async () => {
    await db
      .prepare(`INSERT OR IGNORE INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, 'status-probe', 'Status probe')`)
      .bind(generateTestId(), seed.tenantId)
      .run();
    const res = await statusRoute({
      request: new Request('http://localhost/api/starter-packs/status'),
      env,
      data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
      params: {},
    } as never);
    const s = (await res.json()) as Record<string, any>;
    expect(s.packs).toEqual([]);
    expect(s.not_ledgered).not.toBeNull();
  });
});
