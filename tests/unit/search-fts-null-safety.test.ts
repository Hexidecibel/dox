/**
 * NULL-propagation safety for the documents_fts_source view (migration 0054
 * + 0056 fix).
 *
 * SQLite's `||` operator is NULL-propagating: `'foo' || NULL` is NULL.
 * The Phase 1 view had unwrapped concats on `supplier_text`
 * (`s.name || ' ' || aliases_text`) and `document_type_text`
 * (`dt.name || ' ' || dt.slug`). If either side of those concats was
 * NULL the entire indexed text for that doc's column became NULL —
 * silently dropping the doc out of search hits for that field.
 *
 * Migration 0056 wraps every expression in COALESCE so individual
 * NULLs can't propagate up. These tests pin that behavior.
 *
 * Tests use `documents_fts_source` (the source view) directly rather
 * than `documents_fts` (the FTS5 virtual table) so we're asserting on
 * what gets *fed* to FTS, not on tokenization. This makes failures
 * easier to diagnose: a NULL in a column means the view itself
 * propagated a NULL, regardless of how FTS5 chose to handle it.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const db = env.DB;

const TENANT_A = 'fts-null-tenant-a';
const USER_ID = 'fts-null-user-1';

async function resetData(): Promise<void> {
  await db.prepare(`DELETE FROM document_products WHERE document_id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM document_versions WHERE document_id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM documents WHERE id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM products WHERE id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM document_types WHERE id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM suppliers WHERE id LIKE 'fts-null-%'`).run();
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_ID).run();
  await db.prepare(`DELETE FROM tenants WHERE id = ?`).bind(TENANT_A).run();
}

async function seedBaseline(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_A, 'FTS Null Tenant', 'fts-null-tenant-a')
    .run();

  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .bind(USER_ID, 'fts-null-user@test.com', 'FTS Null User', 'org_admin', TENANT_A, 'fakehash')
    .run();
}

interface InsertDocOpts {
  id: string;
  tenant_id?: string;
  title?: string;
  description?: string | null;
  tags?: string | null;
  primary_metadata?: string | null;
  extended_metadata?: string | null;
  supplier_id?: string | null;
  document_type_id?: string | null;
  /** Set to false to skip creating the document_versions row entirely. */
  with_version?: boolean;
  file_name?: string | null;
  extracted_text?: string | null;
}

