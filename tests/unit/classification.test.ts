/**
 * `documents.classification_status` (migration 0081) — the writer.
 *
 * The column, its CHECK and its index shipped in 0081 and
 * `functions/lib/requirement-gaps.ts` counts by it, but NOTHING EVER WROTE IT:
 * every row stayed at the 'unclassified' default, so the "unclassified" figure
 * was `COUNT(*)` on every tenant. These pin the rule that fixes it, and
 * especially the two refusals — a machine never overrules a person, and a
 * needs_review row never claims a reviewer it does not have.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import { recordClassification } from '../../functions/lib/classification';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;

async function makeDocument(tenantId: string, title: string, documentTypeId: string | null = null) {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, document_type_id)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`,
    )
    .bind(id, tenantId, title, seed.orgAdminId, documentTypeId)
    .run();
  return id;
}

async function makeDocType(tenantId: string, name: string) {
  const id = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, name, `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`)
    .run();
  return id;
}

function readRow(id: string) {
  return db
    .prepare(
      `SELECT classification_status AS status,
              classification_reviewed_at AS at,
              classification_reviewed_by AS by
         FROM documents WHERE id = ?`,
    )
    .bind(id)
    .first<{ status: string; at: string | null; by: string | null }>();
}

beforeAll(async () => {
  await runMigrations(db);
});

beforeEach(async () => {
  await cleanTables(db);
  seed = await seedTestData(db);
});

describe('recordClassification — what each act decides', () => {
  it('a human affirming a type classifies the document and names the reviewer', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA');
    const docId = await makeDocument(seed.tenantId, 'A certificate', typeId);

    const result = await recordClassification(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.orgAdminId,
      byHuman: true,
    });

    expect(result.status).toBe('classified');
    const row = await readRow(docId);
    expect(row?.status).toBe('classified');
    expect(row?.by).toBe(seed.orgAdminId);
    expect(row?.at).toBeTruthy();
  });

  it('a human approving with NO type resolved leaves it in the backlog', async () => {
    const docId = await makeDocument(seed.tenantId, 'Untyped', null);

    const result = await recordClassification(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: null,
      actorId: seed.orgAdminId,
      byHuman: true,
    });

    expect(result.status).toBe('needs_review');
    const row = await readRow(docId);
    expect(row?.status).toBe('needs_review');
    // NOT stamped: the person ruled on the extraction, not on the
    // classification. 0081 says the stamps assert a classification judgment.
    expect(row?.by).toBeNull();
    expect(row?.at).toBeNull();
  });

  it('a machine door declaring a type proposes, it does not confirm', async () => {
    const typeId = await makeDocType(seed.tenantId, 'SDS');
    const docId = await makeDocument(seed.tenantId, 'Ingested', typeId);

    const result = await recordClassification(db, {
      documentId: docId,
      tenantId: seed.tenantId,
      documentTypeId: typeId,
      actorId: seed.orgAdminId, // ingest carries an API key's user, still not a person
      byHuman: false,
    });

    expect(result.status).toBe('needs_review');
    expect((await readRow(docId))?.by).toBeNull();
  });
});

describe('recordClassification — the refusals', () => {
  it('a machine write never demotes a document a human classified', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA');
    const docId = await makeDocument(seed.tenantId, 'Reviewed', typeId);
    await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: typeId,
      actorId: seed.orgAdminId, byHuman: true,
    });

    const result = await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: typeId,
      actorId: null, byHuman: false,
    });

    expect(result.skipped).toBe('already_ruled');
    const row = await readRow(docId);
    expect(row?.status).toBe('classified');
    expect(row?.by).toBe(seed.orgAdminId);
  });

  it('a machine write never resurrects a terminal unclassifiable', async () => {
    const typeId = await makeDocType(seed.tenantId, 'Odd');
    const docId = await makeDocument(seed.tenantId, 'Genuinely fits nothing', typeId);
    await db
      .prepare(
        `UPDATE documents SET classification_status = 'unclassifiable',
                classification_reviewed_at = datetime('now'), classification_reviewed_by = ?
          WHERE id = ?`,
      )
      .bind(seed.orgAdminId, docId)
      .run();

    const result = await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: typeId,
      actorId: null, byHuman: false,
    });

    expect(result.skipped).toBe('already_ruled');
    expect((await readRow(docId))?.status).toBe('unclassifiable');
  });

  it('a human act DOES move a machine-proposed row forward', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA');
    const docId = await makeDocument(seed.tenantId, 'Ingested then reviewed', typeId);
    await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: typeId,
      actorId: null, byHuman: false,
    });
    expect((await readRow(docId))?.status).toBe('needs_review');

    await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: typeId,
      actorId: seed.orgAdminId, byHuman: true,
    });

    const row = await readRow(docId);
    expect(row?.status).toBe('classified');
    expect(row?.by).toBe(seed.orgAdminId);
  });

  it('writes nothing for a document in another tenant', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA');
    const docId = await makeDocument(seed.tenantId, 'Mine', typeId);

    const result = await recordClassification(db, {
      documentId: docId,
      tenantId: seed.tenantId2,
      documentTypeId: typeId,
      actorId: seed.orgAdminId,
      byHuman: true,
    });

    expect(result.status).toBeNull();
    expect((await readRow(docId))?.status).toBe('unclassified');
  });

  it('a repeat machine write on an unchanged row does not touch it', async () => {
    const docId = await makeDocument(seed.tenantId, 'Untyped', null);
    await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: null,
      actorId: null, byHuman: false,
    });
    const result = await recordClassification(db, {
      documentId: docId, tenantId: seed.tenantId, documentTypeId: null,
      actorId: null, byHuman: false,
    });
    expect(result.skipped).toBe('unchanged');
  });
});

describe('the gap report reads it', () => {
  it('the unclassified bucket stops being COUNT(*) once approvals write', async () => {
    const typeId = await makeDocType(seed.tenantId, 'COA');
    const a = await makeDocument(seed.tenantId, 'One', typeId);
    const b = await makeDocument(seed.tenantId, 'Two', typeId);
    const c = await makeDocument(seed.tenantId, 'Three', null);

    for (const [id, type, human] of [[a, typeId, true], [b, typeId, true], [c, null, true]] as const) {
      await recordClassification(db, {
        documentId: id, tenantId: seed.tenantId, documentTypeId: type,
        actorId: seed.orgAdminId, byHuman: human,
      });
    }

    const counts = await db
      .prepare(
        `SELECT classification_status AS s, COUNT(*) AS n FROM documents
          WHERE tenant_id = ? AND status = 'active' GROUP BY classification_status`,
      )
      .bind(seed.tenantId)
      .all<{ s: string; n: number }>();
    const map = Object.fromEntries((counts.results ?? []).map((r) => [r.s, r.n]));

    expect(map.classified).toBe(2);
    expect(map.needs_review).toBe(1);
    expect(map.unclassified ?? 0).toBe(0);
  });
});
