/**
 * Unit tests for functions/lib/requirement-defaults.ts — the producer that
 * turns a per-tenant type → requirements mapping (migration 0100) into real
 * `document_requirements` rows.
 *
 * These drive the helper directly against D1. The three call sites (the COA
 * approve producers, ingest and the document PUT) are covered end to end in
 * tests/api/requirement-defaults.test.ts.
 *
 * The load-bearing case is `does not resurrect a rejected link`. Everything
 * else here is a convenience that can be re-derived; that one is a promise to
 * a human who said no.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { applyDocumentTypeRequirementDefaults } from '../../functions/lib/requirement-defaults';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

async function makeRequirement(tenantId: string, name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function makeDocType(
  tenantId: string,
  name: string,
  defaultOwner: string | null = null,
): Promise<string> {
  const id = `dt-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, default_owner)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, defaultOwner)
    .run();
  return id;
}

async function mapTypeToRequirement(
  tenantId: string,
  documentTypeId: string,
  requirementId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_type_requirements
         (id, tenant_id, document_type_id, requirement_id, source)
       VALUES (?, ?, ?, ?, 'pack')`,
    )
    .bind(`dtr-${generateTestId()}`, tenantId, documentTypeId, requirementId)
    .run();
}

async function makeDocument(
  tenantId: string,
  documentTypeId: string | null,
  owner: string | null = null,
): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, current_version, status, created_by, document_type_id, owner)
       VALUES (?, ?, 'Defaults Fixture', 1, 'active', ?, ?, ?)`,
    )
    .bind(id, tenantId, seed.userId, documentTypeId, owner)
    .run();
  return id;
}

async function linkRows(documentId: string) {
  const rows = await db
    .prepare(
      `SELECT requirement_id, status, source, created_by
         FROM document_requirements WHERE document_id = ? ORDER BY requirement_id`,
    )
    .bind(documentId)
    .all<{ requirement_id: string; status: string; source: string; created_by: string | null }>();
  return rows.results;
}

async function ownerOf(documentId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT owner FROM documents WHERE id = ?')
    .bind(documentId)
    .first<{ owner: string | null }>();
  return row?.owner ?? null;
}

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

describe('applyDocumentTypeRequirementDefaults — the happy path', () => {
  it("proposes one 'suggested' / 'rule' link per mapped requirement", async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA Defaults A');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Matrix A');
    const reqB = await makeRequirement(seed.tenantId, 'Nutritionals A');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    await mapTypeToRequirement(seed.tenantId, typeId, reqB);
    const docId = await makeDocument(seed.tenantId, typeId);

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.applied.sort()).toEqual([reqA, reqB].sort());
    const rows = await linkRows(docId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Machine proposal, human decides. Never 'confirmed'.
      expect(row.status).toBe('suggested');
      expect(row.source).toBe('rule');
      expect(row.created_by).toBe(seed.userId);
    }
  });

  it('is idempotent — a second run proposes nothing new', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA Defaults Idem');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Idem');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    const docId = await makeDocument(seed.tenantId, typeId);

    const first = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });
    const second = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(first.applied).toEqual([reqA]);
    expect(second.applied).toEqual([]);
    expect(await linkRows(docId)).toHaveLength(1);
  });

  it('does nothing at all when the document has no type', async () => {
    const docId = await makeDocument(seed.tenantId, null);
    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: null,
      actorId: seed.userId,
    });
    expect(result).toEqual({ applied: [], ownerSet: null });
    expect(await linkRows(docId)).toHaveLength(0);
  });

  it('ignores a mapping belonging to another tenant', async () => {
    // The mapping row is read with BOTH tenant_id and document_type_id, so a
    // row written under the wrong tenant cannot leak a requirement across.
    const typeId = await makeDocType(seed.tenantId, 'COA Cross Tenant');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Cross');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    const docId = await makeDocument(seed.tenantId, typeId);

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId2,
      documentTypeId: typeId,
      actorId: seed.userId,
    });
    expect(result.applied).toEqual([]);
    expect(await linkRows(docId)).toHaveLength(0);
  });
});

describe('applyDocumentTypeRequirementDefaults — existing links are decisions', () => {
  it('does not duplicate a link a human already confirmed', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA Defaults Confirmed');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Confirmed');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    const docId = await makeDocument(seed.tenantId, typeId);

    await db
      .prepare(
        `INSERT INTO document_requirements
           (id, document_id, requirement_id, status, source, created_by)
         VALUES (?, ?, ?, 'confirmed', 'human', ?)`,
      )
      .bind(`dr-${generateTestId()}`, docId, reqA, seed.userId)
      .run();

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.applied).toEqual([]);
    const rows = await linkRows(docId);
    expect(rows).toHaveLength(1);
    // Still the human's row, untouched — not downgraded to 'suggested'.
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].source).toBe('human');
  });

  it('DOES NOT RESURRECT A REJECTED LINK', async () => {
    // The one that matters. A human looked at this document, was told it
    // satisfied this requirement, and said no. A rule that re-proposes it on
    // the next run has overruled them, and would do so on every run forever.
    const typeId = await makeDocType(seed.tenantId, 'COA Defaults Rejected');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Rejected');
    const reqB = await makeRequirement(seed.tenantId, 'Nutritionals Rejected');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    await mapTypeToRequirement(seed.tenantId, typeId, reqB);
    const docId = await makeDocument(seed.tenantId, typeId);

    await db
      .prepare(
        `INSERT INTO document_requirements
           (id, document_id, requirement_id, status, source, created_by)
         VALUES (?, ?, ?, 'rejected', 'human', ?)`,
      )
      .bind(`dr-${generateTestId()}`, docId, reqA, seed.userId)
      .run();

    // Run it twice: a rejection must survive re-runs, not just the first one.
    await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });
    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.applied).toEqual([]);
    const rows = await linkRows(docId);
    expect(rows).toHaveLength(2);
    const rejected = rows.find((r) => r.requirement_id === reqA);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.source).toBe('human');
    // The unrejected sibling still got proposed — the guard is per pair, not
    // "this document is off limits".
    const suggested = rows.find((r) => r.requirement_id === reqB);
    expect(suggested?.status).toBe('suggested');
  });
});

describe('applyDocumentTypeRequirementDefaults — the owner default', () => {
  it('sets documents.owner from the type when the document has none', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COI Owner Null', 'Insurance');
    const reqA = await makeRequirement(seed.tenantId, 'Insurance Cert');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    const docId = await makeDocument(seed.tenantId, typeId, null);

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.ownerSet).toBe('Insurance');
    expect(await ownerOf(docId)).toBe('Insurance');
  });

  it('NEVER overwrites an owner a human already set', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COI Owner Set', 'Insurance');
    const docId = await makeDocument(seed.tenantId, typeId, 'Accounting');

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.ownerSet).toBeNull();
    expect(await ownerOf(docId)).toBe('Accounting');
  });

  it('applies the owner default even when the type maps to no requirements', async () => {
    // The two halves are gated separately: a tenant that configured
    // default_owner but no mappings must not find the setting silently inert.
    const typeId = await makeDocType(seed.tenantId, 'COI Owner Only', 'Insurance');
    const docId = await makeDocument(seed.tenantId, typeId, null);

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.applied).toEqual([]);
    expect(result.ownerSet).toBe('Insurance');
  });

  it('leaves owner alone when the type declares no default', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA No Owner Default', null);
    const reqA = await makeRequirement(seed.tenantId, 'Allergen No Owner');
    await mapTypeToRequirement(seed.tenantId, typeId, reqA);
    const docId = await makeDocument(seed.tenantId, typeId, null);

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result.applied).toEqual([reqA]);
    expect(result.ownerSet).toBeNull();
    expect(await ownerOf(docId)).toBeNull();
  });
});

describe('applyDocumentTypeRequirementDefaults — an unconfigured tenant', () => {
  it('writes nothing whatsoever when no mappings and no default_owner exist', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA Unconfigured', null);
    const docId = await makeDocument(seed.tenantId, typeId, null);
    const before = await db
      .prepare('SELECT updated_at FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ updated_at: string }>();

    const result = await applyDocumentTypeRequirementDefaults(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result).toEqual({ applied: [], ownerSet: null });
    expect(await linkRows(docId)).toHaveLength(0);
    expect(await ownerOf(docId)).toBeNull();
    const after = await db
      .prepare('SELECT updated_at FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ updated_at: string }>();
    expect(after?.updated_at).toBe(before?.updated_at);
  });
});

describe('applyDocumentTypeRequirementDefaults — failure never reaches the caller', () => {
  it('swallows a DB error and returns an empty result', async () => {
    // A suggestion that cannot be written must not destroy an approval that
    // has already written a document. Stub every query so the FIRST thing the
    // helper touches blows up.
    const boom = {
      prepare(): never {
        throw new Error('D1_ERROR: no such table: document_type_requirements');
      },
    } as unknown as D1Database;

    const result = await applyDocumentTypeRequirementDefaults(boom, {
      documentId: 'doc-nonexistent',
      tenantId: seed.tenantId,
      documentTypeId: 'dt-nonexistent',
      actorId: seed.userId,
    });

    expect(result).toEqual({ applied: [], ownerSet: null });
  });

  it('reports the failure to the audit log when the DB can still take a write', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA Audit Failure', null);
    const docId = await makeDocument(seed.tenantId, typeId, null);

    // Fail only the mapping read; every other statement goes to the real DB so
    // the audit row can actually land.
    const flaky = {
      prepare(sql: string) {
        if (sql.includes('document_type_requirements')) {
          throw new Error('D1_ERROR: simulated');
        }
        return db.prepare(sql);
      },
    } as unknown as D1Database;

    const result = await applyDocumentTypeRequirementDefaults(flaky, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.userId,
    });

    expect(result).toEqual({ applied: [], ownerSet: null });
    const audit = await db
      .prepare(
        `SELECT action FROM audit_log
          WHERE resource_id = ? AND action = 'requirement_defaults.failed'`,
      )
      .bind(docId)
      .first<{ action: string }>();
    expect(audit?.action).toBe('requirement_defaults.failed');
  });
});
