/**
 * Lot-search tests for the documents_fts `lot_text` column (migration 0074,
 * COA sublot split / Option B).
 *
 * Two layers:
 *   1. Pure helper tests for normalizeLotTerm + buildMatchExprWithLot
 *      (the query-normalization that makes separators irrelevant).
 *   2. FTS5 integration: insert per-sublot COA docs linked via
 *      document_lots → lots, then prove that a MAIN-lot query returns ALL
 *      sublot docs and a combined-lot query returns the exact one — with
 *      and without separators in the query.
 *
 * Mirrors tests/unit/search-fts-documents.test.ts (Phase 1 FTS backbone).
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeLotTerm,
  buildMatchExprWithLot,
} from '../../functions/lib/search-fts';

const db = env.DB;

const TENANT_A = 'lotfts-tenant-a';
const USER_ID = 'lotfts-user-1';

// =====================================================================
// 1. Query-normalization helpers
// =====================================================================

describe('normalizeLotTerm', () => {
  it('strips separators and uppercases', () => {
    expect(normalizeLotTerm('10426110-05')).toBe('1042611005');
    expect(normalizeLotTerm('10426110 05')).toBe('1042611005');
    expect(normalizeLotTerm('1042611005')).toBe('1042611005');
    expect(normalizeLotTerm('  061926lc3 ')).toBe('061926LC3');
  });

  it('strips a leading LOT / # noise prefix', () => {
    expect(normalizeLotTerm('Lot# 1042611005')).toBe('1042611005');
    expect(normalizeLotTerm('#10426110 05')).toBe('1042611005');
  });

  it('returns "" for empty / non-alphanumeric input', () => {
    expect(normalizeLotTerm('')).toBe('');
    expect(normalizeLotTerm('   ')).toBe('');
    expect(normalizeLotTerm(null)).toBe('');
    expect(normalizeLotTerm('---')).toBe('');
  });
});

describe('buildMatchExprWithLot', () => {
  it('ORs a normalized, column-scoped lot prefix onto the base expr', () => {
    const expr = buildMatchExprWithLot('10426110-05');
    expect(expr).not.toBeNull();
    expect(expr).toContain('lot_text :');
    // normalized form is separator-free + lowercased, with prefix *
    expect(expr).toContain('"1042611005"*');
  });

  it('produces the SAME normalized lot term regardless of separators', () => {
    const a = buildMatchExprWithLot('10426110-05');
    const b = buildMatchExprWithLot('10426110 05');
    const c = buildMatchExprWithLot('1042611005');
    expect(a).toContain('lot_text : "1042611005"*');
    expect(b).toContain('lot_text : "1042611005"*');
    expect(c).toContain('lot_text : "1042611005"*');
  });

  it('returns null for empty input', () => {
    expect(buildMatchExprWithLot('')).toBeNull();
    expect(buildMatchExprWithLot('   ')).toBeNull();
  });

  it('does not add a lot clause for too-short normalized terms', () => {
    const expr = buildMatchExprWithLot('a');
    expect(expr).not.toBeNull();
    expect(expr).not.toContain('lot_text :');
  });
});

// =====================================================================
// 2. FTS integration — main-lot query returns all sublot docs
// =====================================================================

async function resetData(): Promise<void> {
  await db.prepare(`DELETE FROM document_lots WHERE document_id LIKE 'lotfts-%'`).run();
  await db.prepare(`DELETE FROM lots WHERE id LIKE 'lotfts-%'`).run();
  await db.prepare(`DELETE FROM document_versions WHERE document_id LIKE 'lotfts-%'`).run();
  await db.prepare(`DELETE FROM documents WHERE id LIKE 'lotfts-%'`).run();
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_ID).run();
  await db.prepare(`DELETE FROM tenants WHERE id = ?`).bind(TENANT_A).run();
}

async function seedBaseline(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_A, 'Lot FTS Tenant A', 'lotfts-tenant-a')
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .bind(USER_ID, 'lotfts-user@test.com', 'Lot FTS User', 'org_admin', TENANT_A, 'fakehash')
    .run();
}

async function insertCoaDoc(id: string, title: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, status, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '[]', 'active', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, TENANT_A, title, USER_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, uploaded_by, created_at)
       VALUES (?, ?, 1, ?, 0, 'application/pdf', ?, ?, datetime('now'))`,
    )
    .bind(`${id}-v1`, id, `${id}.pdf`, `r2/${id}/v1.pdf`, USER_ID)
    .run();
}

/**
 * Create a lot (with sublot) and link a doc to it via document_lots. The
 * link INSERT must fire trg_document_lots_ai_fts to populate lot_text.
 */
