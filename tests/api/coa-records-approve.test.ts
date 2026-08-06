/**
 * COA sublot split (Option B) — backend foundation tests.
 *
 * Covers:
 *   - computeRecordLotKey / normalizeSubLotCode: the load-bearing combine rule
 *     ("10426110" + "05" = "1042611005"; '' sentinel when no sublot).
 *   - produceCoaRecords: ONE document + ONE lots row PER sublot record; each
 *     doc attached to ITS OWN combined lot; idempotent external_ref keyed on
 *     sublot identity (re-run upserts the same lots, not duplicates); a
 *     no-sublot record produces a '' sub_lot_code row.
 *   - handleCoaRecordsApprove (via onRequestPut): partial approval — when a
 *     record is held the queue item STAYS pending and only approved records
 *     produce documents.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runMigrations, seedTestData, cleanTables, generateTestId } from '../helpers/db';
import {
  produceCoaRecords,
  computeRecordLotKey,
} from '../../functions/lib/kinds/coa';
import { normalizeSubLotCode } from '../../functions/lib/entities/lots';
import { onRequestPut as updateQueueItem } from '../../functions/api/queue/[id]';
import type { CoaRecordsPayload } from '../../../shared/types';
import type { QueueItem } from '../../lib/queue-approve';

const db = env.DB;
const files = env.FILES;
let seed: Awaited<ReturnType<typeof seedTestData>>;

beforeEach(async () => {
  await runMigrations(db);
  await cleanTables(db);
  seed = await seedTestData(db);
}, 30_000);

// --- fixture helpers -------------------------------------------------------

/** Insert a pending COA queue item with a real R2 file behind file_r2_key. */
async function makeCoaQueueItem(
  aiRecords: CoaRecordsPayload | null
): Promise<QueueItem & { ai_records: string | null; output_kind: string }> {
  const id = generateTestId();
  const r2Key = `pending/${id}.pdf`;
  await files.put(r2Key, new TextEncoder().encode('%PDF-1.4 fake coa'), {
    httpMetadata: { contentType: 'application/pdf' },
  });
  await db
    .prepare(
      `INSERT INTO processing_queue
         (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type,
          ai_records, processing_status, output_kind, status, created_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'application/pdf', ?, 'ready', 'coa', 'pending', ?, datetime('now'))`
    )
    .bind(
      id,
      seed.tenantId,
      r2Key,
      `${id}.pdf`,
      17,
      aiRecords ? JSON.stringify(aiRecords) : null,
      seed.userId
    )
    .run();

  return {
    id,
    tenant_id: seed.tenantId,
    document_type_id: null,
    file_r2_key: r2Key,
    file_name: `${id}.pdf`,
    file_size: 17,
    mime_type: 'application/pdf',
    extracted_text: null,
    ai_fields: null,
    ai_confidence: null,
    confidence_score: null,
    product_names: null,
    supplier: null,
    status: 'pending',
    created_by: seed.userId,
    tenant_slug: 'test-corp',
    ai_records: aiRecords ? JSON.stringify(aiRecords) : null,
    output_kind: 'coa',
  };
}

/** A Darigold-style 3-sublot payload sharing one main lot + product. */
function darigoldPayload(): CoaRecordsPayload {
  const mkRecord = (idx: number, sub: string) => ({
    record_index: idx,
    fields: {
      lot_code: '10426110',
      sub_lot_code: sub,
      product_name: 'Sweet Cream Butter',
    },
    source_pages: [6],
  });
  return {
    record_cardinality: 'multi_lot',
    record_key_basis: 'lot+sublot',
    page_metadata: { manufacturer: 'Darigold', coa_number: 'EDI178057' },
    records: [mkRecord(0, '05'), mkRecord(1, '04'), mkRecord(2, '02')],
  };
}

async function getLotsForKey(lotKey: string) {
  const res = await db
    .prepare(
      'SELECT id, lot_number, sub_lot_code, lot_key FROM lots WHERE tenant_id = ? AND lot_key = ?'
    )
    .bind(seed.tenantId, lotKey)
    .all<{ id: string; lot_number: string; sub_lot_code: string; lot_key: string }>();
  return res.results ?? [];
}

