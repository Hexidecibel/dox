/**
 * GET /api/learned-preferences?supplier_id=X&document_type_id=Y[&tenant_id=Z]
 *
 * Read-only endpoint for the worker / UI. Aggregates the Phase 2 capture
 * tables into the LearnedPreferences shape (per-field source preferences
 * with confidence, dismissed-by-default fields, learned table filters).
 * Both supplier_id and document_type_id are required — preferences only
 * make sense scoped to a (supplier, doctype) pair. Returns the preferences
 * with empty fields/dismissed_fields/table_filters when no signal exists.
 */

import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { getLearnedPreferences } from '../../lib/learnedPreferences';
import type { Env, User } from '../../lib/types';

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

    const tenantId =
      user.role === 'super_admin' && tenantIdParam ? tenantIdParam : user.tenant_id;
    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }
    requireTenantAccess(user, tenantId);

    const prefs = await getLearnedPreferences(
      context.env.DB,
      tenantId,
      supplierId,
      documentTypeId
    );

    return new Response(JSON.stringify(prefs), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get learned preferences error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
