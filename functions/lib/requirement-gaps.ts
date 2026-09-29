/**
 * D1 loader for the requirement gap engine.
 *
 * Same split as `functions/lib/spec-warnings.ts` around `shared/specCheck.ts`:
 * every decision about what counts as a gap lives in `shared/requirementGap.ts`
 * where it is testable without a database, and this file does nothing but
 * fetch rows and bucket them by supplier.
 *
 * A FIXED SET OF QUERIES, NOT A SET PER SUPPLIER. The supplier list view renders every
 * supplier in a tenant, so a per-supplier round trip would turn one screen into
 * hundreds of D1 calls. Each query is tenant-scoped and, when one supplier is
 * asked for, additionally pinned to it; results are grouped in memory.
 *
 * TENANT SCOPING IS IN EVERY QUERY, not in a wrapper. `supplier_requirements`
 * carries a denormalized tenant_id (migration 0087) and `documents` carries its
 * own; both are filtered explicitly, so no join path can walk out of the
 * tenant even if a caller passes a supplier id it does not own — that supplier
 * simply matches nothing.
 */

import {
  computeSupplierGap,
  EMPTY_CLASSIFICATION_COUNTS,
  type ApplicabilityRow,
  type ClaimOpenedRow,
  type ClassificationCounts,
  type ClosureRow,
  type ExcludedProduct,
  type GapOptions,
  type ProductLinkRow,
  type ProductOverrideRow,
  type ProductSubject,
  type SupplierGap,
  type SupplierGapInput,
} from '../../shared/requirementGap';
import { normalizeRequirementScope, type RequirementScope } from '../../shared/requirementScope';
import type { SupplierRequirementTier } from '../../shared/types';

