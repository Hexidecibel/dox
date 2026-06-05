/**
 * Loader for "already-known" teach background — context the system already has
 * so the teach interview doesn't re-ask / re-teach it.
 *
 * Two read-only sources:
 *   1. Tenant `extraction_context` (org-level instructions, column on `tenants`
 *      added in migration 0072). NULL/missing → '' (we do NOT substitute the
 *      dairy default here; this is "what's already authored", not the default).
 *   2. Existing `supplier_extraction_instructions.instructions` for this exact
 *      (supplier_id, document_type_id) pair — a prior teach session's output.
 *
 * Never throws on a missing row; returns '' for each absent piece so the prompt
 * builders can cleanly omit the section.
 */

export interface TeachBackground {
  /** Org-level extraction context, or '' when none authored. */
  tenantContext: string;
  /** Existing instructions for this exact (supplier, doctype), or ''. */
  existingInstructions: string;
}

export interface TeachBackgroundKey {
  tenantId: string;
  supplierId: string;
  documentTypeId: string;
}

/**
 * Load read-only background context for a teach session's (supplier, doctype)
 * pair. Resolves both pieces independently; either may be ''.
 */
export async function loadTeachBackground(
  db: D1Database,
  { tenantId, supplierId, documentTypeId }: TeachBackgroundKey,
): Promise<TeachBackground> {
  let tenantContext = '';
  let existingInstructions = '';

  try {
    const tenantRow = await db
      .prepare('SELECT extraction_context FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ extraction_context: string | null }>();
    tenantContext = tenantRow?.extraction_context?.trim() ? tenantRow.extraction_context : '';
  } catch {
    tenantContext = '';
  }

  try {
    const comboRow = await db
      .prepare(
        `SELECT instructions FROM supplier_extraction_instructions
         WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?`,
      )
      .bind(tenantId, supplierId, documentTypeId)
      .first<{ instructions: string | null }>();
    existingInstructions = comboRow?.instructions?.trim() ? comboRow.instructions : '';
  } catch {
    existingInstructions = '';
  }

  return { tenantContext, existingInstructions };
}
