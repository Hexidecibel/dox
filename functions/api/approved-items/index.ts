/**
 * GET /api/approved-items -- the approved item list (migration 0135, decision
 * C-001): ONE ROW PER ITEM-AND-SUPPLIER PAIR, with the item, our SKU, the
 * supplier, the facility, the approval, whether it is currently supplied, the
 * brand owner and producer, and `private_label`.
 *
 *   ?supplier_id=   one supplier
 *   ?product_id=    one item (every supplier it comes from)
 *   ?facility_id=   one facility
 *   ?approval=      approved | pending | not_approved
 *   ?supplied=      1 = currently supplied, 0 = no longer supplied
 *   ?q=             item, supplier, brand owner, producer, facility, or any
 *                   identifier of the item
 *   ?limit= ?offset=
 *   ?tenant_id=     super_admin only (required for them)
 *
 * Read by any role in the organisation: it is the answer to "may we buy this
 * from them", which sales and receiving ask as often as QA does. Changing an
 * approval is PUT /api/suppliers/:id/products/:productId (org_admin).
 *
 * APPROVAL IS NOT "SUPPLIED". An approved item can be no longer supplied and a
 * supplied item can be pending; both are returned and neither hides the other.
 * `private_label` is a display flag -- nothing here blocks anything, and no
 * gap, renewal or search answer reads this list.
 */

import { BadRequestError, errorToResponse, requireTenantAccess } from '../../lib/permissions';
import { listApprovedItems } from '../../lib/item-approval';
import { isItemApprovalStatus } from '../../../shared/itemApproval';
import type { Env, User } from '../../lib/types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const tenantId = user.role === 'super_admin' ? url.searchParams.get('tenant_id') : user.tenant_id;
    if (!tenantId) throw new BadRequestError('tenant_id is required');
    requireTenantAccess(user, tenantId);

    const approval = url.searchParams.get('approval');
    if (approval && !isItemApprovalStatus(approval)) {
      throw new BadRequestError('approval must be approved, pending or not_approved');
    }
    const suppliedRaw = url.searchParams.get('supplied');
    if (suppliedRaw !== null && suppliedRaw !== '' && suppliedRaw !== '0' && suppliedRaw !== '1') {
      throw new BadRequestError('supplied must be 1 or 0');
    }

    return json(
      await listApprovedItems(context.env.DB, tenantId, {
        supplierId: url.searchParams.get('supplier_id'),
        productId: url.searchParams.get('product_id'),
        facilityId: url.searchParams.get('facility_id'),
        approval: approval && isItemApprovalStatus(approval) ? approval : null,
        supplied: suppliedRaw === '1' ? true : suppliedRaw === '0' ? false : null,
        text: url.searchParams.get('q'),
        limit: parseInt(url.searchParams.get('limit') || '100', 10),
        offset: parseInt(url.searchParams.get('offset') || '0', 10),
      }),
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List approved items error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
