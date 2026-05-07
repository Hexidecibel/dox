/**
 * Phase 1 unit tests for the documents_fts FTS5 backbone (migration 0054).
 *
 * Drives the FTS5 virtual table directly via env.DB — no HTTP layer. The
 * sanitizer used in tests mirrors what Phase 4 will ship in the API
 * handler, but it lives here as a small helper because the API handler
 * doesn't exist yet at this phase.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const db = env.DB;

// Stable test IDs — kept short and prefixed so we can clean them between
// tests without worrying about cross-table FK fan-out.
const TENANT_A = 'fts-tenant-a';
const TENANT_B = 'fts-tenant-b';
const USER_ID = 'fts-user-1';

/**
 * Strip FTS5 operators from user input and quote each token, with a `*`
 * appended to the last token for prefix matching. This mirrors the
 * Phase 4 server-side sanitizer described in the plan.
 *
 * - Strips: `-`, `*`, `:`, `(`, `)`, `"`
 * - Treats reserved-word `NEAR` as a regular token (lowercased + quoted)
 * - Each token is quoted with `"..."` so it cannot be parsed as an op
 * - Last token gets `*` for prefix matching
 */
function buildMatchExpr(input: string): string {
  // Drop characters that have meaning inside FTS5 expressions.
  const cleaned = input.replace(/["*:()\-]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens
    .map((tok, i) => {
      const quoted = `"${tok.toLowerCase()}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' ');
}

async function resetData(): Promise<void> {
  // Clean in FK-safe order. Deletes cascade through document_versions
  // and document_products via FK ON DELETE CASCADE / explicit deletes.
  await db.prepare(`DELETE FROM document_products WHERE document_id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM document_versions WHERE document_id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM documents WHERE id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM products WHERE id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM document_types WHERE id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM suppliers WHERE id LIKE 'fts-%'`).run();
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_ID).run();
  await db.prepare(`DELETE FROM tenants WHERE id IN (?, ?)`).bind(TENANT_A, TENANT_B).run();
}

async function seedBaseline(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_A, 'FTS Tenant A', 'fts-tenant-a')
    .run();
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_B, 'FTS Tenant B', 'fts-tenant-b')
    .run();

  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .bind(USER_ID, 'fts-user@test.com', 'FTS User', 'org_admin', TENANT_A, 'fakehash')
    .run();
}

interface InsertDocOpts {
  id: string;
  tenant_id: string;
  title: string;
  description?: string | null;
  tags?: string | null;
  supplier_id?: string | null;
  document_type_id?: string | null;
  file_name?: string | null;
  extracted_text?: string | null;
}

async function insertDocument(opts: InsertDocOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, description, tags, supplier_id, document_type_id, status, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      opts.id,
      opts.tenant_id,
      opts.title,
      opts.description ?? null,
      opts.tags ?? '[]',
      opts.supplier_id ?? null,
      opts.document_type_id ?? null,
      USER_ID,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, extracted_text, uploaded_by, created_at)
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

interface SearchRow {
  doc_id: string;
}

async function searchDocs(
  tenantId: string,
  rawQuery: string,
): Promise<string[]> {
  const matchExpr = buildMatchExpr(rawQuery);
  const result = await db
    .prepare(
      `SELECT doc_id
       FROM documents_fts
       WHERE tenant_id = ? AND documents_fts MATCH ?
       ORDER BY rank`,
    )
    .bind(tenantId, matchExpr)
    .all<SearchRow>();
  return (result.results ?? []).map((r) => r.doc_id);
}

beforeEach(async () => {
  await resetData();
  await seedBaseline();
});

describe('documents_fts — tenant isolation', () => {
  it('MATCH for a term in both tenants returns only the requesting tenant rows', async () => {
    await insertDocument({ id: 'fts-doc-a1', tenant_id: TENANT_A, title: 'Acme Cheese COA' });
    await insertDocument({ id: 'fts-doc-b1', tenant_id: TENANT_B, title: 'Acme Cheese COA' });

    const aResults = await searchDocs(TENANT_A, 'acme');
    const bResults = await searchDocs(TENANT_B, 'acme');

    expect(aResults).toEqual(['fts-doc-a1']);
    expect(bResults).toEqual(['fts-doc-b1']);
  });
});

describe('documents_fts — multi-token AND', () => {
  it('matches a doc whose title contains all tokens', async () => {
    await insertDocument({ id: 'fts-doc-1', tenant_id: TENANT_A, title: 'Darigold Cheese COA' });
    const results = await searchDocs(TENANT_A, 'darigold cheese');
    expect(results).toContain('fts-doc-1');
  });

  it('does NOT match a doc that has only one of the tokens', async () => {
    await insertDocument({ id: 'fts-doc-2', tenant_id: TENANT_A, title: 'Darigold' });
    await insertDocument({ id: 'fts-doc-3', tenant_id: TENANT_A, title: 'Darigold Cheese COA' });

    const results = await searchDocs(TENANT_A, 'darigold cheese');
    expect(results).toContain('fts-doc-3');
    expect(results).not.toContain('fts-doc-2');
  });
});

describe('documents_fts — supplier-name match', () => {
  it('matches a doc via its linked supplier name', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Darigold', 'darigold', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-sup-1', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-doc-sup',
      tenant_id: TENANT_A,
      title: 'Quarterly Report',
      description: 'Generic description with no supplier name in it',
      supplier_id: 'fts-sup-1',
    });

    const results = await searchDocs(TENANT_A, 'darigold');
    expect(results).toContain('fts-doc-sup');
  });

  it('matches a doc via supplier alias (JSON array)', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Northwest Dairy', 'northwest-dairy', ?, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-sup-2', TENANT_A, JSON.stringify(['Darigold Foods', 'NW Dairy']))
      .run();

    await insertDocument({
      id: 'fts-doc-alias',
      tenant_id: TENANT_A,
      title: 'Cheese Spec',
      supplier_id: 'fts-sup-2',
    });

    const results = await searchDocs(TENANT_A, 'darigold');
    expect(results).toContain('fts-doc-alias');
  });
});

describe('documents_fts — document_type match', () => {
  it('matches a doc via its document_type name', async () => {
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'Certificate of Analysis', 'coa', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-dt-1', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-doc-dt',
      tenant_id: TENANT_A,
      title: 'Random File 12345',
      document_type_id: 'fts-dt-1',
    });

    const results = await searchDocs(TENANT_A, 'certificate');
    expect(results).toContain('fts-doc-dt');
  });
});

describe('documents_fts — product match', () => {
  it('matches a doc via its linked product name', async () => {
    await db
      .prepare(
        `INSERT INTO products (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'Butter', 'butter', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-prod-1', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-doc-prod',
      tenant_id: TENANT_A,
      title: 'Spec sheet 2024',
    });

    await db
      .prepare(
        `INSERT INTO document_products (id, document_id, product_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .bind('fts-dp-1', 'fts-doc-prod', 'fts-prod-1')
      .run();

    const results = await searchDocs(TENANT_A, 'butter');
    expect(results).toContain('fts-doc-prod');
  });
});

describe('documents_fts — extracted_text 200KB cap', () => {
  it('does not match a term beyond byte 200000 in extracted_text', async () => {
    // Build a 300KB string. Place a unique sentinel ("zzunique12345")
    // at byte 250000, and a different sentinel ("aastartmark") near the
    // top so we can prove the *same* doc matches early-text terms.
    const filler = 'x'.repeat(60);
    const earlyMark = 'aastartmark';
    const lateMark = 'zzuniquesentinel';

    const head = `${earlyMark} ` + (filler + ' ').repeat(100); // ~6KB
    const padTo = 250000;
    const padding = filler.repeat(Math.ceil((padTo - head.length) / filler.length));
    const tail = ` ${lateMark} ` + 'y'.repeat(50000);
    const longText = (head + padding + tail).slice(0, 300_000);

    expect(longText.length).toBeGreaterThan(240_000);
    expect(longText.indexOf(lateMark)).toBeGreaterThan(200_000);
    expect(longText.indexOf(earlyMark)).toBeLessThan(200);

    await insertDocument({
      id: 'fts-doc-long',
      tenant_id: TENANT_A,
      title: 'Long Doc',
      extracted_text: longText,
    });

    const earlyHits = await searchDocs(TENANT_A, 'aastartmark');
    const lateHits = await searchDocs(TENANT_A, 'zzuniquesentinel');

    expect(earlyHits).toContain('fts-doc-long');
    expect(lateHits).not.toContain('fts-doc-long');
  });
});

describe('documents_fts — prefix on last token', () => {
  it('matches a single-token prefix search', async () => {
    await insertDocument({ id: 'fts-doc-pfx-1', tenant_id: TENANT_A, title: 'Darigold COA' });
    const results = await searchDocs(TENANT_A, 'dari');
    expect(results).toContain('fts-doc-pfx-1');
  });

  it('matches multi-token where last token is a prefix', async () => {
    await insertDocument({ id: 'fts-doc-pfx-2', tenant_id: TENANT_A, title: 'Darigold Cheese' });
    const results = await searchDocs(TENANT_A, 'darigold chee');
    expect(results).toContain('fts-doc-pfx-2');
  });
});

describe('documents_fts — operator sanitization', () => {
  it('treats FTS5 operators in input as plain text without errors', async () => {
    await insertDocument({
      id: 'fts-doc-safe',
      tenant_id: TENANT_A,
      title: 'Hello World',
    });
    await insertDocument({
      id: 'fts-doc-near',
      tenant_id: TENANT_A,
      title: 'NEAR Hello',
    });

    // Operator-only input must not raise a SQL error; an empty matcher
    // returns nothing rather than blowing up.
    await expect(searchDocs(TENANT_A, '*"():-')).resolves.toBeDefined();

    // `NEAR` is an FTS5 reserved word — without sanitization it would
    // either be parsed as the NEAR operator (syntax error: missing
    // arguments) or match positionally. With the sanitizer it must be
    // treated as a literal token, so "NEAR hello" only matches docs
    // that actually contain BOTH `NEAR` and `hello` as tokens.
    const results = await searchDocs(TENANT_A, 'NEAR hello');
    expect(results).toContain('fts-doc-near');
    expect(results).not.toContain('fts-doc-safe');

    // Hyphen / quote / paren input should not throw and should still
    // search by the surviving tokens.
    const evilResults = await searchDocs(TENANT_A, 'hello "world(":-');
    expect(evilResults).toContain('fts-doc-safe');
  });
});

describe('documents_fts — document delete cascade', () => {
  it('removes the FTS row when its parent document is deleted', async () => {
    await insertDocument({ id: 'fts-doc-del', tenant_id: TENANT_A, title: 'Soon Gone' });

    let results = await searchDocs(TENANT_A, 'gone');
    expect(results).toContain('fts-doc-del');

    // Delete versions first so the FK doesn't block; the trigger should
    // still remove the FTS row when the parent document is deleted.
    await db.prepare(`DELETE FROM document_versions WHERE document_id = ?`).bind('fts-doc-del').run();
    await db.prepare(`DELETE FROM documents WHERE id = ?`).bind('fts-doc-del').run();

    results = await searchDocs(TENANT_A, 'gone');
    expect(results).not.toContain('fts-doc-del');
  });
});

describe('documents_fts — supplier rename does NOT immediately update FTS', () => {
  it('keeps the old supplier text on the FTS row after a supplier UPDATE (Phase 2 will drain async)', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'OldName', 'oldname', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('fts-sup-rename', TENANT_A)
      .run();

    await insertDocument({
      id: 'fts-doc-rename',
      tenant_id: TENANT_A,
      title: 'Boring Title',
      supplier_id: 'fts-sup-rename',
    });

    // Initial: matches by supplier name.
    let results = await searchDocs(TENANT_A, 'oldname');
    expect(results).toContain('fts-doc-rename');

    // Rename the supplier. Phase 1 boundary: trigger MUST NOT fan out
    // to docs (Phase 2 adds the async reindex queue). So the old name
    // should still match, and the new name should NOT match yet.
    await db
      .prepare(`UPDATE suppliers SET name = 'NewName' WHERE id = ?`)
      .bind('fts-sup-rename')
      .run();

    const oldStill = await searchDocs(TENANT_A, 'oldname');
    const newYet = await searchDocs(TENANT_A, 'newname');
    expect(oldStill).toContain('fts-doc-rename');
    expect(newYet).not.toContain('fts-doc-rename');
  });
});
