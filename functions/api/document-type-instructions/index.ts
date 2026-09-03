/**
 * Per-document-type natural-language extraction instructions — the MIDDLE
 * layer of the prompt stack (migration 0098).
 *
 * "Here is how to read a Certificate of Insurance" written ONCE, applying to
 * every supplier that sends one. The (supplier, document_type) endpoint next
 * door (`/api/extraction-instructions`) stays what it always was: the narrower
 * layer that REFINES this one. Neither replaces the other — see
 * functions/lib/extractionInstructionStack.ts for the composition rule.
 *
 * Auth mirrors /api/extraction-instructions exactly (super_admin, org_admin,
 * user): the people who review queue items are the people who write guidance,
 * and a type-level row is the same kind of object as a supplier-level one.
 */

import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import type {
  DocumentTypeExtractionInstructionsGetResponse,
  DocumentTypeExtractionInstructionsListResponse,
  DocumentTypeExtractionInstructionsListRow,
  DocumentTypeInstructionsSupplierOverride,
} from '../../../shared/types';

/** Same cap as the supplier layer — one stack, one budget per block. */
const MAX_INSTRUCTIONS_LENGTH = 8000;

/**
 * Resolve the tenant the request is acting on. super_admin has no implicit
 * tenant so it must say which one; everyone else is pinned to their own and an
 * explicit mismatch is rejected. Lifted verbatim from the supplier-layer
 * endpoint so the two cannot drift on who may write what.
 */
function resolveTenantId(user: User, explicit: string | null | undefined): string {
  if (user.role === 'super_admin') {
    if (!explicit) {
      throw new BadRequestError('tenant_id is required for super_admin');
    }
    return explicit;
  }
  return user.tenant_id!;
}

