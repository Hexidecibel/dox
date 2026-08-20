/**
 * The out-of-spec register and its notification hop.
 *
 * What is worth pinning here is not that a row gets written — it is the three
 * properties that make the register trustworthy months later:
 *
 *   1. The limit is FROZEN into the row. Tightening a threshold in September
 *      must not silently rewrite what was judged in March.
 *   2. A verdict lands on the RIGHT document. A records-mode COA becomes N
 *      documents, and filing record 3's failure against record 0's document
 *      would be a fabricated safety record.
 *   3. Somebody is always told. "Nobody is assigned" must not resolve to
 *      "nobody hears about it".
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { seedTestData, generateTestId } from '../helpers/db';
import {
  registerSpecChecks,
  resolveAlertRecipients,
  registerAndNotifyForApproval,
} from '../../functions/lib/spec-register';
import type { SpecVerdict, ConfiguredLimit } from '../../shared/specCheck';

const db = env.DB;
let seed: Awaited<ReturnType<typeof seedTestData>>;
let supplierId = '';
let docTypeId = '';

const LIMIT: ConfiguredLimit = {
  id: 'limit-coliform',
  spec_test_id: 'st-coliform',
  operator: '<=',
  value_min: null,
  value_max: 10,
  unit: 'CFU/g',
  severity: 'alert',
  active: true,
  supplier_id: null,
  document_type_id: null,
  product_id: null,
};

function verdict(over: Partial<SpecVerdict> = {}): SpecVerdict {
  return {
    scope: 'ai_fields',
    target: { kind: 'table', table_index: 0, row_index: 0, table_name: 'micro' },
    test_name_raw: 'Coliform',
    value_raw: '40',
    unit_raw: 'CFU/g',
    verdict: 'out_of_spec',
    source: 'limit',
    limit_text: '≤10 CFU/g',
    reason: '40 exceeds the 10 limit',
    message: 'Coliform is 40, outside our limit of ≤10 CFU/g.',
    limit_id: LIMIT.id,
    spec_test_id: LIMIT.spec_test_id,
    value_num: 40,
    ...over,
  };
}

async function makeDocument(title: string): Promise<string> {
  const id = generateTestId();
  await db
    .prepare(
      `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, supplier_id)
       VALUES (?, ?, ?, 1, 'active', ?, ?)`
    )
    .bind(id, seed.tenantId, title, seed.orgAdminId, supplierId)
    .run();
  return id;
}

beforeAll(async () => {
  seed = await seedTestData(db);

  supplierId = generateTestId();
  await db
    .prepare('INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)')
    .bind(supplierId, seed.tenantId, 'Andersen Dairy', `andersen-${supplierId.slice(0, 6)}`)
    .run();

  docTypeId = generateTestId();
  await db
    .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
    .bind(docTypeId, seed.tenantId, 'COA', `coa-${docTypeId.slice(0, 6)}`)
    .run();
}, 30_000);

describe('registerSpecChecks', () => {
  it('freezes the limit into the row', async () => {
    const documentId = await makeDocument('Frozen limit COA');
    await registerSpecChecks(db, { tenantId: seed.tenantId, documentId, versionNumber: 1 }, [verdict()], [
      LIMIT,
    ]);

    const row = await db
      .prepare('SELECT * FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<Record<string, unknown>>();

    const snapshot = JSON.parse(String(row!.limit_snapshot));
    expect(snapshot).toMatchObject({ operator: '<=', value_max: 10, unit: 'CFU/g' });
    expect(row!.verdict).toBe('out_of_spec');
    expect(row!.value_num).toBe(40);
    expect(row!.limit_id).toBe(LIMIT.id);

    // Move the threshold. The recorded judgement must not change with it.
    const tightened: ConfiguredLimit = { ...LIMIT, value_max: 1 };
    const after = await db
      .prepare('SELECT limit_snapshot FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<{ limit_snapshot: string }>();
    expect(JSON.parse(after!.limit_snapshot).value_max).toBe(10);
    expect(tightened.value_max).toBe(1);
  });

  it('stores not_checked results, not just failures', async () => {
    // A register that only holds passes and failures implies everything absent
    // from it was fine — the exact false negative this feature exists to avoid.
    const documentId = await makeDocument('Unjudgeable COA');
    await registerSpecChecks(
      db,
      { tenantId: seed.tenantId, documentId },
      [
        verdict({ verdict: 'not_checked', reason: 'reported as <50, which straddles the 10 limit' }),
        verdict({ verdict: 'in_spec', test_name_raw: 'SPC' }),
      ],
      [LIMIT]
    );

    const rows = await db
      .prepare('SELECT verdict, reason FROM document_spec_checks WHERE document_id = ? ORDER BY verdict')
      .bind(documentId)
      .all();
    expect(rows.results.map((r: any) => r.verdict).sort()).toEqual(['in_spec', 'not_checked']);
    const nc = rows.results.find((r: any) => r.verdict === 'not_checked') as any;
    expect(nc.reason).toMatch(/straddle/);
  });

  it('records the approving reviewer as the acknowledgement, on failures only', async () => {
    const documentId = await makeDocument('Approved anyway COA');
    await registerSpecChecks(
      db,
      { tenantId: seed.tenantId, documentId, acknowledgedBy: seed.orgAdminId, acknowledgementNote: 'ok' },
      [verdict(), verdict({ verdict: 'in_spec', test_name_raw: 'SPC' })],
      [LIMIT]
    );

    const rows = (
      await db
        .prepare('SELECT verdict, acknowledged_by FROM document_spec_checks WHERE document_id = ?')
        .bind(documentId)
        .all()
    ).results as any[];
    const fail = rows.find((r) => r.verdict === 'out_of_spec');
    const pass = rows.find((r) => r.verdict === 'in_spec');
    expect(fail.acknowledged_by).toBe(seed.orgAdminId);
    // A passing result was never in front of anybody to acknowledge.
    expect(pass.acknowledged_by).toBeNull();
  });

  it('replaces prior results for the same document version rather than piling up', async () => {
    const documentId = await makeDocument('Rechecked COA');
    const ctx = { tenantId: seed.tenantId, documentId, versionNumber: 1 };
    await registerSpecChecks(db, ctx, [verdict()], [LIMIT]);
    await registerSpecChecks(db, ctx, [verdict()], [LIMIT]);

    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_spec_checks WHERE document_id = ?')
      .bind(documentId)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe('resolveAlertRecipients', () => {
  it('prefers the owner of the (supplier, doctype) queue', async () => {
    await db
      .prepare(
        `INSERT INTO assignments (id, tenant_id, supplier_id, document_type_id, owner_user_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(generateTestId(), seed.tenantId, supplierId, docTypeId, seed.userId)
      .run();

    const r = await resolveAlertRecipients(db, seed.tenantId, supplierId, docTypeId);
    expect(r.map((x) => x.email)).toEqual(['user@test.com']);
  });

  it('falls back to org_admins when nobody owns the combo', async () => {
    // "Nobody is assigned" must never resolve to "nobody is told".
    const orphanDocType = generateTestId();
    await db
      .prepare('INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)')
      .bind(orphanDocType, seed.tenantId, 'Unowned Type', `unowned-${orphanDocType.slice(0, 6)}`)
      .run();

    const r = await resolveAlertRecipients(db, seed.tenantId, supplierId, orphanDocType);
    expect(r.length).toBeGreaterThan(0);
    expect(r.map((x) => x.email)).toContain('orgadmin@test.com');
  });

  it('falls back when the document has no supplier at all', async () => {
    const r = await resolveAlertRecipients(db, seed.tenantId, null, null);
    expect(r.map((x) => x.email)).toContain('orgadmin@test.com');
  });
});

describe('registerAndNotifyForApproval', () => {
  it('files each record verdict against ITS OWN document', async () => {
    const doc0 = await makeDocument('Lot A');
    const doc3 = await makeDocument('Lot D');

    await registerAndNotifyForApproval(
      db,
      undefined, // no email configured — registration still happens
      {
        tenantId: seed.tenantId,
        tenantName: 'Test Corp',
        queueItemId: 'q-1',
        supplierId,
        supplierName: 'Andersen Dairy',
        documentTypeId: docTypeId,
        approvedBy: seed.orgAdminId,
      },
      [
        verdict({ scope: 'record[0]', test_name_raw: 'Coliform', value_raw: '2', verdict: 'in_spec' }),
        verdict({ scope: 'record[3]', test_name_raw: 'Coliform', value_raw: '40' }),
      ],
      [LIMIT],
      [
        { documentId: doc0, title: 'Lot A', recordIndex: 0 },
        { documentId: doc3, title: 'Lot D', recordIndex: 3 },
      ]
    );

    const a = (await db
      .prepare('SELECT verdict, value_raw FROM document_spec_checks WHERE document_id = ?')
      .bind(doc0)
      .first()) as any;
    const d = (await db
      .prepare('SELECT verdict, value_raw FROM document_spec_checks WHERE document_id = ?')
      .bind(doc3)
      .first()) as any;

    expect(a.verdict).toBe('in_spec');
    expect(a.value_raw).toBe('2');
    expect(d.verdict).toBe('out_of_spec');
    expect(d.value_raw).toBe('40');
  });

  it('drops verdicts for records that produced no document', async () => {
    // A held or rejected record filed nothing, so there is nothing to file a
    // result against — and inventing one would be a fabricated record.
    const doc0 = await makeDocument('Only approved lot');
    await registerAndNotifyForApproval(
      db,
      undefined,
      {
        tenantId: seed.tenantId,
        tenantName: 'Test Corp',
        queueItemId: 'q-2',
        supplierId,
        supplierName: 'Andersen Dairy',
        documentTypeId: docTypeId,
        approvedBy: seed.orgAdminId,
      },
      [verdict({ scope: 'record[0]' }), verdict({ scope: 'record[9]' })],
      [LIMIT],
      [{ documentId: doc0, title: 'Only approved lot', recordIndex: 0 }]
    );

    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_spec_checks WHERE queue_item_id = ?')
      .bind('q-2')
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('sends ONE email per document, however many results failed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
    );
    try {
      const doc = await makeDocument('Three failures COA');
      await registerAndNotifyForApproval(
        db,
        're_test_key',
        {
          tenantId: seed.tenantId,
          tenantName: 'Test Corp',
          queueItemId: 'q-3',
          supplierId,
          supplierName: 'Andersen Dairy',
          documentTypeId: docTypeId,
          approvedBy: seed.orgAdminId,
        },
        [
          verdict({ test_name_raw: 'Coliform' }),
          verdict({ test_name_raw: 'SPC', value_raw: '99999' }),
          verdict({ test_name_raw: 'Yeast & Mold', value_raw: '5000' }),
        ],
        [LIMIT],
        [{ documentId: doc, title: 'Three failures COA', recordIndex: null }]
      );

      const emailCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('resend.com'));
      expect(emailCalls).toHaveLength(1);

      const body = JSON.parse(String((emailCalls[0][1] as RequestInit).body));
      expect(body.subject).toMatch(/3 out-of-spec results/);
      // All three named in the one email.
      expect(body.html).toContain('Coliform');
      expect(body.html).toContain('SPC');
      expect(body.html).toContain('Yeast &amp; Mold');

      const notified = await db
        .prepare('SELECT COUNT(*) AS n FROM document_spec_checks WHERE document_id = ? AND notified_at IS NOT NULL')
        .bind(doc)
        .first<{ n: number }>();
      expect(notified!.n).toBe(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('still registers when email is not configured', async () => {
    const doc = await makeDocument('No email tenant COA');
    await registerAndNotifyForApproval(
      db,
      undefined,
      {
        tenantId: seed.tenantId,
        tenantName: 'Test Corp',
        queueItemId: 'q-4',
        supplierId,
        supplierName: null,
        documentTypeId: docTypeId,
        approvedBy: seed.orgAdminId,
      },
      [verdict()],
      [LIMIT],
      [{ documentId: doc, title: 'No email tenant COA', recordIndex: null }]
    );
    const n = await db
      .prepare('SELECT COUNT(*) AS n FROM document_spec_checks WHERE document_id = ?')
      .bind(doc)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});