async function countDocsForQueue(queueId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE external_ref LIKE ?"
    )
    .bind(`queue-${queueId}-%`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- combine rule ----------------------------------------------------------

describe('normalizeSubLotCode', () => {
  it('takes a 2-digit sublot verbatim', () => {
    expect(normalizeSubLotCode('05')).toBe('05');
    expect(normalizeSubLotCode(' 04 ')).toBe('04');
    expect(normalizeSubLotCode('AB')).toBe('AB');
  });
  it('returns the empty-string sentinel for absent sublot', () => {
    expect(normalizeSubLotCode(null)).toBe('');
    expect(normalizeSubLotCode(undefined)).toBe('');
    expect(normalizeSubLotCode('   ')).toBe('');
    expect(normalizeSubLotCode('-')).toBe('');
  });
  it('defensively pads a stray 1-digit sublot', () => {
    expect(normalizeSubLotCode('5')).toBe('05');
  });
});

describe('computeRecordLotKey', () => {
  it('concatenates main lot + sublot verbatim ("10426110" + "05" = "1042611005")', () => {
    const out = computeRecordLotKey({ lot_code: '10426110', sub_lot_code: '05' });
    expect(out).toEqual({ lotNumber: '10426110', subLotCode: '05', lotKey: '1042611005' });
  });
  it('uses the "" sentinel + bare normalized key when no sublot', () => {
    const out = computeRecordLotKey({ lot_code: 'Lot# 061926-LC3' });
    expect(out).toEqual({ lotNumber: 'Lot# 061926-LC3', subLotCode: '', lotKey: '061926LC3' });
  });
  it('returns null when the record has no usable lot', () => {
    expect(computeRecordLotKey({ product_name: 'x' })).toBeNull();
    expect(computeRecordLotKey({ lot_code: '   ' })).toBeNull();
  });
});

// --- produceCoaRecords -----------------------------------------------------

describe('produceCoaRecords', () => {
  it('produces one document + one lot per sublot, each with the combined key', async () => {
    const item = await makeCoaQueueItem(darigoldPayload());
    const result = await produceCoaRecords(db, files, item, {
      payload: darigoldPayload(),
      userId: seed.userId,
    });

    expect(result.documents).toHaveLength(3);
    expect(result.heldRecordIndexes).toEqual([]);
    expect(result.documents.map(d => d.lotKey).sort()).toEqual([
      '1042611002',
      '1042611004',
      '1042611005',
    ]);
    expect(result.documents.map(d => d.subLotCode).sort()).toEqual(['02', '04', '05']);

    // Three distinct combined lots exist, each lot_number=10426110 + its sublot.
    const l05 = await getLotsForKey('1042611005');
    expect(l05).toHaveLength(1);
    expect(l05[0].lot_number).toBe('10426110');
    expect(l05[0].sub_lot_code).toBe('05');
    expect(await getLotsForKey('1042611004')).toHaveLength(1);
    expect(await getLotsForKey('1042611002')).toHaveLength(1);

    // Three documents, each linked to exactly one lot.
    expect(await countDocsForQueue(item.id)).toBe(3);

    // Queue item flipped to approved (nothing held).
    const q = await db
      .prepare('SELECT status FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ status: string }>();
    expect(q?.status).toBe('approved');
  });

  it('RETAINS the source bundle instead of deleting it', async () => {
    // This path page-scopes: it writes one PDF per record, so the produced
    // documents are SLICES of the bundle, not the bundle. Deleting the staging
    // object here destroys the only surviving copy of the multi-page shape.
    //
    // That cost is measured: across three studies the bundle shape could not be
    // graded even once, because every multi-page item resolves to slices that
    // would be graded as if they were originals. Every approval widened the gap.
    // So this path stamps the migration-0083 tombstone instead of deleting.
    const item = await makeCoaQueueItem(darigoldPayload());
    await produceCoaRecords(db, files, item, {
      payload: darigoldPayload(),
      userId: seed.userId,
    });

    // The bytes are still there.
    const obj = await files.get(item.file_r2_key);
    expect(obj).not.toBeNull();

    // ...and tombstoned rather than kept forever.
    const row = await db
      .prepare('SELECT file_retain_until FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ file_retain_until: string | null }>();
    expect(row?.file_retain_until).toBeTruthy();
    // Roughly 90 days out — assert the window is in the future and not absurd.
    const days = (Date.parse(row!.file_retain_until!.replace(' ', 'T') + 'Z') - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(80);
    expect(days).toBeLessThan(100);
  });

  it('does NOT retain when records are held — the item is not resolved yet', async () => {
    // Retention is stamped only when the whole item is resolved, matching where
    // the delete used to live. A partially-approved item keeps its staging file
    // for the ordinary reason: there is still work to do on it.
    const payload = darigoldPayload();
    const item = await makeCoaQueueItem(payload);
    const result = await produceCoaRecords(db, files, item, {
      payload,
      userId: seed.userId,
      decisions: { 0: 'hold' as const },
    });
    expect(result.heldRecordIndexes.length).toBeGreaterThan(0);
    const row = await db
      .prepare('SELECT status, file_retain_until FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ status: string; file_retain_until: string | null }>();
    expect(row?.status).not.toBe('approved');
    expect(row?.file_retain_until).toBeNull();
  });

  it('is idempotent on sublot identity — re-run reuses the same docs + lots, no dups', async () => {
    const item = await makeCoaQueueItem(darigoldPayload());
    const first = await produceCoaRecords(db, files, item, {
      payload: darigoldPayload(),
      userId: seed.userId,
    });
    const firstDocIds = first.documents.map(d => d.documentId).sort();

    // Re-run with a fresh R2 file (the first run deleted the pending blob).
    await files.put(item.file_r2_key, new TextEncoder().encode('%PDF again'), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    const second = await produceCoaRecords(db, files, item, {
      payload: darigoldPayload(),
      userId: seed.userId,
    });
    const secondDocIds = second.documents.map(d => d.documentId).sort();

    // Same external_ref → same document rows reused, not duplicated.
    expect(secondDocIds).toEqual(firstDocIds);
    expect(await countDocsForQueue(item.id)).toBe(3);

    // Lots collapse: still exactly one row per combined key.
    expect(await getLotsForKey('1042611005')).toHaveLength(1);
    expect(await getLotsForKey('1042611004')).toHaveLength(1);
    expect(await getLotsForKey('1042611002')).toHaveLength(1);

    // Exactly the three sublot-identity external_refs, no extras.
    const refs = await db
      .prepare('SELECT external_ref FROM documents WHERE external_ref LIKE ? ORDER BY external_ref')
      .bind(`queue-${item.id}-%`)
      .all<{ external_ref: string }>();
    expect((refs.results ?? []).map(r => r.external_ref)).toEqual([
      `queue-${item.id}-1042611002`,
      `queue-${item.id}-1042611004`,
      `queue-${item.id}-1042611005`,
    ]);
  });

  it('date_code supplier (0075): stored lot_key + external_ref are stripped to the bare MMDDYY date', async () => {
    // A Country-Morning-style supplier pinned to date_code: COA lot "061626WHO"
    // must store as bare "061626" so it collides with the bare-date WMS line,
    // and external_ref = queue-{id}-061626 must agree with the lots row.
    const supplierId = generateTestId();
    await db
      .prepare(
        "INSERT INTO suppliers (id, tenant_id, name, slug, lot_scheme) VALUES (?, ?, ?, ?, 'date_code')"
      )
      .bind(supplierId, seed.tenantId, 'Country Morning Farms', `cmf-${supplierId.slice(0, 6)}`)
      .run();

    const payload: CoaRecordsPayload = {
      record_cardinality: 'single',
      record_key_basis: 'lot',
      page_metadata: { manufacturer: 'Country Morning Farms' },
      records: [
        { record_index: 0, fields: { lot_code: '061626WHO', product_name: 'Milk - Whole' } },
      ],
    };
    const item = await makeCoaQueueItem(payload);
    const result = await produceCoaRecords(db, files, item, {
      payload,
      userId: seed.userId,
      supplierId,
    });

    expect(result.documents).toHaveLength(1);
    // lot_key stripped to the bare date; sublot forced to ''.
    expect(result.documents[0].lotKey).toBe('061626');
    expect(result.documents[0].subLotCode).toBe('');
    // external_ref agrees with the stripped lot_key (not the suffixed raw).
    expect(result.documents[0].externalRef).toBe(`queue-${item.id}-061626`);

    // The stored lots row is bare-date too.
    const lots = await getLotsForKey('061626');
    expect(lots).toHaveLength(1);
    expect(lots[0].lot_key).toBe('061626');
    expect(lots[0].sub_lot_code).toBe('');
    // No suffixed lot row was created.
    expect(await getLotsForKey('061626WHO')).toHaveLength(0);
  });

  it('produces a "" sub_lot_code lot for a single-lot record with no sublot', async () => {
    const payload: CoaRecordsPayload = {
      record_cardinality: 'single',
      record_key_basis: 'lot',
      page_metadata: { manufacturer: 'Acme' },
      records: [
        { record_index: 0, fields: { lot_code: '061926-LC3', product_name: 'Cheddar' } },
      ],
    };
    const item = await makeCoaQueueItem(payload);
    const result = await produceCoaRecords(db, files, item, { payload, userId: seed.userId });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].subLotCode).toBe('');
    expect(result.documents[0].lotKey).toBe('061926LC3');

    const lots = await getLotsForKey('061926LC3');
    expect(lots).toHaveLength(1);
    expect(lots[0].sub_lot_code).toBe('');
    expect(result.documents[0].externalRef).toBe(`queue-${item.id}-061926LC3`);
  });
});

// --- handleCoaRecordsApprove (partial approval) ----------------------------

describe('handleCoaRecordsApprove (via PUT /api/queue/:id)', () => {
  function makeContext(queueId: string, body: unknown): any {
    return {
      request: new Request(`http://localhost/api/queue/${queueId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
      env,
      data: { user: { id: seed.orgAdminId, role: 'org_admin', tenant_id: seed.tenantId } },
      params: { id: queueId },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/queue/[id]',
    };
  }

  it('partial approval (one held) keeps the queue item pending + only produces approved', async () => {
    const item = await makeCoaQueueItem(darigoldPayload());

    const res = await updateQueueItem(
      makeContext(item.id, {
        status: 'approved',
        records: darigoldPayload(),
        // Hold record 1 (sublot 04); approve 0 and 2.
        record_decisions: { '1': 'hold' },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { status: string };
      documents: Array<{ sub_lot_code: string }>;
      held_record_indexes: number[];
    };

    expect(body.item.status).toBe('pending');
    expect(body.held_record_indexes).toEqual([1]);
    expect(body.documents).toHaveLength(2);
    expect(body.documents.map(d => d.sub_lot_code).sort()).toEqual(['02', '05']);

    // The queue item is STILL pending in the DB.
    const q = await db
      .prepare('SELECT status FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ status: string }>();
    expect(q?.status).toBe('pending');

    // Only the two approved sublots have lots; the held one (04) does not.
    expect(await getLotsForKey('1042611005')).toHaveLength(1);
    expect(await getLotsForKey('1042611002')).toHaveLength(1);
    expect(await getLotsForKey('1042611004')).toHaveLength(0);

    // Pending R2 file is NOT deleted while records remain held.
    const blob = await files.get(item.file_r2_key);
    expect(blob).not.toBeNull();
  });

  it('all-approve flips the item to approved and produces every sublot', async () => {
    const item = await makeCoaQueueItem(darigoldPayload());
    const res = await updateQueueItem(
      makeContext(item.id, { status: 'approved', records: darigoldPayload() })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      item: { status: string };
      documents: unknown[];
      held_record_indexes: number[];
    };
    expect(body.item.status).toBe('approved');
    expect(body.held_record_indexes).toEqual([]);
    expect(body.documents).toHaveLength(3);

    const q = await db
      .prepare('SELECT status FROM processing_queue WHERE id = ?')
      .bind(item.id)
      .first<{ status: string }>();
    expect(q?.status).toBe('approved');
  });
});
