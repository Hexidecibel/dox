/**
 * Unified extraction-profile store accessor.
 *
 * As of migration 0068, the single source of truth for "how to extract a
 * document from this (supplier, document_type)" is the
 * `supplier_extraction_instructions` table — it now holds BOTH the
 * natural-language `instructions` (migration 0035) AND the `field_mappings`
 * JSON (migration 0068, moved off the connectors table).
 *
 * This module is the read/write surface for that profile. It is PURE w.r.t.
 * the rest of the app: it only touches the DB and returns plain data, so it
 * can be shared by the /api/sources/:id/profile route, the
 * /api/extraction-instructions endpoints, and any backfill job.
 */

/** A few-shot example pair, as the worker / extractFields() consumes them. */
export interface ProfileExample {
  input_text: string;
  corrected_output: string;
}

/** The resolved extraction profile for a (tenant, supplier, document_type). */
export interface ExtractionProfile {
  supplier_id: string | null;
  document_type_id: string | null;
  /** Parsed JSON field mappings, or null when none authored. */
  field_mappings: unknown | null;
  /** Natural-language reviewer guidance; '' when none authored. */
  extraction_instructions: string;
  /** Supplier-aware few-shot examples (best-scored first). */
  examples: ProfileExample[];
}

export interface LoadProfileKey {
  tenantId: string;
  supplierId: string | null;
  documentTypeId: string | null;
}

const MAX_EXAMPLES = 3;
const MIN_EXAMPLE_SCORE = 0.7;

/**
 * Load the unified extraction profile keyed by (tenant, supplier, document_type)
 * from `supplier_extraction_instructions` (+ few-shot examples from
 * `extraction_examples`).
 *
 * Always resolves to a usable object — when the source has no supplier/doctype
 * or no authored profile yet, returns empty mappings ('' instructions, [] /
 * null mappings) so extraction can proceed with defaults. Never throws on a
 * missing profile.
 */
export async function loadExtractionProfile(
  db: D1Database,
  key: LoadProfileKey,
): Promise<ExtractionProfile> {
  const profile: ExtractionProfile = {
    supplier_id: key.supplierId,
    document_type_id: key.documentTypeId,
    field_mappings: null,
    extraction_instructions: '',
    examples: [],
  };

  // Without a supplier we cannot key the unified store; bail with defaults.
  if (!key.supplierId) {
    return profile;
  }

  // 1) Profile row: instructions + field_mappings.
  //    Exact (supplier, document_type) match when the doctype is known. When
  //    it isn't (worker hasn't promoted the doctype yet), aggregate the
  //    supplier's authored guidance across doctypes (mirrors the behavior of
  //    GET /api/extraction-instructions with no document_type_id) and take the
  //    most-recently-updated field_mappings.
  if (key.documentTypeId) {
    const row = await db
      .prepare(
        `SELECT instructions, field_mappings
         FROM supplier_extraction_instructions
         WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?`,
      )
      .bind(key.tenantId, key.supplierId, key.documentTypeId)
      .first<{ instructions: string | null; field_mappings: string | null }>();

    if (row) {
      profile.extraction_instructions = row.instructions ?? '';
      profile.field_mappings = parseMappings(row.field_mappings);
    }
  } else {
    const agg = await db
      .prepare(
        `SELECT sei.instructions AS instructions,
                sei.field_mappings AS field_mappings,
                dt.name AS doctype_name
         FROM supplier_extraction_instructions sei
         LEFT JOIN document_types dt ON dt.id = sei.document_type_id
         WHERE sei.tenant_id = ? AND sei.supplier_id = ?
         ORDER BY sei.updated_at DESC`,
      )
      .bind(key.tenantId, key.supplierId)
      .all<{ instructions: string | null; field_mappings: string | null; doctype_name: string | null }>();

    const list = agg.results || [];
    if (list.length === 1) {
      profile.extraction_instructions = list[0].instructions ?? '';
    } else if (list.length > 1) {
      profile.extraction_instructions = list
        .filter((r) => r.instructions && r.instructions.trim())
        .map((r) => `[For ${r.doctype_name || 'document type'}]\n${r.instructions}`)
        .join('\n\n');
    }
    // Most-recent non-empty field_mappings wins (list is updated_at DESC).
    for (const r of list) {
      const fm = parseMappings(r.field_mappings);
      if (fm !== null) {
        profile.field_mappings = fm;
        break;
      }
    }
  }

  // 2) Few-shot examples. extraction_examples keys supplier by NAME (string),
  //    not supplier_id — resolve the name first, then prefer supplier-specific
  //    examples and top up with general ones (mirrors webhooks/email-ingest).
  if (key.documentTypeId) {
    const supplierRow = await db
      .prepare('SELECT name FROM suppliers WHERE id = ?')
      .bind(key.supplierId)
      .first<{ name: string }>();
    const supplierName = supplierRow?.name ?? null;

    if (supplierName) {
      const specific = await db
        .prepare(
          `SELECT input_text, corrected_output FROM extraction_examples
           WHERE document_type_id = ? AND tenant_id = ? AND supplier = ? AND score >= ?
           ORDER BY score DESC, created_at DESC LIMIT ?`,
        )
        .bind(key.documentTypeId, key.tenantId, supplierName, MIN_EXAMPLE_SCORE, MAX_EXAMPLES)
        .all<ProfileExample>();
      profile.examples = specific.results || [];
    }

    if (profile.examples.length < MAX_EXAMPLES) {
      const remaining = MAX_EXAMPLES - profile.examples.length;
      const general = await db
        .prepare(
          `SELECT input_text, corrected_output FROM extraction_examples
           WHERE document_type_id = ? AND tenant_id = ? AND (supplier IS NULL OR supplier != ?) AND score >= ?
           ORDER BY score DESC, created_at DESC LIMIT ?`,
        )
        .bind(key.documentTypeId, key.tenantId, supplierName || '', MIN_EXAMPLE_SCORE, remaining)
        .all<ProfileExample>();
      profile.examples = [...profile.examples, ...(general.results || [])];
    }
  }

  return profile;
}

function parseMappings(raw: string | null): unknown | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === '{}') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
