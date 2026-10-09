/**
 * The guarded apply paths of three prod data repairs, run against a real D1
 * with the exact SQL the scripts send:
 *
 *   bin/archive-duplicate-documents  (bin/lib/duplicateArchivePlan.js)
 *   bin/report-lot-key-scheme --apply (bin/lib/lotKeySchemeReport.js)
 *   bin/fix-stale-julian-context     (bin/lib/staleJulianContext.js)
 *
 * What matters is what each one REFUSES: a later copy carrying anything the
 * kept copy lacks stays active; a merge moves every pointer before the row is
 * deleted; a context somebody reworded is not rewritten.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData } from '../helpers/db';
import archivePlan from '../../bin/lib/duplicateArchivePlan.js';
import lotReport from '../../bin/lib/lotKeySchemeReport.js';
import julian from '../../bin/lib/staleJulianContext.js';

const db = env.DB;
type Row = Record<string, unknown>;
const all = async (sql: string): Promise<Row[]> => (await db.prepare(sql).all<Row>()).results ?? [];
const run = async (statements: string[]) => {
  for (const s of statements) await db.prepare(s).run();
};
const q = (v: unknown) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

let T = '';
let U = '';

beforeAll(async () => {
  const seed = await seedTestData(db);
  T = seed.tenantId;
  U = seed.orgAdminId;
  await run([
    `INSERT INTO suppliers (id, tenant_id, name, slug) VALUES ('rp-sup', '${T}', 'Repair Dairy', 'repair-dairy')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('rp-p1', '${T}', 'Cream', 'rp-cream')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('rp-p2', '${T}', 'Milk', 'rp-milk')`,
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code) VALUES ('rp-l1', '${T}', 'rp-sup', 'rp-p1', 'A1', 'A1', '')`,
    `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code) VALUES ('rp-l2', '${T}', 'rp-sup', 'rp-p1', 'A2', 'A2', '')`,
    `INSERT INTO orders (id, tenant_id, order_number) VALUES ('rp-o1', '${T}', 'RP-1')`,
    `INSERT INTO order_items (id, order_id, product_name) VALUES ('rp-oi1', 'rp-o1', 'Cream')`,
    `INSERT INTO order_items (id, order_id, product_name) VALUES ('rp-oi2', 'rp-o1', 'Cream')`,
  ]);
  for (const id of ['rp-keep', 'rp-safe', 'rp-extra-lot', 'rp-order', 'rp-spec']) {
    await run([
      `INSERT INTO documents (id, tenant_id, title, created_by, status) VALUES ('${id}', '${T}', 'COA ${id}', '${U}', 'active')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-${id}', '${id}', 'rp-l1')`,
      `INSERT INTO document_products (id, document_id, product_id) VALUES ('dp-${id}', '${id}', 'rp-p1')`,
      `INSERT INTO document_spec_checks (id, tenant_id, document_id, test_name_raw, value_raw, unit_raw, verdict, source)
         VALUES ('sc-${id}', '${T}', '${id}', 'Coliform', '<10', 'CFU/g', 'in_spec', 'limit')`,
    ]);
  }
  await run([
    // safe: a pending suggestion the kept copy lacks (its lot IS on the kept copy) + a received-again row
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, lot_id, status) VALUES ('rp-s1', '${T}', 'rp-oi1', 'rp-safe', 'rp-l1', 'pending')`,
    `INSERT INTO intake_duplicates (id, tenant_id, checksum, match_kind, matched_document_id, source, file_name, file_size, mime_type, file_r2_key, enqueue_params)
       VALUES ('rp-id1', '${T}', 'abc', 'already_approved', 'rp-safe', 'import', 'a.pdf', 1, 'application/pdf', 'k', '{}')`,
    // extra-lot: a lot the kept copy does not have
    `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-extra2', 'rp-extra-lot', 'rp-l2')`,
    // order: an order line names this copy
    `UPDATE order_items SET coa_document_id = 'rp-order' WHERE id = 'rp-oi2'`,
    // spec: the same test read differently
    `UPDATE document_spec_checks SET value_raw = '0', unit_raw = NULL WHERE id = 'sc-rp-spec'`,
  ]);
});

async function planFor(docs: { id: string; role: string }[]) {
  const report = {
    groups: [
      {
        tenant_id: T,
        checksums: ['abc'],
        same_title: true,
        documents: docs.map((d) => ({ document_id: d.id, role: d.role, title: `COA ${d.id}`, approved_at: '2026-01-01' })),
      },
    ],
  };
  const rowsByKind: Record<string, Row[]> = {};
  for (const [kind, sql] of Object.entries(archivePlan.evidenceSql(docs.map((d) => d.id)))) rowsByKind[kind] = await all(sql as string);
  const ev = archivePlan.buildEvidence(rowsByKind, await all(archivePlan.LIVE_EXPORT_LINKS_SQL));
  return archivePlan.planArchive(report, ev);
}

describe('archive-duplicate-documents', () => {
  it('archives only the copy that carries nothing the kept copy lacks, re-pointing what is safe', async () => {
    const plan = await planFor([
      { id: 'rp-keep', role: 'first' },
      { id: 'rp-safe', role: 'later_copy' },
      { id: 'rp-extra-lot', role: 'later_copy' },
      { id: 'rp-order', role: 'later_copy' },
      { id: 'rp-spec', role: 'later_copy' },
    ]);
    expect(plan.archive.map((a: Row) => a.document_id)).toEqual(['rp-safe']);
    const reasons = Object.fromEntries(plan.skip.map((s: { document_id: string; reasons: { key: string }[] }) => [s.document_id, s.reasons.map((r) => r.key)]));
    expect(reasons).toEqual({ 'rp-extra-lot': ['lot'], 'rp-order': ['order_line'], 'rp-spec': ['spec_missing'] });
    expect(plan.archive[0].repoints).toEqual({ intake_duplicates: ['rp-id1'], lot_match_suggestions: ['rp-s1'] });

    await run(plan.archive.flatMap((a: Row) => archivePlan.archiveToSql(a, 'test')));
    const docs = await all(`SELECT id, status FROM documents WHERE id LIKE 'rp-%' ORDER BY id`);
    expect(Object.fromEntries(docs.map((d) => [d.id, d.status]))).toEqual({
      'rp-extra-lot': 'active', 'rp-keep': 'active', 'rp-order': 'active', 'rp-safe': 'archived', 'rp-spec': 'active',
    });
    expect((await all(`SELECT document_id FROM lot_match_suggestions WHERE id = 'rp-s1'`))[0].document_id).toBe('rp-keep');
    expect((await all(`SELECT matched_document_id FROM intake_duplicates WHERE id = 'rp-id1'`))[0].matched_document_id).toBe('rp-keep');
    const audit = await all(`SELECT details FROM audit_log WHERE action = 'document.archived_as_duplicate' AND resource_id = 'rp-safe'`);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0].details)).kept_document_id).toBe('rp-keep');

    // Nothing was deleted; a re-run finds the archived copy "not active" and writes nothing.
    expect(await all(`SELECT id FROM document_spec_checks WHERE document_id = 'rp-safe'`)).toHaveLength(1);
    const again = await planFor([{ id: 'rp-keep', role: 'first' }, { id: 'rp-safe', role: 'later_copy' }]);
    expect(again.archive).toEqual([]);
    expect(again.skip[0].reasons[0].key).toBe('not_active');
  });
});

describe('report-lot-key-scheme --apply', () => {
  it('re-keys in place, and merges a lot only after moving every pointer', async () => {
    await run([
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code, production_date) VALUES ('lk-comp', '${T}', 'rp-sup', 'rp-p2', '1032603623', '1032603623', '', '2026-02-05')`,
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code, production_date) VALUES ('lk-bad', '${T}', 'rp-sup', 'rp-p2', '10326102', '1032610210326102', '10326102', '2026-04-12')`,
      `INSERT INTO lots (id, tenant_id, supplier_id, product_id, lot_number, lot_key, sub_lot_code, production_date) VALUES ('lk-good', '${T}', 'rp-sup', 'rp-p2', '10326102', '10326102', '', NULL)`,
      `INSERT INTO documents (id, tenant_id, title, created_by) VALUES ('lk-d1', '${T}', 'd1', '${U}')`,
      `INSERT INTO documents (id, tenant_id, title, created_by) VALUES ('lk-d2', '${T}', 'd2', '${U}')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('lkdl1', 'lk-d1', 'lk-bad')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('lkdl2', 'lk-d2', 'lk-bad')`,
      `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('lkdl3', 'lk-d2', 'lk-good')`,
      `INSERT INTO order_items (id, order_id, product_name, lot_id) VALUES ('lk-oi', 'rp-o1', 'Milk', 'lk-bad')`,
      // A hold on the mis-keyed lot row (migration 0139). It must follow the
      // lot, or the lot row could not be removed (or worse, the hold lost).
      `INSERT INTO document_holds (id, tenant_id, document_id, lot_id, reason, source, placed_by) VALUES ('lk-hold', '${T}', 'lk-d1', 'lk-bad', 'Retest pending', 'person', '${U}')`,
    ]);
    const report = {
      rows: [
        { class: 'split_composite', lot_id: 'lk-comp', lot_number: '1032603623', stored: { key: '1032603623', sub: '' }, suggested: { key: '1032603623', sub: '23' }, would_merge_into: null, reason: 'r' },
        { class: 'sublot_not_a_sublot', lot_id: 'lk-bad', lot_number: '10326102', stored: { key: '1032610210326102', sub: '10326102' }, suggested: { key: '10326102', sub: '' }, would_merge_into: 'lk-good', reason: 'r' },
        { class: 'does_not_fit', lot_id: 'lk-comp', lot_number: 'K1', stored: { key: 'K1', sub: '' }, suggested: null, would_merge_into: null, reason: 'r' },
      ],
    };
    const lots = await all(`SELECT l.*, 0 AS document_lots, 0 AS order_items, 0 AS suggestions FROM lots l WHERE id IN ('lk-comp', 'lk-bad', 'lk-good')`);
    const plan = lotReport.planRepairs(report, new Map(lots.map((l) => [l.id, l])));
    expect(plan.repairs.map((r: { kind: string }) => r.kind)).toEqual(['rekey', 'merge']);
    expect(plan.skipped).toHaveLength(1);
    await run(plan.repairs.flatMap((r: unknown) => lotReport.repairToSql(T, r, q, 'test')));

    const after = await all(`SELECT id, lot_key, sub_lot_code, production_date FROM lots WHERE id LIKE 'lk-%' ORDER BY id`);
    expect(after).toEqual([
      { id: 'lk-comp', lot_key: '1032603623', sub_lot_code: '23', production_date: '2026-02-05' },
      { id: 'lk-good', lot_key: '10326102', sub_lot_code: '', production_date: '2026-04-12' },
    ]);
    const links = await all(`SELECT document_id, lot_id FROM document_lots WHERE document_id LIKE 'lk-%' ORDER BY document_id`);
    expect(links).toEqual([
      { document_id: 'lk-d1', lot_id: 'lk-good' },
      { document_id: 'lk-d2', lot_id: 'lk-good' },
    ]);
    expect((await all(`SELECT lot_id FROM order_items WHERE id = 'lk-oi'`))[0].lot_id).toBe('lk-good');
    // The hold followed its lot, still active, nothing else about it touched.
    expect(await all(`SELECT lot_id, reason, released_at FROM document_holds WHERE id = 'lk-hold'`)).toEqual([
      { lot_id: 'lk-good', reason: 'Retest pending', released_at: null },
    ]);
    const merged = await all(`SELECT details FROM audit_log WHERE action = 'lot.merged_on_identity_repair' AND resource_id = 'lk-bad'`);
    expect(JSON.parse(String(merged[0].details)).removed_row.lot_key).toBe('1032610210326102');

    // Re-running the same plan is a no-op: every statement is guarded by the identity it read.
    await run(plan.repairs.flatMap((r: unknown) => lotReport.repairToSql(T, r, q, 'test2')));
    expect(await all(`SELECT id FROM audit_log WHERE details LIKE '%"run_at":"test2"%'`)).toEqual([]);
  });

  it('refuses a merge whose two rows state different production dates', () => {
    const report = { rows: [{ class: 'sublot_not_a_sublot', lot_id: 'a', lot_number: 'x', stored: { key: 'xx', sub: 'x' }, suggested: { key: 'x', sub: '' }, would_merge_into: 'b', reason: 'r' }] };
    const lots = new Map([
      ['a', { id: 'a', supplier_id: 's', product_id: 'p', production_date: '2026-01-01' }],
      ['b', { id: 'b', supplier_id: 's', product_id: 'p', production_date: '2026-01-02' }],
    ]);
    const plan = lotReport.planRepairs(report, lots);
    expect(plan.repairs).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/different production dates/);
  });
});

describe('fix-stale-julian-context', () => {
  const ctx = ['INDUSTRY:', '- Plant numbers', `  ${julian.STALE_LINE}`, '- Net weights'].join('\n');

  it('removes exactly the stale line, or swaps in the current default line', () => {
    const removed = julian.planContextFix(ctx, 'remove');
    expect(removed.action).toBe('change');
    expect(removed.after).toBe(['INDUSTRY:', '- Plant numbers', '- Net weights'].join('\n'));
    expect(removed.removed).toEqual([3]);
    const replaced = julian.planContextFix(ctx, 'replace');
    expect(replaced.after).toContain(`  ${julian.CURRENT_DEFAULT_LINE}`);
    expect(julian.lineDiff(ctx, removed.after!)).toContain(`-   ${julian.STALE_LINE}`);
  });

  it('leaves a reworded line and a NULL context alone', () => {
    expect(julian.planContextFix('- Code dates may use Julian format, decode them', 'remove').action).toBe('reworded');
    expect(julian.planContextFix(null, 'remove').action).toBe('default');
    expect(julian.planContextFix('nothing here', 'remove').action).toBe('none');
  });
});
