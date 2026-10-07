/**
 * Approved items and supplier facilities (migration 0135; decisions C-001 and
 * C-002).
 *
 * Three things live here and all three are careful about the same rule --
 * NOTHING IS ASSERTED THAT NOBODY SAID:
 *
 *   1. APPROVAL is a status on the item-and-supplier pair (`product_suppliers`),
 *      separate from "currently supplied" (`discontinued_at`). A pair on file
 *      before 0135 is `approved` / `initial`; a new pair is `pending` with no
 *      source at all. `decideItemApproval` is the ONE writer, used by a person
 *      (PUT /api/suppliers/:id/products/:productId) and by the verified
 *      supplier list import -- and the import can never override a person.
 *
 *   2. A FACILITY is a named record under a supplier that a person adds. No
 *      code path creates one from a certificate, and a pair with no facility is
 *      simply "no facility recorded".
 *
 *   3. THE LIST (`listApprovedItems`) is one row per pair, including a pair
 *      that exists only through the legacy `products.supplier_id` column and
 *      was made after 0135: it has no row to hold an approval, so it reads
 *      `pending` with `link_id` NULL rather than being left off the list.
 *
 * Nothing here is read by the gap engine, renewals, search or the order send's
 * decision to send. It informs; it never blocks.
 */

import { generateId } from './db';
import { BadRequestError, ConflictError, NotFoundError } from './permissions';
import { sanitizeString } from './validation';
import { isItemApprovalStatus, isPrivateLabel, normalizeFacilityName } from '../../shared/itemApproval';
import type {
  ApprovedItem,
  ApprovedItemsResponse,
  ItemApprovalSource,
  ItemApprovalStatus,
  SupplierFacilitiesResponse,
  SupplierFacility,
  SupplierFacilityWriteRequest,
  SupplierProductLink,
} from '../../shared/types';

const FACILITY_NAME_MAX = 200;
const FACILITY_CODE_MAX = 60;
const NOTE_MAX = 1000;

function cleanText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = sanitizeString(String(v)).slice(0, max);
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

export interface SupplierFacilityRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  name: string;
  name_norm: string;
  plant_code: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  item_count?: number | null;
}

