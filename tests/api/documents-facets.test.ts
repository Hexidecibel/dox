/**
 * Integration tests for the registry FACET write path (migration 0080) —
 * the wiring that makes `document_requirements` and `document_claims` actually
 * receive rows.
 *
 * Before this, `syncDocumentFacet` had no caller outside its own module: the
 * junctions existed, the vocabulary admin UI existed, and both tables were
 * permanently empty, so gap detection could never compute anything. These tests
 * pin the three things that matter:
 *
 *   1. create (POST /api/documents/ingest) and update (PUT /api/documents/:id)
 *      both write facet rows, with the STATUS each path is supposed to produce
 *   2. re-saving converges instead of duplicating
 *   3. the 0079 FTS pipeline still fires after a document write — the
 *      regression that would hurt most, because `document_categories` (retired
 *      by 0080 but NOT dropped) is what feeds `documents_fts_source`, and
 *      SQLite resolves that view lazily. Breaking it fails silently at runtime,
 *      not at migration time.
 *
 * Same hand-rolled-context pattern as documents-registry.test.ts — SELF.fetch
 * isn't wired in this project's vitest-pool-workers config.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';
import {
  onRequestGet as docGet,
  onRequestPut as docPut,
} from '../../functions/api/documents/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let user: { id: string; role: 'user'; tenant_id: string };

let reqAllergen: string;
let reqNutrition: string;
let reqOrigin: string;
let claimOrganic: string;
let claimKosher: string;
/** A requirement belonging to the OTHER tenant — must never be linkable. */
let foreignRequirement: string;
/** An in-tenant supplier, for subject-scoped claims. */
let supplierId: string;

function makeFakePdf(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = '%PDF-1.4\n';
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  for (let i = header.length; i < size; i++) bytes[i] = 0x20;
  return bytes;
}

