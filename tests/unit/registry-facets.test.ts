/**
 * Registry taxonomy P1 — facet schema + shared lib.
 *
 * Covers migrations 0080 (requirements / claim_types / their junctions /
 * claim_type_requirements) and 0081 (documents.classification_status), plus the
 * generalized functions/lib/registry.ts facet-sync helpers.
 *
 * Two concerns deliberately kept together: a migration-applies check (the
 * chain is not re-runnable, so "does the DDL actually land" is worth asserting)
 * and unit coverage of the lib that writes through it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  FACETS,
  CLASSIFICATION_STATUSES,
  REGISTRY_LINK_STATUSES,
  CLAIM_SUBJECT_TYPES,
  isValidClassificationStatus,
  isReviewedClassification,
  isValidLinkStatus,
  isValidClaimSubjectType,
  isValidClaimSubjectGrain,
  parseFacetLinks,
  parseStringArray,
  validateFacetIds,
  validateClaimSubjects,
  syncDocumentFacet,
  listDocumentFacet,
  requirementsOpenedByClaims,
} from '../../functions/lib/registry';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

/** Table columns as a name->type map, straight from PRAGMA. */
async function columnsOf(table: string): Promise<Record<string, string>> {
  const rows = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string; type: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.name, r.type]));
}

async function indexNames(table: string): Promise<string[]> {
  const rows = await db
    .prepare(`PRAGMA index_list(${table})`)
    .all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

async function makeDocument(tenantId: string, title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by)
       VALUES (?, ?, ?, '[]', 1, 'active', ?)`,
    )
    .bind(id, tenantId, title, seed.userId)
    .run();
  return id;
}

async function makeRequirement(tenantId: string, slug: string, name: string) {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO requirements (id, tenant_id, slug, name, checklist, sort_order)
       VALUES (?, ?, ?, ?, 'SOP 102.2', 0)`,
    )
    .bind(id, tenantId, slug, name)
    .run();
  return id;
}

async function makeClaimType(tenantId: string, slug: string, name: string, grain = 'any') {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO claim_types (id, tenant_id, slug, name, subject_grain)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, slug, name, grain)
    .run();
  return id;
}

