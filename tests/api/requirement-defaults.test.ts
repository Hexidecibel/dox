/**
 * Integration cover for the three call sites of
 * functions/lib/requirement-defaults.ts — the producer that makes an approved
 * document actually close checklist items.
 *
 * Before this, `document_requirements` (migration 0080) had exactly two
 * writers, POST /api/documents/ingest and PUT /api/documents/:id, and BOTH
 * required the caller to name the requirement ids. The COA approve path — the
 * door nearly every real document comes through — wrote none, so gap detection
 * ran on a table that only a human ticking boxes could ever fill.
 *
 * What is pinned here:
 *   1. approving a COA writes 'suggested' / 'rule' links from the type mapping
 *      (migration 0100) and defaults documents.owner
 *   2. an ingest caller that sends its own `requirements` facet WINS — the
 *      default never arrives alongside a deliberate set
 *   3. re-typing a document on PUT proposes the new type's defaults, but only
 *      when that document has no requirement links at all yet
 *   4. a tenant with no mappings sees no rows and no behaviour change
 *   5. a broken mapping table does not fail an approve — it audits and the
 *      document still lands
 *
 * Same hand-rolled-context pattern as documents-facets.test.ts: SELF.fetch
 * isn't wired in this project's vitest-pool-workers config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';
import { onRequestPut as docPut } from '../../functions/api/documents/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let user: { id: string; role: 'org_admin'; tenant_id: string };

beforeAll(async () => {
  seed = await seedTestData(db);
  user = { id: seed.orgAdminId, role: 'org_admin' as const, tenant_id: seed.tenantId };
}, 30_000);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeRequirement(tenantId: string, name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function makeDocType(
  name: string,
  defaultOwner: string | null = null,
): Promise<string> {
  const id = `dt-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, default_owner)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      id,
      seed.tenantId,
      name,
      `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`,
      defaultOwner,
    )
    .run();
  return id;
}

async function mapTypeToRequirement(typeId: string, requirementId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_type_requirements
         (id, tenant_id, document_type_id, requirement_id, source)
       VALUES (?, ?, ?, ?, 'pack')`,
    )
    .bind(`dtr-${generateTestId()}`, seed.tenantId, typeId, requirementId)
    .run();
}

async function linkRows(documentId: string) {
  const rows = await db
    .prepare(
      `SELECT requirement_id, status, source
         FROM document_requirements WHERE document_id = ? ORDER BY requirement_id`,
    )
    .bind(documentId)
    .all<{ requirement_id: string; status: string; source: string }>();
  return rows.results;
}

function makeFakePdf(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = '%PDF-1.4\n';
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  for (let i = header.length; i < size; i++) bytes[i] = 0x20;
  return bytes;
}

// ---------------------------------------------------------------------------
// 1. The approve path — the whole point of the change
// ---------------------------------------------------------------------------

/** Seed a pending FLAT (single-record) COA queue item of a given type. */
async function seedFlatQueueItem(documentTypeId: string): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/coa.pdf`;
  await env.FILES.put(r2Key, makeFakePdf(), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          processing_status, status, created_by, extracted_text, ai_fields,
          ai_confidence, confidence_score)
       VALUES (?, ?, ?, ?, 'coa.pdf', 256, 'application/pdf',
               'ready', 'pending', ?, 'raw coa text', ?, 'high', 0.9)`,
    )
    .bind(
      id,
      seed.tenantId,
      documentTypeId,
      r2Key,
      seed.orgAdminId,
      JSON.stringify({ supplier_name: 'Andersen Dairy', lot_number: `L-${id.slice(0, 6)}` }),
    )
    .run();
  return id;
}

