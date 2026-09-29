/**
 * Shared reads/guards for `product_requirements` (migration 0123), used by
 * /api/product-requirements and /api/product-requirements/:id.
 */

import { BadRequestError } from './permissions';
import { normalizeRequirementScope } from '../../shared/requirementScope';

export const PRODUCT_REQUIREMENT_SELECT = `
  SELECT pr.*, r.name AS requirement_name, r.slug AS requirement_slug, r.scope AS requirement_scope,
         p.name AS product_name, s.name AS supplier_name
    FROM product_requirements pr
    JOIN requirements r ON r.id = pr.requirement_id
    JOIN products p ON p.id = pr.product_id
    JOIN suppliers s ON s.id = pr.supplier_id`;

/**
 * Both ends in the tenant, the requirement per-product, and the product one
 * this supplier actually ships (product_suppliers OR the legacy column).
 */
export async function assertProductRequirementTarget(
  db: D1Database,
  tenantId: string,
  supplierId: string,
  productId: string,
  requirementId: string,
): Promise<void> {
  const supplier = await db
    .prepare('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?')
    .bind(supplierId, tenantId)
    .first();
  if (!supplier) throw new BadRequestError('Invalid supplier for this tenant');

  const requirement = await db
    .prepare('SELECT id, scope, active FROM requirements WHERE id = ? AND tenant_id = ?')
    .bind(requirementId, tenantId)
    .first<{ id: string; scope: string | null; active: number }>();
  if (!requirement) throw new BadRequestError('Invalid requirement for this tenant');
  if (normalizeRequirementScope(requirement.scope) !== 'product') {
    throw new BadRequestError(
      'Only a per-product requirement can be added to or exempted from one product. Change the requirement\'s scope to "Per product" first.',
    );
  }

  const product = await db
    .prepare(
      `SELECT p.id FROM products p
        WHERE p.id = ? AND p.tenant_id = ?
          AND (p.supplier_id = ?
               OR EXISTS (SELECT 1 FROM product_suppliers ps
                           WHERE ps.product_id = p.id AND ps.supplier_id = ?))`,
    )
    .bind(productId, tenantId, supplierId, supplierId)
    .first();
  if (!product) {
    throw new BadRequestError('That product is not linked to this supplier');
  }
}
