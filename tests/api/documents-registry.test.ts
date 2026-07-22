/**
 * Integration tests for the IDP Document Registry single-doc upload path
 * (migrations 0076-0079): POST /api/documents/ingest persisting categories[],
 * aliases, renewal fields; GET /api/documents/:id returning them; and the
 * Phase-1 FTS triggers indexing aliases + category names.
 *
 * Drives the handlers directly with hand-rolled contexts — SELF.fetch isn't
 * wired in this project's vitest-pool-workers config (same pattern as
 * documents-ingest.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPost as ingestPost } from '../../functions/api/documents/ingest';
import { onRequestGet as docGet, onRequestPut as docPut } from '../../functions/api/documents/[id]';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let user: { id: string; role: 'user'; tenant_id: string };
let coaTypeId: string;
let specTypeId: string;

function makeFakePdf(size = 256): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = '%PDF-1.4\n';
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  for (let i = header.length; i < size; i++) bytes[i] = 0x20;
  return bytes;
}

async function ingest(extra: Record<string, string>, fileName = 'reg.pdf') {
  const form = new FormData();
  form.append('tenant_id', seed.tenantId);
  form.append('file', new Blob([makeFakePdf()], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const req = new Request('http://localhost/api/documents/ingest', { method: 'POST', body: form });
  const res = await ingestPost({
    request: req,
    env,
    data: { user },
    params: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/documents/ingest',
  } as any);
  return { status: res.status, body: await res.json() as any };
}

async function getDoc(id: string) {
  const res = await docGet({
    request: new Request(`http://localhost/api/documents/${id}`),
    env,
    data: { user },
    params: { id },
  } as any);
  return { status: res.status, body: await res.json() as any };
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
  return { status: res.status, body: await res.json() as any };
}

beforeAll(async () => {
  seed = await seedTestData(db);
  user = { id: seed.userId, role: 'user' as const, tenant_id: seed.tenantId };

  coaTypeId = `dt-coa-${generateTestId()}`;
  specTypeId = `dt-spec-${generateTestId()}`;
  await db.prepare(
    `INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, 'COA', ?)`,
  ).bind(coaTypeId, seed.tenantId, `coa-${generateTestId()}`).run();
  await db.prepare(
    `INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, 'Spec Sheet', ?)`,
  ).bind(specTypeId, seed.tenantId, `spec-${generateTestId()}`).run();
}, 30_000);

describe('registry ingest — categories[], aliases, renewal', () => {
  it('persists two categories with is_primary set, plus aliases + renewal_type', async () => {
    const alias = `insurancecert${generateTestId()}`;
    const { status, body } = await ingest({
      title: 'Registry Doc',
      categories: JSON.stringify([coaTypeId, specTypeId]),
      primary_category_id: specTypeId,
      aliases: JSON.stringify([alias, 'Liability Certificate']),
      criteria: JSON.stringify(['21 CFR 110']),
      applies_to: JSON.stringify(['Kent', 'Portland']),
      owner: 'QA',
      renewal_type: 'review_cycle',
      renewal_interval_months: '12',
      renewal_due_date: '2027-01-15',
    });
    expect(status).toBe(201);
    const docId = body.document.id;

    // Two document_categories rows, primary flagged on the spec type.
    const cats = await db.prepare(
      'SELECT document_type_id, is_primary FROM document_categories WHERE document_id = ? ORDER BY is_primary DESC',
    ).bind(docId).all<{ document_type_id: string; is_primary: number }>();
    expect(cats.results).toHaveLength(2);
    const primary = cats.results.find((c) => c.is_primary === 1);
    expect(primary?.document_type_id).toBe(specTypeId);
    expect(cats.results.filter((c) => c.is_primary === 0)).toHaveLength(1);

    // documents.document_type_id mirrors the primary.
    const row = await db.prepare(
      'SELECT document_type_id, aliases, renewal_type, renewal_interval_months, renewal_due_date, applies_to, owner FROM documents WHERE id = ?',
    ).bind(docId).first<any>();
    expect(row.document_type_id).toBe(specTypeId);
    expect(JSON.parse(row.aliases)).toContain(alias);
    expect(row.renewal_type).toBe('review_cycle');
    expect(row.renewal_interval_months).toBe(12);
    expect(row.renewal_due_date).toBe('2027-01-15');
    expect(JSON.parse(row.applies_to)).toEqual(['Kent', 'Portland']);
    expect(row.owner).toBe('QA');

    // FTS: the alias is searchable via documents_fts.aliases_text, and the
    // category name via category_text — proving the Phase-1 triggers fired on
    // the documents insert and the document_categories inserts.
    const ftsAlias = await db.prepare(
      "SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?",
    ).bind(`aliases_text:${alias}`).all<{ doc_id: string }>();
    expect(ftsAlias.results.map((r) => r.doc_id)).toContain(docId);

    const ftsCat = await db.prepare(
      "SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'category_text:Spec'",
    ).all<{ doc_id: string }>();
    expect(ftsCat.results.map((r) => r.doc_id)).toContain(docId);
  });

  it('rejects an invalid renewal_type', async () => {
    const { status } = await ingest({
      title: 'Bad Renewal',
      renewal_type: 'not_a_real_type',
    });
    expect(status).toBe(400);
  });

  it('rejects a category id from another tenant', async () => {
    // A doctype owned by tenant 2 must not be accepted for tenant 1's doc.
    const foreign = `dt-foreign-${generateTestId()}`;
    await db.prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug) VALUES (?, ?, 'Foreign', ?)`,
    ).bind(foreign, seed.tenantId2, `foreign-${generateTestId()}`).run();
    const { status } = await ingest({
      title: 'Cross Tenant',
      categories: JSON.stringify([foreign]),
    });
    expect(status).toBe(400);
  });
});

describe('registry GET + PUT round-trip', () => {
  it('GET returns categories (with is_primary) and registry fields; PUT edits them', async () => {
    const created = await ingest({
      title: 'RoundTrip',
      categories: JSON.stringify([coaTypeId]),
      aliases: JSON.stringify(['Original Alias']),
      owner: 'Ops',
      renewal_type: 'hard_expiry',
    });
    const docId = created.body.document.id;

    const got = await getDoc(docId);
    expect(got.status).toBe(200);
    expect(got.body.document.categories).toHaveLength(1);
    expect(got.body.document.categories[0].document_type_id).toBe(coaTypeId);
    expect(got.body.document.categories[0].is_primary).toBe(1);
    expect(got.body.document.categories[0].document_type_name).toBe('COA');
    expect(got.body.document.owner).toBe('Ops');
    expect(got.body.document.renewal_type).toBe('hard_expiry');

    // PUT: swap the category set to two types (spec primary), edit aliases/renewal.
    const put = await putDoc(docId, {
      categories: [coaTypeId, specTypeId],
      primary_category_id: specTypeId,
      aliases: ['Edited Alias'],
      renewal_type: 'review_cycle',
      renewal_interval_months: 6,
    });
    expect(put.status).toBe(200);

    const after = await getDoc(docId);
    expect(after.body.document.categories).toHaveLength(2);
    const primary = after.body.document.categories.find((c: any) => c.is_primary === 1);
    expect(primary.document_type_id).toBe(specTypeId);
    expect(after.body.document.document_type_id).toBe(specTypeId);
    expect(after.body.document.aliases).toBe(JSON.stringify(['Edited Alias']));
    expect(after.body.document.renewal_type).toBe('review_cycle');
    expect(after.body.document.renewal_interval_months).toBe(6);
  });

  it('PUT rejects an invalid renewal_type', async () => {
    const created = await ingest({ title: 'PutBad' });
    const put = await putDoc(created.body.document.id, { renewal_type: 'bogus' });
    expect(put.status).toBe(400);
  });
});