async function approve(queueId: string) {
  const res = await updateQueueItem({
    request: new Request(`http://localhost/api/queue/${queueId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', fields: { supplier_name: 'Andersen Dairy' } }),
    }),
    env,
    data: { user },
    params: { id: queueId },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/queue/${queueId}`,
  } as unknown as Parameters<typeof updateQueueItem>[0]);
  return res;
}

async function documentForQueueItem(queueId: string) {
  const row = await db
    .prepare('SELECT id, owner FROM documents WHERE external_ref = ?')
    .bind(`queue-${queueId}`)
    .first<{ id: string; owner: string | null }>();
  return row;
}

describe('approve → requirement defaults', () => {
  it('writes suggested links and defaults the owner when the type is mapped', async () => {
    const typeId = await makeDocType('COA Approve Mapped', 'QA');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Approve');
    const reqB = await makeRequirement(seed.tenantId, 'Nutritionals Approve');
    await mapTypeToRequirement(typeId, reqA);
    await mapTypeToRequirement(typeId, reqB);

    const queueId = await seedFlatQueueItem(typeId);
    expect((await approve(queueId)).status).toBe(200);

    const doc = await documentForQueueItem(queueId);
    expect(doc).toBeTruthy();
    const rows = await linkRows(doc!.id);
    expect(rows.map((r) => r.requirement_id).sort()).toEqual([reqA, reqB].sort());
    expect(rows.every((r) => r.status === 'suggested' && r.source === 'rule')).toBe(true);
    expect(doc!.owner).toBe('QA');
  });

  it('leaves an unmapped tenant exactly as it was', async () => {
    const typeId = await makeDocType('COA Approve Unmapped', null);
    const queueId = await seedFlatQueueItem(typeId);
    expect((await approve(queueId)).status).toBe(200);

    const doc = await documentForQueueItem(queueId);
    expect(doc).toBeTruthy();
    expect(await linkRows(doc!.id)).toHaveLength(0);
    expect(doc!.owner).toBeNull();
  });

  it('still approves when the mapping table is unreadable', async () => {
    // Best-effort by construction: the document row is already written by the
    // time the defaults run, so a failure there must degrade to "nobody
    // suggested anything", never to a failed approve.
    const typeId = await makeDocType('COA Approve Broken', null);
    const queueId = await seedFlatQueueItem(typeId);

    await db.prepare('ALTER TABLE document_type_requirements RENAME TO dtr_hidden').run();
    try {
      expect((await approve(queueId)).status).toBe(200);
    } finally {
      await db.prepare('ALTER TABLE dtr_hidden RENAME TO document_type_requirements').run();
    }

    const doc = await documentForQueueItem(queueId);
    expect(doc).toBeTruthy();
    expect(await linkRows(doc!.id)).toHaveLength(0);

    const audit = await db
      .prepare(
        `SELECT action FROM audit_log
          WHERE resource_id = ? AND action = 'requirement_defaults.failed'`,
      )
      .bind(doc!.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('requirement_defaults.failed');
  });
});

// ---------------------------------------------------------------------------
// 2. Ingest — an explicit facet always wins
// ---------------------------------------------------------------------------

async function ingest(extra: Record<string, string>, fileName = 'defaults.pdf') {
  const form = new FormData();
  form.append('tenant_id', seed.tenantId);
  form.append('file', new Blob([makeFakePdf()], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await ingestPost({
    request: new Request('http://localhost/api/documents/ingest', {
      method: 'POST',
      body: form,
    }),
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/ingest',
  } as unknown as Parameters<typeof ingestPost>[0]);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('ingest → requirement defaults', () => {
  it('applies the type defaults when the caller sends no requirements facet', async () => {
    const typeId = await makeDocType('COA Ingest Default', 'QA');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Ingest');
    await mapTypeToRequirement(typeId, reqA);

    const { status, body } = await ingest({
      title: 'Ingest with defaults',
      document_type_id: typeId,
      external_ref: `ing-default-${generateTestId()}`,
    });
    expect(status).toBe(201);

    const rows = await linkRows(body.document.id);
    expect(rows).toEqual([
      expect.objectContaining({ requirement_id: reqA, status: 'suggested', source: 'rule' }),
    ]);
    // The ingest response echoes the values it was handed, not the row as
    // stored, so the owner default is read back from the DB.
    const stored = await db
      .prepare('SELECT owner FROM documents WHERE id = ?')
      .bind(body.document.id)
      .first<{ owner: string | null }>();
    expect(stored?.owner).toBe('QA');
  });

  it('an explicit requirements facet WINS — no default is mixed in', async () => {
    const typeId = await makeDocType('COA Ingest Explicit', null);
    const mapped = await makeRequirement(seed.tenantId, 'Mapped Not Wanted');
    const chosen = await makeRequirement(seed.tenantId, 'Chosen By Caller');
    await mapTypeToRequirement(typeId, mapped);

    const { status, body } = await ingest({
      title: 'Ingest with explicit facet',
      document_type_id: typeId,
      external_ref: `ing-explicit-${generateTestId()}`,
      requirements: JSON.stringify([chosen]),
    });
    expect(status).toBe(201);

    const rows = await linkRows(body.document.id);
    expect(rows.map((r) => r.requirement_id)).toEqual([chosen]);
  });

  it('an explicit EMPTY requirements facet is still a decision and still wins', async () => {
    const typeId = await makeDocType('COA Ingest Empty Facet', null);
    const mapped = await makeRequirement(seed.tenantId, 'Mapped Cleared');
    await mapTypeToRequirement(typeId, mapped);

    const { status, body } = await ingest({
      title: 'Ingest clearing the facet',
      document_type_id: typeId,
      external_ref: `ing-empty-${generateTestId()}`,
      requirements: JSON.stringify([]),
    });
    expect(status).toBe(201);
    expect(await linkRows(body.document.id)).toHaveLength(0);
  });

  it('applies defaults on the UPDATE branch (a new version of a known ref)', async () => {
    const typeId = await makeDocType('COA Ingest Version', null);
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Versioned');
    await mapTypeToRequirement(typeId, reqA);
    const externalRef = `ing-version-${generateTestId()}`;

    const first = await ingest({
      title: 'Version 1',
      document_type_id: typeId,
      external_ref: externalRef,
    });
    expect(first.status).toBe(201);

    // Clear what the create branch proposed so the update branch is what is
    // being measured rather than the first call's leftovers.
    await db
      .prepare('DELETE FROM document_requirements WHERE document_id = ?')
      .bind(first.body.document.id)
      .run();

    const second = await ingest({
      title: 'Version 2',
      document_type_id: typeId,
      external_ref: externalRef,
    });
    expect(second.status).toBe(200);
    expect((await linkRows(first.body.document.id)).map((r) => r.requirement_id)).toEqual([reqA]);
  });
});

// ---------------------------------------------------------------------------
// 3. PUT /api/documents/:id — re-typing
// ---------------------------------------------------------------------------

async function putDoc(id: string, body: Record<string, unknown>) {
  const res = await docPut({
    request: new Request(`http://localhost/api/documents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { user },
    params: { id },
  } as unknown as Parameters<typeof docPut>[0]);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function makeDocument(typeId: string | null): Promise<string> {
  const id = `doc-${generateTestId()}`;
  await db
    .prepare(
      `INSERT INTO documents
         (id, tenant_id, title, current_version, status, created_by, document_type_id)
       VALUES (?, ?, 'Retype Fixture', 1, 'active', ?, ?)`,
    )
    .bind(id, seed.tenantId, seed.orgAdminId, typeId)
    .run();
  return id;
}

describe('PUT /api/documents/:id → requirement defaults on a type change', () => {
  it('proposes the new type defaults when the document has no links yet', async () => {
    const oldType = await makeDocType('Retype From', null);
    const newType = await makeDocType('Retype To', 'Insurance');
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Retype');
    await mapTypeToRequirement(newType, reqA);
    const docId = await makeDocument(oldType);

    const { status } = await putDoc(docId, { document_type_id: newType });
    expect(status).toBe(200);

    const rows = await linkRows(docId);
    expect(rows).toEqual([
      expect.objectContaining({ requirement_id: reqA, status: 'suggested', source: 'rule' }),
    ]);
  });

  it('does NOT propose anything when the document already has links', async () => {
    // A curated set built under the old type is a set of decisions. The new
    // type's defaults are a guess, and a guess does not arrive beside them.
    const oldType = await makeDocType('Retype Curated From', null);
    const newType = await makeDocType('Retype Curated To', null);
    const existing = await makeRequirement(seed.tenantId, 'Already Confirmed Retype');
    const mapped = await makeRequirement(seed.tenantId, 'Mapped To New Type');
    await mapTypeToRequirement(newType, mapped);
    const docId = await makeDocument(oldType);
    await db
      .prepare(
        `INSERT INTO document_requirements
           (id, document_id, requirement_id, status, source, created_by)
         VALUES (?, ?, ?, 'confirmed', 'human', ?)`,
      )
      .bind(`dr-${generateTestId()}`, docId, existing, seed.orgAdminId)
      .run();

    expect((await putDoc(docId, { document_type_id: newType })).status).toBe(200);

    const rows = await linkRows(docId);
    expect(rows.map((r) => r.requirement_id)).toEqual([existing]);
  });

  it('does not re-propose on an edit that leaves the type alone', async () => {
    const typeId = await makeDocType('Retype Unchanged', null);
    const reqA = await makeRequirement(seed.tenantId, 'Allergen Unchanged');
    await mapTypeToRequirement(typeId, reqA);
    const docId = await makeDocument(typeId);

    expect((await putDoc(docId, { title: 'Renamed, same type' })).status).toBe(200);
    expect(await linkRows(docId)).toHaveLength(0);
  });
});
