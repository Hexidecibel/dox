import {
  requireRole,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { normalizeFieldMappings } from '../../../../shared/fieldMappings';
import { loadExtractionProfile } from '../../../lib/extractionProfiles';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/sources/:id/profile
 *
 * Returns the unified extraction profile the worker consumes to extract a
 * queued document. As of the Connectors -> Sources refactor (migration 0068),
 * the profile (field_mappings + extraction_instructions + examples) is keyed on
 * (tenant_id, supplier_id, document_type_id) and lives in
 * `supplier_extraction_instructions` — NOT on the connector row.
 *
 * This :id route is now a thin wrapper: it resolves the source's
 * supplier_id + document_type_id (+ output_kind) from the `connectors` row,
 * then delegates to loadExtractionProfile() to read the actual profile from
 * the unified store. Connector columns (field_mappings, extraction_instructions)
 * are intentionally NOT read here — they remain in the DB for a later cleanup
 * but are no longer the source of truth.
 *
 * Response contract (kept identical to what bin/process-worker's
 * loadExtractionProfile expects):
 *   { id, tenant_id, origin_kind, output_kind, supplier_id,
 *     document_type_id, extraction_instructions, field_mappings, examples }
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
      `SELECT id, tenant_id, origin_kind, output_kind, supplier_id, document_type_id
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
      }>();

    if (!source) {
      throw new NotFoundError('Source not found');
    }

    // Tenant scoping: super_admin sees all; everyone else only their own tenant.
    // A cross-tenant hit is reported as 404 to avoid leaking existence.
    if (user.role !== 'super_admin' && source.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Source not found');
    }

    // Resolve the unified profile from supplier_extraction_instructions, keyed
    // by the source's (tenant_id, supplier_id, document_type_id). Returns empty
    // mappings/instructions when the source has no supplier/doctype or no
    // authored profile yet — extraction must always be able to proceed.
    const profile = await loadExtractionProfile(context.env.DB, {
      tenantId: source.tenant_id,
      supplierId: source.supplier_id,
      documentTypeId: source.document_type_id,
    });

    return new Response(
      JSON.stringify({
        id: source.id,
        tenant_id: source.tenant_id,
        origin_kind: source.origin_kind,
        output_kind: source.output_kind,
        supplier_id: source.supplier_id,
        document_type_id: source.document_type_id,
        extraction_instructions: profile.extraction_instructions,
        field_mappings: normalizeFieldMappings(profile.field_mappings ?? {}),
        examples: profile.examples,
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
