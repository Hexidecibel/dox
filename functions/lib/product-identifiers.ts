/**
 * The product identifier graph (migration 0107): load it for search, and the
 * one write path the API and the seed script share.
 *
 * `value_norm` is computed HERE and nowhere else: codes compare as upper-case
 * alphanumerics (leading zeros kept — 0801 is not 801, and whether 08012 is
 * 0801 is a question for a person, not a normalizer), names as collapsed
 * lower-case words.
 */

import type { ProductIdentifier, ProductIdentifierKind, ProductIdentifierSource } from '../../shared/types';
import { prepareCatalog, type CatalogProduct, type PreparedCatalog } from '../../shared/productIdentity';
import { normalizeCode, normalizeName } from '../../shared/productVocabulary';
import { generateId, logAudit } from './db';

export const IDENTIFIER_KINDS: readonly ProductIdentifierKind[] = ['our_sku', 'supplier_item', 'supplier_name', 'alias', 'gtin', 'pack'];
export const SUPPLIER_KINDS: ReadonlySet<ProductIdentifierKind> = new Set(['supplier_item', 'supplier_name']);
const CODE_KINDS: ReadonlySet<ProductIdentifierKind> = new Set(['our_sku', 'supplier_item', 'gtin']);

export function normalizeIdentifierValue(kind: ProductIdentifierKind, value: string): string {
  return CODE_KINDS.has(kind) ? normalizeCode(value) : normalizeName(value);
}

/** Cap on identifiers read per search; a tenant past it is a design review, not a slow page. */
export const CATALOG_CAP = 5000;

/**
 * Every identifier a tenant holds, grouped by product. Returns null when the
 * tenant has none, so a tenant that never configured identifiers pays for one
 * empty indexed read and nothing else.
 */
export async function loadProductCatalog(db: D1Database, tenantId: string): Promise<PreparedCatalog | null> {
  const res = await db
    .prepare(
      `SELECT pi.id, pi.product_id, pi.kind, pi.value, pi.supplier_id, pi.superseded, pi.confirmed, pi.note,
              p.name AS product_name, s.name AS supplier_name
         FROM product_identifiers pi
         JOIN products p ON p.id = pi.product_id
         LEFT JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.tenant_id = ? AND p.active = 1
        LIMIT ?`,
    )
    .bind(tenantId, CATALOG_CAP)
    .all<{
      id: string; product_id: string; kind: ProductIdentifierKind; value: string; supplier_id: string | null;
      superseded: number; confirmed: number; note: string | null; product_name: string; supplier_name: string | null;
    }>();
  const rows = res.results ?? [];
  if (rows.length === 0) return null;
  const byProduct = new Map<string, CatalogProduct>();
  for (const r of rows) {
    const p = byProduct.get(r.product_id) ?? { product_id: r.product_id, product_name: r.product_name, identifiers: [] };
    p.identifiers.push({
      id: r.id, kind: r.kind, value: r.value, supplier_id: r.supplier_id, supplier_name: r.supplier_name,
      superseded: r.superseded === 1, confirmed: r.confirmed === 1, note: r.note,
    });
    byProduct.set(r.product_id, p);
  }
  return prepareCatalog([...byProduct.values()]);
}

export async function listProductIdentifiers(db: D1Database, productId: string): Promise<ProductIdentifier[]> {
  const res = await db
    .prepare(
      `SELECT pi.*, s.name AS supplier_name
         FROM product_identifiers pi LEFT JOIN suppliers s ON s.id = pi.supplier_id
        WHERE pi.product_id = ?
        ORDER BY CASE pi.kind WHEN 'our_sku' THEN 0 WHEN 'supplier_item' THEN 1 WHEN 'supplier_name' THEN 2
                              WHEN 'pack' THEN 3 WHEN 'alias' THEN 4 ELSE 5 END, pi.superseded, pi.value`,
    )
    .bind(productId)
    .all<ProductIdentifier>();
  return res.results ?? [];
}

export interface IdentifierInput {
  kind: ProductIdentifierKind;
  value: string;
  supplier_id?: string | null;
  superseded?: boolean;
  confirmed?: boolean;
  source: ProductIdentifierSource;
  note?: string | null;
}

export class IdentifierValidationError extends Error {}