/**
 * GET /api/document-type-instructions?document_type_id=X[&tenant_id=Y]
 *   → the one type's instructions, plus the suppliers that refine them.
 * GET /api/document-type-instructions[?tenant_id=Y]
 *   → one row per ACTIVE document type in the tenant, `instructions` null where
 *     nothing is authored yet. Same "server pre-joins so the UI loop stays
 *     dumb" shape as /api/extraction-instructions/by-supplier.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const documentTypeId = url.searchParams.get('document_type_id');
    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);

    if (documentTypeId) {
      const docType = await context.env.DB.prepare(
        'SELECT id, name FROM document_types WHERE id = ? AND tenant_id = ?',
      )
        .bind(documentTypeId, tenantId)
        .first<{ id: string; name: string }>();
      if (!docType) {
        throw new BadRequestError('Document type not found or does not belong to this tenant');
      }

      const row = await context.env.DB.prepare(
        `SELECT instructions, updated_at, updated_by
           FROM document_type_extraction_instructions
          WHERE tenant_id = ? AND document_type_id = ?`,
      )
        .bind(tenantId, documentTypeId)
        .first<{ instructions: string; updated_at: string; updated_by: string | null }>();

      // The suppliers that already refine this type. Returned WITH the type
      // row rather than behind a second call because the layering is the whole
      // point of this screen: an admin editing type-level guidance has to be
      // able to see, without leaving, that four suppliers have said something
      // narrower that will be read after it.
      const overrides = await context.env.DB.prepare(
        `SELECT sei.supplier_id AS supplier_id,
                s.name          AS supplier_name,
                sei.updated_at  AS updated_at
           FROM supplier_extraction_instructions sei
           JOIN suppliers s ON s.id = sei.supplier_id
          WHERE sei.tenant_id = ?
            AND sei.document_type_id = ?
            AND TRIM(COALESCE(sei.instructions, '')) <> ''
          ORDER BY s.name COLLATE NOCASE`,
      )
        .bind(tenantId, documentTypeId)
        .all<DocumentTypeInstructionsSupplierOverride>();

      const body: DocumentTypeExtractionInstructionsGetResponse = {
        tenant_id: tenantId,
        document_type_id: documentTypeId,
        document_type_name: docType.name,
        instructions: row?.instructions ?? null,
        updated_at: row?.updated_at ?? null,
        updated_by: row?.updated_by ?? null,
        supplier_overrides: overrides.results ?? [],
      };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Whole-tenant listing. LEFT JOIN so types with no guidance yet still
    // appear — "nothing written for this type" is exactly the state the admin
    // opened the page to fix, so it must be visible, not absent.
    const rows = await context.env.DB.prepare(
      `SELECT dt.id            AS document_type_id,
              dt.name          AS document_type_name,
              dtei.instructions AS instructions,
              dtei.updated_at   AS updated_at,
              dtei.updated_by   AS updated_by,
              (SELECT COUNT(*)
                 FROM supplier_extraction_instructions sei
                WHERE sei.tenant_id = dt.tenant_id
                  AND sei.document_type_id = dt.id
                  AND TRIM(COALESCE(sei.instructions, '')) <> '') AS supplier_override_count
         FROM document_types dt
         LEFT JOIN document_type_extraction_instructions dtei
           ON dtei.document_type_id = dt.id
          AND dtei.tenant_id = dt.tenant_id
        WHERE dt.tenant_id = ?
          AND dt.active = 1
        ORDER BY dt.name COLLATE NOCASE`,
    )
      .bind(tenantId)
      .all<DocumentTypeExtractionInstructionsListRow>();

    const body: DocumentTypeExtractionInstructionsListResponse = {
      tenant_id: tenantId,
      document_types: rows.results ?? [],
    };
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get document-type extraction instructions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * PUT /api/document-type-instructions
 * Body: { document_type_id, instructions, tenant_id? }
 *
 * Upsert on the plain UNIQUE(tenant_id, document_type_id) from 0098. An empty
 * string is a legal value and stores an empty row rather than deleting: the
 * autosave editor sends whatever is in the textarea, and "the admin cleared the
 * box" should not be indistinguishable from "the admin never wrote one". Use
 * DELETE to actually remove the layer.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      document_type_id?: string;
      instructions?: string;
      tenant_id?: string;
    };

    if (!body.document_type_id) {
      throw new BadRequestError('document_type_id is required');
    }
    if (typeof body.instructions !== 'string') {
      throw new BadRequestError('instructions must be a string');
    }
    const instructions = body.instructions.trim();
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new BadRequestError(
        `instructions too long (max ${MAX_INSTRUCTIONS_LENGTH} chars)`,
      );
    }

    const tenantId = resolveTenantId(user, body.tenant_id);
    requireTenantAccess(user, tenantId);

    // Fail fast on a cross-tenant doctype: writing the row anyway would produce
    // one the tenant-scoped read below (and the worker's) could never see.
    const docType = await context.env.DB.prepare(
      'SELECT id FROM document_types WHERE id = ? AND tenant_id = ?',
    )
      .bind(body.document_type_id, tenantId)
      .first();
    if (!docType) {
      throw new BadRequestError('Document type not found or does not belong to this tenant');
    }

    await context.env.DB.prepare(
      `INSERT INTO document_type_extraction_instructions
         (id, tenant_id, document_type_id, instructions, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(tenant_id, document_type_id) DO UPDATE SET
         instructions = excluded.instructions,
         updated_by   = excluded.updated_by,
         updated_at   = datetime('now')`,
    )
      .bind(generateId(), tenantId, body.document_type_id, instructions, user.id)
      .run();

    const saved = await context.env.DB.prepare(
      `SELECT id, tenant_id, document_type_id, instructions, created_at, updated_at, updated_by
         FROM document_type_extraction_instructions
        WHERE tenant_id = ? AND document_type_id = ?`,
    )
      .bind(tenantId, body.document_type_id)
      .first();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_type_extraction_instructions_upserted',
      'document_type_extraction_instructions',
      (saved?.id as string) ?? null,
      JSON.stringify({
        document_type_id: body.document_type_id,
        length: instructions.length,
      }),
      getClientIp(context.request),
    );

    return new Response(JSON.stringify({ instructions: saved }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Upsert document-type extraction instructions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

/**
 * DELETE /api/document-type-instructions?document_type_id=X[&tenant_id=Y]
 *
 * Removes the layer entirely (as opposed to PUTting ''). A hard delete is right
 * here for the same reason it is on supplier_requirements: nothing points at
 * one of these rows, it is pure configuration, and a tombstone would only be a
 * second state every read had to exclude. Restricted to admins — an ordinary
 * `user` may author a layer but should not silently remove one that every
 * supplier's extraction depends on.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const documentTypeId = url.searchParams.get('document_type_id');
    if (!documentTypeId) {
      throw new BadRequestError('document_type_id is required');
    }
    const tenantId = resolveTenantId(user, url.searchParams.get('tenant_id'));
    requireTenantAccess(user, tenantId);

    const existing = await context.env.DB.prepare(
      `SELECT id FROM document_type_extraction_instructions
        WHERE tenant_id = ? AND document_type_id = ?`,
    )
      .bind(tenantId, documentTypeId)
      .first<{ id: string }>();

    if (existing) {
      await context.env.DB.prepare(
        'DELETE FROM document_type_extraction_instructions WHERE id = ?',
      )
        .bind(existing.id)
        .run();

      await logAudit(
        context.env.DB,
        user.id,
        tenantId,
        'document_type_extraction_instructions_deleted',
        'document_type_extraction_instructions',
        existing.id,
        JSON.stringify({ document_type_id: documentTypeId }),
        getClientIp(context.request),
      );
    }

    // Idempotent: deleting guidance that is already gone is a success, not a
    // 404. The caller's intent ("this type has no type-level layer") holds.
    return new Response(JSON.stringify({ deleted: !!existing }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete document-type extraction instructions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
