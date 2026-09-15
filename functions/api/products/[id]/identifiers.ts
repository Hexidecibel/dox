/**
 * GET  /api/products/:id/identifiers — what this product goes by (migration 0107).
 * POST /api/products/:id/identifiers — add one (org_admin / super_admin), audited.
 *
 * A person adding an identifier here stands behind it, so it is written
 * `confirmed = 1`, `source = 'reviewer'` unless the body says `confirmed: false`
 * (a candidate somebody wants searchable but has not verified — search then
 * labels every result reached through it "via unconfirmed …").
 */

import { getClientIp, logAudit } from '../../../lib/db';
import {
  BadRequestError,
  NotFoundError,
  errorToResponse,
  requireRole,
  requireTenantAccess,
} from '../../../lib/permissions';
import {
  IdentifierValidationError,
  insertProductIdentifier,
  listProductIdentifiers,
  validateIdentifierInput,
} from '../../../lib/product-identifiers';
import type { Env, User } from '../../../lib/types';

async function loadProduct(db: D1Database, user: User, productId: string) {
  const product = await db
    .prepare('SELECT id, tenant_id, name FROM products WHERE id = ?')
    .bind(productId)
    .first<{ id: string; tenant_id: string; name: string }>();
  if (!product || (user.role !== 'super_admin' && product.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Product not found');
  }
  return product;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const product = await loadProduct(context.env.DB, user, context.params.id as string);
    return json({ identifiers: await listProductIdentifiers(context.env.DB, product.id) });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List product identifiers error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const product = await loadProduct(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, product.tenant_id);

    const body = (await context.request.json().catch(() => ({}))) as Record<string, unknown>;
    let input;
    try {
      input = validateIdentifierInput({
        kind: body.kind as never,
        value: body.value as string,
        supplier_id: (body.supplier_id as string | null) ?? null,
        superseded: body.superseded === true,
        confirmed: body.confirmed !== false,
        source: 'reviewer',
        note: (body.note as string | null) ?? null,
      });
    } catch (e) {
      if (e instanceof IdentifierValidationError) throw new BadRequestError(e.message);
      throw e;
    }
    if (input.supplier_id) {
      const sup = await context.env.DB
        .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
        .bind(input.supplier_id, product.tenant_id)
        .first();
      if (!sup) throw new BadRequestError('supplier not found in this workspace');
    }

    const { row, created } = await insertProductIdentifier(context.env.DB, product.tenant_id, product.id, input, user.id);
    if (created) {
      await logAudit(
        context.env.DB, user.id, product.tenant_id, 'product_identifier.added', 'product', product.id,
        JSON.stringify({ identifier: row, product_name: product.name }),
        getClientIp(context.request),
      );
    }
    return json({ identifier: row, created }, created ? 201 : 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add product identifier error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