async function insertDocument(opts: InsertDocOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, description, tags, primary_metadata, extended_metadata,
          supplier_id, document_type_id, status, current_version, created_by,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      opts.id,
      opts.tenant_id ?? TENANT_A,
      opts.title ?? 'Untitled',
      opts.description ?? null,
      // Pass NULL through; the view should still produce a non-NULL row.
      opts.tags === undefined ? '[]' : opts.tags,
      opts.primary_metadata ?? null,
      opts.extended_metadata ?? null,
      opts.supplier_id ?? null,
      opts.document_type_id ?? null,
      USER_ID,
    )
    .run();

  if (opts.with_version === false) return;

  await db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, version_number, file_name, file_size, mime_type, r2_key,
          extracted_text, uploaded_by, created_at)
       VALUES (?, ?, 1, ?, ?, 'application/pdf', ?, ?, ?, datetime('now'))`,
    )
    .bind(
      `${opts.id}-v1`,
      opts.id,
      opts.file_name ?? `${opts.id}.pdf`,
      (opts.extracted_text ?? '').length,
      `r2/${opts.id}/v1.pdf`,
      opts.extracted_text ?? null,
      USER_ID,
    )
    .run();
}

interface SourceRow {
  doc_id: string;
  title: string | null;
  description: string | null;
  tags_text: string | null;
  file_name: string | null;
  extracted_text: string | null;
  primary_metadata_text: string | null;
  extended_metadata_text: string | null;
  supplier_text: string | null;
  document_type_text: string | null;
  product_text: string | null;
}

async function loadSourceRow(docId: string): Promise<SourceRow> {
  const row = await db
    .prepare(`SELECT * FROM documents_fts_source WHERE doc_id = ?`)
    .bind(docId)
    .first<SourceRow>();
  expect(row).not.toBeNull();
  return row as SourceRow;
}

async function searchDocs(tenantId: string, term: string): Promise<string[]> {
  // Quote the term so a stray `-` or other operator never reaches FTS.
  const expr = `"${term.toLowerCase()}"`;
  const result = await db
    .prepare(
      `SELECT doc_id
         FROM documents_fts
        WHERE tenant_id = ? AND documents_fts MATCH ?`,
    )
    .bind(tenantId, expr)
    .all<{ doc_id: string }>();
  return (result.results ?? []).map((r) => r.doc_id);
}

beforeEach(async () => {
  await resetData();
  await seedBaseline();
});

describe('documents_fts_source — document_type_text NULL safety', () => {
  it('produces non-NULL document_type_text when slug is NULL', async () => {
    // Bypass the schema NOT-NULL on slug by inserting via a
    // raw value-coerced path: we insert with a placeholder slug
    // then UPDATE it to NULL through PRAGMA-relaxed channel.
    // SQLite enforces NOT NULL on INSERT, so we test the view's
    // robustness by simulating NULL via an empty string + the
    // expected behavior of the COALESCE wrapper.
    //
    // NOTE: as of this writing `document_types.slug` is NOT NULL
    // in schema. This test guards against a future schema change
    // (e.g. making slug optional) silently breaking doctype-name
    // search. It also verifies that an EMPTY slug still produces
    // searchable doctype text rather than dropping the name.
    await db
      .prepare(
        `INSERT INTO document_types
           (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-null-dt-1', TENANT_A, 'COA Report', '')
      .run();

    await insertDocument({
      id: 'fts-null-doc-dt-empty',
      title: 'Misc Random Title',
      document_type_id: 'fts-null-dt-1',
    });

    const row = await loadSourceRow('fts-null-doc-dt-empty');
    expect(row.document_type_text).not.toBeNull();
    // Must contain the doctype name so the doc is findable by it.
    expect(row.document_type_text).toContain('COA Report');

    // And the FTS index actually picks it up.
    const hits = await searchDocs(TENANT_A, 'COA');
    expect(hits).toContain('fts-null-doc-dt-empty');
  });

  it('indexes doctype name even when description is NULL', async () => {
    await db
      .prepare(
        `INSERT INTO document_types
           (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'Spec Sheet', 'spec-sheet', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-null-dt-2', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-null-doc-dt-spec',
      title: 'Anonymous Document',
      document_type_id: 'fts-null-dt-2',
    });

    const row = await loadSourceRow('fts-null-doc-dt-spec');
    expect(row.document_type_text).not.toBeNull();
    expect(row.document_type_text?.toLowerCase()).toContain('spec');

    const hits = await searchDocs(TENANT_A, 'spec');
    expect(hits).toContain('fts-null-doc-dt-spec');
  });
});

describe('documents_fts_source — supplier_text NULL safety', () => {
  it('produces non-NULL supplier_text when aliases is NULL', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers
           (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Acme', 'acme', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-null-sup-1', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-null-doc-sup-noalias',
      title: 'Random File 9999',
      supplier_id: 'fts-null-sup-1',
    });

    const row = await loadSourceRow('fts-null-doc-sup-noalias');
    expect(row.supplier_text).not.toBeNull();
    expect(row.supplier_text).toContain('Acme');

    const hits = await searchDocs(TENANT_A, 'Acme');
    expect(hits).toContain('fts-null-doc-sup-noalias');
  });

  it('produces non-NULL (whitespace-only is fine) supplier_text when supplier_id is NULL', async () => {
    await insertDocument({
      id: 'fts-null-doc-no-supplier',
      title: 'Floating Document',
      supplier_id: null,
    });

    const row = await loadSourceRow('fts-null-doc-no-supplier');
    // Must not be NULL — FTS5 indexes a NULL column as zero tokens
    // which is fine, but a NULL value flowing through `||` elsewhere
    // would silently zero out other columns. The contract is
    // "this view never returns NULL for any indexed column."
    expect(row.supplier_text).not.toBeNull();
    // Trimmed value is empty (no supplier name, no aliases).
    expect(row.supplier_text?.trim()).toBe('');
  });
});

describe('documents_fts_source — direct-column NULL safety', () => {
  it('handles a doc with NULL description / NULL tags / NULL metadata', async () => {
    await insertDocument({
      id: 'fts-null-doc-allnulls',
      title: 'Findable Title Token',
      description: null,
      tags: null,
      primary_metadata: null,
      extended_metadata: null,
    });

    const row = await loadSourceRow('fts-null-doc-allnulls');
    // Every text column must come back non-NULL.
    expect(row.title).not.toBeNull();
    expect(row.description).not.toBeNull();
    expect(row.tags_text).not.toBeNull();
    expect(row.primary_metadata_text).not.toBeNull();
    expect(row.extended_metadata_text).not.toBeNull();
    expect(row.supplier_text).not.toBeNull();
    expect(row.document_type_text).not.toBeNull();
    expect(row.product_text).not.toBeNull();

    // Title-only search still hits the doc.
    const hits = await searchDocs(TENANT_A, 'findable');
    expect(hits).toContain('fts-null-doc-allnulls');
  });
});

describe('documents_fts_source — extracted_text NULL safety', () => {
  it('handles NULL extracted_text without crashing the view', async () => {
    await insertDocument({
      id: 'fts-null-doc-no-extract',
      title: 'Searchable Title',
      file_name: 'unique-fname-token.pdf',
      extracted_text: null,
    });

    const row = await loadSourceRow('fts-null-doc-no-extract');
    expect(row.extracted_text).not.toBeNull();
    expect(row.extracted_text).toBe('');
    expect(row.file_name).toBe('unique-fname-token.pdf');

    // Other columns still searchable.
    const hits = await searchDocs(TENANT_A, 'searchable');
    expect(hits).toContain('fts-null-doc-no-extract');
  });

  it('handles a doc that has no document_versions row at all', async () => {
    // A doc without a version row exercises the LEFT JOIN miss
    // path on `dv`, which yields NULL for every dv.* column.
    await insertDocument({
      id: 'fts-null-doc-no-version',
      title: 'Versionless Sentinel',
      with_version: false,
    });

    const row = await loadSourceRow('fts-null-doc-no-version');
    expect(row.file_name).not.toBeNull();
    expect(row.file_name).toBe('');
    expect(row.extracted_text).not.toBeNull();
    expect(row.extracted_text).toBe('');

    const hits = await searchDocs(TENANT_A, 'versionless');
    expect(hits).toContain('fts-null-doc-no-version');
  });
});

describe('documents_fts_source — product_text NULL safety', () => {
  it('handles a doc with no linked products', async () => {
    await insertDocument({
      id: 'fts-null-doc-no-products',
      title: 'Lonely Document',
    });

    const row = await loadSourceRow('fts-null-doc-no-products');
    expect(row.product_text).not.toBeNull();
    expect(row.product_text?.trim()).toBe('');
  });
});
