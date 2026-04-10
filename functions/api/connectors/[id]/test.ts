import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

const REQUIRED_CONFIG_FIELDS: Record<string, string[]> = {
  email: ['subject_patterns'],
  api_poll: ['endpoint_url'],
  webhook: [],
  file_watch: ['r2_prefix'],
};

/**
 * POST /api/connectors/:id/test
 * Validate connector configuration.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await context.env.DB.prepare(
      'SELECT * FROM connectors WHERE id = ?'
    )
      .bind(connectorId)
      .first();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id as string);

    // Validate config is parseable JSON
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(connector.config as string || '{}');
    } catch {
      throw new BadRequestError('Connector config is not valid JSON');
    }

    // Validate required fields per connector type
    const connectorType = connector.connector_type as string;
    const requiredFields = REQUIRED_CONFIG_FIELDS[connectorType] || [];
    const missingFields = requiredFields.filter(
      (field) => config[field] === undefined || config[field] === null || config[field] === ''
    );

    if (missingFields.length > 0) {
      throw new BadRequestError(
        `Missing required config fields for ${connectorType}: ${missingFields.join(', ')}`
      );
    }

    // Validate field_mappings is parseable
    try {
      JSON.parse(connector.field_mappings as string || '{}');
    } catch {
      throw new BadRequestError('Connector field_mappings is not valid JSON');
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Connector configuration is valid',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Test connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