// Migrations are applied globally by tests/setup.ts (runMigrations), so the
// schema assertions below double as the migration-applies check for 0080/0081.
beforeEach(async () => {
  // Junctions first, then documents, then vocabularies — FK order.
  for (const t of [
    'document_requirements',
    'document_claims',
    'claim_type_requirements',
    'documents',
    'requirements',
    'claim_types',
    'products',
    'suppliers',
  ]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  seed = await seedTestData(db);
});

// ---------------------------------------------------------------------------

describe('migration 0080 — facet schema applies', () => {
  it('creates the layer-2 requirements vocabulary, tenant-scoped', async () => {
    const cols = await columnsOf('requirements');
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        'id', 'tenant_id', 'slug', 'name', 'description',
        'checklist', 'sort_order', 'active', 'created_at', 'updated_at',
      ]),
    );
  });

  it('creates the layer-3 claim_types vocabulary with a subject_grain', async () => {
    const cols = await columnsOf('claim_types');
    expect(cols).toHaveProperty('subject_grain');
    expect(cols).toHaveProperty('tenant_id');
  });

  it('creates claim_type_requirements — the claim -> what-proves-it mapping', async () => {
    const cols = await columnsOf('claim_type_requirements');
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(['tenant_id', 'claim_type_id', 'requirement_id', 'is_required']),
    );
  });

  it('creates both document junctions with the human-in-the-loop columns', async () => {
    for (const table of ['document_requirements', 'document_claims']) {
      const cols = await columnsOf(table);
      expect(Object.keys(cols)).toEqual(
        expect.arrayContaining(['status', 'source', 'confidence', 'created_by', 'confirmed_at', 'confirmed_by']),
      );
    }
    // Claims additionally carry the polymorphic subject + evidence.
    const claimCols = await columnsOf('document_claims');
    expect(Object.keys(claimCols)).toEqual(
      expect.arrayContaining(['subject_type', 'subject_id', 'evidence']),
    );
  });

  it('scopes the vocabularies per tenant via UNIQUE(tenant_id, slug)', async () => {
    await makeRequirement(seed.tenantId, 'allergen-matrix', 'Allergen Matrix');
    // Same slug in another tenant is fine — vocabularies are per-tenant rows.
    await expect(
      makeRequirement(seed.tenantId2, 'allergen-matrix', 'Allergen Matrix'),
    ).resolves.toBeTruthy();
    // Same slug in the SAME tenant is not.
    await expect(
      makeRequirement(seed.tenantId, 'allergen-matrix', 'Dupe'),
    ).rejects.toThrow();
  });

  it('guards duplicate tenant-wide claims despite a NULL subject_id', async () => {
    // Plain UNIQUE would not catch this: SQLite treats NULLs as distinct. The
    // expression index on COALESCE(subject_id,'') is what makes it work.
    expect(await indexNames('document_claims')).toContain('idx_document_claims_unique');

    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const claimId = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    const insert = () =>
      db
        .prepare(
          `INSERT INTO document_claims (id, document_id, claim_type_id, subject_type, subject_id)
           VALUES (?, ?, ?, 'tenant', NULL)`,
        )
        .bind(generateTestId(), docId, claimId)
        .run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('allows the same claim about two different subjects', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const claimId = await makeClaimType(seed.tenantId, 'organic', 'Organic', 'product');
    for (const subject of ['prod-a', 'prod-b']) {
      await db
        .prepare(
          `INSERT INTO document_claims (id, document_id, claim_type_id, subject_type, subject_id)
           VALUES (?, ?, ?, 'product', ?)`,
        )
        .bind(generateTestId(), docId, claimId, subject)
        .run();
    }
    const rows = await db
      .prepare('SELECT COUNT(*) AS n FROM document_claims WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('defaults a raw junction insert to suggested (fail-safe, never auto-confirmed)', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const reqId = await makeRequirement(seed.tenantId, 'gtin', 'GTIN');
    await db
      .prepare(
        `INSERT INTO document_requirements (id, document_id, requirement_id) VALUES (?, ?, ?)`,
      )
      .bind(generateTestId(), docId, reqId)
      .run();
    const row = await db
      .prepare('SELECT status, source FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .first<{ status: string; source: string }>();
    expect(row?.status).toBe('suggested');
    expect(row?.source).toBe('human');
  });

  it('rejects an out-of-set link status', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const reqId = await makeRequirement(seed.tenantId, 'gtin', 'GTIN');
    await expect(
      db
        .prepare(
          `INSERT INTO document_requirements (id, document_id, requirement_id, status)
           VALUES (?, ?, ?, 'maybe')`,
        )
        .bind(generateTestId(), docId, reqId)
        .run(),
    ).rejects.toThrow();
  });

  it('leaves the 0079 FTS pipeline intact (document_categories still readable)', async () => {
    // P1 must not break the existing index: documents_fts_source still selects
    // from document_categories, so an ordinary document insert must still fire
    // its triggers cleanly.
    const docId = await makeDocument(seed.tenantId, 'Registry Smoke Doc');
    const hit = await db
      .prepare('SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?')
      .bind('title:Registry')
      .all<{ doc_id: string }>();
    expect(hit.results.map((r) => r.doc_id)).toContain(docId);
  });
});

