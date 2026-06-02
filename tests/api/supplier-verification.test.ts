/**
 * Backend half of "supplier must be verified on import; reviewer can
 * override/update supplier".
 *
 * Covers:
 *   - resolveExistingSupplierId: read-only alias-aware matching
 *     (slug / name / normalized / alias), null for unknown, null for junk.
 *   - PUT /api/queue/:id approve with supplier_id override (valid → used;
 *     wrong-tenant → ignored, falls back) and supplier_name override
 *     (creates/dedupes via findOrCreateSupplier).
 *   - COA results dispatch NO LONGER auto-ingests: every COA item stays in
 *     review regardless of confidence / template / known supplier. A matched
 *     known supplier is pre-resolved onto the queue item's supplier_id as
 *     review assist, but the item stays pending and no document is created.
 *   - PUT /api/documents/:id with supplier_name resolves + sets supplier_id.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { resolveExistingSupplierId } from '../../functions/lib/suppliers';
import { onRequestPut as putQueueItem } from '../../functions/api/queue/[id]';
import { onRequestPut as putQueueResults } from '../../functions/api/queue/[id]/results';
import { onRequestPut as putDocument } from '../../functions/api/documents/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;
const files = env.FILES;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makeCtx(
  path: string,
  id: string,
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null }
): any {
  return {
    request: new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: path,
  };
}

async function seedSupplier(
  tenantId: string,
  name: string,
  opts: { slug?: string; aliases?: string[] } = {}
): Promise<string> {
  const id = generateTestId();
  const slug =
    opts.slug ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug, aliases) VALUES (?, ?, ?, ?, ?)')
    .bind(id, tenantId, name, slug, opts.aliases ? JSON.stringify(opts.aliases) : null)
    .run();
  return id;
}

async function seedCoaQueueItem(
  tenantId: string,
  userId: string,
  opts: {
    supplier?: string | null;
    aiFields?: Record<string, string>;
    docTypeId?: string | null;
  } = {}
): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/coa.pdf`;
  // Path B downloads the pending file during approve; stage a real R2 object.
  await files.put(r2Key, new Uint8Array([1, 2, 3, 4]).buffer);
  await db
    .prepare(
      `INSERT INTO processing_queue
       (id, tenant_id, file_r2_key, file_name, file_size, mime_type,
        processing_status, status, created_by, output_kind, supplier, ai_fields, document_type_id)
       VALUES (?, ?, ?, 'coa.pdf', 4, 'application/pdf', 'processing', 'pending', ?, 'coa', ?, ?, ?)`
    )
    .bind(
      id,
      tenantId,
      r2Key,
      userId,
      opts.supplier ?? null,
      opts.aiFields ? JSON.stringify(opts.aiFields) : null,
      opts.docTypeId ?? null
    )
    .run();
  return id;
}

describe('resolveExistingSupplierId', () => {
  it('matches by slug', async () => {
    const id = await seedSupplier(seed.tenantId, 'Slug Match Co', { slug: 'slug-match-co' });
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'Slug Match Co');
    expect(got).toBe(id);
  });

  it('matches by exact case-insensitive name', async () => {
    const id = await seedSupplier(seed.tenantId, 'CaseName Foods', { slug: `cn-${generateTestId().slice(0, 6)}` });
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'casename foods');
    expect(got).toBe(id);
  });

  it('matches by normalized name (business suffix stripped)', async () => {
    const id = await seedSupplier(seed.tenantId, 'Medosweet Farms', { slug: `med-${generateTestId().slice(0, 6)}` });
    // "Medosweet Farms, Inc." normalizes to the same key as "Medosweet Farms".
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'Medosweet Farms, Inc.');
    expect(got).toBe(id);
  });

  it('matches by alias', async () => {
    const id = await seedSupplier(seed.tenantId, 'Canonical Dairy', {
      slug: `canon-${generateTestId().slice(0, 6)}`,
      aliases: ['CD Logistics', 'Canonical D'],
    });
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'CD Logistics');
    expect(got).toBe(id);
  });

  it('returns null for an unknown supplier', async () => {
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'Totally Unknown Vendor XYZ');
    expect(got).toBeNull();
  });

  it('returns null for junk (cell reference "C2#")', async () => {
    // Even if a junk-named row somehow existed, junk fails the plausibility
    // guard before any DB read, so it is never "known".
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'C2#');
    expect(got).toBeNull();
  });

  it('returns null for empty / whitespace', async () => {
    expect(await resolveExistingSupplierId(db, seed.tenantId, '')).toBeNull();
    expect(await resolveExistingSupplierId(db, seed.tenantId, '   ')).toBeNull();
    expect(await resolveExistingSupplierId(db, seed.tenantId, null)).toBeNull();
  });

  it('does not match a supplier in a different tenant', async () => {
    const id = await seedSupplier(seed.tenantId2, 'Other Tenant Supplier', { slug: `ots-${generateTestId().slice(0, 6)}` });
    expect(id).toBeTruthy();
    const got = await resolveExistingSupplierId(db, seed.tenantId, 'Other Tenant Supplier');
    expect(got).toBeNull();
  });
});

describe('PUT /api/queue/:id approve — supplier override', () => {
  const admin = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

  it('uses a valid same-tenant supplier_id override directly', async () => {
    const supplierId = await seedSupplier(seed.tenantId, 'Override Target', { slug: `ovt-${generateTestId().slice(0, 6)}` });
    // Raw extraction names a DIFFERENT supplier; override must win.
    const queueId = await seedCoaQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier: 'Wrong Extracted Name',
      aiFields: { title: 'Doc A' },
    });

    const res = await putQueueItem(
      makeCtx(`/api/queue/${queueId}`, queueId, { status: 'approved', supplier_id: supplierId }, admin())
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first<{ supplier_id: string | null }>();
    expect(doc!.supplier_id).toBe(supplierId);
  });

  it('ignores a wrong-tenant supplier_id and falls back to the extracted supplier', async () => {
    // supplier_id belongs to tenant2 — invalid for this item → fall through.
    const foreignId = await seedSupplier(seed.tenantId2, 'Foreign Supplier', { slug: `frn-${generateTestId().slice(0, 6)}` });
    const queueId = await seedCoaQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier: 'Legacy Fallback Supplier',
      aiFields: { title: 'Doc B' },
    });

    const res = await putQueueItem(
      makeCtx(`/api/queue/${queueId}`, queueId, { status: 'approved', supplier_id: foreignId }, admin())
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first<{ supplier_id: string | null }>();
    expect(doc!.supplier_id).not.toBe(foreignId);

    // The fallback created/resolved "Legacy Fallback Supplier" in this tenant.
    const fallback = await db
      .prepare('SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)')
      .bind(seed.tenantId, 'Legacy Fallback Supplier')
      .first<{ id: string }>();
    expect(fallback).not.toBeNull();
    expect(doc!.supplier_id).toBe(fallback!.id);
  });

  it('supplier_name override creates/dedupes via findOrCreateSupplier', async () => {
    // Pre-existing supplier; override name is an alias-equivalent of it.
    const existingId = await seedSupplier(seed.tenantId, 'Dedupe Dairy', { slug: `ddd-${generateTestId().slice(0, 6)}` });
    const queueId = await seedCoaQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier: 'Some Other Raw Name',
      aiFields: { title: 'Doc C' },
    });

    const res = await putQueueItem(
      makeCtx(
        `/api/queue/${queueId}`,
        queueId,
        { status: 'approved', supplier_name: 'Dedupe Dairy, Inc.' },
        admin()
      )
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first<{ supplier_id: string | null }>();
    // Deduped onto the existing row rather than minting a new one.
    expect(doc!.supplier_id).toBe(existingId);
  });
});

describe('PUT /api/queue/:id/results — COA never auto-ingests (review-only)', () => {
  const worker = () => ({ id: seed.userId, role: 'user', tenant_id: seed.tenantId });

  it('does NOT auto-ingest a KNOWN supplier at high confidence — stays pending, but pre-resolves supplier_id as review assist', async () => {
    await db
      .prepare('UPDATE tenants SET auto_approve_threshold = 0.8 WHERE id = ?')
      .bind(seed.tenantId)
      .run();
    const supplierId = await seedSupplier(seed.tenantId, 'Trusted Vendor', { slug: `trust-${generateTestId().slice(0, 6)}` });

    // No template — only the (now-removed) Path B auto-approve could ever have fired.
    const queueId = await seedCoaQueueItem(seed.tenantId, seed.userId, {
      supplier: 'Trusted Vendor',
    });

    const res = await putQueueResults(
      makeCtx(
        `/api/queue/${queueId}/results`,
        queueId,
        {
          processing_status: 'ready',
          supplier: 'Trusted Vendor',
          confidence: 0.95,
          ai_fields: JSON.stringify({ title: 'Auto Doc', product_name: 'Widget' }),
        },
        worker()
      )
    );
    expect(res.status).toBe(200);

    // The item stays in review — NOT approved, NOT auto-ingested.
    const row = await db
      .prepare('SELECT status, auto_ingested, supplier_id, processing_status FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; supplier_id: string | null; processing_status: string }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.processing_status).toBe('ready');
    // Review assist: the matched known supplier is pre-resolved onto the item.
    expect(row!.supplier_id).toBe(supplierId);

    // No document was created.
    const doc = await db
      .prepare('SELECT id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first();
    expect(doc).toBeNull();
  });

  it('does NOT auto-ingest when the supplier is UNKNOWN (stays pending, supplier_id left null)', async () => {
    await db
      .prepare('UPDATE tenants SET auto_approve_threshold = 0.8 WHERE id = ?')
      .bind(seed.tenantId)
      .run();

    const queueId = await seedCoaQueueItem(seed.tenantId, seed.userId, {
      supplier: 'Never Seen This Vendor Before',
    });

    const res = await putQueueResults(
      makeCtx(
        `/api/queue/${queueId}/results`,
        queueId,
        {
          processing_status: 'ready',
          supplier: 'Never Seen This Vendor Before',
          confidence: 0.99,
          ai_fields: JSON.stringify({ title: 'Should Stay Pending' }),
        },
        worker()
      )
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, supplier_id FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; supplier_id: string | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    expect(row!.supplier_id).toBeNull();

    const doc = await db
      .prepare('SELECT id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first();
    expect(doc).toBeNull();
  });

  it('does NOT auto-ingest for junk supplier even at high confidence', async () => {
    await db
      .prepare('UPDATE tenants SET auto_approve_threshold = 0.8 WHERE id = ?')
      .bind(seed.tenantId)
      .run();

    const queueId = await seedCoaQueueItem(seed.tenantId, seed.userId, { supplier: 'C2#' });

    const res = await putQueueResults(
      makeCtx(
        `/api/queue/${queueId}/results`,
        queueId,
        {
          processing_status: 'ready',
          supplier: 'C2#',
          confidence: 0.99,
          ai_fields: JSON.stringify({ title: 'Junk Supplier Doc' }),
        },
        worker()
      )
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare('SELECT status, supplier_id FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; supplier_id: string | null }>();
    expect(row!.status).toBe('pending');
    expect(row!.supplier_id).toBeNull();
  });

  it('does NOT auto-ingest even when a matching auto-ingest-enabled template exists (template only pre-fills the review form)', async () => {
    await db
      .prepare('UPDATE tenants SET auto_approve_threshold = 0.8 WHERE id = ?')
      .bind(seed.tenantId)
      .run();

    const supplierId = await seedSupplier(seed.tenantId, 'Template Vendor', { slug: `tpl-${generateTestId().slice(0, 6)}` });

    // A document type for the template + queue item.
    const docTypeId = generateTestId();
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, auto_ingest, active)
         VALUES (?, ?, 'COA', ?, 1, 1)`
      )
      .bind(docTypeId, seed.tenantId, `coa-${docTypeId.slice(0, 6)}`)
      .run();

    // An auto-ingest-enabled template with a 0 confidence threshold + no
    // required fields — under the OLD behavior this would have auto-ingested.
    const templateId = generateTestId();
    await db
      .prepare(
        `INSERT INTO extraction_templates
           (id, tenant_id, supplier_id, document_type_id, field_mappings, auto_ingest_enabled, confidence_threshold)
         VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .bind(
        templateId,
        seed.tenantId,
        supplierId,
        docTypeId,
        JSON.stringify([
          { field_key: 'lot_number', tier: 'primary', required: false, aliases: [] },
          { field_key: 'product_name', tier: 'product_name', required: false, aliases: [] },
        ])
      )
      .run();

    const queueId = await seedCoaQueueItem(seed.tenantId, seed.userId, {
      supplier: 'Template Vendor',
      docTypeId,
      aiFields: { lot_number: 'L-1', product_name: 'Widget' },
    });

    const res = await putQueueResults(
      makeCtx(
        `/api/queue/${queueId}/results`,
        queueId,
        {
          processing_status: 'ready',
          supplier: 'Template Vendor',
          confidence_score: 0.99,
          confidence: 0.99,
          ai_fields: JSON.stringify({ lot_number: 'L-1', product_name: 'Widget' }),
          document_type_id: docTypeId,
        },
        worker()
      )
    );
    expect(res.status).toBe(200);

    const row = await db
      .prepare('SELECT status, auto_ingested, template_id, supplier_id FROM processing_queue WHERE id = ?')
      .bind(queueId)
      .first<{ status: string; auto_ingested: number | null; template_id: string | null; supplier_id: string | null }>();
    // Stays in review, NOT auto-ingested...
    expect(row!.status).toBe('pending');
    expect(row!.auto_ingested ?? 0).toBe(0);
    // ...but the template + supplier are attached as review assist.
    expect(row!.template_id).toBe(templateId);
    expect(row!.supplier_id).toBe(supplierId);

    const doc = await db
      .prepare('SELECT id FROM documents WHERE external_ref = ?')
      .bind(`queue-${queueId}`)
      .first();
    expect(doc).toBeNull();
  });
});

describe('PUT /api/documents/:id — supplier_name resolves + sets supplier_id', () => {
  const admin = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

  async function seedDocument(tenantId: string): Promise<string> {
    const id = generateTestId();
    await db
      .prepare(
        `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by)
         VALUES (?, ?, 'PUT Target Doc', 1, 'active', ?)`
      )
      .bind(id, tenantId, seed.orgAdminId)
      .run();
    return id;
  }

  it('resolves a typed supplier_name to an existing supplier and sets supplier_id', async () => {
    const supplierId = await seedSupplier(seed.tenantId, 'Doc PUT Supplier', { slug: `dps-${generateTestId().slice(0, 6)}` });
    const docId = await seedDocument(seed.tenantId);

    const res = await putDocument(
      makeCtx(`/api/documents/${docId}`, docId, { supplier_name: 'Doc PUT Supplier, Inc.' }, admin())
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ supplier_id: string | null }>();
    expect(doc!.supplier_id).toBe(supplierId);
  });

  it('creates a new supplier from supplier_name when none exists', async () => {
    const docId = await seedDocument(seed.tenantId);
    const name = `Fresh Doc Supplier ${generateTestId().slice(0, 6)}`;

    const res = await putDocument(
      makeCtx(`/api/documents/${docId}`, docId, { supplier_name: name }, admin())
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ supplier_id: string | null }>();
    expect(doc!.supplier_id).not.toBeNull();

    const supplier = await db
      .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
      .bind(doc!.supplier_id, seed.tenantId)
      .first<{ id: string }>();
    expect(supplier).not.toBeNull();
  });

  it('explicit supplier_id takes precedence over supplier_name', async () => {
    const explicitId = await seedSupplier(seed.tenantId, 'Explicit Wins', { slug: `exw-${generateTestId().slice(0, 6)}` });
    const docId = await seedDocument(seed.tenantId);

    const res = await putDocument(
      makeCtx(
        `/api/documents/${docId}`,
        docId,
        { supplier_id: explicitId, supplier_name: 'Should Be Ignored Name' },
        admin()
      )
    );
    expect(res.status).toBe(200);

    const doc = await db
      .prepare('SELECT supplier_id FROM documents WHERE id = ?')
      .bind(docId)
      .first<{ supplier_id: string | null }>();
    expect(doc!.supplier_id).toBe(explicitId);
  });
});