async function ingest(extra: Record<string, string>, fileName = 'facet.pdf') {
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
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function getDoc(id: string) {
  const res = await docGet({
    request: new Request(`http://localhost/api/documents/${id}`),
    env,
    data: { user },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function putDoc(id: string, body: Record<string, unknown>) {
  const res = await docPut({
    request: new Request(`http://localhost/api/documents/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    env,
    data: { user },
    params: { id },
  } as any);
  return { status: res.status, body: (await res.json()) as any };
}

async function requirementRows(docId: string) {
  const rows = await db
    .prepare(
      `SELECT requirement_id, status, source, confirmed_by
         FROM document_requirements WHERE document_id = ? ORDER BY requirement_id`,
    )
    .bind(docId)
    .all<{ requirement_id: string; status: string; source: string; confirmed_by: string | null }>();
  return rows.results;
}

async function claimRows(docId: string) {
  const rows = await db
    .prepare(
      `SELECT claim_type_id, status, subject_type, subject_id, evidence
         FROM document_claims WHERE document_id = ? ORDER BY claim_type_id`,
    )
    .bind(docId)
    .all<{
      claim_type_id: string;
      status: string;
      subject_type: string;
      subject_id: string | null;
      evidence: string | null;
    }>();
  return rows.results;
}

async function makeRequirement(tenantId: string, name: string): Promise<string> {
  const id = `req-${generateTestId()}`;
  await db
    .prepare('INSERT INTO requirements (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

async function makeClaimType(tenantId: string, name: string): Promise<string> {
  const id = `clm-${generateTestId()}`;
  await db
    .prepare('INSERT INTO claim_types (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)')
    .bind(id, tenantId, `${name.toLowerCase().replace(/\W+/g, '-')}-${generateTestId()}`, name)
    .run();
  return id;
}

beforeAll(async () => {
  seed = await seedTestData(db);
  user = { id: seed.userId, role: 'user' as const, tenant_id: seed.tenantId };

  reqAllergen = await makeRequirement(seed.tenantId, 'Allergen Matrix');
  reqNutrition = await makeRequirement(seed.tenantId, '100g Nutritionals');
  reqOrigin = await makeRequirement(seed.tenantId, 'Country of Origin');
  claimOrganic = await makeClaimType(seed.tenantId, 'Organic');
  claimKosher = await makeClaimType(seed.tenantId, 'Kosher');
  foreignRequirement = await makeRequirement(seed.tenantId2, 'Foreign Line Item');

  supplierId = `sup-${generateTestId()}`;
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Facet Supplier', `facet-sup-${generateTestId()}`)
    .run();
}, 30_000);

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

describe('facet writes — POST /api/documents/ingest (create)', () => {
  it('writes document_requirements and document_claims on a new document', async () => {
    const { status, body } = await ingest({
      title: 'Spec Sheet with facets',
      requirements: JSON.stringify([reqAllergen, reqNutrition]),
      claims: JSON.stringify([claimOrganic]),
    });
    expect(status).toBe(201);
    const docId = body.document.id;

    const reqs = await requirementRows(docId);
    expect(reqs.map((r) => r.requirement_id).sort()).toEqual([reqAllergen, reqNutrition].sort());

    const claims = await claimRows(docId);
    expect(claims).toHaveLength(1);
    expect(claims[0].claim_type_id).toBe(claimOrganic);
  });

  it('lands links as SUGGESTED — ingest is the machine-reachable path', async () => {
    // Ingest is API-key reachable and is the email/agentic pipeline's entry
    // point. A wrong claim read that auto-confirmed would manufacture a false
    // missing-document alert, so nothing here asserts on its own authority.
    const { body } = await ingest({
      title: 'Suggested by default',
      requirements: JSON.stringify([reqAllergen]),
      claims: JSON.stringify([claimOrganic]),
    });
    const docId = body.document.id;

    expect((await requirementRows(docId))[0].status).toBe('suggested');
    expect((await claimRows(docId))[0].status).toBe('suggested');

    // A suggestion is not a confirmation: confirmed_by must stay empty.
    expect((await requirementRows(docId))[0].confirmed_by).toBeNull();
  });

  it('honours a per-link status/source/confidence object', async () => {
    const { body } = await ingest({
      title: 'Rich link payload',
      requirements: JSON.stringify([
        { id: reqAllergen, status: 'confirmed', source: 'extraction', confidence: 0.91 },
      ]),
    });
    const rows = await requirementRows(body.document.id);
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].source).toBe('extraction');
  });

  it('carries a claim subject and its evidence snippet', async () => {
    const { body } = await ingest({
      title: 'Subject-scoped claim',
      claims: JSON.stringify([
        {
          id: claimOrganic,
          subject_type: 'supplier',
          subject_id: supplierId,
          evidence: 'Certified Organic by CCOF',
        },
      ]),
    });
    const rows = await claimRows(body.document.id);
    expect(rows[0].subject_type).toBe('supplier');
    expect(rows[0].subject_id).toBe(supplierId);
    expect(rows[0].evidence).toBe('Certified Organic by CCOF');
  });

  it('writes NO facet rows when the fields are absent (no silent defaults)', async () => {
    const { body } = await ingest({ title: 'No facets sent' });
    expect(await requirementRows(body.document.id)).toHaveLength(0);
    expect(await claimRows(body.document.id)).toHaveLength(0);
  });

  it('rejects a cross-tenant requirement id before writing anything', async () => {
    const { status, body } = await ingest({
      title: 'Cross-tenant attempt',
      requirements: JSON.stringify([foreignRequirement]),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/requirement/i);

    // And nothing leaked into the junction for the other tenant's row.
    const leaked = await db
      .prepare('SELECT COUNT(*) AS n FROM document_requirements WHERE requirement_id = ?')
      .bind(foreignRequirement)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it('rejects a claim whose subject belongs to another tenant', async () => {
    const foreignSupplier = `sup-${generateTestId()}`;
    await db
      .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(foreignSupplier, seed.tenantId2, 'Foreign Supplier', `fs-${generateTestId()}`)
      .run();

    const { status } = await ingest({
      title: 'Cross-tenant claim subject',
      claims: JSON.stringify([
        { id: claimOrganic, subject_type: 'supplier', subject_id: foreignSupplier },
      ]),
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe('facet writes — PUT /api/documents/:id (update)', () => {
  it('writes facet rows on update and CONFIRMS them (the human editor)', async () => {
    // Ingest proposes; the editor is where a human confirms. If this path also
    // wrote 'suggested' there would be no route to a confirmed link at all and
    // gap detection — which counts confirmed rows — would stay empty forever.
    const { body: created } = await ingest({ title: 'Edit me' });
    const docId = created.document.id;

    const { status } = await putDoc(docId, {
      requirements: [reqAllergen, reqOrigin],
      claims: [claimKosher],
    });
    expect(status).toBe(200);

    const reqs = await requirementRows(docId);
    expect(reqs).toHaveLength(2);
    expect(reqs.every((r) => r.status === 'confirmed')).toBe(true);
    expect(reqs.every((r) => r.confirmed_by === seed.userId)).toBe(true);
    expect((await claimRows(docId))[0].status).toBe('confirmed');
  });

  it('accepts a facet-only edit instead of 400 "No fields to update"', async () => {
    const { body: created } = await ingest({ title: 'Facet-only edit' });
    const { status } = await putDoc(created.document.id, { requirements: [reqAllergen] });
    expect(status).toBe(200);
    expect(await requirementRows(created.document.id)).toHaveLength(1);
  });

  it('REPLACES the set — an omitted facet is untouched, an empty array clears', async () => {
    const { body: created } = await ingest({ title: 'Replace semantics' });
    const docId = created.document.id;

    await putDoc(docId, { requirements: [reqAllergen, reqNutrition], claims: [claimOrganic] });
    expect(await requirementRows(docId)).toHaveLength(2);

    // Sending only `requirements` must not disturb `claims`.
    await putDoc(docId, { requirements: [reqOrigin] });
    const reqs = await requirementRows(docId);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].requirement_id).toBe(reqOrigin);
    expect(await claimRows(docId)).toHaveLength(1);

    // An explicit empty array is a real instruction: clear them.
    await putDoc(docId, { claims: [] });
    expect(await claimRows(docId)).toHaveLength(0);
    expect(await requirementRows(docId)).toHaveLength(1);
  });

  it('rejects a cross-tenant requirement without mutating the document', async () => {
    const { body: created } = await ingest({ title: 'Guarded update' });
    const docId = created.document.id;
    await putDoc(docId, { requirements: [reqAllergen] });

    const { status } = await putDoc(docId, {
      title: 'Renamed',
      requirements: [foreignRequirement],
    });
    expect(status).toBe(400);

    // Validation runs BEFORE the UPDATE, so the title change was not applied
    // and the previously-confirmed link survived.
    const row = await db
      .prepare('SELECT title FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ title: string }>();
    expect(row?.title).toBe('Guarded update');
    expect(await requirementRows(docId)).toHaveLength(1);
  });

  it('returns the facet sets on GET and on the PUT response', async () => {
    const { body: created } = await ingest({ title: 'Read back' });
    const docId = created.document.id;

    const put = await putDoc(docId, { requirements: [reqAllergen], claims: [claimOrganic] });
    expect(put.body.document.requirements).toHaveLength(1);
    expect(put.body.document.claims).toHaveLength(1);

    const got = await getDoc(docId);
    expect(got.status).toBe(200);
    expect(got.body.document.requirements.map((r: any) => r.requirement_id)).toEqual([reqAllergen]);
    expect(got.body.document.claims.map((c: any) => c.claim_type_id)).toEqual([claimOrganic]);
    // The vocabulary is joined in so the editor can render names directly.
    expect(got.body.document.requirements[0].vocab_name).toBe('Allergen Matrix');
  });
});

// ---------------------------------------------------------------------------
// IDEMPOTENCE
// ---------------------------------------------------------------------------

describe('facet writes — idempotence', () => {
  it('re-saving the same PUT payload does not duplicate rows', async () => {
    const { body: created } = await ingest({ title: 'Idempotent PUT' });
    const docId = created.document.id;

    for (let i = 0; i < 3; i++) {
      await putDoc(docId, {
        requirements: [reqAllergen, reqNutrition],
        claims: [claimOrganic],
      });
    }

    expect(await requirementRows(docId)).toHaveLength(2);
    expect(await claimRows(docId)).toHaveLength(1);
  });

  it('a repeated id inside ONE payload collapses to a single row', async () => {
    const { body: created } = await ingest({ title: 'Duplicate ids in payload' });
    const docId = created.document.id;
    await putDoc(docId, { requirements: [reqAllergen, reqAllergen, reqAllergen] });
    expect(await requirementRows(docId)).toHaveLength(1);
  });

  it('re-ingesting the same external_ref converges instead of accumulating', async () => {
    const ref = `ext-${generateTestId()}`;
    const first = await ingest({
      title: 'Upsert v1',
      external_ref: ref,
      requirements: JSON.stringify([reqAllergen, reqNutrition]),
    });
    expect(first.status).toBe(201);
    const docId = first.body.document.id;

    const second = await ingest({
      title: 'Upsert v2',
      external_ref: ref,
      requirements: JSON.stringify([reqAllergen, reqNutrition]),
    });
    expect(second.status).toBe(200);
    expect(second.body.document.id).toBe(docId);

    expect(await requirementRows(docId)).toHaveLength(2);
  });

  it('a re-ingest cannot resurrect a link a human already REJECTED', async () => {
    const ref = `ext-${generateTestId()}`;
    const first = await ingest({
      title: 'Rejected link',
      external_ref: ref,
      requirements: JSON.stringify([reqAllergen]),
    });
    const docId = first.body.document.id;

    // A reviewer turns the suggestion down. Rejections are retained, not
    // deleted, precisely so the same wrong suggestion is not re-proposed.
    await db
      .prepare(
        "UPDATE document_requirements SET status = 'rejected' WHERE document_id = ? AND requirement_id = ?",
      )
      .bind(docId, reqAllergen)
      .run();

    await ingest({
      title: 'Rejected link',
      external_ref: ref,
      requirements: JSON.stringify([reqAllergen]),
    });

    const rows = await requirementRows(docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// FTS REGRESSION — the expensive one to get wrong
// ---------------------------------------------------------------------------

describe('facet writes — the 0079 FTS pipeline still fires', () => {
  it('indexes a document created WITH facet links', async () => {
    // documents_fts_source reads document_categories (retired by 0080, not
    // dropped — 0079's view and every FTS trigger still go through it). SQLite
    // resolves views lazily, so dropping those writes would not error: document
    // writes would start failing at runtime, or search would go quietly stale.
    // This asserts the facet writes were ADDED alongside, not swapped in.
    const marker = `facetfts${generateTestId()}`;
    const { status, body } = await ingest({
      title: `FTS ${marker}`,
      aliases: JSON.stringify([marker]),
      requirements: JSON.stringify([reqAllergen]),
      claims: JSON.stringify([claimOrganic]),
    });
    expect(status).toBe(201);
    const docId = body.document.id;

    const hits = await db
      .prepare('SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?')
      .bind(`aliases_text:${marker}`)
      .all<{ doc_id: string }>();
    expect(hits.results.map((r) => r.doc_id)).toContain(docId);
  });

  it('keeps category_text working when categories AND facets are sent together', async () => {
    const typeId = `dt-${generateTestId()}`;
    const marker = `Catmarker${generateTestId()}`;
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
      .bind(typeId, seed.tenantId, marker, `cat-${generateTestId()}`)
      .run();

    const { body } = await ingest({
      title: 'Categories and facets together',
      categories: JSON.stringify([typeId]),
      requirements: JSON.stringify([reqAllergen]),
    });
    const docId = body.document.id;

    // Both junctions were written.
    const cats = await db
      .prepare('SELECT COUNT(*) AS n FROM document_categories WHERE document_id = ?')
      .bind(docId)
      .first<{ n: number }>();
    expect(cats?.n).toBe(1);
    expect(await requirementRows(docId)).toHaveLength(1);

    // And the document_categories FTS trigger still refreshed category_text.
    const hits = await db
      .prepare('SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?')
      .bind(`category_text:${marker}`)
      .all<{ doc_id: string }>();
    expect(hits.results.map((r) => r.doc_id)).toContain(docId);
  });

  it('a facet-only PUT leaves the document searchable', async () => {
    const marker = `putfts${generateTestId()}`;
    const { body } = await ingest({
      title: `PUT FTS ${marker}`,
      aliases: JSON.stringify([marker]),
    });
    const docId = body.document.id;

    const { status } = await putDoc(docId, { requirements: [reqAllergen] });
    expect(status).toBe(200);

    const hits = await db
      .prepare('SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?')
      .bind(`aliases_text:${marker}`)
      .all<{ doc_id: string }>();
    expect(hits.results.map((r) => r.doc_id)).toContain(docId);
  });
});
