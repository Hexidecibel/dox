/**
 * GET /api/requirements/:id/scope-preview?scope=product
 *
 * What changing ONE requirement's scope (migration 0123) would do, before
 * anybody saves it. Read-only: the gap inputs of every supplier the
 * requirement touches are loaded ONCE and judged twice by the pure engine —
 * as they are, and as if the requirement had the proposed scope — so the
 * preview and the report can never compute "after" two different ways.
 *
 * Answers the question a person has to be able to answer before pressing
 * save: "6 suppliers go from satisfied to open; 41 product obligations are
 * created". Same role gate as editing the requirement (super_admin | org_admin).
 */

import { requireRole, requireTenantAccess, NotFoundError, errorToResponse } from '../../../lib/permissions';
import { loadGapInputs, withRequirementScope } from '../../../lib/requirement-gaps';
import { computeSupplierGap, type SupplierGapStatus } from '../../../../shared/requirementGap';
import {
  REQUIREMENT_SCOPES,
  isRequirementScope,
  normalizeRequirementScope,
} from '../../../../shared/requirementScope';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface ScopePreviewSupplier {
  supplier_id: string;
  supplier_name: string;
  status_before: SupplierGapStatus;
  status_after: SupplierGapStatus;
  /** Per-product obligations this requirement creates for the supplier (after). */
  product_obligations: number;
  /** Of those, how many are already closed by a linked confirmed document. */
  product_obligations_satisfied: number;
  /** Confirmed documents that would stop closing it because they name no product. */
  unattributed_documents: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');
    const id = context.params.id as string;
    const url = new URL(context.request.url);
    const proposed = url.searchParams.get('scope');
    if (!isRequirementScope(proposed)) {
      return json({ error: `scope must be one of: ${REQUIREMENT_SCOPES.join(', ')}` }, 400);
    }

    const requirement = await context.env.DB.prepare(
      'SELECT id, tenant_id, name, scope FROM requirements WHERE id = ?',
    )
      .bind(id)
      .first<{ id: string; tenant_id: string; name: string; scope: string | null }>();
    if (!requirement) throw new NotFoundError('Requirement not found');
    requireTenantAccess(user, requirement.tenant_id);
    const tenantId = requirement.tenant_id;
    const current = normalizeRequirementScope(requirement.scope);

    // Every supplier the requirement can reach: attached to it, holding a
    // product row for it, or with a confirmed claim that opens it.
    const supplierRows = await context.env.DB.prepare(
      `SELECT s.id, s.name FROM suppliers s
        WHERE s.tenant_id = ?
          AND s.id IN (
            SELECT supplier_id FROM supplier_requirements WHERE tenant_id = ? AND requirement_id = ?
            UNION
            SELECT supplier_id FROM product_requirements WHERE tenant_id = ? AND requirement_id = ?
            UNION
            SELECT d.supplier_id FROM document_claims dc
              JOIN documents d ON d.id = dc.document_id
              JOIN claim_type_requirements ctr ON ctr.claim_type_id = dc.claim_type_id
             WHERE d.tenant_id = ? AND ctr.requirement_id = ? AND dc.status = 'confirmed'
               AND d.status = 'active' AND d.supplier_id IS NOT NULL
          )
        ORDER BY s.name`,
    )
      .bind(tenantId, tenantId, id, tenantId, id, tenantId, id)
      .all<{ id: string; name: string }>();
    const suppliers = (supplierRows.results ?? []).map((r) => ({ id: r.id, name: r.name }));

    const inputs = await loadGapInputs(context.env.DB, tenantId, suppliers);
    const rows: ScopePreviewSupplier[] = inputs.map((input) => {
      const before = computeSupplierGap(input);
      const after = computeSupplierGap(withRequirementScope(input, id, proposed));
      const item = after.applicable.find((a) => a.requirement_id === id);
      return {
        supplier_id: input.supplier_id,
        supplier_name: input.supplier_name,
        status_before: before.status,
        status_after: after.status,
        product_obligations: item?.subjects_total ?? 0,
        product_obligations_satisfied: item?.subjects_satisfied ?? 0,
        unattributed_documents: item?.unattributed?.length ?? 0,
      };
    });

    const transitions: Record<string, number> = {};
    for (const r of rows) {
      if (r.status_before === r.status_after) continue;
      const key = `${r.status_before}->${r.status_after}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }

    return json({
      requirement: { id: requirement.id, name: requirement.name, scope: current },
      proposed_scope: proposed,
      unchanged: current === proposed,
      suppliers_considered: rows.length,
      suppliers_changing: rows.filter((r) => r.status_before !== r.status_after).length,
      transitions,
      product_obligations: rows.reduce((n, r) => n + r.product_obligations, 0),
      product_obligations_satisfied: rows.reduce((n, r) => n + r.product_obligations_satisfied, 0),
      unattributed_documents: rows.reduce((n, r) => n + r.unattributed_documents, 0),
      lot_scope_note:
        proposed === 'lot'
          ? 'Per-lot checking has not shipped yet. A per-lot requirement is judged once per supplier until it does, so nothing changes today.'
          : null,
      suppliers: rows,
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Requirement scope preview error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
