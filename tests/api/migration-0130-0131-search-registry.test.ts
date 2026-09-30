/**
 * Migrations 0130 (document provenance + its provable backfill) and 0131 (the
 * deferred "P3 FTS rebuild": documents_fts_source reads requirements and
 * confirmed product identifiers), rehearsed on a POPULATED database the way
 * 0110 / 0113 were: an empty D1 (MIGRATION_DB) is migrated to just before
 * 0130, filled with the prod shapes each rule has to handle, and each file is
 * applied as ONE batch, the way `wrangler d1 execute --file` (and
 * bin/migrate-prod-one) applies it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, MIGRATIONS, splitStatements } from '../helpers/db';
import m0130 from '../../migrations/0130_document_provenance.sql?raw';
import m0131 from '../../migrations/0131_fts_registry_rebuild.sql?raw';
import { drainSearchReindexQueue } from '../../functions/lib/search-reindex';

const db = env.MIGRATION_DB;
const IDX = MIGRATIONS.indexOf(m0130);
const T = 'tenant-0130';
const T2 = 'tenant-0130-empty';
const U = 'user-0130';
type Row = Record<string, unknown>;
const one = async (sql: string, ...b: unknown[]): Promise<Row | null> => db.prepare(sql).bind(...b).first<Row>();
const fts = async (match: string): Promise<string[]> =>
  ((await db.prepare(`SELECT doc_id FROM documents_fts WHERE tenant_id = ? AND documents_fts MATCH ? ORDER BY doc_id`).bind(T, match).all<{ doc_id: string }>()).results ?? []).map((r) => r.doc_id);

beforeAll(async () => {
  const existing = await db.prepare("SELECT count(*) AS n FROM pragma_table_info('documents') WHERE name = 'approved_at'").first<{ n: number }>();
  if ((existing?.n ?? 0) === 0) {
    expect(IDX).toBeGreaterThan(0);
    await runMigrations(db, { before: IDX });
  }
  // A rehearsal on a database 0130 already ran on proves nothing.
  const cols = await db.prepare("SELECT count(*) AS n FROM pragma_table_info('documents') WHERE name = 'approved_at'").first<{ n: number }>();
  expect(cols?.n).toBe(0);

  const doc = (id: string, title: string) =>
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by) VALUES ('${id}', '${T}', '${title}', '[]', 1, 'active', '${U}')`;
  const ver = (id: string, text: string) =>
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
       VALUES ('${id}-v1', '${id}', 1, '${id}.pdf', 10, 'application/pdf', 'k/${id}', 'c-${id}', '${text}', '${U}')`;
  const stmts = [
    `INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Rehearsal Dairy', 'rehearsal-0130')`,
    `INSERT INTO tenants (id, name, slug) VALUES ('${T2}', 'Empty Dairy', 'rehearsal-0130-empty')`,
    `INSERT INTO users (id, email, password_hash, name, role, tenant_id) VALUES ('${U}', 'r0130@example.com', 'x', 'R', 'org_admin', '${T}')`,
    `INSERT INTO document_types (id, tenant_id, name, slug) VALUES ('dt-log', '${T}', 'Letter of Guarantee', 'log-0130')`,
    `INSERT INTO requirements (id, tenant_id, slug, name) VALUES ('req-allergen', '${T}', 'allergen', 'Allergen statement')`,
    `INSERT INTO requirements (id, tenant_id, slug, name) VALUES ('req-haccp', '${T}', 'haccp', 'HACCP plan')`,
    `INSERT INTO products (id, tenant_id, name, slug) VALUES ('p-butter', '${T}', 'BTR BULK U/S 25KG', 'btr-0130')`,
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, confirmed, source) VALUES ('pi-sku', '${T}', 'p-butter', 'our_sku', 'SKUQ4417', 'SKUQ4417', 1, 'seed')`,
    `INSERT INTO product_identifiers (id, tenant_id, product_id, kind, value, value_norm, confirmed, source) VALUES ('pi-alias', '${T}', 'p-butter', 'alias', 'mysterybutter', 'mysterybutter', 0, 'seed')`,
    `INSERT INTO lots (id, tenant_id, product_id, lot_number, lot_key) VALUES ('lot-1', '${T}', 'p-butter', '777111', '777111')`,
    doc('d1', 'Emailed COA'), ver('d1', 'plain text one'),
    doc('d2', 'Packet part A'), ver('d2', 'plain text two'),
    doc('d3', 'Packet part B'), ver('d3', 'plain text three'),
    doc('d4', 'Direct upload'), ver('d4', 'plain text four'),
    doc('d5', 'Ingested'), ver('d5', 'plain text five'),
    doc('d6', 'Unknown origin'), ver('d6', 'plain text six'),
    // Review Queue items the approvals came from.
    `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, source) VALUES ('q1', '${T}', 'q/1', 'q1.pdf', 1, 'application/pdf', 'approved', 'email')`,
    `INSERT INTO processing_queue (id, tenant_id, file_r2_key, file_name, file_size, mime_type, status, source) VALUES ('q2', '${T}', 'q/2', 'q2.pdf', 1, 'application/pdf', 'approved', 'request_link')`,
    // The approval audit rows: one document_id; a records approve's document_ids.
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, created_at)
       VALUES ('${U}', '${T}', 'queue_item.approved', 'processing_queue', 'q1', '{"document_id":"d1","file_name":"q1.pdf"}', '2026-08-01 09:00:00')`,
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, created_at)
       VALUES ('${U}', '${T}', 'queue_item.partial_approved', 'processing_queue', 'q2', '{"document_ids":["d2","d3"],"held_count":1}', '2026-08-02 10:00:00')`,
    // A later approval naming d1 again must not move it.
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, created_at)
       VALUES ('${U}', '${T}', 'queue_item.approved', 'processing_queue', 'q2', '{"document_id":"d1"}', '2026-08-09 09:00:00')`,
    // Another tenant's audit row naming d6 proves nothing about d6.
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, created_at)
       VALUES ('${U}', '${T2}', 'queue_item.approved', 'processing_queue', 'q9', '{"document_id":"d6"}', '2026-08-03 09:00:00')`,
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES ('${U}', '${T}', 'document_created', 'document', 'd4', '{}')`,
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES ('${U}', '${T}', 'document.ingested', 'document', 'd5', '{"action":"created"}')`,
    `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details) VALUES ('${U}', '${T}', 'document.ingested', 'document', 'd6', '{"action":"version_added"}')`,
    // Registry links: what 0131 must read (and not read).
    `INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES ('dr-2', 'd2', 'req-allergen', 'confirmed')`,
    `INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES ('dr-3', 'd3', 'req-haccp', 'rejected')`,
    `INSERT INTO document_categories (id, document_id, document_type_id, is_primary) VALUES ('dc-1', 'd1', 'dt-log', 1)`,
    `INSERT INTO document_lots (id, document_id, lot_id) VALUES ('dl-3', 'd3', 'lot-1')`,
  ];
  for (const s of stmts) await db.prepare(s).run();

  await db.batch(splitStatements(m0130).map((s) => db.prepare(s)));
  await db.batch(splitStatements(m0131).map((s) => db.prepare(s)));
}, 180_000);

describe('migration 0130 — provenance, backfilled only where provable', () => {
  it('a reviewed document takes its approval time, queue item and door from the approval audit row', async () => {
    expect(await one(`SELECT approved_at, origin_queue_id, intake_source FROM documents WHERE id = 'd1'`))
      .toEqual({ approved_at: '2026-08-01 09:00:00', origin_queue_id: 'q1', intake_source: 'email' });
  });

  it('every document a records approval names gets the same provenance', async () => {
    for (const id of ['d2', 'd3']) {
      expect(await one(`SELECT approved_at, origin_queue_id, intake_source FROM documents WHERE id = ?`, id))
        .toEqual({ approved_at: '2026-08-02 10:00:00', origin_queue_id: 'q2', intake_source: 'request_link' });
    }
  });

  it('a direct upload and an ingest-API create say so, and were never approved', async () => {
    expect(await one(`SELECT approved_at, intake_source FROM documents WHERE id = 'd4'`)).toEqual({ approved_at: null, intake_source: 'direct_upload' });
    expect(await one(`SELECT approved_at, intake_source FROM documents WHERE id = 'd5'`)).toEqual({ approved_at: null, intake_source: 'ingest_api' });
  });

  it('nothing provable (another tenant\'s row, a version added) leaves it NOT RECORDED', async () => {
    expect(await one(`SELECT approved_at, origin_queue_id, intake_source FROM documents WHERE id = 'd6'`))
      .toEqual({ approved_at: null, origin_queue_id: null, intake_source: null });
  });
});

describe('migration 0131 — documents_fts reads requirements and product identifiers', () => {
  it('retires the document_categories FTS triggers and adds the document_requirements ones', async () => {
    const names = ((await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all<{ name: string }>()).results ?? []).map((r) => r.name);
    expect(names).not.toContain('trg_document_categories_ai_fts');
    expect(names).not.toContain('trg_document_categories_ad_fts');
    for (const t of ['trg_document_requirements_ai_fts', 'trg_document_requirements_au_fts', 'trg_document_requirements_ad_fts', 'trg_requirements_au_reindex', 'trg_product_identifiers_ai_reindex']) {
      expect(names).toContain(t);
    }
  });

  it('the view names non-rejected requirements, and no longer reads document_categories', async () => {
    const src = async (id: string) => one(`SELECT category_text, product_text FROM documents_fts_source WHERE doc_id = ?`, id);
    expect((await src('d2'))!.category_text).toBe('Allergen statement');
    expect((await src('d3'))!.category_text).toBe(''); // rejected
    expect((await src('d1'))!.category_text).toBe(''); // the retired junction feeds nothing
  });

  it('a lot-linked product and its CONFIRMED identifiers reach product_text; an unconfirmed one does not', async () => {
    const t = String((await one(`SELECT product_text FROM documents_fts_source WHERE doc_id = 'd3'`))!.product_text);
    expect(t).toContain('BTR BULK U/S 25KG');
    expect(t).toContain('SKUQ4417');
    expect(t).not.toContain('mysterybutter');
  });

  it('enqueues ONE full re-emit per organization that has documents, and draining it makes the new text searchable', async () => {
    const jobs = (await db.prepare(`SELECT tenant_id FROM search_reindex_jobs WHERE entity_kind = 'tenant' AND status = 'pending'`).all<{ tenant_id: string }>()).results ?? [];
    expect(jobs.map((j) => j.tenant_id)).toEqual([T]);
    expect(await fts('allergen')).toEqual([]); // not yet: the rows were written through the old view
    await drainSearchReindexQueue(db, { maxJobs: 25 });
    expect(await fts('allergen')).toEqual(['d2']);
    expect(await fts('haccp')).toEqual([]);
    expect(await fts('SKUQ4417')).toEqual(['d3']);
  });

  it('a new requirement link is searchable at once (inline re-emit); a rejection takes it away', async () => {
    await db.prepare(`INSERT INTO document_requirements (id, document_id, requirement_id, status) VALUES ('dr-4', 'd4', 'req-haccp', 'suggested')`).run();
    expect(await fts('haccp')).toEqual(['d4']);
    await db.prepare(`UPDATE document_requirements SET status = 'rejected' WHERE id = 'dr-4'`).run();
    expect(await fts('haccp')).toEqual([]);
  });

  it('a requirement rename and an identifier change enqueue re-emits for the drainer', async () => {
    await db.prepare(`UPDATE requirements SET name = 'Allergen control statement' WHERE id = 'req-allergen'`).run();
    await db.prepare(`UPDATE product_identifiers SET confirmed = 1 WHERE id = 'pi-alias'`).run();
    const kinds = ((await db.prepare(`SELECT entity_kind, entity_id FROM search_reindex_jobs WHERE status = 'pending' AND entity_kind IN ('product', 'requirement') ORDER BY entity_kind`).all<Row>()).results ?? []);
    expect(kinds).toEqual([{ entity_kind: 'product', entity_id: 'p-butter' }, { entity_kind: 'requirement', entity_id: 'req-allergen' }]);
    await drainSearchReindexQueue(db, { maxJobs: 25 });
    expect(await fts('control')).toEqual(['d2']);
    expect(await fts('mysterybutter')).toEqual(['d3']);
  });
});
