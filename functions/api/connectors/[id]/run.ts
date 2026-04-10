import { generateId } from '../../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * POST /api/connectors/:id/run
 * Trigger a manual connector run.
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

    if (!connector.active) {
      throw new BadRequestError('Cannot run an inactive connector');
    }

    const connectorType = connector.connector_type as string;

    if (connectorType === 'email') {
      throw new BadRequestError(
        'Email connectors are triggered by incoming emails, not manual runs'
      );
    }

    // For non-email types: not yet implemented
    const runId = generateId();

    return new Response(
      JSON.stringify({
        run: {
          id: runId,
          connector_id: connectorId,
          status: 'not_implemented',
          message: `Manual runs for ${connectorType} connectors are not yet implemented`,
        },
      }),
      { status: 501, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Run connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
