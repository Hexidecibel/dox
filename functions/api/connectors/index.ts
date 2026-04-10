import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { encryptCredentials } from '../../lib/connectors/crypto';
import type { Env, User } from '../../lib/types';

const VALID_CONNECTOR_TYPES = ['email', 'api_poll', 'webhook', 'file_watch'];
const VALID_SYSTEM_TYPES = ['erp', 'wms', 'other'];

function transformConnector(row: Record<string, unknown>): Record<string, unknown> {
  const { credentials_encrypted, credentials_iv, ...rest } = row;
  return {
    ...rest,
    has_credentials: !!(credentials_encrypted && credentials_iv),
  };
}

/**
 * GET /api/connectors
 * List connectors for a tenant.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    let tenantId = url.searchParams.get('tenant_id');
    const connectorType = url.searchParams.get('connector_type');
    const systemType = url.searchParams.get('system_type');
    const active = url.searchParams.get('active');
    const search = url.searchParams.get('search');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const conditions: string[] = ['c.tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (active !== null && active !== undefined && active !== '') {
      conditions.push('c.active = ?');
      params.push(parseInt(active, 10));
    } else {
      conditions.push('c.active = 1');
    }

    if (connectorType) {
      conditions.push('c.connector_type = ?');
      params.push(connectorType);
    }

    if (systemType) {
      conditions.push('c.system_type = ?');
      params.push(systemType);
    }

    if (search) {
      conditions.push('c.name LIKE ?');
      params.push(`%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await context.env.DB.prepare(
      `SELECT COUNT(*) as total FROM connectors c ${whereClause}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const results = await context.env.DB.prepare(
      `SELECT c.*, u.name as created_by_name, t.name as tenant_name
       FROM connectors c
       LEFT JOIN users u ON c.created_by = u.id
       LEFT JOIN tenants t ON c.tenant_id = t.id
       ${whereClause}
       ORDER BY c.name ASC LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all();

    const connectors = (results.results || []).map(transformConnector);

    return new Response(
      JSON.stringify({
        connectors,
        total: countResult?.total || 0,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List connectors error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/connectors
 * Create a new connector.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      connector_type?: string;
      system_type?: string;
      config?: Record<string, unknown>;
      field_mappings?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
    };

    if (!body.name?.trim()) {
      throw new BadRequestError('name is required');
    }

    if (!body.connector_type) {
      throw new BadRequestError('connector_type is required');
    }

    if (!VALID_CONNECTOR_TYPES.includes(body.connector_type)) {
      throw new BadRequestError(
        `connector_type must be one of: ${VALID_CONNECTOR_TYPES.join(', ')}`
      );
    }

    if (body.system_type && !VALID_SYSTEM_TYPES.includes(body.system_type)) {
      throw new BadRequestError(
        `system_type must be one of: ${VALID_SYSTEM_TYPES.join(', ')}`
      );
    }

    let tenantId = body.tenant_id || null;
    if (user.role !== 'super_admin') {
      tenantId = user.tenant_id;
    }

    if (!tenantId) {
      throw new BadRequestError('tenant_id is required');
    }

    requireTenantAccess(user, tenantId);

    const id = generateId();
    const name = sanitizeString(body.name.trim());
    const connectorType = body.connector_type;
    const systemType = body.system_type || 'other';
    const config = body.config ? JSON.stringify(body.config) : '{}';
    const fieldMappings = body.field_mappings ? JSON.stringify(body.field_mappings) : '{}';
    const schedule = body.schedule ? sanitizeString(body.schedule) : null;

    let credentialsEncrypted: string | null = null;
    let credentialsIv: string | null = null;

    if (body.credentials && context.env.CONNECTOR_ENCRYPTION_KEY) {
      const { encrypted, iv } = await encryptCredentials(
        body.credentials,
        context.env.CONNECTOR_ENCRYPTION_KEY,
        tenantId,
        id
      );
      credentialsEncrypted = encrypted;
      credentialsIv = iv;
    }

    await context.env.DB.prepare(
      `INSERT INTO connectors (
        id, tenant_id, name, connector_type, system_type,
        config, field_mappings, credentials_encrypted, credentials_iv,
        schedule, active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`
    )
      .bind(
        id, tenantId, name, connectorType, systemType,
        config, fieldMappings, credentialsEncrypted, credentialsIv,
        schedule, user.id
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'connector.created',
      'connector',
      id,
      JSON.stringify({ name, connector_type: connectorType, system_type: systemType }),
      getClientIp(context.request)
    );

    const connector = await context.env.DB.prepare(
      `SELECT c.*, u.name as created_by_name, t.name as tenant_name
       FROM connectors c
       LEFT JOIN users u ON c.created_by = u.id
       LEFT JOIN tenants t ON c.tenant_id = t.id
       WHERE c.id = ?`
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ connector: connector ? transformConnector(connector) : null }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Create connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