async function linkLot(
  lotId: string,
  docId: string,
  lotNumber: string,
  subLotCode: string,
): Promise<void> {
  // lot_key = norm(lot_number) + sub_lot_code (mirrors lots.ts).
  const norm = lotNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lotKey = norm + subLotCode;
  await db
    .prepare(
      `INSERT INTO lots (id, tenant_id, lot_number, sub_lot_code, lot_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(lotId, TENANT_A, lotNumber, subLotCode, lotKey)
    .run();
  await db
    .prepare(
      `INSERT INTO document_lots (id, document_id, lot_id, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .bind(`${docId}-dl-${lotId}`, docId, lotId)
    .run();
}

async function searchDocs(rawQuery: string): Promise<string[]> {
  const matchExpr = buildMatchExprWithLot(rawQuery);
  if (matchExpr === null) return [];
  const result = await db
    .prepare(
      `SELECT doc_id FROM documents_fts
       WHERE tenant_id = ? AND documents_fts MATCH ?
       ORDER BY rank`,
    )
    .bind(TENANT_A, matchExpr)
    .all<{ doc_id: string }>();
  return (result.results ?? []).map((r) => r.doc_id);
}

describe('documents_fts lot_text — sublot search', () => {
  beforeEach(async () => {
    await resetData();
    await seedBaseline();
    // Main lot 10426110 with three sublots, each its own COA doc.
    await insertCoaDoc('lotfts-doc-05', 'COA sublot 05');
    await insertCoaDoc('lotfts-doc-06', 'COA sublot 06');
    await insertCoaDoc('lotfts-doc-07', 'COA sublot 07');
    await linkLot('lotfts-lot-05', 'lotfts-doc-05', '10426110', '05');
    await linkLot('lotfts-lot-06', 'lotfts-doc-06', '10426110', '06');
    await linkLot('lotfts-lot-07', 'lotfts-doc-07', '10426110', '07');
    // A different main lot that must NOT leak into 10426110 searches.
    await insertCoaDoc('lotfts-doc-other', 'COA other lot');
    await linkLot('lotfts-lot-other', 'lotfts-doc-other', '99999999', '01');
  });

  it('main-lot query returns ALL sublot COAs', async () => {
    const results = await searchDocs('10426110');
    expect(results).toEqual(
      expect.arrayContaining(['lotfts-doc-05', 'lotfts-doc-06', 'lotfts-doc-07']),
    );
    expect(results).not.toContain('lotfts-doc-other');
  });

  it('combined-lot query returns the exact sublot COA', async () => {
    const results = await searchDocs('1042611005');
    expect(results).toContain('lotfts-doc-05');
    expect(results).not.toContain('lotfts-doc-06');
    expect(results).not.toContain('lotfts-doc-07');
  });

  it('separators in the query do not matter (combined sublot)', async () => {
    const dashed = await searchDocs('10426110-05');
    const spaced = await searchDocs('10426110 05');
    expect(dashed).toContain('lotfts-doc-05');
    expect(dashed).not.toContain('lotfts-doc-06');
    expect(spaced).toContain('lotfts-doc-05');
    expect(spaced).not.toContain('lotfts-doc-06');
  });

  it('removing the document_lots link drops the doc from lot search', async () => {
    let results = await searchDocs('1042611005');
    expect(results).toContain('lotfts-doc-05');

    await db
      .prepare(`DELETE FROM document_lots WHERE document_id = ?`)
      .bind('lotfts-doc-05')
      .run();

    results = await searchDocs('1042611005');
    expect(results).not.toContain('lotfts-doc-05');
  });
});