/** Validate an identifier against the kind/supplier pairing the table CHECKs. */
export function validateIdentifierInput(input: Partial<IdentifierInput>): IdentifierInput {
  const kind = input.kind as ProductIdentifierKind;
  if (!IDENTIFIER_KINDS.includes(kind)) throw new IdentifierValidationError(`kind must be one of ${IDENTIFIER_KINDS.join(', ')}`);
  const value = String(input.value ?? '').trim();
  if (!value) throw new IdentifierValidationError('value is required');
  if (value.length > 200) throw new IdentifierValidationError('value is too long');
  if (!normalizeIdentifierValue(kind, value)) throw new IdentifierValidationError('value has no letters or digits');
  const supplierId = input.supplier_id ? String(input.supplier_id) : null;
  if (SUPPLIER_KINDS.has(kind) && !supplierId) throw new IdentifierValidationError(`a ${kind.replace('_', ' ')} needs the supplier it belongs to`);
  if (!SUPPLIER_KINDS.has(kind) && supplierId) throw new IdentifierValidationError(`a ${kind.replace('_', ' ')} is not tied to a supplier`);
  if (input.superseded && kind !== 'supplier_item' && kind !== 'our_sku') {
    throw new IdentifierValidationError('only an item number or our SKU can be marked former');
  }
  return {
    kind, value, supplier_id: supplierId, superseded: !!input.superseded, confirmed: !!input.confirmed,
    source: input.source ?? 'reviewer', note: input.note ? String(input.note).trim().slice(0, 1000) || null : null,
  };
}

/**
 * Insert one identifier, or return the existing row with the same identity
 * (product, kind, supplier, normalized value) untouched. Never overwrites: a
 * seed re-run cannot un-confirm what a person confirmed.
 */
export async function insertProductIdentifier(
  db: D1Database,
  tenantId: string,
  productId: string,
  input: IdentifierInput,
  actorId: string | null,
): Promise<{ row: ProductIdentifier; created: boolean }> {
  const norm = normalizeIdentifierValue(input.kind, input.value);
  const existing = await db
    .prepare(
      `SELECT * FROM product_identifiers
        WHERE product_id = ? AND kind = ? AND value_norm = ?
          AND ((? IS NULL AND supplier_id IS NULL) OR supplier_id = ?)`,
    )
    .bind(productId, input.kind, norm, input.supplier_id ?? null, input.supplier_id ?? null)
    .first<ProductIdentifier>();
  if (existing) return { row: existing, created: false };
  const id = generateId();
  await db
    .prepare(
      `INSERT INTO product_identifiers
         (id, tenant_id, product_id, kind, value, value_norm, supplier_id, superseded, confirmed, source, note,
          created_by, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') END)`,
    )
    .bind(
      id, tenantId, productId, input.kind, input.value, norm, input.supplier_id ?? null,
      input.superseded ? 1 : 0, input.confirmed ? 1 : 0, input.source, input.note ?? null,
      actorId, input.confirmed ? actorId : null, input.confirmed ? 1 : 0,
    )
    .run();
  const row = await db.prepare('SELECT * FROM product_identifiers WHERE id = ?').bind(id).first<ProductIdentifier>();
  return { row: row!, created: true };
}

// ---------------------------------------------------------------------------
// Review-time teach (replaces the supplier_product_map write, migration 0113)
// ---------------------------------------------------------------------------

export interface TeachSupplierProductInput {
  tenantId: string;
  supplierId: string;
  /** OUR product the reviewer picked. */
  productId: string;
  /** The certificate's product name, as printed. */
  coaProductName: string;
  /** The supplier's item number printed on the record, when there is one. */
  supplierItem?: string | null;
  /** The order-line product code shown with the picked product (our SKU), when there is one. */
  ourSku?: string | null;
  actorId: string | null;
  /** Where the teach happened, for the evidence note and the audit row. */
  queueItemId: string;
  clientIp: string | null;
}

export interface TeachSupplierProductResult {
  identifiers: ProductIdentifier[];
  created: number;
  confirmed: number;
  skipped: Array<{ kind: ProductIdentifierKind; value: string; reason: string }>;
}

