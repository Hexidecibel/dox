import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { encryptCredentials } from '../../lib/connectors/crypto';
import type { Env, User } from '../../lib/types';
import { normalizeFieldMappings, validateFieldMappings } from '../../../shared/fieldMappings';
import { validateEmailConfig } from './[id]/test';

/**
 * Transform a DB row into the API-facing shape. Parses field_mappings JSON
 * through normalizeFieldMappings so legacy v1 configs load transparently.
 * We do NOT rewrite the DB on GET — the upgrade is only persisted on the
 * next successful PUT.
 */
function transformConnector(row: Record<string, unknown>): Record<string, unknown> {
  const {
    credentials_encrypted,
    credentials_iv,
    field_mappings,
    // Phase B3: never echo the encrypted R2 vendor secret. See the
    // matching strip in functions/api/connectors/index.ts for rationale.
    r2_secret_access_key_encrypted,
    ...rest
  } = row;
  let parsedMappings: unknown = field_mappings;
  if (typeof field_mappings === 'string') {
    try {
      parsedMappings = JSON.parse(field_mappings);
    } catch {
      parsedMappings = {};
    }
  }
  return {
    ...rest,
    field_mappings: normalizeFieldMappings(parsedMappings),
    has_credentials: !!(credentials_encrypted && credentials_iv),
    has_r2_secret: !!r2_secret_access_key_encrypted,
  };
}

/**
 * GET /api/connectors/:id
 * Get a single connector by ID.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const connectorId = context.params.id as string;

    const connector = await context.env.DB.prepare(
      `SELECT c.*, u.name as created_by_name
       FROM connectors c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`
    )
      .bind(connectorId)
      .first();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }

    if (user.role !== 'super_admin' && connector.tenant_id !== user.tenant_id) {
      throw new NotFoundError('Connector not found');
    }

    const transformed = transformConnector(connector);
    // Phase B3: include the R2 S3-compat endpoint in the GET response
    // when an account id is configured. The UI's S3-drop card needs
    // it to render the vendor instructions, and exposing it here
    // keeps the frontend from needing a separate /api/config call.
    if (context.env.CLOUDFLARE_ACCOUNT_ID) {
      transformed.r2_endpoint = `https://${context.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    }
    return new Response(
      JSON.stringify({ connector: transformed }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Get connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * PUT /api/connectors/:id
 * Update a connector.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
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

    const body = (await context.request.json()) as {
      name?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string | null;
      active?: number | boolean;
      sample_r2_key?: string | null;
    };

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name);
      if (!name) {
        throw new BadRequestError('name cannot be empty');
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.config !== undefined) {
      updates.push('config = ?');
      params.push(JSON.stringify(body.config));
    }

    // Phase B0 universal model: connectors no longer have a per-row type,
    // so email-scoping validation runs only when the caller is actually
    // touching the email-scoping fields. We treat the row as having opted
    // into email scoping if the EFFECTIVE config (after applying this PATCH)
    // carries a `subject_patterns` array OR a `sender_filter` string. If
    // the user wipes both to empty, that's the same incoherent state we
    // rejected pre-B0 — keep the gate.
    if (body.config !== undefined) {
      const effectiveConfig = (body.config as Record<string, unknown>) || {};
      const wantsEmailScoping =
        Array.isArray(effectiveConfig.subject_patterns) ||
        typeof effectiveConfig.sender_filter === 'string';
      if (wantsEmailScoping) {
        const emailErr = validateEmailConfig(effectiveConfig);
        if (emailErr) {
          return new Response(
            JSON.stringify({ error: emailErr.error, code: emailErr.code }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
    }

    if (body.field_mappings !== undefined) {
      const normalizedMappings = normalizeFieldMappings(body.field_mappings);
      const mappingValidation = validateFieldMappings(normalizedMappings);
      if (!mappingValidation.ok) {
        throw new BadRequestError(
          `field_mappings invalid: ${mappingValidation.errors.join('; ')}`,
        );
      }
      updates.push('field_mappings = ?');
      params.push(JSON.stringify(normalizedMappings));
    }

    if (body.sample_r2_key !== undefined) {
      const key = typeof body.sample_r2_key === 'string' && body.sample_r2_key.length > 0
        ? sanitizeString(body.sample_r2_key)
        : null;
      updates.push('sample_r2_key = ?');
      params.push(key);
    }

    if (body.credentials !== undefined) {
      if (body.credentials && context.env.CONNECTOR_ENCRYPTION_KEY) {
        const { encrypted, iv } = await encryptCredentials(
          body.credentials,
          context.env.CONNECTOR_ENCRYPTION_KEY,
          connector.tenant_id as string,
          connectorId
        );
        updates.push('credentials_encrypted = ?');
        params.push(encrypted);
        updates.push('credentials_iv = ?');
        params.push(iv);
      } else {
        updates.push('credentials_encrypted = ?');
        params.push(null);
        updates.push('credentials_iv = ?');
        params.push(null);
      }
    }

    if (body.schedule !== undefined) {
      updates.push('schedule = ?');
      params.push(body.schedule ? sanitizeString(body.schedule) : null);
    }

    if (body.active !== undefined) {
      let activeVal: number;
      if (typeof body.active === 'boolean') {
        activeVal = body.active ? 1 : 0;
      } else {
        activeVal = body.active;
      }
      if (activeVal !== 0 && activeVal !== 1) {
        throw new BadRequestError('active must be 0 or 1');
      }
      updates.push('active = ?');
      params.push(activeVal);
    }

    if (updates.length === 0) {
      throw new BadRequestError('No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    params.push(connectorId);

    await context.env.DB.prepare(
      `UPDATE connectors SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id as string,
      'connector.updated',
      'connector',
      connectorId,
      JSON.stringify({ changes: Object.keys(body) }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      `SELECT c.*, u.name as created_by_name
       FROM connectors c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`
    )
      .bind(connectorId)
      .first();

    return new Response(
      JSON.stringify({ connector: updated ? transformConnector(updated) : null }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * DELETE /api/connectors/:id
 * Soft-delete a connector (set active=0).
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
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

    // Soft-delete: flip active=0 AND stamp deleted_at so the list endpoint
    // can distinguish this tombstoned row from a draft. Historical rows that
    // were deleted before migration 0037 will have deleted_at=NULL and show
    // up in the list as drafts — user can re-hit Delete to tombstone them.
    await context.env.DB.prepare(
      "UPDATE connectors SET active = 0, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    )
      .bind(connectorId)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id as string,
      'connector.deleted',
      'connector',
      connectorId,
      JSON.stringify({ name: connector.name }),
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Delete connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