describe('migration 0081 — classification_status', () => {
  it('defaults every document to unclassified', async () => {
    const docId = await makeDocument(seed.tenantId, 'Untyped');
    const row = await db
      .prepare(
        `SELECT classification_status, classification_reviewed_at, classification_reviewed_by
           FROM documents WHERE id = ?`,
      )
      .bind(docId)
      .first<{
        classification_status: string;
        classification_reviewed_at: string | null;
        classification_reviewed_by: string | null;
      }>();
    expect(row?.classification_status).toBe('unclassified');
    expect(row?.classification_reviewed_at).toBeNull();
    expect(row?.classification_reviewed_by).toBeNull();
  });

  it('distinguishes never-touched from reviewed-and-unclassifiable', async () => {
    const a = await makeDocument(seed.tenantId, 'Never touched');
    const b = await makeDocument(seed.tenantId, 'Reviewed, hopeless');
    await db
      .prepare(
        `UPDATE documents
            SET classification_status = 'unclassifiable',
                classification_reviewed_at = datetime('now'),
                classification_reviewed_by = ?
          WHERE id = ?`,
      )
      .bind(seed.orgAdminId, b)
      .run();

    // The countable backlog is 'unclassified' ALONE — the terminal judgment
    // must not keep inflating it.
    const backlog = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents
          WHERE tenant_id = ? AND classification_status = 'unclassified'`,
      )
      .bind(seed.tenantId)
      .first<{ n: number }>();
    expect(backlog?.n).toBe(1);
    expect(a).toBeTruthy();
  });

  it('rejects an unknown classification status', async () => {
    const docId = await makeDocument(seed.tenantId, 'Doc');
    await expect(
      db
        .prepare('UPDATE documents SET classification_status = ? WHERE id = ?')
        .bind('sorta-classified', docId)
        .run(),
    ).rejects.toThrow();
  });

  it('indexes the status per tenant so the bucket is an index-only count', async () => {
    expect(await indexNames('documents')).toContain('idx_documents_classification_status');
  });
});

describe('registry lib — constants and validators', () => {
  it('exposes both junction-backed facets and nothing else', () => {
    expect(Object.keys(FACETS).sort()).toEqual(['claim', 'requirement']);
    expect(FACETS.requirement.junctionTable).toBe('document_requirements');
    expect(FACETS.claim.vocabColumn).toBe('claim_type_id');
  });

  it('validates classification statuses', () => {
    expect(CLASSIFICATION_STATUSES).toHaveLength(4);
    expect(isValidClassificationStatus('needs_review')).toBe(true);
    expect(isValidClassificationStatus('nope')).toBe(false);
    expect(isReviewedClassification('classified')).toBe(true);
    expect(isReviewedClassification('unclassifiable')).toBe(true);
    expect(isReviewedClassification('unclassified')).toBe(false);
    expect(isReviewedClassification('needs_review')).toBe(false);
  });

  it('validates link statuses and claim subject types', () => {
    expect(REGISTRY_LINK_STATUSES).toEqual(['suggested', 'confirmed', 'rejected']);
    expect(isValidLinkStatus('rejected')).toBe(true);
    expect(isValidLinkStatus('approved')).toBe(false);
    expect(CLAIM_SUBJECT_TYPES).toContain('product');
    expect(CLAIM_SUBJECT_TYPES).toContain('supplier');
    expect(isValidClaimSubjectType('facility')).toBe(true);
    expect(isValidClaimSubjectType('any')).toBe(false); // 'any' is a grain, not a subject
    expect(isValidClaimSubjectGrain('any')).toBe(true);
  });
});

describe('registry lib — parseFacetLinks', () => {
  it('accepts bare id arrays (the simple multi-select shape)', () => {
    expect(parseFacetLinks('["a"," b ",""]', 'requirements')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('accepts rich objects and mixed arrays (the extraction shape)', () => {
    const links = parseFacetLinks(
      JSON.stringify([
        'a',
        {
          id: 'b',
          status: 'suggested',
          source: 'extraction',
          confidence: 0.82,
          subject_type: 'product',
          subject_id: 'prod-1',
          evidence: 'Certified Organic',
        },
      ]),
      'claims',
    );
    expect(links[0]).toEqual({ id: 'a' });
    expect(links[1]).toMatchObject({
      id: 'b',
      status: 'suggested',
      source: 'extraction',
      confidence: 0.82,
      subjectType: 'product',
      subjectId: 'prod-1',
      evidence: 'Certified Organic',
    });
  });

  it('accepts camelCase subject keys too', () => {
    const [link] = parseFacetLinks(
      [{ id: 'b', subjectType: 'supplier', subjectId: 'sup-1' }] as unknown[],
      'claims',
    );
    expect(link).toMatchObject({ subjectType: 'supplier', subjectId: 'sup-1' });
  });

  it('returns [] for null/empty and throws on garbage', () => {
    expect(parseFacetLinks(null, 'claims')).toEqual([]);
    expect(parseFacetLinks('', 'claims')).toEqual([]);
    expect(() => parseFacetLinks('{', 'claims')).toThrow(/valid JSON array/);
    expect(() => parseFacetLinks('{"id":"a"}', 'claims')).toThrow(/JSON array/);
    expect(() => parseFacetLinks('[{}]', 'claims')).toThrow(/must have an id/);
    expect(() => parseFacetLinks('[{"id":"a","status":"yes"}]', 'claims')).toThrow(/invalid status/);
    expect(() => parseFacetLinks('[{"id":"a","source":"vibes"}]', 'claims')).toThrow(/invalid source/);
    expect(() => parseFacetLinks('[{"id":"a","subject_type":"planet"}]', 'claims')).toThrow(/invalid subject_type/);
    expect(() => parseFacetLinks('[{"id":"a","confidence":4}]', 'claims')).toThrow(/between 0 and 1/);
  });

  it('still parses plain string arrays for aliases/criteria', () => {
    expect(parseStringArray('["x","y"]', 'aliases')).toEqual(['x', 'y']);
  });
});

describe('registry lib — validateFacetIds', () => {
  it('accepts in-tenant vocabulary ids for either facet', async () => {
    const reqId = await makeRequirement(seed.tenantId, 'gtin', 'GTIN');
    const claimId = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await expect(validateFacetIds(db, 'requirement', seed.tenantId, [reqId])).resolves.toBeUndefined();
    await expect(validateFacetIds(db, 'claim', seed.tenantId, [{ id: claimId }])).resolves.toBeUndefined();
  });

  it('rejects a cross-tenant vocabulary id', async () => {
    const foreign = await makeRequirement(seed.tenantId2, 'gtin', 'GTIN');
    await expect(
      validateFacetIds(db, 'requirement', seed.tenantId, [foreign]),
    ).rejects.toThrow(/Invalid requirement\(s\) for this tenant/);
  });

  it('names the right noun per facet', async () => {
    const foreign = await makeClaimType(seed.tenantId2, 'organic', 'Organic');
    await expect(
      validateFacetIds(db, 'claim', seed.tenantId, [foreign]),
    ).rejects.toThrow(/Invalid claim type\(s\)/);
  });

  it('is a no-op for an empty list', async () => {
    await expect(validateFacetIds(db, 'claim', seed.tenantId, [])).resolves.toBeUndefined();
  });
});

describe('registry lib — validateClaimSubjects', () => {
  it('accepts a tenant-wide claim with no subject', async () => {
    await expect(validateClaimSubjects(db, seed.tenantId, [{ id: 'c' }])).resolves.toBeUndefined();
  });

  it('rejects a tenant-wide claim that smuggles in a subject id', async () => {
    await expect(
      validateClaimSubjects(db, seed.tenantId, [{ id: 'c', subjectType: 'tenant', subjectId: 'x' }]),
    ).rejects.toThrow(/must not carry a subject_id/);
  });

  it('requires a subject id for a narrower grain', async () => {
    await expect(
      validateClaimSubjects(db, seed.tenantId, [{ id: 'c', subjectType: 'product' }]),
    ).rejects.toThrow(/requires a subject_id/);
  });

  it('tenant-scopes a product subject — the check an FK could not have made', async () => {
    const productId = generateTestId();
    await db
      .prepare(`INSERT INTO products (id, tenant_id, name, slug) VALUES (?, ?, 'Butter', 'butter')`)
      .bind(productId, seed.tenantId2)
      .run();
    // The product exists, so a raw FK would have passed it. It belongs to
    // another tenant, so this must not.
    await expect(
      validateClaimSubjects(db, seed.tenantId, [
        { id: 'c', subjectType: 'product', subjectId: productId },
      ]),
    ).rejects.toThrow(/claim subject product/);
    await expect(
      validateClaimSubjects(db, seed.tenantId2, [
        { id: 'c', subjectType: 'product', subjectId: productId },
      ]),
    ).resolves.toBeUndefined();
  });

  it('tenant-scopes a supplier subject', async () => {
    const supplierId = generateTestId();
    await db
      .prepare(`INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, 'Darigold', 'darigold')`)
      .bind(supplierId, seed.tenantId)
      .run();
    await expect(
      validateClaimSubjects(db, seed.tenantId, [
        { id: 'c', subjectType: 'supplier', subjectId: supplierId },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      validateClaimSubjects(db, seed.tenantId2, [
        { id: 'c', subjectType: 'supplier', subjectId: supplierId },
      ]),
    ).rejects.toThrow(/claim subject supplier/);
  });

  it('lets a facility subject through as free text (no facility entity yet)', async () => {
    await expect(
      validateClaimSubjects(db, seed.tenantId, [
        { id: 'c', subjectType: 'facility', subjectId: 'Kent' },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('registry lib — syncDocumentFacet', () => {
  it('closes many requirements with one document (the layer-2 point)', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const ids = [];
    for (const [slug, name] of [
      ['spec-sheet', 'Spec Sheet'],
      ['micro-limits', 'Micro Limits'],
      ['pack-size', 'Pack Size'],
      ['nutritionals', '100g Nutritionals'],
      ['allergen-matrix', 'Allergen Matrix'],
      ['country-of-origin', 'Country of Origin'],
      ['gtin', 'GTIN'],
    ]) {
      ids.push(await makeRequirement(seed.tenantId, slug, name));
    }

    await syncDocumentFacet(db, 'requirement', docId, ids, { actorId: seed.userId });

    const rows = await db
      .prepare('SELECT status, source, confirmed_by FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .all<{ status: string; source: string; confirmed_by: string | null }>();
    expect(rows.results).toHaveLength(7);
    // The human editing path confirms; the DB default alone would have left
    // these 'suggested'.
    expect(rows.results.every((r) => r.status === 'confirmed')).toBe(true);
    expect(rows.results.every((r) => r.source === 'human')).toBe(true);
    expect(rows.results.every((r) => r.confirmed_by === seed.userId)).toBe(true);
  });

  it('REPLACES the set rather than appending', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const a = await makeRequirement(seed.tenantId, 'a', 'A');
    const b = await makeRequirement(seed.tenantId, 'b', 'B');
    const c = await makeRequirement(seed.tenantId, 'c', 'C');

    await syncDocumentFacet(db, 'requirement', docId, [a, b]);
    await syncDocumentFacet(db, 'requirement', docId, [c]);

    const rows = await db
      .prepare('SELECT requirement_id FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .all<{ requirement_id: string }>();
    expect(rows.results.map((r) => r.requirement_id)).toEqual([c]);
  });

  it('is idempotent and dedupes a payload with repeats', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const a = await makeRequirement(seed.tenantId, 'a', 'A');
    await syncDocumentFacet(db, 'requirement', docId, [a, a, a]);
    await syncDocumentFacet(db, 'requirement', docId, [a]);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('lands machine-proposed claims as suggestions, never confirmed', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await syncDocumentFacet(
      db,
      'claim',
      docId,
      [{ id: organic, confidence: 0.9, evidence: 'USDA Organic', subjectType: 'facility', subjectId: 'Kent' }],
      { defaultStatus: 'suggested', defaultSource: 'extraction' },
    );
    const row = await db
      .prepare(
        `SELECT status, source, confidence, evidence, subject_type, subject_id, confirmed_at
           FROM document_claims WHERE document_id = ?`,
      )
      .bind(docId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: 'suggested',
      source: 'extraction',
      confidence: 0.9,
      evidence: 'USDA Organic',
      subject_type: 'facility',
      subject_id: 'Kent',
    });
    expect(row?.confirmed_at).toBeNull();
  });

  it('defaults a claim with no subject to the tenant grain', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await syncDocumentFacet(db, 'claim', docId, [organic]);
    const row = await db
      .prepare('SELECT subject_type, subject_id FROM document_claims WHERE document_id = ?')
      .bind(docId)
      .first<{ subject_type: string; subject_id: string | null }>();
    expect(row?.subject_type).toBe('tenant');
    expect(row?.subject_id).toBeNull();
  });

  it('preserveRejected stops a re-run resurrecting a human rejection', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    const kosher = await makeClaimType(seed.tenantId, 'kosher', 'Kosher');

    await syncDocumentFacet(db, 'claim', docId, [
      { id: organic, status: 'rejected' },
      { id: kosher, status: 'confirmed' },
    ]);

    // An extraction pass re-proposes both.
    await syncDocumentFacet(
      db,
      'claim',
      docId,
      [{ id: organic }, { id: kosher }],
      { defaultStatus: 'suggested', defaultSource: 'extraction', preserveRejected: true },
    );

    const rows = await db
      .prepare('SELECT claim_type_id, status FROM document_claims WHERE document_id = ? ORDER BY status')
      .bind(docId)
      .all<{ claim_type_id: string; status: string }>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.claim_type_id, r.status]));
    expect(byId[organic]).toBe('rejected'); // survived, not re-suggested
    expect(byId[kosher]).toBe('suggested');
    expect(rows.results).toHaveLength(2);
  });

  it('clears rejections when a human explicitly replaces the set', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await syncDocumentFacet(db, 'claim', docId, [{ id: organic, status: 'rejected' }]);
    await syncDocumentFacet(db, 'claim', docId, [{ id: organic, status: 'confirmed' }]);
    const row = await db
      .prepare('SELECT status FROM document_claims WHERE document_id = ?')
      .bind(docId)
      .first<{ status: string }>();
    expect(row?.status).toBe('confirmed');
  });

  it('clears the set when given an empty list', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const a = await makeRequirement(seed.tenantId, 'a', 'A');
    await syncDocumentFacet(db, 'requirement', docId, [a]);
    await syncDocumentFacet(db, 'requirement', docId, []);
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('cascades link rows away when the document is deleted', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const a = await makeRequirement(seed.tenantId, 'a', 'A');
    await syncDocumentFacet(db, 'requirement', docId, [a]);
    await db.prepare('DELETE FROM documents WHERE id = ?').bind(docId).run();
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_requirements WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe('registry lib — listDocumentFacet', () => {
  it('joins the vocabulary in and honours the tenant sort order', async () => {
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const zeta = generateTestId();
    const alpha = generateTestId();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name, sort_order) VALUES (?, ?, 'zeta', 'Zeta', 1)`)
      .bind(zeta, seed.tenantId)
      .run();
    await db
      .prepare(`INSERT INTO requirements (id, tenant_id, slug, name, sort_order) VALUES (?, ?, 'alpha', 'Alpha', 0)`)
      .bind(alpha, seed.tenantId)
      .run();

    await syncDocumentFacet(db, 'requirement', docId, [zeta, alpha]);
    const rows = await listDocumentFacet<{ vocab_name: string; vocab_slug: string }>(
      db,
      'requirement',
      docId,
    );
    expect(rows.map((r) => r.vocab_name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('registry lib — requirementsOpenedByClaims (the layer-3 payoff)', () => {
  it('resolves a claim to the requirement that proves it', async () => {
    const organicCert = await makeRequirement(seed.tenantId, 'organic-cert', 'Organic Certificate');
    const advisory = await makeRequirement(seed.tenantId, 'organic-affidavit', 'Organic Affidavit');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');

    await db
      .prepare(
        `INSERT INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id, is_required)
         VALUES (?, ?, ?, ?, 1), (?, ?, ?, ?, 0)`,
      )
      .bind(
        generateTestId(), seed.tenantId, organic, organicCert,
        generateTestId(), seed.tenantId, organic, advisory,
      )
      .run();

    const required = await requirementsOpenedByClaims(db, seed.tenantId, [organic]);
    expect(required).toEqual([organicCert]);

    const all = await requirementsOpenedByClaims(db, seed.tenantId, [organic], false);
    expect(all.sort()).toEqual([organicCert, advisory].sort());
  });

  it('is tenant-scoped and empty-safe', async () => {
    const req = await makeRequirement(seed.tenantId, 'organic-cert', 'Organic Certificate');
    const claim = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await db
      .prepare(
        `INSERT INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateTestId(), seed.tenantId, claim, req)
      .run();

    expect(await requirementsOpenedByClaims(db, seed.tenantId2, [claim])).toEqual([]);
    expect(await requirementsOpenedByClaims(db, seed.tenantId, [])).toEqual([]);
  });

  it('supports gap detection as a set difference over one vocabulary', async () => {
    // A spec sheet CLOSES six requirements and, by claiming Organic, OPENS a
    // seventh it does not close. That gap is the product value of layer 3.
    const docId = await makeDocument(seed.tenantId, 'Spec Sheet');
    const closed = [];
    for (const slug of ['spec', 'micro', 'pack', 'nutri', 'allergen', 'origin']) {
      closed.push(await makeRequirement(seed.tenantId, slug, slug));
    }
    const organicCert = await makeRequirement(seed.tenantId, 'organic-cert', 'Organic Certificate');
    const organic = await makeClaimType(seed.tenantId, 'organic', 'Organic');
    await db
      .prepare(
        `INSERT INTO claim_type_requirements (id, tenant_id, claim_type_id, requirement_id)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateTestId(), seed.tenantId, organic, organicCert)
      .run();

    await syncDocumentFacet(db, 'requirement', docId, closed);
    await syncDocumentFacet(db, 'claim', docId, [{ id: organic, status: 'confirmed' }]);

    const opened = await requirementsOpenedByClaims(db, seed.tenantId, [organic]);
    const closedRows = await db
      .prepare(
        `SELECT requirement_id FROM document_requirements
          WHERE document_id = ? AND status = 'confirmed'`,
      )
      .bind(docId)
      .all<{ requirement_id: string }>();
    const closedSet = new Set(closedRows.results.map((r) => r.requirement_id));
    const gaps = opened.filter((r) => !closedSet.has(r));
    expect(gaps).toEqual([organicCert]);
  });
});