/**
 * A reviewer mapping a certificate's product to one of ours at approval. Writes
 * a CONFIRMED `supplier_name` identifier, plus a `supplier_item` when the record
 * prints an item number and an `our_sku` when the picked product carries an
 * order-line code — the same UX the old supplier_product_map write had, into the
 * one store search and matching both read.
 *
 * A person stands behind this, so an existing UNCONFIRMED identifier with the
 * same identity is confirmed (audited), never duplicated. An item number that
 * is already a CONFIRMED identifier of a DIFFERENT product for this supplier is
 * not written onto a second product: that would turn a certain number into an
 * ambiguous one behind the reviewer's back. It is reported in `skipped` and in
 * a `product_identifier.teach_skipped` audit row instead. Every row written is
 * audited `product_identifier.added`.
 */
export async function teachSupplierProduct(
  db: D1Database,
  input: TeachSupplierProductInput,
): Promise<TeachSupplierProductResult> {
  const product = await db
    .prepare('SELECT id, name FROM products WHERE id = ? AND tenant_id = ?')
    .bind(input.productId, input.tenantId)
    .first<{ id: string; name: string }>();
  const supplier = await db
    .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(input.supplierId, input.tenantId)
    .first<{ id: string }>();
  const result: TeachSupplierProductResult = { identifiers: [], created: 0, confirmed: 0, skipped: [] };
  if (!product || !supplier) {
    result.skipped.push({ kind: 'supplier_name', value: input.coaProductName, reason: 'product or supplier is not in this workspace' });
    return result;
  }

  const note = `Taught at review (queue item ${input.queueItemId}): the reviewer mapped this certificate product to ${product.name}.`;
  const wanted: Array<{ kind: ProductIdentifierKind; value: string | null | undefined; supplier: boolean }> = [
    { kind: 'supplier_name', value: input.coaProductName, supplier: true },
    { kind: 'supplier_item', value: input.supplierItem, supplier: true },
    { kind: 'our_sku', value: input.ourSku, supplier: false },
  ];

  for (const w of wanted) {
    const raw = (w.value ?? '').trim();
    if (!raw) continue;
    let valid: IdentifierInput;
    try {
      valid = validateIdentifierInput({
        kind: w.kind, value: raw, supplier_id: w.supplier ? input.supplierId : null, confirmed: true, source: 'reviewer', note,
      });
    } catch (e) {
      result.skipped.push({ kind: w.kind, value: raw, reason: e instanceof Error ? e.message : 'invalid' });
      continue;
    }

    if (w.kind === 'supplier_item') {
      const elsewhere = await db
        .prepare(
          `SELECT p.name FROM product_identifiers pi JOIN products p ON p.id = pi.product_id
            WHERE pi.tenant_id = ? AND pi.kind = 'supplier_item' AND pi.supplier_id = ? AND pi.value_norm = ?
              AND pi.confirmed = 1 AND pi.product_id <> ?
            LIMIT 1`,
        )
        .bind(input.tenantId, input.supplierId, normalizeIdentifierValue('supplier_item', raw), input.productId)
        .first<{ name: string }>();
      if (elsewhere) {
        result.skipped.push({ kind: w.kind, value: raw, reason: `already the confirmed item number of ${elsewhere.name}` });
        continue;
      }
    }

    const { row, created } = await insertProductIdentifier(db, input.tenantId, input.productId, valid, input.actorId);
    if (created) {
      result.created++;
      result.identifiers.push(row);
      await logAudit(
        db, input.actorId, input.tenantId, 'product_identifier.added', 'product', input.productId,
        JSON.stringify({ identifier: row, product_name: product.name, via: 'review_teach', queue_item_id: input.queueItemId }),
        input.clientIp,
      );
    } else if (row.confirmed !== 1) {
      await db
        .prepare(
          `UPDATE product_identifiers SET confirmed = 1, confirmed_by = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`,
        )
        .bind(input.actorId, row.id)
        .run();
      result.confirmed++;
      result.identifiers.push({ ...row, confirmed: 1 });
      await logAudit(
        db, input.actorId, input.tenantId, 'product_identifier.confirmed', 'product', input.productId,
        JSON.stringify({ identifier_id: row.id, kind: row.kind, value: row.value, via: 'review_teach', queue_item_id: input.queueItemId }),
        input.clientIp,
      );
    } else {
      result.identifiers.push(row);
    }
  }

  if (result.skipped.length > 0) {
    await logAudit(
      db, input.actorId, input.tenantId, 'product_identifier.teach_skipped', 'product', input.productId,
      JSON.stringify({ skipped: result.skipped, supplier_id: input.supplierId, queue_item_id: input.queueItemId }),
      input.clientIp,
    );
  }
  return result;
}