export function toSupplierFacility(r: SupplierFacilityRow): SupplierFacility {
  return {
    id: r.id,
    supplier_id: r.supplier_id,
    name: r.name,
    plant_code: r.plant_code ?? null,
    notes: r.notes ?? null,
    active: Number(r.active) === 1,
    item_count: Number(r.item_count ?? 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const FACILITY_SELECT = `
  SELECT f.id, f.tenant_id, f.supplier_id, f.name, f.name_norm, f.plant_code, f.notes, f.active,
         f.created_at, f.updated_at,
         (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.facility_id = f.id) AS item_count
    FROM supplier_facilities f`;

export async function listSupplierFacilities(
  db: D1Database,
  tenantId: string,
  supplierId: string,
): Promise<SupplierFacilityRow[]> {
  const res = await db
    .prepare(`${FACILITY_SELECT} WHERE f.tenant_id = ? AND f.supplier_id = ? ORDER BY f.active DESC, f.name COLLATE NOCASE`)
    .bind(tenantId, supplierId)
    .all<SupplierFacilityRow>();
  return res.results ?? [];
}

export async function buildFacilitiesResponse(
  db: D1Database,
  supplier: { id: string; tenant_id: string; name: string },
): Promise<SupplierFacilitiesResponse> {
  return {
    supplier: { id: supplier.id, name: supplier.name },
    facilities: (await listSupplierFacilities(db, supplier.tenant_id, supplier.id)).map(toSupplierFacility),
  };
}

export async function loadSupplierFacility(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  facilityId: string,
): Promise<SupplierFacilityRow> {
  const row = await db
    .prepare(`${FACILITY_SELECT} WHERE f.id = ? AND f.tenant_id = ? AND f.supplier_id = ?`)
    .bind(facilityId, tenantId, supplierId)
    .first<SupplierFacilityRow>();
  if (!row) throw new NotFoundError('Facility not found');
  return row;
}

async function refuseDuplicateFacility(
  db: D1Database,
  supplierId: string,
  nameNorm: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await db
    .prepare('SELECT id, name FROM supplier_facilities WHERE supplier_id = ? AND name_norm = ?')
    .bind(supplierId, nameNorm)
    .first<{ id: string; name: string }>();
  if (clash && clash.id !== exceptId) {
    throw new ConflictError(`This supplier already has a facility named "${clash.name}".`);
  }
}

export async function createSupplierFacility(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  body: SupplierFacilityWriteRequest,
  actorId: string,
): Promise<SupplierFacilityRow> {
  const name = cleanText(body.name, FACILITY_NAME_MAX);
  if (!name) throw new BadRequestError('A facility needs a name');
  const nameNorm = normalizeFacilityName(name);
  await refuseDuplicateFacility(db, supplierId, nameNorm, null);

  const id = generateId();
  await db
    .prepare(
      `INSERT INTO supplier_facilities
         (id, tenant_id, supplier_id, name, name_norm, plant_code, notes, active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      supplierId,
      name,
      nameNorm,
      cleanText(body.plant_code, FACILITY_CODE_MAX),
      cleanText(body.notes, NOTE_MAX),
      body.active === false ? 0 : 1,
      actorId,
      actorId,
    )
    .run();
  return loadSupplierFacility(db, tenantId, supplierId, id);
}

export async function updateSupplierFacility(
  db: D1Database,
  existing: SupplierFacilityRow,
  body: SupplierFacilityWriteRequest,
  actorId: string,
): Promise<{ row: SupplierFacilityRow; changed: boolean }> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (body.name !== undefined) {
    const name = cleanText(body.name, FACILITY_NAME_MAX);
    if (!name) throw new BadRequestError('A facility needs a name');
    if (name !== existing.name) {
      const nameNorm = normalizeFacilityName(name);
      await refuseDuplicateFacility(db, existing.supplier_id, nameNorm, existing.id);
      sets.push('name = ?', 'name_norm = ?');
      params.push(name, nameNorm);
    }
  }
  if (body.plant_code !== undefined) {
    const code = cleanText(body.plant_code, FACILITY_CODE_MAX);
    if (code !== (existing.plant_code ?? null)) {
      sets.push('plant_code = ?');
      params.push(code);
    }
  }
  if (body.notes !== undefined) {
    const notes = cleanText(body.notes, NOTE_MAX);
    if (notes !== (existing.notes ?? null)) {
      sets.push('notes = ?');
      params.push(notes);
    }
  }
  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
    if (active !== Number(existing.active)) {
      sets.push('active = ?');
      params.push(active);
    }
  }
  if (sets.length === 0) return { row: existing, changed: false };

  await db
    .prepare(
      `UPDATE supplier_facilities SET ${sets.join(', ')}, updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
    .bind(...params, actorId, existing.id, existing.tenant_id)
    .run();
  return {
    row: await loadSupplierFacility(db, existing.tenant_id, existing.supplier_id, existing.id),
    changed: true,
  };
}

/**
 * Remove a facility. The items that named it are NOT removed: they go back to
 * "no facility recorded", and the caller's audit row lists which, because the
 * foreign key's SET NULL would otherwise do that silently.
 */
export async function removeSupplierFacility(
  db: D1Database,
  existing: SupplierFacilityRow,
): Promise<{ cleared_product_ids: string[] }> {
  const used = await db
    .prepare('SELECT product_id FROM product_suppliers WHERE facility_id = ? AND tenant_id = ?')
    .bind(existing.id, existing.tenant_id)
    .all<{ product_id: string }>();
  const cleared = (used.results ?? []).map((r) => r.product_id);
  await db.batch([
    db
      .prepare(
        `UPDATE product_suppliers SET facility_id = NULL, updated_at = datetime('now')
          WHERE facility_id = ? AND tenant_id = ?`,
      )
      .bind(existing.id, existing.tenant_id),
    db.prepare('DELETE FROM supplier_facilities WHERE id = ? AND tenant_id = ?').bind(existing.id, existing.tenant_id),
  ]);
  return { cleared_product_ids: cleared };
}

// ---------------------------------------------------------------------------
// The pair
// ---------------------------------------------------------------------------

export interface ProductSupplierLinkRow {
  id: string;
  tenant_id: string;
  product_id: string;
  supplier_id: string;
  source: string | null;
  discontinued_at: string | null;
  discontinued_by: string | null;
  nothing_owed_reason: string | null;
  nothing_owed_at: string | null;
  nothing_owed_by: string | null;
  approval_status: ItemApprovalStatus;
  approval_source: ItemApprovalSource | null;
  approval_decided_at: string | null;
  approval_decided_by: string | null;
  approval_note: string | null;
  facility_id: string | null;
}

export const LINK_COLUMNS = `id, tenant_id, product_id, supplier_id, source, discontinued_at, discontinued_by,
  nothing_owed_reason, nothing_owed_at, nothing_owed_by,
  approval_status, approval_source, approval_decided_at, approval_decided_by, approval_note, facility_id`;

export function toSupplierProductLink(r: ProductSupplierLinkRow): SupplierProductLink {
  return {
    product_id: r.product_id,
    supplier_id: r.supplier_id,
    source: r.source ?? null,
    discontinued_at: r.discontinued_at ?? null,
    discontinued_by: r.discontinued_by ?? null,
    nothing_owed_reason: r.nothing_owed_reason ?? null,
    nothing_owed_at: r.nothing_owed_at ?? null,
    nothing_owed_by: r.nothing_owed_by ?? null,
    approval_status: r.approval_status,
    approval_source: r.approval_source ?? null,
    approval_decided_at: r.approval_decided_at ?? null,
    approval_decided_by: r.approval_decided_by ?? null,
    approval_note: r.approval_note ?? null,
    facility_id: r.facility_id ?? null,
  };
}

export async function loadProductSupplierLink(
  db: D1Database,
  productId: string,
  supplierId: string,
): Promise<ProductSupplierLinkRow | null> {
  return db
    .prepare(`SELECT ${LINK_COLUMNS} FROM product_suppliers WHERE product_id = ? AND supplier_id = ?`)
    .bind(productId, supplierId)
    .first<ProductSupplierLinkRow>();
}

export interface ApprovalDecision {
  status: ItemApprovalStatus;
  note?: string | null;
  source: Extract<ItemApprovalSource, 'person' | 'import'>;
  actorId: string | null;
}

export interface ApprovalOutcome {
  /** Whether a row was written. */
  changed: boolean;
  /** Why nothing was written, when nothing was. */
  kept: 'same' | 'person_decided' | null;
  previous: Pick<
    ProductSupplierLinkRow,
    'approval_status' | 'approval_source' | 'approval_decided_at' | 'approval_decided_by' | 'approval_note'
  >;
  status: ItemApprovalStatus;
  note: string | null;
}

/**
 * What a decision would do to a pair, without writing. Pure, so the supplier
 * list's dry run reports exactly what its apply writes.
 *
 *   - `not_approved` needs a note. A person is refused without one; the import
 *     always supplies its own.
 *   - An IMPORT never overrides a `person` row -- not to agree with it and not
 *     to disagree. The person's row stands as written.
 *   - A person re-affirming what an `initial` or `import` row already says IS
 *     a change: the status is the same but now somebody decided it, and that
 *     is what protects it from the next import.
 */
export function planApprovalDecision(
  current: Pick<ProductSupplierLinkRow, 'approval_status' | 'approval_source' | 'approval_note'>,
  decision: Pick<ApprovalDecision, 'status' | 'note' | 'source'>,
): { write: boolean; kept: ApprovalOutcome['kept']; note: string | null } {
  const note = cleanText(decision.note, NOTE_MAX);
  if (decision.status === 'not_approved' && !note) {
    throw new BadRequestError('Marking an item not approved needs a note saying why');
  }
  if (decision.source === 'import') {
    if (current.approval_source === 'person') return { write: false, kept: 'person_decided', note };
    if (current.approval_status === decision.status) return { write: false, kept: 'same', note };
    return { write: true, kept: null, note };
  }
  const same =
    current.approval_source === 'person' &&
    current.approval_status === decision.status &&
    (current.approval_note ?? null) === note;
  return same ? { write: false, kept: 'same', note } : { write: true, kept: null, note };
}

/**
 * Settle one pair's approval. The ONE writer of the approval columns after the
 * 0135 backfill. Guarded in SQL on the source it read, so an import racing a
 * person's click cannot land on top of it.
 */
export async function decideItemApproval(
  db: D1Database,
  link: ProductSupplierLinkRow,
  decision: ApprovalDecision,
): Promise<ApprovalOutcome> {
  if (!isItemApprovalStatus(decision.status)) {
    throw new BadRequestError('approval_status must be approved, pending or not_approved');
  }
  const plan = planApprovalDecision(link, decision);
  const previous = {
    approval_status: link.approval_status,
    approval_source: link.approval_source ?? null,
    approval_decided_at: link.approval_decided_at ?? null,
    approval_decided_by: link.approval_decided_by ?? null,
    approval_note: link.approval_note ?? null,
  };
  if (!plan.write) {
    return { changed: false, kept: plan.kept, previous, status: link.approval_status, note: link.approval_note ?? null };
  }
  const guard = decision.source === 'import' ? ` AND (approval_source IS NULL OR approval_source != 'person')` : '';
  const res = await db
    .prepare(
      `UPDATE product_suppliers
          SET approval_status = ?, approval_source = ?, approval_note = ?,
              approval_decided_at = datetime('now'), approval_decided_by = ?,
              updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?${guard}`,
    )
    .bind(decision.status, decision.source, plan.note, decision.actorId, link.id, link.tenant_id)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    // Only the import's guard can make this miss: a person decided meanwhile.
    return { changed: false, kept: 'person_decided', previous, status: link.approval_status, note: link.approval_note ?? null };
  }
  return { changed: true, kept: null, previous, status: decision.status, note: plan.note };
}

/**
 * Name the facility an item comes from, or clear it. The facility must be one
 * of THIS supplier's and active: a retired facility keeps the items it already
 * has but takes no new ones.
 */
export async function resolveAssignableFacility(
  db: D1Database,
  link: Pick<ProductSupplierLinkRow, 'tenant_id' | 'supplier_id' | 'facility_id'>,
  facilityId: string | null,
): Promise<SupplierFacilityRow | null> {
  if (facilityId === null) return null;
  if (typeof facilityId !== 'string' || !facilityId) {
    throw new BadRequestError('facility_id must be a facility id or null');
  }
  const row = await db
    .prepare(`${FACILITY_SELECT} WHERE f.id = ? AND f.tenant_id = ? AND f.supplier_id = ?`)
    .bind(facilityId, link.tenant_id, link.supplier_id)
    .first<SupplierFacilityRow>();
  if (!row) throw new BadRequestError('That facility does not belong to this supplier');
  if (Number(row.active) !== 1 && facilityId !== (link.facility_id ?? null)) {
    throw new BadRequestError(`"${row.name}" is no longer in use. Reactivate it or pick another facility.`);
  }
  return row;
}

export async function setItemFacility(
  db: D1Database,
  link: ProductSupplierLinkRow,
  facilityId: string | null,
): Promise<{ changed: boolean; previous_facility_id: string | null; facility: SupplierFacilityRow | null }> {
  const previous = link.facility_id ?? null;
  const facility = await resolveAssignableFacility(db, link, facilityId);
  if (facilityId === previous) return { changed: false, previous_facility_id: previous, facility };
  await db
    .prepare(`UPDATE product_suppliers SET facility_id = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .bind(facilityId, link.id, link.tenant_id)
    .run();
  return { changed: true, previous_facility_id: previous, facility };
}

// ---------------------------------------------------------------------------
// The approved items list
// ---------------------------------------------------------------------------

export interface ApprovedItemsFilter {
  supplierId?: string | null;
  productId?: string | null;
  facilityId?: string | null;
  approval?: ItemApprovalStatus | null;
  /** true = currently supplied only, false = no longer supplied only. */
  supplied?: boolean | null;
  text?: string | null;
  limit?: number;
  offset?: number;
}

interface ApprovedItemSqlRow {
  link_id: string | null;
  product_id: string;
  product_name: string;
  product_active: number | null;
  our_sku: string | null;
  supplier_id: string;
  supplier_name: string;
  facility_id: string | null;
  facility_name: string | null;
  facility_plant_code: string | null;
  facility_active: number | null;
  approval_status: ItemApprovalStatus;
  approval_source: ItemApprovalSource | null;
  approval_decided_at: string | null;
  approval_decided_by: string | null;
  approval_decided_by_name: string | null;
  approval_note: string | null;
  discontinued_at: string | null;
  link_source: string | null;
  brand_owner: string | null;
  producer: string | null;
  plant_code: string | null;
}

// Both paths to "this supplier ships this product", the same OR every other
// reader makes (functions/lib/requirement-gaps.ts query 5). The second branch
// is a pair with no product_suppliers row: nothing recorded, so `pending`.
const PAIRS_CTE = `
  WITH pairs AS (
    SELECT ps.id AS link_id, ps.product_id, ps.supplier_id, ps.source AS link_source, ps.discontinued_at,
           ps.approval_status, ps.approval_source, ps.approval_decided_at, ps.approval_decided_by,
           ps.approval_note, ps.facility_id
      FROM product_suppliers ps
     WHERE ps.tenant_id = ?
    UNION ALL
    SELECT NULL, p0.id, p0.supplier_id, NULL, NULL,
           'pending', NULL, NULL, NULL, NULL, NULL
      FROM products p0
     WHERE p0.tenant_id = ?
       AND p0.supplier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM product_suppliers ps2
                        WHERE ps2.product_id = p0.id AND ps2.supplier_id = p0.supplier_id)
  )`;

const PAIRS_FROM = `
    FROM pairs x
    JOIN products p ON p.id = x.product_id AND p.tenant_id = ?
    JOIN suppliers s ON s.id = x.supplier_id AND s.tenant_id = ?
    LEFT JOIN supplier_facilities f ON f.id = x.facility_id`;

const OUR_SKU_SQL = `(SELECT group_concat(pi.value, ', ') FROM product_identifiers pi
                       WHERE pi.product_id = p.id AND pi.kind = 'our_sku' AND pi.superseded = 0)`;

export async function listApprovedItems(
  db: D1Database,
  tenantId: string,
  filter: ApprovedItemsFilter = {},
): Promise<ApprovedItemsResponse> {
  const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
  const offset = Math.max(Number(filter.offset) || 0, 0);

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.supplierId) {
    where.push('x.supplier_id = ?');
    params.push(filter.supplierId);
  }
  if (filter.productId) {
    where.push('x.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.facilityId) {
    where.push('x.facility_id = ?');
    params.push(filter.facilityId);
  }
  if (filter.supplied === true) where.push('x.discontinued_at IS NULL');
  if (filter.supplied === false) where.push('x.discontinued_at IS NOT NULL');
  const text = (filter.text ?? '').trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR p.brand_owner LIKE ? ESCAPE '\\'
        OR p.producer LIKE ? ESCAPE '\\' OR f.name LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM product_identifiers pi2
                    WHERE pi2.product_id = p.id AND pi2.superseded = 0 AND pi2.value LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like, like, like, like);
  }
  const base = [tenantId, tenantId, tenantId, tenantId];
  const whereSql = (extra: string[]) => {
    const all = [...where, ...extra];
    return all.length ? ` WHERE ${all.join(' AND ')}` : '';
  };

  // The three counts ignore the approval filter so the screen's tabs can show
  // how many sit under each status for the rest of what was asked.
  const countRows = await db
    .prepare(`${PAIRS_CTE} SELECT x.approval_status AS status, COUNT(*) AS n ${PAIRS_FROM}${whereSql([])} GROUP BY x.approval_status`)
    .bind(...base, ...params)
    .all<{ status: string; n: number }>();
  const counts: Record<ItemApprovalStatus, number> = { approved: 0, pending: 0, not_approved: 0 };
  for (const r of countRows.results ?? []) {
    if (isItemApprovalStatus(r.status)) counts[r.status] = Number(r.n) || 0;
  }

  const approvalWhere = filter.approval ? ['x.approval_status = ?'] : [];
  const approvalParams = filter.approval ? [filter.approval] : [];
  const rows = await db
    .prepare(
      `${PAIRS_CTE}
       SELECT x.link_id, p.id AS product_id, p.name AS product_name, p.active AS product_active,
              ${OUR_SKU_SQL} AS our_sku,
              s.id AS supplier_id, s.name AS supplier_name,
              f.id AS facility_id, f.name AS facility_name, f.plant_code AS facility_plant_code, f.active AS facility_active,
              x.approval_status, x.approval_source, x.approval_decided_at, x.approval_decided_by,
              (SELECT u.name FROM users u WHERE u.id = x.approval_decided_by) AS approval_decided_by_name,
              x.approval_note, x.discontinued_at, x.link_source,
              p.brand_owner, p.producer, p.plant_code
       ${PAIRS_FROM}${whereSql(approvalWhere)}
       ORDER BY s.name COLLATE NOCASE, p.name COLLATE NOCASE, p.id
       LIMIT ? OFFSET ?`,
    )
    .bind(...base, ...params, ...approvalParams, limit, offset)
    .all<ApprovedItemSqlRow>();

  const items: ApprovedItem[] = (rows.results ?? []).map((r) => ({
    link_id: r.link_id ?? null,
    product_id: r.product_id,
    product_name: r.product_name,
    product_active: Number(r.product_active ?? 1) === 1,
    our_sku: r.our_sku ?? null,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    facility: r.facility_id
      ? {
          id: r.facility_id,
          name: r.facility_name ?? '',
          plant_code: r.facility_plant_code ?? null,
          active: Number(r.facility_active ?? 1) === 1,
        }
      : null,
    approval_status: r.approval_status,
    approval_source: r.approval_source ?? null,
    approval_decided_at: r.approval_decided_at ?? null,
    approval_decided_by: r.approval_decided_by ?? null,
    approval_decided_by_name: r.approval_decided_by_name ?? null,
    approval_note: r.approval_note ?? null,
    supplied: r.discontinued_at == null,
    discontinued_at: r.discontinued_at ?? null,
    link_source: r.link_source ?? null,
    brand_owner: r.brand_owner ?? null,
    producer: r.producer ?? null,
    plant_code: r.plant_code ?? null,
    private_label: isPrivateLabel(r.brand_owner, r.producer),
  }));

  const total = filter.approval ? counts[filter.approval] : counts.approved + counts.pending + counts.not_approved;
  return { items, total, counts, limit, offset };
}
