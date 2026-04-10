import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/connectors/:id/runs
 * List run history for a connector.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorId = context.params.id as string;
    const url = new URL(context.request.url);

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Verify the connector exists and user has access
    const connector = await context.env.DB.prepare(
      'SELECT * FROM connectors WHERE id = ?'
    )
      .bind(connectorId)
      .first();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }

    if (user.role !== 'super_admin' && connector.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id as string);

    const countResult = await context.env.DB.prepare(
      'SELECT COUNT(*) as total FROM connector_runs WHERE connector_id = ?'
    )
      .bind(connectorId)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT * FROM connector_runs
       WHERE connector_id = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(connectorId, limit, offset)
      .all();

    return new Response(
      JSON.stringify({
        runs: results.results || [],
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List connector runs error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
