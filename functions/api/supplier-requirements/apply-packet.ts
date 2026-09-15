/**
 * POST /api/supplier-requirements/apply-packet — apply one requirement packet
 * to suppliers an admin has NAMED, with a preview first.
 *
 * The setup wizard's /api/starter-packs/apply-packet takes one supplier by
 * design, and its header explains why: the live tenant's requirements are
 * uniform-and-wrong because one retroactive pass wrote the same items across
 * every supplier. This endpoint is the admin-screen counterpart and keeps the
 * part of that discipline that mattered:
 *
 *   - Every supplier is named by id. There is no "all suppliers" shape, and a
 *     call is capped (PACKET_SUPPLIER_CAP).
 *   - dry_run defaults to TRUE and returns, per supplier, what would be added,
 *     what already exists (and at which tier, by whom), and which unconfirmed
 *     seed rows would be adopted or removed. The page shows that before the
 *     apply button is enabled.
 *   - Nothing a person set and nothing the verified list derived is changed —
 *     not its tier, not its notes. Only unconfirmed (source IS NULL) rows are
 *     adopted, and only with `replace_unconfirmed` are the rest removed.
 *   - Rows land with source 'packet' and packet_slug; one
 *     `requirement_packet.apply` audit row per supplier that changed.
 *   - Idempotent: a second apply reports everything as already present.
 *
 * Body: packet, supplier_ids[], dry_run?, replace_unconfirmed?, pack?, tenant_id?
 * Role: super_admin, org_admin.
 */

import { getClientIp } from '../../lib/db';
import { requireRole, BadRequestError, errorToResponse } from '../../lib/permissions';
import { resolveWriteTenant } from '../../lib/registry-vocab';
import { applyPacketToSuppliers, resolveTenantPack } from '../../lib/requirement-derivation';
import type { Env, User } from '../../lib/types';
import type { BulkApplyPacketRequest } from '../../../shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json().catch(() => null)) as BulkApplyPacketRequest | null;
    if (!body || typeof body !== 'object') throw new BadRequestError('A JSON body is required');
    const tenantId = resolveWriteTenant(user, body.tenant_id);

    const packetSlug = String(body.packet ?? '').trim();
    if (!packetSlug) throw new BadRequestError('packet is required');
    if (!Array.isArray(body.supplier_ids)) {
      throw new BadRequestError('supplier_ids must be an array of supplier ids');
    }

    const pack = await resolveTenantPack(context.env.DB, tenantId, body.pack ?? null);
    const result = await applyPacketToSuppliers(context.env.DB, {
      tenantId,
      pack,
      packetSlug,
      supplierIds: body.supplier_ids,
      dryRun: body.dry_run !== false,
      replaceUnconfirmed: body.replace_unconfirmed === true,
      actorId: user.id,
      ip: getClientIp(context.request),
    });
    return json(result);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('bulk packet apply error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
