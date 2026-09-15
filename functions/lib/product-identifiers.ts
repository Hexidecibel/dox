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
import { generateId } from './db';

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
