/**
 * Small, file-local helpers shared by the Records REST handlers.
 *
 * Intentionally NOT a service-layer abstraction — handlers still talk to
 * D1 directly. This file just hosts utilities that would otherwise be
 * copy-pasted: slugifying sheet/column keys, ensuring tenant-scoped
 * sheet access, and rebuilding the records_row_refs index for a row.
 */

import { NotFoundError } from '../permissions';
import type { User } from '../types';
import type {
  RecordColumnRow,
  RecordRefType,
  RecordRowData,
} from '../../../shared/types';

/**
 * URL/key slugify. Mirrors the convention used by suppliers and
 * document_types: lowercase, non-alnum runs collapsed to '-', no
 * leading/trailing dashes.
 */
export function slugifyRecords(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load a sheet by id and check tenant access. Throws NotFoundError if
 * missing or out-of-tenant (we hide existence on cross-tenant lookups
 * the same way suppliers/[id].ts does).
 */
export async function loadSheetForUser(
  db: D1Database,
  sheetId: string,
  user: User,
): Promise<{
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  archived: number;
}> {
  const sheet = await db
    .prepare('SELECT id, tenant_id, name, slug, archived FROM records_sheets WHERE id = ?')
    .bind(sheetId)
    .first<{ id: string; tenant_id: string; name: string; slug: string; archived: number }>();

  if (!sheet) {
    throw new NotFoundError('Sheet not found');
  }
  if (user.role !== 'super_admin' && sheet.tenant_id !== user.tenant_id) {
    // Hide existence outside caller's tenant.
    throw new NotFoundError('Sheet not found');
  }
  return sheet;
}

/** Map a column type to the ref_type stored in records_row_refs, or null. */
export function refTypeForColumn(columnType: string): RecordRefType | null {
  switch (columnType) {
    case 'supplier_ref':
      return 'supplier';
    case 'product_ref':
      return 'product';
    case 'document_ref':
      return 'document';
    case 'record_ref':
      return 'record';
    case 'contact':
      return 'contact';
    case 'customer_ref':
      return 'customer';
    default:
      return null;
  }
}

/**
 * Normalize a cell value for an entity-ref column into a flat list of
 * referenced ids. Accepts: string id, {id} object, or array of either.
 */
export function extractRefIds(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item) {
      ids.push(item);
    } else if (item && typeof item === 'object' && 'id' in item) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return ids;
}

/**
 * Replace records_row_refs for a row using the current `data` JSON +
 * column schema. Caller is responsible for running this inside the same
 * logical write as the row update; D1 doesn't expose transactions but
 * we keep the writes adjacent and idempotent.
 *
 * Strategy: delete all existing refs for the row, re-insert from data.
 * Cheap because rows have a bounded number of ref columns.
 */
export async function rebuildRowRefs(
  db: D1Database,
  tenantId: string,
  sheetId: string,
  rowId: string,
  columns: RecordColumnRow[],
  data: RecordRowData,
): Promise<void> {
  await db
    .prepare('DELETE FROM records_row_refs WHERE row_id = ?')
    .bind(rowId)
    .run();

  for (const col of columns) {
    const refType = refTypeForColumn(col.type);
    if (!refType) continue;
    const cell = data[col.key];
    const ids = extractRefIds(cell);
    for (const refId of ids) {
      await db
        .prepare(
          `INSERT INTO records_row_refs (tenant_id, sheet_id, row_id, column_key, ref_type, ref_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(tenantId, sheetId, rowId, col.key, refType, refId)
        .run();
    }
  }
}

/**
 * Compute the display_title for a row from its data + column schema,
 * by reading whichever column has is_title=1 (if any).
 */
export function computeDisplayTitle(
  columns: RecordColumnRow[],
  data: RecordRowData,
): string | null {
  const titleCol = columns.find((c) => c.is_title === 1 && c.archived === 0);
  if (!titleCol) return null;
  const v = data[titleCol.key];
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/**
 * Insert a records_activity row. Best-effort: a failure here must not
 * fail the parent mutation, since activity is a UX feed and audit_log
 * remains the compliance record.
 */
export async function logRecordsActivity(
  db: D1Database,
  params: {
    tenantId: string;
    sheetId: string;
    rowId: string;
    actorId: string | null;
    kind: string;
    details?: unknown;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO records_activity (tenant_id, sheet_id, row_id, actor_id, kind, details)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.tenantId,
        params.sheetId,
        params.rowId,
        params.actorId,
        params.kind,
        params.details === undefined ? null : JSON.stringify(params.details),
      )
      .run();
  } catch (err) {
    console.error('records_activity insert failed:', err);
  }
}

/** Parse JSON cell payload, falling back to {} on malformed input. */
export function parseRowData(json: string | null): RecordRowData {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordRowData) : {};
  } catch {
    return {};
  }
}
