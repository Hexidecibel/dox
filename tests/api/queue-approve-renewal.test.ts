/**
 * API tests for the renewal half of PUT /api/queue/:id.
 *
 * ONE DISTINCTION IS BEING DEFENDED: a document whose renewal columns are NULL
 * because nobody has ruled, versus one whose columns are NULL because somebody
 * ruled that it does not renew. `resolveRenewalExpiry` tier 2 reads any
 * recorded decision as the second, permanently and ahead of every default, so a
 * decision written by accident is a certificate that never comes due again.
 *
 * The accident was real: the Review Queue sent the renewal key on every
 * approve, so an `unresolvable` proposal — "a period applies but there is no
 * effective date to count it from", where the box is empty because WE could not
 * fill it — came back as `{ due_date: null }` and was stored as 'accepted'.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';

let seed: Awaited<ReturnType<typeof seedTestData>>;
const db = env.DB;

beforeAll(async () => {
  seed = await seedTestData(db);
}, 30_000);

function makePutContext(
  id: string,
  body: Record<string, unknown>,
  user: { id: string; role: string; tenant_id: string | null },
) {
  const request = new Request(`http://localhost/api/queue/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    request,
    env,
    data: { user },
    params: { id },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: `/api/queue/${id}`,
  } as unknown as Parameters<typeof updateQueueItem>[0];
}

/** A document type with the migration-default renewal setting: annual. */
async function annualType(tenantId: string): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM document_types WHERE tenant_id = ? AND slug = ?')
    .bind(tenantId, 'renewal-annual')
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO document_types (id, tenant_id, name, slug, active, renewal_policy, renewal_interval_months)
       VALUES (?, ?, 'Letter of Guarantee', 'renewal-annual', 1, 'inherit', NULL)`,
    )
    .bind(id, tenantId)
    .run();
  return id;
}

async function seedQueueItem(
  tenantId: string,
  userId: string,
  fields: Record<string, unknown>,
): Promise<string> {
  const id = generateTestId();
  const r2Key = `queue/${id}/test.pdf`;
  const docTypeId = await annualType(tenantId);

  await env.FILES.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake'), {
    httpMetadata: { contentType: 'application/pdf' },
  });

  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          processing_status, status, created_by, extracted_text, ai_fields, confidence_score)
       VALUES (?, ?, ?, ?, ?, 12, 'application/pdf', 'ready', 'pending', ?, 'text', ?, 0.8)`,
    )
    .bind(id, tenantId, docTypeId, r2Key, 'test.pdf', userId, JSON.stringify(fields))
    .run();

  return id;
}

interface RenewalRow {
  renewal_due_date: string | null;
  renewal_decision: string | null;
  renewal_snapshot: string | null;
  renewal_decided_by: string | null;
}

async function approvedDocument(queueId: string): Promise<RenewalRow> {
  const row = await db
    .prepare(
      `SELECT renewal_due_date, renewal_decision, renewal_snapshot, renewal_decided_by
         FROM documents WHERE external_ref = ?`,
    )
    .bind(`queue-${queueId}`)
    .first<RenewalRow>();
  expect(row, 'the approve did not produce a document').toBeTruthy();
  return row!;
}

describe('PUT /api/queue/:id — the renewal decision', () => {
  const user = () => ({ id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId });

  it('an approve that sends NO renewal key leaves every renewal column NULL', async () => {
    // What the Review Queue now sends for an unresolvable proposal nobody
    // touched. All-NULL is the state that means "still to be decided", and the
    // dashboard goes on deriving a date rather than being overruled.
    const queueId = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier_name: 'ACME',
    });
    const res = await updateQueueItem(
      makePutContext(queueId, { status: 'approved', fields: { supplier_name: 'ACME' } }, user()),
    );
    expect(res.status).toBe(200);

    const doc = await approvedDocument(queueId);
    expect(doc.renewal_decision).toBeNull();
    expect(doc.renewal_due_date).toBeNull();
    expect(doc.renewal_snapshot).toBeNull();
    expect(doc.renewal_decided_by).toBeNull();
  });

  it('an empty answer to an unresolvable proposal is recorded as CLEARED, not accepted', async () => {
    // The reviewer deliberately left it blank after looking. That is a ruling,
    // and 'cleared' is the word for it — never 'accepted', which would claim
    // they agreed with a proposal that never existed.
    const queueId = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier_name: 'ACME',
    });
    const res = await updateQueueItem(
      makePutContext(
        queueId,
        { status: 'approved', fields: { supplier_name: 'ACME' }, renewal: { due_date: null } },
        user(),
      ),
    );
    expect(res.status).toBe(200);

    const doc = await approvedDocument(queueId);
    expect(doc.renewal_decision).toBe('cleared');
    expect(doc.renewal_due_date).toBeNull();
    const snap = JSON.parse(doc.renewal_snapshot!) as { rule: string; proposed_due_date: string | null };
    expect(snap.rule).toBe('unresolvable');
    expect(snap.proposed_due_date).toBeNull();
    expect(doc.renewal_decided_by).toBe(seed.orgAdminId);
  });

  it('a resolvable proposal confirmed as-is is an ACCEPT, and the date is stored', async () => {
    const queueId = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier_name: 'ACME',
      effective_date: '2026-01-15',
    });
    const res = await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME', effective_date: '2026-01-15' },
          renewal: { due_date: '2027-01-15' },
        },
        user(),
      ),
    );
    expect(res.status).toBe(200);

    const doc = await approvedDocument(queueId);
    expect(doc.renewal_decision).toBe('accepted');
    expect(doc.renewal_due_date).toBe('2027-01-15');
    const snap = JSON.parse(doc.renewal_snapshot!) as { rule: string };
    expect(snap.rule).toBe('system_default_annual');
  });

  it('writes an audit row naming the decision', async () => {
    const queueId = await seedQueueItem(seed.tenantId, seed.orgAdminId, {
      supplier_name: 'ACME',
      effective_date: '2026-02-01',
    });
    await updateQueueItem(
      makePutContext(
        queueId,
        {
          status: 'approved',
          fields: { supplier_name: 'ACME', effective_date: '2026-02-01' },
          renewal: { due_date: '2029-02-01' },
        },
        user(),
      ),
    );
    const audit = await db
      .prepare(
        `SELECT details FROM audit_log
          WHERE tenant_id = ? AND action = 'document.renewal_decided'
          ORDER BY id DESC LIMIT 1`,
      )
      .bind(seed.tenantId)
      .first<{ details: string }>();
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit!.details) as { decision: string; renewal_due_date: string };
    expect(details.decision).toBe('overridden');
    expect(details.renewal_due_date).toBe('2029-02-01');
  });
});
