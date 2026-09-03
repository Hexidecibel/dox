/**
 * Per-supplier + document-type natural-language extraction instructions.
 *
 * Reviewers type plain-English guidance once (e.g. "COAG values go in column A,
 * not column B") and it gets injected into the Qwen prompt on every future
 * extraction of that (supplier, document_type) pair. This is complementary to
 * the silent few-shot correction loop (extraction_examples) — it exists
 * specifically so reviewers have an explicit "teach the model" surface.
 *
 * See migration 0035_supplier_extraction_instructions.sql for the schema.
 *
 * SINCE 0098 this endpoint also SERVES the layer above it. `instructions` is
 * still exactly the supplier row and nothing else — the editing UI PUTs that
 * value straight back, so folding anything into it would let a broader layer's
 * text be saved into a narrower row on the next blur. The composed stack is a
 * separate field, `effective_instructions`, and that is what the worker sends
 * to the model.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  composeInstructions,
  loadTypeInstructions,
} from '../../lib/extractionInstructionStack';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/** Hard cap on instruction length so a runaway textarea can't blow up the
 *  Qwen prompt. Generous enough for multi-paragraph reviewer guidance. */
const MAX_INSTRUCTIONS_LENGTH = 8000;

/** Hard cap on serialized field_mappings JSON (defense against runaway blobs). */
const MAX_FIELD_MAPPINGS_LENGTH = 32000;

