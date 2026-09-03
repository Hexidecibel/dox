/**
 * The extraction-instruction stack: resolve every layer of natural-language
 * guidance that applies to one (tenant, supplier?, document_type?) and compose
 * them in general -> specific order.
 *
 * THE STACK
 * ---------
 *   1. tenants.extraction_context            (0072) — the tenant "industry
 *      layer". NOT resolved here: it occupies a different slot in the prompt
 *      (it REPLACES the seeded DEFAULT_DAIRY_CONTEXT block wholesale) and is
 *      served by /api/tenant-extraction-context.
 *   2. document_type_extraction_instructions (0098) — "how to read a
 *      Certificate of Insurance", from anybody.
 *   3. supplier_extraction_instructions      (0035/0068) — "how to read a
 *      Certificate of Insurance from Darigold specifically".
 *
 * Layers 2 and 3 COMPOSE. That is not a new convention: layer 3 already
 * composes with BASE_PROMPT (bin/process-worker prepends it as its own
 * labelled "## Reviewer instructions" block rather than substituting into the
 * base rules), so layer 2 joins the same way, ahead of it. The supplier block
 * sits CLOSER to the base rules than the type block, so a supplier instruction
 * reads as a refinement of the type instruction, not a competitor to it.
 *
 * Whole-block replacement is reserved for layer 1, because that layer is a
 * template a tenant edits in full.
 *
 * WHAT COMPOSITION MAY NOT DO
 * ---------------------------
 * Neither of these layers can license the model to supply a value the document
 * did not print. The header this module emits says so out loud, and TABLE
 * EXTRACTION RULE 14 ("NEVER SUPPLY A UNIT, SPEC OR VERDICT THE DOCUMENT DID
 * NOT PRINT") still governs everything a type-level instruction asks for. An
 * invented unit is not a cosmetic error: a result carrying a unit the document
 * never stated is silently dropped from spec checking.
 */

/** One resolved layer, plus the composed text the prompt builders consume. */
export interface InstructionStack {
  /** Layer 2 — guidance for the document type, any supplier. '' when none. */
  type_instructions: string;
  /** Layer 3 — guidance for the exact (supplier, document type). '' when none. */
  supplier_instructions: string;
  /**
   * Layers 2 and 3 joined general -> specific, with each block labelled so the
   * model (and a human reading a prompt dump) can tell which layer said what.
   * '' when both layers are empty — callers treat that as "no guidance".
   */
  effective_instructions: string;
}

export interface InstructionStackKey {
  tenantId: string;
  /** null when the supplier is not resolved yet — layer 3 is then skipped. */
  supplierId: string | null;
  /** null when the doc type is not resolved yet — layer 2 is then skipped. */
  documentTypeId: string | null;
}

/**
 * Label prefixed to the type layer inside `effective_instructions`.
 *
 * The labels matter for more than tidiness. Without them the two layers arrive
 * as one undifferentiated wall of text, and a reviewer debugging a bad
 * extraction from a prompt dump cannot tell whether the offending sentence came
 * from the type row (fix once, affects every supplier) or the supplier row (fix
 * once, affects one). The header also re-states the boundary that composition
 * must never cross — see the rule-14 note in this file's header.
 */
const TYPE_LAYER_HEADER =
  'Guidance for this KIND of document (applies to every supplier). ' +
  'It tells you where the values usually sit on this kind of paperwork. ' +
  'It never authorises you to supply a unit, specification or verdict the ' +
  'document did not print — the extraction rules below still govern that.';

/** Label prefixed to the supplier layer when BOTH layers are present. */
const SUPPLIER_LAYER_HEADER =
  'Guidance for this SUPPLIER on this kind of document. It refines the ' +
  'document-type guidance above; where the two disagree, follow this one.';

/**
 * Join the resolved layers into the single string the prompt builders prepend.
 *
 * Exported (and pure) because the worker composes the same two strings from an
 * API response rather than from the DB, and the two must produce byte-identical
 * text — one composition function, not two.
 *
 * When only ONE layer is present the text is emitted unlabelled: the existing
 * "## Reviewer instructions" block already introduces it, and adding a second
 * heading for a single block would change the prompt every existing
 * supplier-only tenant already gets, for no gain.
 */
export function composeInstructions(
  typeInstructions: string,
  supplierInstructions: string,
): string {
  const type = (typeInstructions || '').trim();
  const supplier = (supplierInstructions || '').trim();

  if (!type) return supplier;
  if (!supplier) return type;

  return [
    TYPE_LAYER_HEADER,
    '',
    type,
    '',
    SUPPLIER_LAYER_HEADER,
    '',
    supplier,
  ].join('\n');
}

/**
 * Read layers 2 and 3 for a key and compose them.
 *
 * Both reads are independently optional: an unresolved supplier still gets type
 * guidance (that is the whole point of layer 2), and an unresolved document type
 * still gets whatever supplier guidance exists. Never throws on a missing row —
 * "no guidance authored yet" is the normal state, not an error.
 */
export async function resolveInstructionStack(
  db: D1Database,
  key: InstructionStackKey,
): Promise<InstructionStack> {
  const typeInstructions = key.documentTypeId
    ? await loadTypeInstructions(db, key.tenantId, key.documentTypeId)
    : '';

  let supplierInstructions = '';
  if (key.supplierId && key.documentTypeId) {
    const row = await db
      .prepare(
        `SELECT instructions
           FROM supplier_extraction_instructions
          WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?`,
      )
      .bind(key.tenantId, key.supplierId, key.documentTypeId)
      .first<{ instructions: string | null }>();
    supplierInstructions = (row?.instructions ?? '').trim();
  }

  return {
    type_instructions: typeInstructions,
    supplier_instructions: supplierInstructions,
    effective_instructions: composeInstructions(typeInstructions, supplierInstructions),
  };
}

/**
 * Layer 2 on its own. Returns '' when nothing is authored for the type.
 */
export async function loadTypeInstructions(
  db: D1Database,
  tenantId: string,
  documentTypeId: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT instructions
         FROM document_type_extraction_instructions
        WHERE tenant_id = ? AND document_type_id = ?`,
    )
    .bind(tenantId, documentTypeId)
    .first<{ instructions: string | null }>();
  return (row?.instructions ?? '').trim();
}
