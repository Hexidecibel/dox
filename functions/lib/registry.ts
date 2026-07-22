import { generateId } from './db';
import { BadRequestError } from './permissions';
import type { RenewalType } from '../../shared/types';

/**
 * IDP Document Registry helpers (migrations 0076-0079).
 *
 * Shared by the manual single-doc upload path (POST /api/documents/ingest)
 * and the post-upload editor (PUT /api/documents/:id). Keeps category-set
 * syncing, tenant validation, and renewal-type validation in one place so the
 * two endpoints stay consistent.
 */

/** The renewal_type CHECK set (migration 0077). */
export const RENEWAL_TYPES: readonly RenewalType[] = [
  'renewal_application',
  'hard_expiry',
  'keep_current',
  'review_cycle',
];

export function isValidRenewalType(value: string): value is RenewalType {
  return (RENEWAL_TYPES as readonly string[]).includes(value);
}

/**
 * Parse a form/body value that should be a JSON array of strings. Returns the
 * cleaned array (trimmed, empties dropped). Throws BadRequestError with the
 * given field name on malformed input. `null`/`undefined` yield [].
 */
export function parseStringArray(
  raw: string | string[] | null | undefined,
  field: string,
): string[] {
  if (raw == null) return [];
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      arr = JSON.parse(raw);
    } catch {
      throw new BadRequestError(`${field} must be a valid JSON array`);
    }
  }
  if (!Array.isArray(arr)) {
    throw new BadRequestError(`${field} must be a JSON array of strings`);
  }
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => (v as string).trim())
    .filter(Boolean);
}

/**
 * Ensure every id in `ids` is a document_type belonging to `tenantId`.
 * Throws BadRequestError listing the offenders. No-op for an empty list.
 */
export async function validateCategoryIds(
  db: D1Database,
  tenantId: string,
  ids: string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT id FROM document_types WHERE id IN (${placeholders}) AND tenant_id = ?`,
    )
    .bind(...unique, tenantId)
    .all<{ id: string }>();
  const valid = new Set(rows.results.map((r) => r.id));
  const invalid = unique.filter((id) => !valid.has(id));
  if (invalid.length > 0) {
    throw new BadRequestError(
      `Invalid document type(s) for this tenant: ${invalid.join(', ')}`,
    );
  }
}

/**
 * Resolve which category id is the primary. Prefers an explicit
 * `primaryCategoryId` when it is one of the categories; otherwise the first
 * category. Returns null when there are no categories.
 */
export function resolvePrimaryCategoryId(
  categoryIds: string[],
  primaryCategoryId: string | null | undefined,
): string | null {
  if (categoryIds.length === 0) return null;
  if (primaryCategoryId && categoryIds.includes(primaryCategoryId)) {
    return primaryCategoryId;
  }
  return categoryIds[0];
}

/**
 * REPLACE a document's category set. Deletes existing document_categories rows
 * and inserts one per id, flagging `primaryId` as is_primary. Idempotent via
 * the UNIQUE(document_id, document_type_id) guard. The Phase-1 FTS triggers on
 * document_categories keep category_text in sync.
 */
export async function syncDocumentCategories(
  db: D1Database,
  documentId: string,
  categoryIds: string[],
  primaryId: string | null,
): Promise<void> {
  await db
    .prepare('DELETE FROM document_categories WHERE document_id = ?')
    .bind(documentId)
    .run();
  const unique = [...new Set(categoryIds)];
  for (const catId of unique) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO document_categories (id, document_id, document_type_id, is_primary)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(generateId(), documentId, catId, catId === primaryId ? 1 : 0)
      .run();
  }
}
