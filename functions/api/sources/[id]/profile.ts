import {
  requireRole,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { normalizeFieldMappings } from '../../../../shared/fieldMappings';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/sources/:id/profile
 *
 * Returns a "source" mapping/profile for the unified intake engine to consume
 * (Phase P0 — nothing routes through this yet). A "source" is a `connectors`
 * row; this endpoint is the read surface the worker will hit to learn how to
 * route + extract a queued document.
 *
 * Auth: the worker authenticates via an API key that resolves to super_admin,
 * so super_admin may read any source. Otherwise the caller must own the
 * source's tenant. Cross-tenant / missing -> 404 (no existence leak).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sourceId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const source = await context.env.DB.prepare(
      `SELECT id, tenant_id, origin_kind, output_kind, supplier_id,
              document_type_id, extraction_instructions, field_mappings
       FROM connectors
       WHERE id = ?`
    )
      .bind(sourceId)
      .first<{
        id: string;
        tenant_id: string;
        origin_kind: string | null;
        output_kind: string | null;
        supplier_id: string | null;
        document_type_id: string | null;
        extraction_instructions: string | null;
        field_mappings: string | null;
      }>();

    if (!source) {
      throw new NotFoundError('Source not found');
    }

    // Tenant scoping: super_admin sees all; everyone else only their own tenant.
    // A cross-tenant hit is reported as 404 to avoid leaking existence.
    if (user.role !== 'super_admin' && source.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Source not found');
    }

    // Parse field_mappings JSON through the shared normalizer so legacy v1
    // configs load transparently (mirrors functions/api/connectors/[id].ts).
    let parsedMappings: unknown = {};
    if (typeof source.field_mappings === 'string') {
      try {
        parsedMappings = JSON.parse(source.field_mappings);
      } catch {
        parsedMappings = {};
      }
    }

    return new Response(
      JSON.stringify({
        id: source.id,
        tenant_id: source.tenant_id,
        origin_kind: source.origin_kind,
        output_kind: source.output_kind,
        supplier_id: source.supplier_id,
        document_type_id: source.document_type_id,
        extraction_instructions: source.extraction_instructions,
        field_mappings: normalizeFieldMappings(parsedMappings),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get source profile error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
