/**
 * GET /api/extraction-instructions/by-supplier?supplier_id=X[&tenant_id=Y]
 *
 * List every (document_type, instructions) pair the reviewer has authored for
 * a single supplier. Used by the Extraction Instructions tab on the Supplier
 * Detail page (R2.a) so a proactive reviewer can pre-write guidance for ALL
 * document types of that supplier in one place — without round-tripping
 * GET /api/extraction-instructions once per document_type.
 *
 * Returns one entry per document_type in the tenant, with `instructions = null`
 * for pairs that have never been authored. This shape keeps the UI's rendering
 * loop dead simple — it doesn't need to merge "all doctypes" against "instructions
 * I've already written"; the server pre-joins.
 *
 * Auth: super_admin, org_admin, user — matches the single-pair endpoint.
 */

import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

interface SupplierInstructionsRow {
  document_type_id: string;
  document_type_name: string;
  instructions: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ListBySupplierResponse {
  supplier_id: string;
  tenant_id: string;
  document_types: SupplierInstructionsRow[];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const url = new URL(context.request.url);
    const supplierId = url.searchParams.get('supplier_id');
    const tenantIdParam = url.searchParams.get('tenant_id');

    if (!supplierId) {
      throw new BadRequestError('supplier_id is required');
    }

    // Tenant resolution mirrors the single-row endpoint:
    //   - super_admin must pass ?tenant_id= explicitly (their JWT has no
    //     tenant scope, so we need the user to disambiguate).
    //   - everyone else is scoped to their own tenant; an explicit
    //     tenant_id mismatch is rejected by requireTenantAccess.
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

    // Validate supplier exists and belongs to the tenant. Fail fast so a
    // bad supplier_id doesn't silently return an empty doctype list (which
    // looks the same as "supplier has no instructions yet" to the UI).
    const supplier = await context.env.DB.prepare(
      'SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?',
    )
      .bind(supplierId, tenantId)
      .first();
    if (!supplier) {
      throw new BadRequestError('Supplier not found or does not belong to this tenant');
    }

    // Left-join doc types -> instructions so doctypes without authored
    // guidance still appear with a null `instructions`. The UI uses the
    // same row shape for both states. Filtered to active doctypes only —
    // an admin removing a doctype shouldn't keep showing it on the
    // supplier page.
    const rows = await context.env.DB.prepare(
      `SELECT
         dt.id AS document_type_id,
         dt.name AS document_type_name,
         sei.instructions AS instructions,
         sei.updated_at AS updated_at,
         sei.updated_by AS updated_by
       FROM document_types dt
       LEFT JOIN supplier_extraction_instructions sei
         ON sei.document_type_id = dt.id
        AND sei.supplier_id = ?
        AND sei.tenant_id = ?
       WHERE dt.tenant_id = ?
         AND dt.active = 1
       ORDER BY dt.name COLLATE NOCASE`,
    )
      .bind(supplierId, tenantId, tenantId)
      .all<SupplierInstructionsRow>();

    const body: ListBySupplierResponse = {
      supplier_id: supplierId,
      tenant_id: tenantId,
      document_types: rows.results ?? [],
    };

    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List extraction instructions by supplier error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
