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
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
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

    if (!supplierId) {
      throw new BadRequestError('supplier_id is required');
    }
    if (!documentTypeId) {
      throw new BadRequestError('document_type_id is required');
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

    const row = await context.env.DB.prepare(
      `SELECT instructions, updated_at, updated_by
       FROM supplier_extraction_instructions
       WHERE tenant_id = ? AND supplier_id = ? AND document_type_id = ?`
    )
      .bind(tenantId, supplierId, documentTypeId)
      .first<{ instructions: string; updated_at: string; updated_by: string | null }>();

    if (!row) {
      return new Response(
        JSON.stringify({ instructions: null, updated_at: null, updated_by: null }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        instructions: row.instructions,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
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
    const newId = generateId();
    await context.env.DB.prepare(
      `INSERT INTO supplier_extraction_instructions
         (id, supplier_id, document_type_id, tenant_id, instructions, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(supplier_id, document_type_id) DO UPDATE SET
         instructions = excluded.instructions,
         updated_by   = excluded.updated_by,
         updated_at   = datetime('now')`
    )
      .bind(newId, body.supplier_id, body.document_type_id, tenantId, instructions, user.id)
      .run();

    const saved = await context.env.DB.prepare(
      `SELECT id, supplier_id, document_type_id, tenant_id, instructions,
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