/** Parse the stored field_mappings JSON column to an object, or null. */
function parseFieldMappings(raw: string | null): unknown | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === '{}') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * GET /api/extraction-instructions?supplier_id=X&document_type_id=Y[&tenant_id=Z]
 * Look up the instructions row for a (supplier, document_type) pair.
 * Returns `{ instructions: null, updated_at: null, updated_by: null }` when no
 * row exists yet (this is the normal case for unseen pairs, not an error).
 * Auth: super_admin, org_admin, user — matches who can review queue items.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const documentTypeId = url.searchParams.get('document_type_id');
    const tenantIdParam = url.searchParams.get('tenant_id');

    // supplier_id used to be unconditionally required. Since 0098 it is not:
    // a document_type_id ALONE is a legitimate question ("what do we know
    // about reading this kind of document, from anybody"), and it is the exact
    // question the worker has to ask when a document arrives from a supplier it
    // cannot resolve — which is the case this whole layer exists for. One of
    // the two is still required; neither is a lookup with no key.
    if (!supplierId && !documentTypeId) {
      throw new BadRequestError('supplier_id or document_type_id is required');
    }

    // Tenant resolution: super_admin may pass ?tenant_id= to query any tenant;
    // all other roles are scoped to their own tenant.
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!tenantIdParam) {
        throw new BadRequestError('tenant_id is required for super_admin');
      }
      tenantId = tenantIdParam;
    } else {
      tenantId = user.tenant_id!;
    }
    requireTenantAccess(user, tenantId);

    // Exact (supplier, document_type) match — used by the reviewer editing UI
    // (which always knows the doctype) and by the worker when the queue item's
    // doctype is already resolved. No supplier-wide fallback here: that would
    // mis-fill the editing textarea with another doctype's guidance.
    if (documentTypeId) {
      // Layer 2 (0098) — resolved whether or not a supplier is known. When the
      // supplier is unknown this is the ONLY guidance there is, and returning
      // it is the point of the layer.
      const typeInstructions = await loadTypeInstructions(
        context.env.DB,
        tenantId,
        documentTypeId
      );

      const row = supplierId
        ? await context.env.DB.prepare(
            `SELECT instructions, field_mappings, updated_at, updated_by
         FROM supplier_extraction_instructions
         WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?`
          )
            .bind(tenantId, supplierId, documentTypeId)
            .first<{ instructions: string; field_mappings: string | null; updated_at: string; updated_by: string | null }>()
        : null;

      return new Response(
        JSON.stringify({
          // The supplier row, verbatim. The editor round-trips this.
          instructions: row ? row.instructions : null,
          field_mappings: row ? parseFieldMappings(row.field_mappings) : null,
          updated_at: row ? row.updated_at : null,
          updated_by: row ? row.updated_by : null,
          // The layer above, broken out so a UI can label it as inherited.
          document_type_instructions: typeInstructions || null,
          // What the model should actually be told: general -> specific.
          effective_instructions:
            composeInstructions(typeInstructions, row?.instructions ?? '') || null,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // No doctype supplied: the queue worker hasn't resolved the document type
    // yet (it's promoted only AFTER extraction). Return the supplier's guidance
    // aggregated across all doctypes so instructions still reach the prompt.
    // When several doctypes have guidance, label each so the model has context.
    const agg = await context.env.DB.prepare(
      `SELECT sei.instructions AS instructions,
              sei.updated_at  AS updated_at,
              sei.updated_by  AS updated_by,
              dt.name         AS doctype_name
       FROM supplier_extraction_instructions sei
       LEFT JOIN document_types dt ON dt.id = sei.document_type_id
       WHERE sei.tenant_id = ? AND sei.supplier_id = ?
       ORDER BY sei.updated_at DESC`
    )
      .bind(tenantId, supplierId)
      .all<{ instructions: string; updated_at: string; updated_by: string | null; doctype_name: string | null }>();

    const list = agg.results || [];
    if (list.length === 0) {
      return new Response(
        JSON.stringify({
          instructions: null,
          updated_at: null,
          updated_by: null,
          // No document type in the question, so no type layer can be resolved.
          // Deliberately NOT "every type layer this tenant has": that would send
          // 27 types' worth of guidance for one document.
          document_type_instructions: null,
          effective_instructions: null,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const instructions =
      list.length === 1
        ? list[0].instructions
        : list
            .map((r) => `[For ${r.doctype_name || 'document type'}]\n${r.instructions}`)
            .join('\n\n');

    return new Response(
      JSON.stringify({
        instructions,
        updated_at: list[0].updated_at,
        updated_by: list[0].updated_by,
        document_type_instructions: null,
        effective_instructions: instructions,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get extraction instructions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/extraction-instructions
 * Upsert instructions for a (supplier, document_type) pair.
 * Body: { supplier_id, document_type_id, instructions, tenant_id? }
 * Auth: super_admin, org_admin, user — matches who can review queue items.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      supplier_id?: string;
      document_type_id?: string;
      instructions?: string;
      field_mappings?: unknown;
      tenant_id?: string;
    };

    if (!body.supplier_id) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!body.document_type_id) {
      throw new BadRequestError('document_type_id is required');
    }
    if (typeof body.instructions !== 'string') {
      throw new BadRequestError('instructions must be a string');
    }
    const instructions = body.instructions.trim();
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new BadRequestError(
        `instructions too long (max ${MAX_INSTRUCTIONS_LENGTH} chars)`
      );
    }

    // field_mappings is optional. When provided it must be a JSON object (or
    // null to clear). `undefined` means "don't touch the existing mappings".
    let fieldMappingsJson: string | null | undefined;
    if (body.field_mappings === undefined) {
      fieldMappingsJson = undefined;
    } else if (body.field_mappings === null) {
      fieldMappingsJson = null;
    } else if (typeof body.field_mappings === 'object') {
      fieldMappingsJson = JSON.stringify(body.field_mappings);
      if (fieldMappingsJson.length > MAX_FIELD_MAPPINGS_LENGTH) {
        throw new BadRequestError(
          `field_mappings too large (max ${MAX_FIELD_MAPPINGS_LENGTH} chars)`
        );
      }
    } else {
      throw new BadRequestError('field_mappings must be an object or null');
    }

    // Tenant resolution (mirrors GET).
    let tenantId: string;
    if (user.role === 'super_admin') {
      if (!body.tenant_id) {
        throw new BadRequestError('tenant_id is required for super_admin');
      }
      tenantId = body.tenant_id;
    } else {
      tenantId = user.tenant_id!;
    }
    requireTenantAccess(user, tenantId);

    // Validate supplier + doc type belong to the tenant (fail fast — avoids
    // writing a row that the GET/worker lookup would later ignore due to the
    // tenant scope filter).
    const supplier = await context.env.DB.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.supplier_id, tenantId)
      .first();
    if (!supplier) {
      throw new BadRequestError('Supplier not found or does not belong to this tenant');
    }

    const docType = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?'
    )
      .bind(body.document_type_id, tenantId)
      .first();
    if (!docType) {
      throw new BadRequestError('Document type not found or does not belong to this tenant');
    }

    // Upsert. SQLite UPSERT via ON CONFLICT on the UNIQUE(supplier_id,
    // document_type_id) constraint — keeps the original id + created_at
    // while bumping instructions/updated_at/updated_by.
    // On a fresh insert, store the provided mappings (NULL when not given).
    // On conflict: if field_mappings was provided (object or explicit null),
    // overwrite; if it was omitted (undefined), preserve the existing value via
    // COALESCE — passing a sentinel marker through `excluded` isn't possible, so
    // we branch the UPDATE clause on whether mappings were supplied.
    const insertMappings = fieldMappingsJson === undefined ? null : fieldMappingsJson;
    const updateMappingsClause =
      fieldMappingsJson === undefined
        ? 'field_mappings = supplier_extraction_instructions.field_mappings'
        : 'field_mappings = excluded.field_mappings';

    const newId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, field_mappings, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(supplier_id, document_type_id) DO UPDATE SET
         instructions = excluded.instructions,
         ${updateMappingsClause},
         updated_by   = excluded.updated_by,
         updated_at   = datetime('now')`
    )
      .bind(newId, body.supplier_id, body.document_type_id, tenantId, instructions, insertMappings, user.id)
      .run();

    const saved = await context.env.DB.prepare(
      `SELECT id, supplier_id, document_type_id, tenant_id, instructions, field_mappings,
              created_at, updated_at, updated_by
       FROM supplier_extraction_instructions
       WHERE supplier_id = ? AND document_type_id = ?`
    )
      .bind(body.supplier_id, body.document_type_id)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'supplier_extraction_instructions_upserted',
      'supplier_extraction_instructions',
      saved?.id as string | null,
      JSON.stringify({
        supplier_id: body.supplier_id,
        document_type_id: body.document_type_id,
        length: instructions.length,
        field_mappings_updated: fieldMappingsJson !== undefined,
      }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ instructions: saved }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Upsert extraction instructions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
