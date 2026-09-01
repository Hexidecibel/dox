/**
 * D1 loader for the requirement gap engine.
 *
 * Same split as `functions/lib/spec-warnings.ts` around `shared/specCheck.ts`:
 * every decision about what counts as a gap lives in `shared/requirementGap.ts`
 * where it is testable without a database, and this file does nothing but
 * fetch rows and bucket them by supplier.
 *
 * FIVE QUERIES, NOT FIVE PER SUPPLIER. The supplier list view renders every
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
  type GapOptions,
  type SupplierGap,
  type SupplierGapInput,
} from '../../shared/requirementGap';
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
 * Load every input the engine needs, for the given suppliers, and compute.
 *
 * `supplierId` narrows the SQL as well as the output; without it the queries
 * run tenant-wide and are bucketed, which is what the list view wants.
 */
export async function computeGapsForSuppliers(
  db: D1Database,
  tenantId: string,
  suppliers: GapSupplier[],
  options: GapOptions & { supplierId?: string | null } = {},
): Promise<SupplierGap[]> {
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
              r.name, r.slug, r.checklist, r.sort_order
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
  //    than dropped in SQL, so an opt-in caller can still see them.
  const claimRows = await db
    .prepare(
      `SELECT d.supplier_id, ctr.requirement_id, ctr.is_required,
              r.name, r.slug, r.checklist, r.sort_order,
              ct.id AS claim_type_id, ct.name AS claim_type_name,
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

  // 3. Closures — the right-hand side. ONLY status = 'confirmed'. A
  //    'suggested' link is an unreviewed machine proposal and a 'rejected' one
  //    is a human saying no; either counting as a closure would let the
  //    pipeline close its own gaps.
  const closureRows = await db
    .prepare(
      `SELECT d.supplier_id, dr.requirement_id, dr.confirmed_at,
              d.id AS document_id, d.title AS document_title
         FROM document_requirements dr
         JOIN documents d ON d.id = dr.document_id
        WHERE d.tenant_id = ?
          AND d.status = 'active'
          AND d.supplier_id IS NOT NULL
          AND dr.status = 'confirmed'${pin.replace('%COL%', 'd.supplier_id')}`,
    )
    .bind(tenantId, ...pinParam)
    .all<Record<string, unknown>>();

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

  const applicability = emptyBuckets<ApplicabilityRow>(ids);
  for (const r of applicabilityRows.results ?? []) {
    bucket(applicability, str(r.supplier_id), {
      requirement_id: str(r.requirement_id),
      name: str(r.name),
      slug: str(r.slug),
      checklist: nullableStr(r.checklist),
      sort_order: num(r.sort_order),
      tier: (str(r.tier) === 'recommended' ? 'recommended' : 'required') as SupplierRequirementTier,
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
      is_required: num(r.is_required),
      claim_type_id: str(r.claim_type_id),
      claim_type_name: str(r.claim_type_name),
      document_id: str(r.document_id),
      document_title: str(r.document_title),
    });
  }

  const closures = emptyBuckets<ClosureRow>(ids);
  for (const r of closureRows.results ?? []) {
    bucket(closures, str(r.supplier_id), {
      requirement_id: str(r.requirement_id),
      document_id: str(r.document_id),
      document_title: str(r.document_title),
      confirmed_at: nullableStr(r.confirmed_at),
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

  return suppliers.map((supplier) => {
    const input: SupplierGapInput = {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      applicability: applicability.get(supplier.id) ?? [],
      claimOpened: claimOpened.get(supplier.id) ?? [],
      closures: closures.get(supplier.id) ?? [],
      documentCount: documentTotals.get(supplier.id) ?? 0,
      classification: classification.get(supplier.id) ?? { ...EMPTY_CLASSIFICATION_COUNTS },
    };
    return computeSupplierGap(input, options);
  });
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
