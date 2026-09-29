/**
 * What a requirement is owed PER — the vocabulary of `requirements.scope`
 * (migration 0123), owned here and nowhere else.
 *
 * The column has no SQL CHECK on purpose: `requirements` is the target of
 * several CASCADE foreign keys, so widening a CHECK later would force a table
 * rebuild. The same pattern as `CLAIM_SUBJECT_TYPES` in functions/lib/registry.ts
 * — code validates writes, and a value this file does not know reads as
 * `supplier` (today's behaviour), never as something stricter or looser.
 *
 *   supplier  closed once per supplier by any confirmed document (the rule
 *             before 0123, and still the default).
 *   product   owed for every ACTIVE product of the supplier; a (requirement,
 *             product) pair is closed only by a confirmed document linked to
 *             that product. A document linked to no product closes nothing.
 *   lot       owed per lot. STORED, NOT YET EVALUATED: per-lot checking is a
 *             later phase, so the gap engine judges a lot-scope requirement
 *             once per supplier and says so in a caveat.
 *
 * A future `facility` scope is one more value here plus one subject kind in
 * the engine — no migration.
 */

export const REQUIREMENT_SCOPES = ['supplier', 'product', 'lot'] as const;
export type RequirementScope = (typeof REQUIREMENT_SCOPES)[number];

export const DEFAULT_REQUIREMENT_SCOPE: RequirementScope = 'supplier';

/** Scopes the gap engine evaluates at their own grain today. */
export const EVALUATED_REQUIREMENT_SCOPES: readonly RequirementScope[] = ['supplier', 'product'];

export const REQUIREMENT_SCOPE_LABELS: Record<RequirementScope, string> = {
  supplier: 'Once per supplier',
  product: 'Per product',
  lot: 'Per lot',
};

/** Short form for chips and summaries: "per product". */
export const REQUIREMENT_SCOPE_SHORT: Record<RequirementScope, string> = {
  supplier: 'per supplier',
  product: 'per product',
  lot: 'per lot',
};

export function isRequirementScope(v: unknown): v is RequirementScope {
  return typeof v === 'string' && (REQUIREMENT_SCOPES as readonly string[]).includes(v);
}

/** Read a stored value. NULL / unknown -> 'supplier' (the pre-0123 rule). */
export function normalizeRequirementScope(v: unknown): RequirementScope {
  return isRequirementScope(v) ? v : DEFAULT_REQUIREMENT_SCOPE;
}

/** `product_requirements.mode` (0123). CHECKed in SQL too — a closed pair. */
export const PRODUCT_REQUIREMENT_MODES = ['add', 'exempt'] as const;
export type ProductRequirementMode = (typeof PRODUCT_REQUIREMENT_MODES)[number];

export function isProductRequirementMode(v: unknown): v is ProductRequirementMode {
  return typeof v === 'string' && (PRODUCT_REQUIREMENT_MODES as readonly string[]).includes(v);
}

/**
 * `product_suppliers.source` (0123). Who recorded that a supplier ships a
 * product. NULL = linked before 0123. No SQL CHECK (producers grow).
 */
export const PRODUCT_SUPPLIER_SOURCES = ['certificate', 'admin', 'import', 'connector'] as const;
export type ProductSupplierSource = (typeof PRODUCT_SUPPLIER_SOURCES)[number];

export function isProductSupplierSource(v: unknown): v is ProductSupplierSource {
  return typeof v === 'string' && (PRODUCT_SUPPLIER_SOURCES as readonly string[]).includes(v);
}
