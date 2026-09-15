/**
 * GET /api/suppliers/:id/lot-scheme — the supplier's declared lot format
 *   (migration 0110), every version, and how the lots on file read against the
 *   format in force. Read-only; any role in the tenant.
 * PUT /api/suppliers/:id/lot-scheme — declare a format (org_admin / super_admin).
 *   Body: { spec, note? }. Validated by shared/lotScheme.ts before anything is
 *   written; a new VERSION is appended (never an update), and the declaration
 *   is audited with the previous spec and the fit counts it produced. Saving the
 *   format already in force writes nothing and says so (`unchanged: true`).
 *
 * A declared format is a validator and a labelled fallback, never an authority:
 * saving one rewrites no stored lot key and no stored date. Existing keys that a
 * format would store differently are reported by bin/report-lot-key-scheme.
 */

import { getClientIp, logAudit } from '../../../lib/db';
import { NotFoundError, errorToResponse, requireRole, requireTenantAccess } from '../../../lib/permissions';
import {
  declareLotScheme,
  listLotSchemeVersions,
  loadResolvedLotScheme,
  loadSupplierLotsForFit,
  LotSchemeValidationError,
  previewLotFit,
} from '../../../lib/lot-schemes';
import type { Env, User } from '../../../lib/types';
import type { SupplierLotSchemeResponse, LotScheme } from '../../../../shared/types';

const LOT_LIMIT = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function loadSupplier(db: D1Database, user: User, supplierId: string) {
  const supplier = await db
    .prepare('SELECT id, tenant_id, name, lot_scheme FROM suppliers WHERE id = ?')
    .bind(supplierId)
    .first<{ id: string; tenant_id: string; name: string; lot_scheme: LotScheme | null }>();
  // Another tenant's supplier is indistinguishable from a missing one.
  if (!supplier || (user.role !== 'super_admin' && supplier.tenant_id !== user.tenant_id)) {
    throw new NotFoundError('Supplier not found');
  }
  return supplier;
}

async function buildResponse(
  db: D1Database,
  supplier: { id: string; tenant_id: string; name: string; lot_scheme: LotScheme | null },
): Promise<SupplierLotSchemeResponse> {
  const [resolved, versions, lotsPlusOne] = await Promise.all([
    loadResolvedLotScheme(db, supplier.tenant_id, supplier.id),
    listLotSchemeVersions(db, supplier.tenant_id, supplier.id),
    loadSupplierLotsForFit(db, supplier.tenant_id, supplier.id, LOT_LIMIT + 1),
  ]);
  const lots = lotsPlusOne.slice(0, LOT_LIMIT);
  return {
    supplier: { id: supplier.id, name: supplier.name, lot_scheme: supplier.lot_scheme },
    current: versions[0] ?? null,
    effective: { source: resolved.source, spec: resolved.spec, version: resolved.version },
    versions,
    lots,
    lots_truncated: lotsPlusOne.length > LOT_LIMIT,
    preview: previewLotFit(resolved.spec, lots),
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const supplier = await loadSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);
    return json(await buildResponse(context.env.DB, supplier));
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get supplier lot scheme error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const supplier = await loadSupplier(context.env.DB, user, context.params.id as string);
    requireTenantAccess(user, supplier.tenant_id);

    let body: { spec?: unknown; note?: unknown };
    try {
      body = (await context.request.json()) as { spec?: unknown; note?: unknown };
    } catch {
      return json({ error: 'Body must be JSON: { spec, note? }' }, 400);
    }
    if (body.spec === undefined) return json({ error: 'spec is required' }, 400);

    let declared;
    try {
      declared = await declareLotScheme(context.env.DB, {
        tenantId: supplier.tenant_id,
        supplierId: supplier.id,
        spec: body.spec,
        source: 'admin',
        note: typeof body.note === 'string' ? body.note : null,
        userId: user.id,
      });
    } catch (err) {
      if (err instanceof LotSchemeValidationError) {
        return json({ error: `This lot format cannot be saved: ${err.errors.join(' ')}`, errors: err.errors }, 400);
      }
      throw err;
    }

    const response = await buildResponse(context.env.DB, supplier);
    if (!declared.unchanged) {
      await logAudit(
        context.env.DB,
        user.id,
        supplier.tenant_id,
        'supplier.lot_scheme_declared',
        'supplier',
        supplier.id,
        JSON.stringify({
          supplier_name: supplier.name,
          version: declared.row.version,
          scheme_id: declared.row.id,
          spec: declared.row.spec,
          previous_version: declared.previous?.version ?? null,
          previous_spec: declared.previous?.spec ?? null,
          legacy_lot_scheme: supplier.lot_scheme,
          note: declared.row.note,
          fit: {
            total: response.preview.total,
            fits: response.preview.fits,
            not_fitting: response.preview.not_fitting.length,
            date_disagreements: response.preview.date_disagreements.length,
            key_differs: response.preview.key_differs,
          },
        }),
        getClientIp(context.request),
      );
    }
    return json({ ...response, unchanged: declared.unchanged });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Declare supplier lot scheme error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
