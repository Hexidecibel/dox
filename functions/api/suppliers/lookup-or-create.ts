import { getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { findOrCreateSupplier } from '../../lib/suppliers';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/suppliers/lookup-or-create
 * Normalize the incoming name (strip Inc / LLC / Co / trailing punctuation,
 * lowercase, collapse whitespace) and match against existing suppliers'
 * names AND aliases. On match, append the raw incoming name to that
 * supplier's aliases so future lookups by that exact spelling are O(1).
 * On no-match, create a new supplier.
 *
 * Shared logic lives in functions/lib/suppliers.ts so the queue-approve
 * path uses the same matching semantics.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      name?: string;
      tenant_id?: string;
    };

    if (!body.name?.trim()) {
      throw new BadRequestError('name is required');
    }

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const name = sanitizeString(body.name.trim());

    const result = await findOrCreateSupplier(context.env.DB, tenantId, name, {
      userId: user.id,
      ip: getClientIp(context.request),
    });

    const supplier = await context.env.DB.prepare(
      'SELECT * FROM suppliers WHERE id = ?'
    )
      .bind(result.id)
      .first();

    return new Response(
      JSON.stringify({ supplier, created: result.created }),
      {
        status: result.created ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Supplier lookup-or-create error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