/** The supplier rows a gap report is being built for. */
export interface GapSupplier {
  id: string;
  name: string;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function nullableStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Push a row into the array for its supplier, creating the bucket on demand.
 * Rows whose supplier is not in scope are dropped rather than kept in a
 * stray bucket — a bucket that no supplier row backs would never be rendered
 * and would only make the maps disagree about how many suppliers exist.
 */
function bucket<T>(map: Map<string, T[]>, supplierId: string, row: T): void {
  const hit = map.get(supplierId);
  if (hit) hit.push(row);
}

function emptyBuckets<T>(supplierIds: string[]): Map<string, T[]> {
  return new Map(supplierIds.map((id) => [id, [] as T[]]));
}

/**
 * List the suppliers a gap report covers.
 *
 * Inactive suppliers are included: a supplier deactivated with open
 * requirements is exactly the case an auditor asks about, and silently
 * dropping them would be another way for the report to read clean.
 */
export async function listGapSuppliers(
  db: D1Database,
  tenantId: string,
  opts: { supplierId?: string | null; limit?: number; offset?: number } = {},
): Promise<{ suppliers: GapSupplier[]; total: number }> {
  const params: (string | number)[] = [tenantId];
  let where = 'tenant_id = ?';
  if (opts.supplierId) {
    where += ' AND id = ?';
    params.push(opts.supplierId);
  }

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM suppliers WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>();

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await db
    .prepare(
      `SELECT id, name FROM suppliers WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all<{ id: string; name: string }>();

  return {
    suppliers: (rows.results ?? []).map((r) => ({ id: str(r.id), name: str(r.name) })),
    total: totalRow?.total ?? 0,
  };
}

/**
 * One confirmed `document_requirements` closure, with what the gap engine and
 * the request composer both need to judge it. THE ONE CLOSURE READ: the
 * composer's line closure (`functions/lib/document-requests.ts#loadClosures`)
 * and the gap report call this, so the two cannot disagree about what closed
 * what.
 */
export interface ClosureQueryRow extends ClosureRow {
  supplier_id: string;
  expires_on: string | null;
  arrived_at: string | null;
  created_at: string | null;
  /** `requirements.scope` of the closed requirement (0123). */
  scope: RequirementScope;
  /** The document is linked to at least one product (`document_products`). */
  has_product_link: boolean;
}

/**
 * Confirmed closures from ACTIVE, supplier-attributed documents. ONLY
 * `status = 'confirmed'`: a 'suggested' link is an unreviewed machine proposal
 * and a 'rejected' one is a human saying no; either counting as a closure would
 * let the pipeline close its own gaps.
 */
export async function loadConfirmedClosures(
  db: D1Database,
  tenantId: string,
  opts: { supplierId?: string | null; requirementIds?: string[] } = {},
): Promise<ClosureQueryRow[]> {
  const params: string[] = [tenantId];
  let extra = '';
  if (opts.supplierId) {
    extra += ' AND d.supplier_id = ?';
    params.push(opts.supplierId);
  }
  if (opts.requirementIds) {
    if (opts.requirementIds.length === 0) return [];
    extra += ` AND dr.requirement_id IN (${opts.requirementIds.map(() => '?').join(', ')})`;
    params.push(...opts.requirementIds);
  }
  const rows = await db
    .prepare(
      `SELECT d.supplier_id, dr.requirement_id, dr.confirmed_at,
              d.id AS document_id, d.title AS document_title,
              -- G4: a certificate already expired when it arrived closes
              -- nothing. The printed expiry, never expiration_date (a shelf life).
              CASE WHEN json_valid(d.primary_metadata)
                   THEN json_extract(d.primary_metadata, '$.document_expires_on') END AS expires_on,
              d.arrived_at AS arrived_at,
              d.created_at AS created_at,
              r.scope AS scope,
              EXISTS (SELECT 1 FROM document_products dp WHERE dp.document_id = d.id) AS has_product_link
         FROM document_requirements dr
         JOIN documents d ON d.id = dr.document_id
         LEFT JOIN requirements r ON r.id = dr.requirement_id
        WHERE d.tenant_id = ?
          AND d.status = 'active'
          AND d.supplier_id IS NOT NULL
          AND dr.status = 'confirmed'${extra}
        ORDER BY dr.confirmed_at DESC`,
    )
    .bind(...params)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((r) => ({
    supplier_id: str(r.supplier_id),
    requirement_id: str(r.requirement_id),
    document_id: str(r.document_id),
    document_title: str(r.document_title),
    confirmed_at: nullableStr(r.confirmed_at),
    expires_on: nullableStr(r.expires_on),
    arrived_at: nullableStr(r.arrived_at),
    created_at: nullableStr(r.created_at),
    scope: normalizeRequirementScope(r.scope),
    has_product_link: num(r.has_product_link) > 0,
  }));
}

/**
 * Load every input the engine needs, for the given suppliers.
 *
 * `supplierId` narrows the SQL as well as the output; without it the queries
 * run tenant-wide and are bucketed, which is what the list view wants.
 * Returned separately from the computation so a caller can judge the same
 * inputs twice (the scope-change preview).
 */
export async function loadGapInputs(
  db: D1Database,
  tenantId: string,
  suppliers: GapSupplier[],
  options: { supplierId?: string | null } = {},
): Promise<SupplierGapInput[]> {
  if (suppliers.length === 0) return [];

  const ids = suppliers.map((s) => s.id);
  const pin = options.supplierId ? ' AND %COL% = ?' : '';
  const pinParam: string[] = options.supplierId ? [options.supplierId] : [];

  // 1. Applicability — the configured left-hand side. Only ACTIVE requirements
  //    apply: a line item a tenant retired must stop generating gaps, and
  //    `requirements` soft-deletes precisely so its ids keep resolving for the
  //    history in document_requirements.
  const applicabilityRows = await db
    .prepare(
      `SELECT sr.supplier_id, sr.requirement_id, sr.tier,
              r.name, r.slug, r.checklist, r.sort_order, r.scope
         FROM supplier_requirements sr
         JOIN requirements r ON r.id = sr.requirement_id
        WHERE sr.tenant_id = ? AND r.active = 1${pin.replace('%COL%', 'sr.supplier_id')}`,
    )
    .bind(tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  // 2. Requirements OPENED by confirmed claims on this supplier's active
  //    documents. This is `requirementsOpenedByClaims` in registry.ts widened
  //    to keep the provenance (which claim, on which document) so the report
  //    can say why something is owed; the advisory `is_required = 0` mappings
  //    are kept here and demoted to the recommended tier by the engine rather
  //    than dropped in SQL, so an opt-in caller can still see them. The claim's
  //    SUBJECT rides along (design §5): a product-scope requirement opened by a
  //    claim about one product is owed by that product only.
  const claimRows = await db
    .prepare(
      `SELECT d.supplier_id, ctr.requirement_id, ctr.is_required,
              r.name, r.slug, r.checklist, r.sort_order, r.scope,
              ct.id AS claim_type_id, ct.name AS claim_type_name, ct.subject_grain,
              dc.subject_type, dc.subject_id,
              d.id AS document_id, d.title AS document_title
         FROM document_claims dc
         JOIN documents d ON d.id = dc.document_id
         JOIN claim_types ct ON ct.id = dc.claim_type_id
         JOIN claim_type_requirements ctr ON ctr.claim_type_id = dc.claim_type_id
         JOIN requirements r ON r.id = ctr.requirement_id
        WHERE d.tenant_id = ?
          AND ctr.tenant_id = ?
          AND d.status = 'active'
          AND d.supplier_id IS NOT NULL
          AND dc.status = 'confirmed'
          AND r.active = 1${pin.replace('%COL%', 'd.supplier_id')}`,
    )
    .bind(tenantId, tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  // 3. Closures — the right-hand side (the shared closure read).
  const closureRows = await loadConfirmedClosures(db, tenantId, {
    supplierId: options.supplierId ?? null,
  });

  // 4. Classification counts (migration 0081) over the same active documents.
  //    Carried on every result so "0 open" and "nothing was ever classified"
  //    cannot render identically.
  const classificationRows = await db
    .prepare(
      `SELECT supplier_id, classification_status, COUNT(*) AS n
         FROM documents
        WHERE tenant_id = ?
          AND status = 'active'
          AND supplier_id IS NOT NULL${pin.replace('%COL%', 'supplier_id')}
        GROUP BY supplier_id, classification_status`,
    )
    .bind(tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  // 5. Supplier -> product links (0123), BOTH paths: the product_suppliers
  //    graph and the legacy products.supplier_id column, the same OR that
  //    GET /api/products?supplier_id= makes. A legacy-only link has no
  //    product_suppliers row, so it carries no source / discontinued /
  //    nothing-owed facts. `identified` = a CONFIRMED product_identifiers row.
  const productRows = await db
    .prepare(
      `SELECT ps.supplier_id, p.id AS product_id, p.name, p.active,
              ps.source, ps.discontinued_at,
              ps.nothing_owed_reason, ps.nothing_owed_at, ps.nothing_owed_by,
              EXISTS (SELECT 1 FROM product_identifiers pi
                       WHERE pi.product_id = p.id AND pi.confirmed = 1) AS identified
         FROM product_suppliers ps
         JOIN products p ON p.id = ps.product_id
        WHERE ps.tenant_id = ? AND p.tenant_id = ?${pin.replace('%COL%', 'ps.supplier_id')}
       UNION ALL
       SELECT p.supplier_id, p.id AS product_id, p.name, p.active,
              NULL, NULL, NULL, NULL, NULL,
              EXISTS (SELECT 1 FROM product_identifiers pi
                       WHERE pi.product_id = p.id AND pi.confirmed = 1) AS identified
         FROM products p
        WHERE p.tenant_id = ?
          AND p.supplier_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_suppliers ps2
                           WHERE ps2.product_id = p.id AND ps2.supplier_id = p.supplier_id)${pin.replace('%COL%', 'p.supplier_id')}`,
    )
    .bind(tenantId, tenantId, ...pinParam, tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  // 6. Per-product overrides (0123), with the requirement vocabulary. Only
  //    ACTIVE requirements, for the same reason as query 1.
  const overrideRows = await db
    .prepare(
      `SELECT pr.supplier_id, pr.product_id, pr.requirement_id, pr.mode, pr.tier, pr.reason,
              r.name, r.slug, r.checklist, r.sort_order, r.scope
         FROM product_requirements pr
         JOIN requirements r ON r.id = pr.requirement_id
        WHERE pr.tenant_id = ? AND r.active = 1${pin.replace('%COL%', 'pr.supplier_id')}`,
    )
    .bind(tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  // 7. document_products for the active documents that CLOSE a product-scope
  //    requirement — the only documents whose product links the engine reads.
  const linkRows = await db
    .prepare(
      `SELECT d.supplier_id, dp.document_id, dp.product_id
         FROM document_products dp
         JOIN documents d ON d.id = dp.document_id
        WHERE d.tenant_id = ?
          AND d.status = 'active'
          AND d.supplier_id IS NOT NULL${pin.replace('%COL%', 'd.supplier_id')}
          AND EXISTS (SELECT 1 FROM document_requirements dr
                        JOIN requirements r ON r.id = dr.requirement_id
                       WHERE dr.document_id = d.id
                         AND dr.status = 'confirmed'
                         AND r.scope = 'product')`,
    )
    .bind(tenantId, ...pinParam)
    .all<Record<string, unknown>>();

  const applicability = emptyBuckets<ApplicabilityRow>(ids);
  for (const r of applicabilityRows.results ?? []) {
    bucket(applicability, str(r.supplier_id), {
      requirement_id: str(r.requirement_id),
      name: str(r.name),
      slug: str(r.slug),
      checklist: nullableStr(r.checklist),
      sort_order: num(r.sort_order),
      scope: normalizeRequirementScope(r.scope),
      tier: tierOf(r.tier),
    });
  }

  const claimOpened = emptyBuckets<ClaimOpenedRow>(ids);
  for (const r of claimRows.results ?? []) {
    bucket(claimOpened, str(r.supplier_id), {
      requirement_id: str(r.requirement_id),
      name: str(r.name),
      slug: str(r.slug),
      checklist: nullableStr(r.checklist),
      sort_order: num(r.sort_order),
      scope: normalizeRequirementScope(r.scope),
      is_required: num(r.is_required),
      claim_type_id: str(r.claim_type_id),
      claim_type_name: str(r.claim_type_name),
      document_id: str(r.document_id),
      document_title: str(r.document_title),
      subject_type: nullableStr(r.subject_type),
      subject_id: nullableStr(r.subject_id),
      subject_grain: nullableStr(r.subject_grain),
    });
  }

  const closures = emptyBuckets<ClosureRow>(ids);
  for (const r of closureRows) {
    bucket(closures, r.supplier_id, {
      requirement_id: r.requirement_id,
      document_id: r.document_id,
      document_title: r.document_title,
      confirmed_at: r.confirmed_at,
      expires_on: r.expires_on,
      arrived_at: r.arrived_at,
      created_at: r.created_at,
    });
  }

  const classification = new Map<string, ClassificationCounts>(
    ids.map((id) => [id, { ...EMPTY_CLASSIFICATION_COUNTS }]),
  );
  const documentTotals = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const r of classificationRows.results ?? []) {
    const supplierId = str(r.supplier_id);
    const counts = classification.get(supplierId);
    if (!counts) continue;
    const key = str(r.classification_status) as keyof ClassificationCounts;
    const n = num(r.n);
    if (key in counts) counts[key] += n;
    documentTotals.set(supplierId, (documentTotals.get(supplierId) ?? 0) + n);
  }

  // A product is ACTIVE for S when it is linked (either path), products.active
  // = 1 and the link is not marked no-longer-supplied. Anything else linked is
  // EXCLUDED and named in a caveat — never dropped silently.
  const products = emptyBuckets<ProductSubject>(ids);
  const excluded = emptyBuckets<ExcludedProduct>(ids);
  const seenProduct = new Set<string>();
  for (const r of productRows.results ?? []) {
    const supplierId = str(r.supplier_id);
    const productId = str(r.product_id);
    const key = `${supplierId}::${productId}`;
    if (seenProduct.has(key)) continue;
    seenProduct.add(key);
    const name = str(r.name);
    if (num(r.active) !== 1) {
      bucket(excluded, supplierId, { product_id: productId, name, reason: 'inactive' });
      continue;
    }
    if (r.discontinued_at != null) {
      bucket(excluded, supplierId, { product_id: productId, name, reason: 'discontinued' });
      continue;
    }
    const reason = nullableStr(r.nothing_owed_reason);
    bucket(products, supplierId, {
      product_id: productId,
      name,
      source: nullableStr(r.source),
      identified: num(r.identified) > 0,
      nothing_owed: reason
        ? { reason, at: nullableStr(r.nothing_owed_at), by: nullableStr(r.nothing_owed_by) }
        : null,
    });
  }

  const productOverrides = emptyBuckets<ProductOverrideRow>(ids);
  for (const r of overrideRows.results ?? []) {
    bucket(productOverrides, str(r.supplier_id), {
      requirement_id: str(r.requirement_id),
      name: str(r.name),
      slug: str(r.slug),
      checklist: nullableStr(r.checklist),
      sort_order: num(r.sort_order),
      scope: normalizeRequirementScope(r.scope),
      product_id: str(r.product_id),
      mode: str(r.mode) === 'exempt' ? 'exempt' : 'add',
      tier: tierOf(r.tier),
      reason: nullableStr(r.reason),
    });
  }

  const productLinks = emptyBuckets<ProductLinkRow>(ids);
  for (const r of linkRows.results ?? []) {
    bucket(productLinks, str(r.supplier_id), {
      document_id: str(r.document_id),
      product_id: str(r.product_id),
    });
  }

  return suppliers.map((supplier) => ({
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    applicability: applicability.get(supplier.id) ?? [],
    claimOpened: claimOpened.get(supplier.id) ?? [],
    closures: closures.get(supplier.id) ?? [],
    documentCount: documentTotals.get(supplier.id) ?? 0,
    classification: classification.get(supplier.id) ?? { ...EMPTY_CLASSIFICATION_COUNTS },
    products: products.get(supplier.id) ?? [],
    excludedProducts: excluded.get(supplier.id) ?? [],
    productOverrides: productOverrides.get(supplier.id) ?? [],
    productLinks: productLinks.get(supplier.id) ?? [],
  }));
}

function tierOf(v: unknown): SupplierRequirementTier {
  return str(v) === 'recommended' ? 'recommended' : 'required';
}

/**
 * Load every input the engine needs, for the given suppliers, and compute.
 */
export async function computeGapsForSuppliers(
  db: D1Database,
  tenantId: string,
  suppliers: GapSupplier[],
  options: GapOptions & { supplierId?: string | null } = {},
): Promise<SupplierGap[]> {
  const inputs = await loadGapInputs(db, tenantId, suppliers, options);
  return inputs.map((input) => computeSupplierGap(input, options));
}

/**
 * Re-read the same inputs as if requirement `requirementId` had scope `scope`
 * — the "what would change" half of the scope-change preview. Pure over the
 * loaded rows: nothing is written.
 */
export function withRequirementScope(
  input: SupplierGapInput,
  requirementId: string,
  scope: RequirementScope,
): SupplierGapInput {
  const rescope = <T extends { requirement_id: string; scope?: unknown }>(rows: T[] | undefined): T[] =>
    (rows ?? []).map((r) => (r.requirement_id === requirementId ? { ...r, scope } : r));
  return {
    ...input,
    applicability: rescope(input.applicability),
    claimOpened: rescope(input.claimOpened),
    productOverrides: rescope(input.productOverrides),
  };
}

/**
 * The whole report in one call: resolve the supplier page, then compute.
 * Returns `total` (suppliers in scope, before paging) alongside the gaps.
 */
export async function loadSupplierGaps(
  db: D1Database,
  tenantId: string,
  opts: GapOptions & {
    supplierId?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ gaps: SupplierGap[]; total: number }> {
  const { suppliers, total } = await listGapSuppliers(db, tenantId, opts);
  const gaps = await computeGapsForSuppliers(db, tenantId, suppliers, opts);
  return { gaps, total };
}
