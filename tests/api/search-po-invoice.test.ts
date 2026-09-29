/**
 * PO and invoice as their own search fields (search redesign Phase 1, design
 * 4e; prod facts 2026-09-29).
 *
 * TWO PO NAMESPACES that share no value on prod: the PO printed on a supplier's
 * certificate is OUR purchase order to them ("K134273", "k134514", "K 135680"),
 * and the customer's PO lives on a WMS order ("PO-90001"). Either answers:
 *   - the document's own printed PO           -> covering (it says so on the paper)
 *   - a customer PO on an order -> lines ->
 *       a person-accepted lot match           -> covering
 *       a pending suggestion                  -> likely ("confirm")
 * Invoice: only the document's own printed invoice number. A WMS order with the
 * same number is named, never followed.
 *
 * I3: a PO nothing covers answers "No document on file covers PO X" and puts
 * NO nearest document in the covering band.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as queryHandler } from '../../functions/api/search/query';
import type { Clause, SearchQuery } from '../../shared/searchQuery';

const db = env.DB;
const T = 'spi-tenant';
const USER = { id: 'spi-user', role: 'org_admin', tenant_id: T };
const SUP_DG = 'spi-sup-dg';
const SUP_CMF = 'spi-sup-cmf';
const DT_COA = 'spi-dt-coa';
const DT_INV = 'spi-dt-invoice';

const DOC = {
  ownPo: 'spi-doc-own-po',
  otherPo: 'spi-doc-other-po',
  invoice: 'spi-doc-invoice',
  suggested: 'spi-doc-suggested',
  accepted: 'spi-doc-accepted',
  both: 'spi-doc-both',
  docNumber: 'spi-doc-docnum',
};

async function insertDoc(id: string, supplierId: string, typeId: string, metadata: Record<string, unknown>, text = '') {
  await db.prepare(
    `INSERT INTO documents (id, tenant_id, title, tags, current_version, status, created_by, supplier_id, document_type_id, primary_metadata, created_at, updated_at)
     VALUES (?, ?, ?, '[]', 1, 'active', ?, ?, ?, ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
  ).bind(id, T, `Doc ${id}`, USER.id, supplierId, typeId, JSON.stringify(metadata)).run();
  await db.prepare(
    `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, extracted_text, uploaded_by)
     VALUES (?, ?, 1, ?, 10, 'application/pdf', ?, 'x', ?, ?)`,
  ).bind(`${id}-v1`, id, `${id}.pdf`, `r2/${id}.pdf`, text, USER.id).run();
}

async function linkLot(docId: string, lotNumber: string, sub: string) {
  const lotId = `${docId}-lot`;
  await db.prepare(`INSERT INTO lots (id, tenant_id, supplier_id, lot_number, sub_lot_code, lot_key) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(lotId, T, SUP_DG, lotNumber, sub, `${lotNumber}${sub}`).run();
  await db.prepare(`INSERT INTO document_lots (id, document_id, lot_id) VALUES (?, ?, ?)`).bind(`${lotId}-dl`, docId, lotId).run();
}

async function insertOrder(id: string, orderNumber: string, po: string, lot: string, docId: string, status: 'pending' | 'accepted') {
  await db.prepare(`INSERT INTO orders (id, tenant_id, order_number, po_number, customer_name, status) VALUES (?, ?, ?, ?, 'Medosweet', 'pending')`)
    .bind(id, T, orderNumber, po).run();
  await db.prepare(`INSERT INTO order_items (id, order_id, product_code, product_name, lot_number) VALUES (?, ?, '810004', 'BUTTER', ?)`)
    .bind(`${id}-i1`, id, lot).run();
  await db.prepare(
    `INSERT INTO lot_match_suggestions (id, tenant_id, order_item_id, document_id, match_basis, match_confidence, status)
     VALUES (?, ?, ?, ?, 'lot_exact', 0.9, ?)`,
  ).bind(`${id}-s1`, T, `${id}-i1`, docId, status).run();
}

beforeAll(async () => {
  await db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, active) VALUES (?, 'PO Co', 'po-co', 1)`).bind(T).run();
  await db.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
     VALUES (?, 'spi@test.com', 'Spi', 'org_admin', ?, 'x', 1, 0)`,
  ).bind(USER.id, T).run();
  for (const [id, name] of [[SUP_DG, 'Darigold, Inc.'], [SUP_CMF, 'Country Morning Farms']]) {
    await db.prepare(`INSERT INTO suppliers (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, id).run();
  }
  for (const [id, name, slug] of [[DT_COA, 'COA', 'coa'], [DT_INV, 'Invoice', 'invoice']]) {
    await db.prepare(`INSERT INTO document_types (id, tenant_id, name, slug, active) VALUES (?, ?, ?, ?, 1)`).bind(id, T, name, slug).run();
  }
  // Our PO to Darigold, printed with a space the way prod has it.
  await insertDoc(DOC.ownPo, SUP_DG, DT_COA, { po_number: 'K 134273', lot_number: '10426203', sub_lot_code: '03' }, 'Darigold PO K 134273');
  await linkLot(DOC.ownPo, '10426203', '03');
  await insertDoc(DOC.otherPo, SUP_DG, DT_COA, { po_number: 'K999111', lot_number: '10426204', sub_lot_code: '13' }, 'Darigold PO K999111');
  await linkLot(DOC.otherPo, '10426204', '13');
  await insertDoc(DOC.invoice, SUP_CMF, DT_INV, { invoice_number: '261149' }, 'Country Morning invoice 261149');
  await insertDoc(DOC.suggested, SUP_DG, DT_COA, { lot_number: '10426205', sub_lot_code: '01' });
  await linkLot(DOC.suggested, '10426205', '01');
  await insertDoc(DOC.accepted, SUP_DG, DT_COA, { lot_number: '10426206', sub_lot_code: '02' });
  await linkLot(DOC.accepted, '10426206', '02');
  // A number that is our PO on one certificate AND a customer's PO on a WMS order.
  await insertDoc(DOC.both, SUP_DG, DT_COA, { po_number: '7700123', lot_number: '10426207', sub_lot_code: '01' });
  await linkLot(DOC.both, '10426207', '01');

  // The line shipped a lot the certificate does not print: only the pending suggestion links them.
  // Its own document number is also a WMS order number.
  await insertDoc(DOC.docNumber, SUP_CMF, DT_COA, { document_number: '1809923' });

  await insertOrder('spi-order-1', '1809921', 'PO-90001', '5555555501', DOC.suggested, 'pending');
  await insertOrder('spi-order-2', '1809922', 'PO-90002', '1042620602', DOC.accepted, 'accepted');
  await insertOrder('spi-order-3', '1809923', '7700123', '99999999', DOC.otherPo, 'pending');
}, 60_000);

function ctx(body: unknown): any {
  return {
    request: new Request('http://localhost/api/search/query', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    env, data: { user: USER }, params: {},
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null), functionPath: '/api/search/query',
  };
}

async function run(clauses: Clause[], text = '', interpret = false) {
  const query: SearchQuery = { v: 1, text, clauses, view: { entity: 'documents' } };
  const res = await queryHandler(ctx({ query, limit: 50, interpret }));
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

const clause = (field: Clause['field'], value: string): Clause => ({ id: 'c1', field, op: 'is', values: [value], source: 'builder' });
const withStatus = (body: any, status: string) => body.documents.filter((d: any) => d.match_status === status).map((d: any) => d.id).sort();

describe('PO', () => {
  it('covers through the PO printed on the document — case and spaces fold, the paper says so', async () => {
    for (const typed of ['K134273', 'k134273', 'K 134273', 'PO K134273']) {
      const body = await run([clause('po', typed)]);
      expect(body.coverage).toBe('covered');
      expect(withStatus(body, 'covering')).toEqual([DOC.ownPo]);
      const check = body.documents[0].match_checks[0];
      expect(check.message).toMatch(/PO number printed on this document is K 134273/);
    }
  });

  it("follows the CUSTOMER's PO through the WMS order: an accepted match covers, a pending suggestion is likely", async () => {
    const accepted = await run([clause('po', 'PO-90002')]);
    expect(accepted.coverage).toBe('covered');
    expect(withStatus(accepted, 'covering')).toEqual([DOC.accepted]);
    expect(accepted.documents[0].match_checks[0].message).toMatch(/Customer PO PO-90002 is on WMS order 1809922/);

    const pending = await run([clause('po', 'PO-90001')]);
    expect(pending.coverage).toBe('likely');
    expect(withStatus(pending, 'covering')).toEqual([]);
    expect(withStatus(pending, 'likely_covering')).toEqual([DOC.suggested]);
    expect(pending.coverage_summary).toMatch(/No document on file is confirmed to cover PO PO-90001/);
  });

  it("a customer PO matches with or without its PO prefix; the rest must be exact", async () => {
    for (const typed of ['90002', 'po#90002', 'PO 90002', 'Po90002']) {
      const body = await run([clause('po', typed)]);
      expect(withStatus(body, 'covering')).toEqual([DOC.accepted]);
    }
    const shorter = await run([clause('po', '9000')]);
    expect(withStatus(shorter, 'covering')).toEqual([]);
    expect(withStatus(shorter, 'likely_covering')).toEqual([]);
    // Typed without a keyword, the folded number is still read as a PO.
    const typed = await run([], '90002', true);
    expect(typed.interpreted.clauses).toMatchObject([{ field: 'po' }]);
    expect(withStatus(typed, 'covering')).toEqual([DOC.accepted]);
  });

  it('our PO to the supplier is never folded: a K-number without its K is not it', async () => {
    const body = await run([clause('po', '134273')]);
    expect(withStatus(body, 'covering')).toEqual([]);
    expect(body.coverage).toBe('none');
  });

  it('I3: a PO nothing covers says so, and no nearest document stands in the covering band', async () => {
    const body = await run([clause('po', 'K555000')]);
    expect(body.coverage).toBe('none');
    expect(body.coverage_summary).toBe('No document on file covers PO K555000.');
    expect(withStatus(body, 'covering')).toEqual([]);
    expect(withStatus(body, 'likely_covering')).toEqual([]);
    // A certificate with a different PO is not "nearby": a PO has no near miss.
    expect(body.documents.map((d: any) => d.id)).not.toContain(DOC.otherPo);
  });

  it('a number that is both kinds of PO answers from both, and each check says which', async () => {
    const body = await run([clause('po', '7700123')]);
    expect(withStatus(body, 'covering')).toEqual([DOC.both]);
    // The WMS order carrying it as the customer's PO suggests another certificate: likely, labelled.
    expect(withStatus(body, 'likely_covering')).toEqual([DOC.otherPo]);
    expect(body.constraints[0].note).toMatch(/customer's PO on WMS order 1809923/);
  });
});

describe('invoice', () => {
  it("covers only through the document's own printed invoice number", async () => {
    const body = await run([clause('invoice', '261149')]);
    expect(body.coverage).toBe('covered');
    expect(withStatus(body, 'covering')).toEqual([DOC.invoice]);
  });

  it('never routes an invoice through a WMS order with the same number — it names the order instead', async () => {
    const body = await run([clause('invoice', '1809921')]);
    expect(body.coverage).toBe('none');
    expect(body.coverage_summary).toBe('No document on file covers invoice 1809921.');
    expect(withStatus(body, 'covering')).toEqual([]);
    expect(withStatus(body, 'likely_covering')).toEqual([]);
    expect(body.constraints[0].note).toMatch(/WMS order 1809921 has this number.*not followed/);
  });
});

describe('reading a PO, an invoice or an order out of typed text', () => {
  it('a number on file only as our PO becomes a PO clause, and says what it was read as', async () => {
    const body = await run([], 'K134273', true);
    expect(body.interpreted.clauses).toMatchObject([{ field: 'po', source: 'detected' }]);
    expect(body.interpreted.clauses[0].note).toMatch(/PO printed on a document/);
    expect(withStatus(body, 'covering')).toEqual([DOC.ownPo]);
  });

  it('a keyword decides: "invoice 261149" is an invoice, "PO-90002" a customer PO', async () => {
    const inv = await run([], 'invoice 261149', true);
    expect(inv.interpreted.clauses).toMatchObject([{ field: 'invoice' }]);
    expect(withStatus(inv, 'covering')).toEqual([DOC.invoice]);
    const po = await run([], 'PO-90002', true);
    expect(po.interpreted.clauses).toMatchObject([{ field: 'po' }]);
    expect(withStatus(po, 'covering')).toEqual([DOC.accepted]);
  });

  it('both kinds of PO are still a PO; a WMS order number alone is an order', async () => {
    const po = await run([], '7700123', true);
    expect(po.interpreted.clauses).toMatchObject([{ field: 'po' }]);
    const order = await run([], '1809921', true);
    expect(order.interpreted.clauses).toMatchObject([{ field: 'order' }]);
    expect(withStatus(order, 'likely_covering')).toEqual([DOC.suggested]);
  });

  it('a number on file as more than one KIND is an identifier clause — any kind answers, nothing is picked', async () => {
    const body = await run([], '1809923', true);
    expect(body.interpreted.clauses).toMatchObject([{ field: 'identifier' }]);
    expect(body.interpreted.clauses[0].note).toMatch(/document number.*WMS order number.*nothing is picked/);
    expect(withStatus(body, 'covering')).toEqual([DOC.docNumber]);
    expect(body.documents.find((d: any) => d.id === DOC.docNumber).match_checks[0].message).toMatch(/document number printed on this document is 1809923/);
    // The order's pending suggestion answers too, as likely.
    expect(withStatus(body, 'likely_covering')).toEqual([DOC.otherPo]);
  });

  it('an unknown 7-digit number stays text: no clause, no coverage claim', async () => {
    const body = await run([], '4500123', true);
    expect(body.interpreted?.clauses ?? []).toEqual([]);
    expect(body.coverage).toBe('unconstrained');
  });
});
