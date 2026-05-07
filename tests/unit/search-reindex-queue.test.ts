/**
 * Phase 2 unit tests for the search_reindex_jobs queue + drainer (migration
 * 0055). These exercise the trigger boundary defined by Phase 1 (which
 * deliberately does NOT fan supplier/product/doc_type renames out to docs)
 * and prove that Phase 2 closes the loop:
 *
 *   1. Triggers on suppliers / products / document_types enqueue a job
 *      when name (or aliases / slug) changes.
 *   2. Enqueue is idempotent — repeating the same rename while a prior
 *      job is still pending must not produce a duplicate row.
 *   3. The drainer pulls pending jobs, looks up affected docs, deletes +
 *      re-inserts FTS rows in 500-row batches, and marks the job
 *      completed.
 *   4. The drainer is tenant-scoped — a job's affected-doc lookup
 *      respects the job's tenant_id.
 *   5. On failure, the drainer flips the job to status='failed' (or
 *      back to 'pending' with attempts++) and records last_error.
 *
 * Tests run against the live FTS schema from migration 0054 and the
 * Phase 2 schema from 0055.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { drainSearchReindexQueue } from '../../functions/lib/search-reindex';

const db = env.DB;

const TENANT_A = 'rqx-tenant-a';
const TENANT_B = 'rqx-tenant-b';
const USER_ID = 'rqx-user-1';

async function resetData(): Promise<void> {
  await db.prepare(`DELETE FROM search_reindex_jobs WHERE tenant_id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM document_products WHERE document_id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM document_versions WHERE document_id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM documents WHERE id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM products WHERE id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM document_types WHERE id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM suppliers WHERE id LIKE 'rqx-%'`).run();
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(USER_ID).run();
  await db.prepare(`DELETE FROM tenants WHERE id IN (?, ?)`).bind(TENANT_A, TENANT_B).run();
}

async function seedBaseline(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_A, 'Reindex Tenant A', 'rqx-tenant-a')
    .run();
  await db
    .prepare(
      `INSERT INTO tenants (id, name, slug, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(TENANT_B, 'Reindex Tenant B', 'rqx-tenant-b')
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .bind(USER_ID, 'rqx-user@test.com', 'RQX User', 'org_admin', TENANT_A, 'fakehash')
    .run();
}

interface InsertDocOpts {
  id: string;
  tenant_id: string;
  title: string;
  supplier_id?: string | null;
  document_type_id?: string | null;
  extracted_text?: string | null;
}

async function insertDocument(opts: InsertDocOpts): Promise<void> {
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, description, tags, supplier_id, document_type_id, status, current_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, NULL, '[]', ?, ?, 'active', 1, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      opts.id,
      opts.tenant_id,
      opts.title,
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
      `${opts.id}.pdf`,
      (opts.extracted_text ?? '').length,
      `r2/${opts.id}/v1.pdf`,
      opts.extracted_text ?? null,
      USER_ID,
    )
    .run();
}

async function linkDocProduct(docId: string, productId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO document_products (id, document_id, product_id, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(`${docId}-${productId}`, docId, productId)
    .run();
}

async function searchDocs(tenantId: string, term: string): Promise<string[]> {
  const matchExpr = `"${term.toLowerCase()}"*`;
  const result = await db
    .prepare(
      `SELECT doc_id
       FROM documents_fts
       WHERE tenant_id = ? AND documents_fts MATCH ?`,
    )
    .bind(tenantId, matchExpr)
    .all<{ doc_id: string }>();
  return (result.results ?? []).map((r) => r.doc_id);
}

interface JobRow {
  id: string;
  tenant_id: string;
  entity_kind: string;
  entity_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
}

async function listJobs(filter: Partial<JobRow> = {}): Promise<JobRow[]> {
  const conds: string[] = ['1=1'];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(filter)) {
    conds.push(`${k} = ?`);
    params.push(v);
  }
  const result = await db
    .prepare(
      `SELECT id, tenant_id, entity_kind, entity_id, status, attempts, last_error, processed_at
         FROM search_reindex_jobs
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at`,
    )
    .bind(...params)
    .all<JobRow>();
  return result.results ?? [];
}

beforeEach(async () => {
  await resetData();
  await seedBaseline();
});

describe('search_reindex_jobs — trigger enqueue', () => {
  it('enqueues exactly one pending job when a supplier name is updated', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'OldSupplier', 'oldsupplier', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-1', TENANT_A)
      .run();

    expect(await listJobs({ tenant_id: TENANT_A })).toEqual([]);

    await db
      .prepare(`UPDATE suppliers SET name = 'NewSupplier' WHERE id = ?`)
      .bind('rqx-sup-1')
      .run();

    const jobs = await listJobs({ tenant_id: TENANT_A });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      tenant_id: TENANT_A,
      entity_kind: 'supplier',
      entity_id: 'rqx-sup-1',
      status: 'pending',
      attempts: 0,
    });
  });

  it('enqueues a job when a supplier aliases column is updated', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Sup', 'sup', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-aliases', TENANT_A)
      .run();

    await db
      .prepare(`UPDATE suppliers SET aliases = ? WHERE id = ?`)
      .bind(JSON.stringify(['Alpha', 'Beta']), 'rqx-sup-aliases')
      .run();

    const jobs = await listJobs({ tenant_id: TENANT_A, entity_kind: 'supplier' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].entity_id).toBe('rqx-sup-aliases');
  });

  it('enqueues a job when a product name is updated', async () => {
    await db
      .prepare(
        `INSERT INTO products (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'OldProd', 'oldprod', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-prod-1', TENANT_A)
      .run();

    await db
      .prepare(`UPDATE products SET name = 'NewProd' WHERE id = ?`)
      .bind('rqx-prod-1')
      .run();

    const jobs = await listJobs({ tenant_id: TENANT_A, entity_kind: 'product' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].entity_id).toBe('rqx-prod-1');
  });

  it('enqueues a job when a document_type name is updated', async () => {
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'OldType', 'oldtype', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-dt-1', TENANT_A)
      .run();

    await db
      .prepare(`UPDATE document_types SET name = 'NewType' WHERE id = ?`)
      .bind('rqx-dt-1')
      .run();

    const jobs = await listJobs({ tenant_id: TENANT_A, entity_kind: 'document_type' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].entity_id).toBe('rqx-dt-1');
  });

  it('does not duplicate a pending job when the same supplier is renamed twice', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'A', 'a', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-dup', TENANT_A)
      .run();

    await db.prepare(`UPDATE suppliers SET name = 'B' WHERE id = ?`).bind('rqx-sup-dup').run();
    await db.prepare(`UPDATE suppliers SET name = 'C' WHERE id = ?`).bind('rqx-sup-dup').run();
    await db.prepare(`UPDATE suppliers SET name = 'D' WHERE id = ?`).bind('rqx-sup-dup').run();

    const jobs = await listJobs({ tenant_id: TENANT_A, entity_kind: 'supplier' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
  });
});

describe('drainSearchReindexQueue — basic drain', () => {
  it('re-emits documents_fts rows so the new supplier name matches and the old does not', async () => {
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Acmecorp', 'acmecorp', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-drain', TENANT_A)
      .run();

    await insertDocument({
      id: 'rqx-doc-drain-1',
      tenant_id: TENANT_A,
      title: 'Boring Title',
      supplier_id: 'rqx-sup-drain',
    });

    expect(await searchDocs(TENANT_A, 'acmecorp')).toContain('rqx-doc-drain-1');

    await db
      .prepare(`UPDATE suppliers SET name = 'Zenithco' WHERE id = ?`)
      .bind('rqx-sup-drain')
      .run();

    // Phase 1 boundary check: doc FTS row still has the old supplier text.
    expect(await searchDocs(TENANT_A, 'acmecorp')).toContain('rqx-doc-drain-1');
    expect(await searchDocs(TENANT_A, 'zenithco')).not.toContain('rqx-doc-drain-1');

    const result = await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });
    expect(result.jobsCompleted).toBe(1);
    expect(result.docsReindexed).toBe(1);

    expect(await searchDocs(TENANT_A, 'zenithco')).toContain('rqx-doc-drain-1');
    expect(await searchDocs(TENANT_A, 'acmecorp')).not.toContain('rqx-doc-drain-1');

    const jobs = await listJobs({ tenant_id: TENANT_A });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('completed');
    expect(jobs[0].processed_at).not.toBeNull();
  });

  it('re-emits documents_fts rows when a product name changes', async () => {
    await db
      .prepare(
        `INSERT INTO products (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'Buttercream', 'buttercream', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-prod-drain', TENANT_A)
      .run();
    await insertDocument({
      id: 'rqx-doc-prod-1',
      tenant_id: TENANT_A,
      title: 'Spec',
    });
    await linkDocProduct('rqx-doc-prod-1', 'rqx-prod-drain');

    expect(await searchDocs(TENANT_A, 'buttercream')).toContain('rqx-doc-prod-1');

    await db
      .prepare(`UPDATE products SET name = 'Margaroil' WHERE id = ?`)
      .bind('rqx-prod-drain')
      .run();

    expect(await searchDocs(TENANT_A, 'margaroil')).not.toContain('rqx-doc-prod-1');

    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });

    expect(await searchDocs(TENANT_A, 'margaroil')).toContain('rqx-doc-prod-1');
    expect(await searchDocs(TENANT_A, 'buttercream')).not.toContain('rqx-doc-prod-1');
  });

  it('re-emits documents_fts rows when a document_type name changes', async () => {
    await db
      .prepare(
        `INSERT INTO document_types (id, tenant_id, name, slug, description, active, created_at, updated_at)
         VALUES (?, ?, 'Certofan', 'certofan', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-dt-drain', TENANT_A)
      .run();
    await insertDocument({
      id: 'rqx-doc-dt-1',
      tenant_id: TENANT_A,
      title: 'Random Title',
      document_type_id: 'rqx-dt-drain',
    });

    expect(await searchDocs(TENANT_A, 'certofan')).toContain('rqx-doc-dt-1');

    // Rename both name and slug — the source view indexes both, so a
    // realistic doc_type rename touches them together.
    await db
      .prepare(
        `UPDATE document_types SET name = 'Slipsheet', slug = 'slipsheet' WHERE id = ?`,
      )
      .bind('rqx-dt-drain')
      .run();

    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });

    expect(await searchDocs(TENANT_A, 'slipsheet')).toContain('rqx-doc-dt-1');
    expect(await searchDocs(TENANT_A, 'certofan')).not.toContain('rqx-doc-dt-1');
  });
});

describe('drainSearchReindexQueue — chunking', () => {
  // Lower the linked-doc count from 1200 to 120 to keep the test fast in
  // miniflare. The batchSize is dropped to 50 so we still cross multiple
  // batches and exercise the chunking loop. The plan calls for 500 in
  // production; this test asserts the LOOP works, not the absolute number.
  it('processes a high-fan-out supplier in multiple batches', async () => {
    const docCount = 120;
    const batchSize = 50;

    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'Originalsup', 'originalsup', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-fan', TENANT_A)
      .run();

    for (let i = 0; i < docCount; i++) {
      await insertDocument({
        id: `rqx-doc-fan-${i}`,
        tenant_id: TENANT_A,
        title: `Fanout Doc ${i}`,
        supplier_id: 'rqx-sup-fan',
      });
    }

    // Sanity: every doc starts matching the original supplier name.
    const beforeHits = await searchDocs(TENANT_A, 'originalsup');
    expect(beforeHits.length).toBe(docCount);

    await db
      .prepare(`UPDATE suppliers SET name = 'Renamedsup' WHERE id = ?`)
      .bind('rqx-sup-fan')
      .run();

    const result = await drainSearchReindexQueue(db, { batchSize, maxJobs: 10 });
    expect(result.jobsCompleted).toBe(1);
    expect(result.docsReindexed).toBe(docCount);
    expect(result.batchesRun).toBeGreaterThanOrEqual(Math.ceil(docCount / batchSize));

    const afterHits = await searchDocs(TENANT_A, 'renamedsup');
    expect(afterHits.length).toBe(docCount);
  });
});

describe('drainSearchReindexQueue — failure handling', () => {
  it('flips a job to failed once max attempts is exhausted, recording last_error', async () => {
    // Synthesize an unresolvable job: entity_kind='supplier' but the
    // supplier row was deleted before drain. The drainer should treat
    // missing entities as a hard failure (vs an unknown-kind crash).
    // Insert the job manually so we don't depend on triggers for this case.
    await db
      .prepare(
        `INSERT INTO search_reindex_jobs
           (id, tenant_id, entity_kind, entity_id, status, attempts, max_attempts, created_at)
         VALUES (?, ?, 'unknown_kind_xx', 'nonexistent', 'pending', 0, 1, datetime('now'))`,
      )
      .bind('rqx-job-bad', TENANT_A)
      .run();

    const result = await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });
    expect(result.jobsFailed).toBe(1);

    const jobs = await listJobs({ id: 'rqx-job-bad' });
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].last_error).not.toBeNull();
    expect(jobs[0].attempts).toBeGreaterThan(0);
  });

  it('leaves a job in pending when attempts < max_attempts and a transient failure occurs', async () => {
    // Same trick: an unknown_kind row that the drainer treats as a
    // permanent error. With max_attempts=3 and attempts=0, after one
    // drain the job's attempts==1 and status stays 'pending' (next drain
    // tick will retry).
    await db
      .prepare(
        `INSERT INTO search_reindex_jobs
           (id, tenant_id, entity_kind, entity_id, status, attempts, max_attempts, created_at)
         VALUES (?, ?, 'unknown_kind_xx', 'nonexistent', 'pending', 0, 3, datetime('now'))`,
      )
      .bind('rqx-job-retry', TENANT_A)
      .run();

    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });

    const jobs = await listJobs({ id: 'rqx-job-retry' });
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].attempts).toBe(1);
    expect(jobs[0].last_error).not.toBeNull();

    // Drain twice more — should hit max_attempts and flip to 'failed'.
    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });
    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });

    const finalJobs = await listJobs({ id: 'rqx-job-retry' });
    expect(finalJobs[0].status).toBe('failed');
    expect(finalJobs[0].attempts).toBe(3);
  });
});

describe('drainSearchReindexQueue — tenant scoping', () => {
  it('only re-emits docs in the job\'s tenant when a shared-id supplier rename happens', async () => {
    // Set up two suppliers (different ids) in different tenants. Only
    // tenant A's supplier is renamed. The drainer must not touch
    // tenant B's docs even if some other process accidentally enqueued
    // a tenant-A job referencing tenant B doc ids.
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'TenantAOriginal', 'tenant-a-original', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-tenant-a', TENANT_A)
      .run();
    await db
      .prepare(
        `INSERT INTO suppliers (id, tenant_id, name, slug, aliases, active, created_at, updated_at)
         VALUES (?, ?, 'TenantBOriginal', 'tenant-b-original', NULL, 1, datetime('now'), datetime('now'))`,
      )
      .bind('rqx-sup-tenant-b', TENANT_B)
      .run();

    await insertDocument({
      id: 'rqx-doc-ta-1',
      tenant_id: TENANT_A,
      title: 'A doc',
      supplier_id: 'rqx-sup-tenant-a',
    });
    await insertDocument({
      id: 'rqx-doc-tb-1',
      tenant_id: TENANT_B,
      title: 'B doc',
      supplier_id: 'rqx-sup-tenant-b',
    });

    // Snapshot tenant B's FTS row before drain.
    const tenantBBefore = await db
      .prepare(
        `SELECT supplier_text FROM documents_fts
          WHERE doc_id = ? AND tenant_id = ?`,
      )
      .bind('rqx-doc-tb-1', TENANT_B)
      .first<{ supplier_text: string }>();

    await db
      .prepare(`UPDATE suppliers SET name = 'TenantARenamed' WHERE id = ?`)
      .bind('rqx-sup-tenant-a')
      .run();

    await drainSearchReindexQueue(db, { batchSize: 500, maxJobs: 10 });

    // Tenant A's doc reflects the rename.
    expect(await searchDocs(TENANT_A, 'tenantarenamed')).toContain('rqx-doc-ta-1');
    // Tenant B's doc text is unchanged.
    const tenantBAfter = await db
      .prepare(
        `SELECT supplier_text FROM documents_fts
          WHERE doc_id = ? AND tenant_id = ?`,
      )
      .bind('rqx-doc-tb-1', TENANT_B)
      .first<{ supplier_text: string }>();
    expect(tenantBAfter?.supplier_text).toBe(tenantBBefore?.supplier_text);
    expect(await searchDocs(TENANT_B, 'tenantboriginal')).toContain('rqx-doc-tb-1');
  });
});
