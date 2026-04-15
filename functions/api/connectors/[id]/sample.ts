/**
 * GET /api/connectors/:id/sample
 *
 * Rehydrates the stored sample for a connector. Fetches the bytes at the
 * connector's sample_r2_key, re-runs the format-appropriate schema discovery,
 * and returns the same shape as POST /api/connectors/discover-schema so the
 * wizard's "Re-test" button can land users back on the Review step with a
 * live preview primed from the saved sample.
 *
 * Never writes to D1. Honors tenant access controls.
 */

import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import {
  discoverFromCSV,
  discoverFromXLSX,
  discoverFromPDF,
  discoverFromEmail,
  buildFieldMappingsFromDetection,
  type DiscoveryResult,
} from '../../../lib/connectors/schemaDiscovery';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await context.env.DB.prepare(
      'SELECT id, tenant_id, sample_r2_key FROM connectors WHERE id = ?'
    )
      .bind(connectorId)
      .first<{ id: string; tenant_id: string; sample_r2_key: string | null }>();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }
    requireTenantAccess(user, connector.tenant_id);

    if (!connector.sample_r2_key) {
      return new Response(
        JSON.stringify({ error: 'No stored sample for this connector. Upload a new sample to re-test.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!context.env.FILES) {
      return new Response(
        JSON.stringify({ error: 'R2 (FILES) binding not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const object = await context.env.FILES.get(connector.sample_r2_key);
    if (!object) {
      return new Response(
        JSON.stringify({ error: 'Stored sample not found in R2 (may have expired)' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const buffer = await object.arrayBuffer();
    const sourceType = (object.customMetadata?.source_type || 'csv') as
      | 'csv' | 'xlsx' | 'pdf' | 'eml' | 'text';
    const originalName = object.customMetadata?.original_name || `sample.${sourceType}`;

    const qwenConfig = {
      url: context.env.QWEN_URL,
      secret: context.env.QWEN_SECRET,
    };

    let result: DiscoveryResult;
    switch (sourceType) {
      case 'csv':
      case 'text': {
        result = discoverFromCSV(new TextDecoder().decode(buffer));
        break;
      }
      case 'xlsx': {
        result = await discoverFromXLSX(buffer);
        break;
      }
      case 'pdf': {
        result = await discoverFromPDF(buffer, qwenConfig);
        break;
      }
      case 'eml': {
        result = await discoverFromEmail(new TextDecoder().decode(buffer), qwenConfig);
        break;
      }
      default:
        return new Response(
          JSON.stringify({ error: `Unsupported source_type: ${sourceType}` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const suggestedMappings = buildFieldMappingsFromDetection(result);

    return new Response(
      JSON.stringify({
        sample_id: connector.sample_r2_key,
        source_type: sourceType,
        file_name: originalName,
        size: buffer.byteLength,
        expires_at: Number(object.customMetadata?.expires_at || 0),
        detected_fields: result.detected_fields,
        sample_rows: result.sample_rows,
        layout_hint: result.layout_hint,
        warnings: result.warnings,
        suggested_mappings: suggestedMappings,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Rehydrate sample error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
