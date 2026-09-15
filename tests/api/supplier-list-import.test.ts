/**
 * POST /api/supplier-list/import — requirements derived from the verified
 * supplier list (migration 0111).
 *
 * Pinned: a dry run writes NOTHING; apply writes derived rows with provenance
 * and a stored run; a person's row always wins; an unconfirmed seed row the
 * list implies is adopted; re-import flags rather than deletes; unmatched
 * claims / products / rows are reported; tenants stay isolated.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import { applyStarterPack } from '../../functions/lib/starter-packs';
import { getStarterPack } from '../../functions/lib/starterPacks.generated';
import { onRequestPost as importPost } from '../../functions/api/supplier-list/import';
import { onRequestGet as importsList } from '../../functions/api/supplier-list/imports/index';
import { onRequestGet as importGet } from '../../functions/api/supplier-list/imports/[id]';
import medosweetCsv from '../fixtures/supplier-list/medosweet-verified-suppliers.csv?raw';
import type { SupplierListImportResponse } from '../../shared/types';

const db = env.DB;

let seed: Awaited<ReturnType<typeof seedTestData>>;
type Actor = { id: string; role: string; tenant_id: string | null };
let admin: Actor;
let admin2: Actor;
let reader: Actor;
let superAdmin: Actor;

async function post(body: unknown, as: Actor = admin) {
  const res = await importPost({
    request: new Request('http://localhost/api/supplier-list/import', { method: 'POST', body: JSON.stringify(body) }),
    env,
    data: { user: as },
    params: {},
  } as never);
  return { status: res.status, body: (await res.json()) as SupplierListImportResponse & { error?: string } };
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

async function rowsFor(tenantId: string, supplierName: string) {
  const res = await db
    .prepare(
      `SELECT sr.id, r.slug, sr.tier, sr.source, sr.derivation_run_id, sr.derivation_basis, sr.review_flag
         FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id
         JOIN suppliers s ON s.id = sr.supplier_id
        WHERE sr.tenant_id = ? AND s.name = ?
        ORDER BY r.slug`,
    )
    .bind(tenantId, supplierName)
    .all<{ id: string; slug: string; tier: string; source: string | null; derivation_run_id: string | null; derivation_basis: string | null; review_flag: string | null }>();
  return res.results ?? [];
}

beforeAll(async () => {
  seed = await seedTestData(db);
  admin = { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId };
  admin2 = { id: seed.orgAdmin2Id, role: 'org_admin', tenant_id: seed.tenantId2 };
  reader = { id: seed.readerId, role: 'reader', tenant_id: seed.tenantId };
  superAdmin = { id: seed.superAdminId, role: 'super_admin', tenant_id: null };
  const pack = getStarterPack('fsqa')!;
  await applyStarterPack(db, pack, seed.tenantId, 'test-corp');
  await applyStarterPack(db, pack, seed.tenantId2, 'other-corp');
});

beforeEach(async () => {
  for (const t of [seed.tenantId, seed.tenantId2]) {
    await db.prepare('DELETE FROM supplier_requirements WHERE tenant_id = ?').bind(t).run();
    await db.prepare('DELETE FROM supplier_list_imports WHERE tenant_id = ?').bind(t).run();
    await db.prepare('DELETE FROM product_identifiers WHERE tenant_id = ?').bind(t).run();
    await db.prepare('DELETE FROM products WHERE tenant_id = ?').bind(t).run();
    await db.prepare('DELETE FROM suppliers WHERE tenant_id = ?').bind(t).run();
    await db.prepare("DELETE FROM audit_log WHERE tenant_id = ? AND action LIKE 'supplier%'").bind(t).run();
  }
  // One catalog product the list's SKU 0801 should match.
  await db
    .prepare("INSERT INTO products (id, tenant_id, name, slug) VALUES ('prod_0801', ?, 'Butter Unsalted 25 kg Bag', 'butter-unsalted-25kg')")
    .bind(seed.tenantId)
    .run();
  await db
    .prepare(
      `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, source, confirmed)
       VALUES ('pi_0801', ?, 'prod_0801', 'our_sku', '0801', '0801', 'seed', 1)`,
    )
    .bind(seed.tenantId)
    .run();
});

describe('POST /api/supplier-list/import — dry run', () => {
  it('previews the derivation and writes nothing at all', async () => {
    const auditBefore = await count('SELECT COUNT(*) AS n FROM audit_log');
    const { status, body } = await post({ csv: medosweetCsv, file_name: 'medosweet.csv' });
    expect(status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(body.run_id).toBeNull();

    expect(await count('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?', seed.tenantId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM supplier_requirements WHERE tenant_id = ?', seed.tenantId)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM supplier_list_imports')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM audit_log')).toBe(auditBefore);

    expect(body.counts).toMatchObject({
      rows_total: 8,
      rows_accepted: 8,
      rows_rejected: 0,
      suppliers_listed: 6,
      suppliers_created: 6,
      suppliers_not_approved: 1,
      products_matched: 1,
      products_unmatched: 6,
    });

    const byName = Object.fromEntries(body.suppliers.map((s) => [s.supplier_name, s]));
    const darigold = byName['Darigold, Inc.'];
    expect(darigold.supplier_match).toBe('will_create');
    const dSlugs = Object.fromEntries(darigold.lines.map((l) => [l.requirement_slug, l]));
    // baseline
    expect(dSlugs['certificate-of-insurance'].tier).toBe('required');
    expect(dSlugs['third-party-audit-certificate'].tier).toBe('required');
    // ingredient packet
    expect(dSlugs['micro-limits'].tier).toBe('required');
    expect(dSlugs['haccp-plan'].tier).toBe('required');
    expect(dSlugs['gtin'].tier).toBe('recommended');
    // rBST-free claim -> the pack's claim rule (letter of guarantee)
    expect(dSlugs['letter-of-guarantee'].because).toContain('"rbst-free" claim on 0801 Unsalted Butter 25kg Bag');
    // spec sheet per product bought, both products named
    expect(dSlugs['spec-sheet'].because).toContain(
      'Spec sheet for 0801 Unsalted Butter 25kg Bag, 10286 Unsalted Butter 300 gal Tote',
    );

    const andersen = byName['Andersen Dairy'];
    const aSlugs = andersen.lines.map((l) => l.requirement_slug);
    expect(aSlugs).toContain('kosher-certificate');
    expect(aSlugs).toContain('halal-certificate');

    const chem = byName['Northwest Sanitation Chemical Co'];
    const cSlugs = chem.lines.map((l) => l.requirement_slug);
    expect(cSlugs).toContain('sds-on-file');
    expect(cSlugs).not.toContain('micro-limits');

    const packaging = byName['Cascade Packaging'];
    expect(packaging.lines.map((l) => l.requirement_slug).sort()).toEqual([
      'certificate-of-insurance',
      'spec-sheet',
      'third-party-audit-certificate',
    ]);
    expect(body.rule_problems).toContain(
      'No requirement packet is defined for packaging suppliers; they get the baseline only.',
    );

    expect(byName['Old Creamery Supply'].approved).toBe(false);
    expect(byName['Old Creamery Supply'].lines).toEqual([]);

    const matched = body.rows.find((r) => r.line === 2)!;
    expect(matched.product_id).toBe('prod_0801');
    expect(body.unmatched.filter((u) => u.kind === 'product')).toHaveLength(6);
  });

  it('reports unmatched claims and rejected rows with reasons; refuses a file missing required columns', async () => {
    const csv = [
      'Supplier name,Supplier category,Approved (Y/N),Product name,Claims made',
      'Acme Foods,ingredient,Y,Oat Base,"vegan, kosher"',
      'Blank Approved Co,ingredient,,,',
      'C2#,ingredient,Y,,',
    ].join('\n');
    const { body } = await post({ csv });
    expect(body.counts.rows_rejected).toBe(2);
    expect(body.unmatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, kind: 'claim', value: 'vegan' }),
        expect.objectContaining({ line: 3, kind: 'row', reason: 'Approved is blank. Enter Y or N.' }),
        expect.objectContaining({ line: 4, kind: 'row', reason: '"C2#" does not look like a supplier name.' }),
      ]),
    );
    const acme = body.suppliers.find((s) => s.supplier_name === 'Acme Foods')!;
    expect(acme.lines.map((l) => l.requirement_slug)).toContain('kosher-certificate');

    const missing = await post({ csv: 'Supplier name,Product name\nAcme,Oats\n' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/missing required columns: Supplier category, Approved \(Y\/N\)/);
  });
});

describe('POST /api/supplier-list/import — apply', () => {
  it('creates suppliers, writes derived rows with a pointer to a stored run, and audits', async () => {
    const { status, body } = await post({ csv: medosweetCsv, file_name: 'medosweet.csv', dry_run: false });
    expect(status).toBe(201);
    expect(body.run_id).toBeTruthy();
    expect(body.counts.suppliers_created).toBe(6);

    const darigold = await rowsFor(seed.tenantId, 'Darigold, Inc.');
    expect(darigold.length).toBeGreaterThan(10);
    expect(darigold.every((r) => r.source === 'derived' && r.derivation_run_id === body.run_id)).toBe(true);
    const log = darigold.find((r) => r.slug === 'letter-of-guarantee')!;
    expect(JSON.parse(log.derivation_basis!)).toEqual(
      expect.arrayContaining([{ rule: 'claim', claim: 'rbst-free', product: '0801 Unsalted Butter 25kg Bag' }]),
    );
    expect(await rowsFor(seed.tenantId, 'Old Creamery Supply')).toEqual([]);

    const run = await db
      .prepare('SELECT file_name, input_format, pack, counts, row_outcomes, input_rows, created_by FROM supplier_list_imports WHERE id = ?')
      .bind(body.run_id)
      .first<Record<string, string>>();
    expect(run).toMatchObject({ file_name: 'medosweet.csv', input_format: 'csv', pack: 'fsqa', created_by: admin.id });
    expect(JSON.parse(run!.row_outcomes)).toHaveLength(8);
    expect(JSON.parse(run!.input_rows)).toHaveLength(8);

    const audit = await db
      .prepare("SELECT details FROM audit_log WHERE action = 'supplier_list.import' AND resource_id = ?")
      .bind(body.run_id)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details).counts.requirements_added).toBe(body.counts.requirements_added);

    // The runs are listable and readable.
    const listRes = await importsList({ request: new Request('http://localhost/api/supplier-list/imports'), env, data: { user: admin }, params: {} } as never);
    const list = (await listRes.json()) as { imports: Array<{ id: string; counts: { rows_total: number } }> };
    expect(list.imports[0]).toMatchObject({ id: body.run_id, counts: { rows_total: 8 } });
    const oneRes = await importGet({ request: new Request('http://localhost/'), env, data: { user: admin }, params: { id: body.run_id } } as never);
    expect(((await oneRes.json()) as { import: { row_outcomes: unknown[] } }).import.row_outcomes).toHaveLength(8);
  });

  it('a person\'s row wins; an unconfirmed seed row the list implies is adopted', async () => {
    await db.prepare("INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('sup_dg', ?, 'Darigold', 'darigold')").bind(seed.tenantId).run();
    await db
      .prepare(
        `INSERT INTO supplier_requirements (id, tenant_id, supplier_id, requirement_id, tier, source)
         VALUES ('sr_human', ?, 'sup_dg', 'req_test-corp_spec-sheet', 'recommended', 'human'),
                ('sr_seed', ?, 'sup_dg', 'req_test-corp_micro-limits', 'recommended', NULL),
                ('sr_unrelated_seed', ?, 'sup_dg', 'req_test-corp_w9-on-file', 'required', NULL),
                ('sr_seed_higher', ?, 'sup_dg', 'req_test-corp_letter-of-guarantee', 'required', NULL)`,
      )
      .bind(seed.tenantId, seed.tenantId, seed.tenantId, seed.tenantId)
      .run();

    const preview = await post({ csv: medosweetCsv });
    const dg = preview.body.suppliers.find((s) => s.supplier_name === 'Darigold, Inc.')!;
    expect(dg.supplier_id).toBe('sup_dg'); // matched through the normalized name
    expect(dg.lines.find((l) => l.requirement_slug === 'spec-sheet')).toMatchObject({
      action: 'keep_person',
      tier: 'recommended',
      existing_source: 'human',
    });
    expect(dg.lines.find((l) => l.requirement_slug === 'micro-limits')).toMatchObject({
      action: 'adopt_unconfirmed',
      from_tier: 'recommended',
      tier: 'required',
    });

    // rBST-free recommends a letter of guarantee; the seed said required. Held.
    expect(dg.lines.find((l) => l.requirement_slug === 'letter-of-guarantee')).toMatchObject({
      action: 'hold_unconfirmed',
      tier: 'required',
    });
    expect(preview.body.counts.requirements_held_unconfirmed).toBe(1);

    const { body } = await post({ csv: medosweetCsv, dry_run: false });
    const rows = Object.fromEntries((await rowsFor(seed.tenantId, 'Darigold')).map((r) => [r.slug, r]));
    expect(rows['letter-of-guarantee']).toMatchObject({ id: 'sr_seed_higher', tier: 'required', source: null });
    expect(rows['spec-sheet']).toMatchObject({ id: 'sr_human', tier: 'recommended', source: 'human', derivation_run_id: null });
    expect(rows['micro-limits']).toMatchObject({ id: 'sr_seed', tier: 'required', source: 'derived', derivation_run_id: body.run_id });
    // A seed row the list implies at a LOWER tier is held, not downgraded.
    expect(dg.lines.find((l) => l.requirement_slug === 'w9-on-file')).toBeUndefined();
    // The list says nothing about the W-9: it stays unconfirmed, for the worklist.
    expect(rows['w9-on-file']).toMatchObject({ source: null, review_flag: null });
    // The name the list used became an alias rather than a second supplier.
    expect(await count('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ? AND name LIKE ?', seed.tenantId, 'Darigold%')).toBe(1);
  });

  it('is idempotent: a second apply adds nothing and changes no tier', async () => {
    await post({ csv: medosweetCsv, dry_run: false });
    const before = await count('SELECT COUNT(*) AS n FROM supplier_requirements WHERE tenant_id = ?', seed.tenantId);
    const suppliersBefore = await count('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?', seed.tenantId);
    const { body } = await post({ csv: medosweetCsv, dry_run: false });
    expect(body.counts).toMatchObject({
      suppliers_created: 0,
      requirements_added: 0,
      requirements_adopted_unconfirmed: 0,
      requirements_tier_changed: 0,
      requirements_newly_flagged: 0,
    });
    expect(body.counts.requirements_refreshed).toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM supplier_requirements WHERE tenant_id = ?', seed.tenantId)).toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?', seed.tenantId)).toBe(suppliersBefore);
  });

  it('re-import flags derived rows no longer on the list, never deletes them, and clears the flag when they return', async () => {
    await post({ csv: medosweetCsv, dry_run: false });
    const andersenBefore = await rowsFor(seed.tenantId, 'Andersen Dairy');
    expect(andersenBefore.length).toBeGreaterThan(0);

    // Andersen dropped from the list; Darigold's rBST-free claim removed.
    const trimmed = medosweetCsv
      .split('\n')
      .filter((l) => !l.startsWith('Andersen Dairy'))
      .map((l) => l.replace(/,rBST-free$/, ','))
      .join('\n');
    const { body } = await post({ csv: trimmed, dry_run: false });
    expect(body.counts.requirements_newly_flagged).toBeGreaterThan(0);
    const flaggedNames = new Set(body.flagged.map((f) => f.supplier_name));
    expect(flaggedNames.has('Andersen Dairy')).toBe(true);

    const andersenAfter = await rowsFor(seed.tenantId, 'Andersen Dairy');
    expect(andersenAfter).toHaveLength(andersenBefore.length);
    expect(andersenAfter.every((r) => r.review_flag === 'not_on_verified_list' && r.source === 'derived')).toBe(true);

    // Letter of guarantee is still owed by Darigold via... nothing else in the
    // ingredient packet, so it is flagged; the ingredient items are not.
    const dg = Object.fromEntries((await rowsFor(seed.tenantId, 'Darigold, Inc.')).map((r) => [r.slug, r]));
    expect(dg['letter-of-guarantee'].review_flag).toBe('not_on_verified_list');
    expect(dg['micro-limits'].review_flag).toBeNull();

    // Back on the list: flags clear.
    const again = await post({ csv: medosweetCsv, dry_run: false });
    expect(again.body.flagged.filter((f) => f.supplier_name === 'Andersen Dairy')).toEqual([]);
    expect((await rowsFor(seed.tenantId, 'Andersen Dairy')).every((r) => r.review_flag === null)).toBe(true);
  });

  it('accepts structured rows (the future API/webhook caller) and re-runs a stored run', async () => {
    const rows = [
      { supplier_name: 'Api Dairy', supplier_category: 'ingredient', approved: 'Y', product_name: 'Cream', claims: 'kosher' },
    ];
    const first = await post({ rows, dry_run: false });
    expect(first.status).toBe(201);
    expect((await rowsFor(seed.tenantId, 'Api Dairy')).map((r) => r.slug)).toContain('kosher-certificate');

    const rerun = await post({ rerun_of: first.body.run_id, dry_run: true });
    expect(rerun.status).toBe(200);
    expect(rerun.body.counts.requirements_refreshed).toBeGreaterThan(0);
    expect(rerun.body.counts.requirements_added).toBe(0);

    expect((await post({ rows, csv: 'x' })).status).toBe(400);
  });

  it('reads an .xlsx workbook', async () => {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Supplier name', 'Supplier category', 'Approved (Y/N)', 'Product SKU', 'Product name', 'Claims made'],
      ['Xlsx Creamery', 'ingredient', 'Y', '2235', 'Heavy Cream', 'halal'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Suppliers');
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;
    const { status, body } = await post({ xlsx_base64: b64, file_name: 'list.xlsx' });
    expect(status).toBe(200);
    expect(body.suppliers[0].lines.map((l) => l.requirement_slug)).toContain('halal-certificate');
  });
});

describe('POST /api/supplier-list/import — access', () => {
  it('keeps tenants apart, requires tenant_id for super_admin, and refuses non-admins', async () => {
    await post({ csv: medosweetCsv, dry_run: false });
    expect(await count('SELECT COUNT(*) AS n FROM suppliers WHERE tenant_id = ?', seed.tenantId2)).toBe(0);

    // The other tenant's import sees none of tenant 1's suppliers and flags none of its rows.
    const other = await post({ csv: medosweetCsv }, admin2);
    expect(other.body.counts.suppliers_matched).toBe(0);
    expect(other.body.flagged).toEqual([]);

    // Tenant 1's run is not readable from tenant 2, nor re-runnable.
    const run = await db.prepare('SELECT id FROM supplier_list_imports WHERE tenant_id = ?').bind(seed.tenantId).first<{ id: string }>();
    const cross = await importGet({ request: new Request('http://localhost/'), env, data: { user: admin2 }, params: { id: run!.id } } as never);
    expect(cross.status).toBe(403);
    expect((await post({ rerun_of: run!.id }, admin2)).status).toBe(404);

    expect((await post({ csv: medosweetCsv }, superAdmin)).status).toBe(400);
    expect((await post({ csv: medosweetCsv, tenant_id: seed.tenantId2 }, superAdmin)).status).toBe(200);
    expect((await post({ csv: medosweetCsv }, reader)).status).toBe(403);
  });
});
