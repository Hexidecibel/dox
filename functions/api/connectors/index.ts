import { generateId, logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { encryptCredentials } from '../../lib/connectors/crypto';
import { provisionConnectorBucket } from '../../lib/connectors/provisionR2';
import { encryptIntakeSecret } from '../../lib/intakeEncryption';
import type { Env, User } from '../../lib/types';
import { normalizeFieldMappings, validateFieldMappings } from '../../../shared/fieldMappings';
import {
  isValidConnectorSlug,
  slugifyConnectorName,
} from '../../../shared/connectorSlug';
import { validateEmailConfig } from './[id]/test';

const VALID_SYSTEM_TYPES = ['erp', 'wms', 'other'];

/**
 * Generate a 32-byte random hex token for the connector's HTTP POST drop
 * door. Same shape as `openssl rand -hex 32` (64 hex chars) so the value
 * mirrors how `CONNECTOR_POLL_TOKEN` is shaped on the env side. We
 * generate at create time so every new connector exposes the API drop
 * door without an extra rotation call. Matches the rotation flow in
 * `[id]/api-token/rotate.ts`.
 */
function generateApiTokenForConnector(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Transform a DB row into the API-facing shape. Parses field_mappings JSON
 * through normalizeFieldMappings so the client always sees a fresh v2 shape
 * even if the stored row is a legacy v1 config. We do NOT rewrite the row
 * in the DB on GET — that happens on the next PUT.
 */
function transformConnector(row: Record<string, unknown>): Record<string, unknown> {
  const {
    credentials_encrypted,
    credentials_iv,
    field_mappings,
    // Phase B3: never echo the encrypted R2 vendor secret on read.
    // The plaintext is shown ONCE at provision/rotation time and then
    // stays server-side. The UI surfaces a "Rotate to view" affordance
    // since we don't keep a recoverable copy.
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
    // Sentinel flag the UI uses to render the "rotate to view" surface.
    has_r2_secret: !!r2_secret_access_key_encrypted,
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

    const conditions: string[] = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
    const params: (string | number)[] = [tenantId];

    // Filter by active only when the caller explicitly asked. The default
    // now returns BOTH active=1 and active=0 so wizard drafts surface in
    // the list (previously they were invisible until you activated them).
    // Hard-deleted rows are excluded via the deleted_at IS NULL predicate
    // added above — soft-delete now stamps that column instead of just
    // flipping active=0, so the two states are distinguishable.
    if (active !== null && active !== undefined && active !== '') {
      conditions.push('c.active = ?');
      params.push(parseInt(active, 10));
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
      slug?: string;
      system_type?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
      sample_r2_key?: string | null;
    };

    if (!body.name?.trim()) {
      throw new BadRequestError('name is required');
    }

    if (body.system_type && !VALID_SYSTEM_TYPES.includes(body.system_type)) {
      throw new BadRequestError(
        `system_type must be one of: ${VALID_SYSTEM_TYPES.join(', ')}`
      );
    }

    // If the caller has populated email-scoping config (subject patterns
    // or sender filter), validate it. Phase B0: connectors are universal,
    // so empty email-config is now FINE — it just means this connector
    // hasn't opted into the email door yet. validateEmailConfig only fires
    // when the caller asked us to scope email but did so incoherently.
    const incomingConfig = (body.config as Record<string, unknown>) || {};
    const wantsEmailScoping =
      Array.isArray(incomingConfig.subject_patterns) ||
      typeof incomingConfig.sender_filter === 'string';
    if (wantsEmailScoping) {
      const emailErr = validateEmailConfig(incomingConfig);
      if (emailErr) {
        return new Response(
          JSON.stringify({ error: emailErr.error, code: emailErr.code }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
    const systemType = body.system_type || 'other';
    const config = body.config ? JSON.stringify(body.config) : '{}';

    // ---- Slug validation + uniqueness ----
    // Phase B0.5: connectors carry a globally-unique URL-safe slug used
    // in vendor-facing addresses (email, HTTP API, S3, public link).
    // The wizard normally sends an explicit slug; if one is missing we
    // fall back to slugifying the name. Either way we validate the
    // shape and check the unique index. On collision we return 409
    // with a suggested alternative so the wizard can prompt without a
    // round-trip per char.
    const requestedSlug = (typeof body.slug === 'string' && body.slug.trim().length > 0)
      ? body.slug.trim().toLowerCase()
      : slugifyConnectorName(body.name);

    if (!requestedSlug || !isValidConnectorSlug(requestedSlug)) {
      throw new BadRequestError(
        'slug is required and must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/',
      );
    }

    const existingSlug = await context.env.DB.prepare(
      `SELECT id FROM connectors WHERE slug = ?`,
    )
      .bind(requestedSlug)
      .first<{ id: string }>();

    if (existingSlug) {
      // Suggest the next available `<slug>-N` so the wizard can offer a
      // one-click fix. Probe up to 50 suffixes; in the (very unlikely)
      // case that all are taken, return the base + a random 4-char hex
      // suffix as a last-resort suggestion.
      let suggested = '';
      for (let i = 2; i <= 50; i++) {
        const candidate = `${requestedSlug}-${i}`.slice(0, 64);
        const taken = await context.env.DB.prepare(
          `SELECT id FROM connectors WHERE slug = ?`,
        )
          .bind(candidate)
          .first<{ id: string }>();
        if (!taken) {
          suggested = candidate;
          break;
        }
      }
      if (!suggested) {
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        suggested = `${requestedSlug}-${rand}`.slice(0, 64);
      }
      return new Response(
        JSON.stringify({ error: 'slug_taken', suggested }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Normalize + validate the open-ended field-mapping config. Legacy v1
    // shapes are transparently upgraded; invalid shapes produce a structured
    // 400 with a list of errors the wizard can surface inline.
    const normalizedMappings = normalizeFieldMappings(body.field_mappings);
    const mappingValidation = validateFieldMappings(normalizedMappings);
    if (!mappingValidation.ok) {
      throw new BadRequestError(
        `field_mappings invalid: ${mappingValidation.errors.join('; ')}`,
      );
    }
    const fieldMappings = JSON.stringify(normalizedMappings);
    const schedule = body.schedule ? sanitizeString(body.schedule) : null;
    const sampleR2Key = typeof body.sample_r2_key === 'string' && body.sample_r2_key.length > 0
      ? sanitizeString(body.sample_r2_key)
      : null;

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

    // Auto-generate the HTTP-POST drop bearer token at create time so the
    // API drop door is usable from day one — vendors don't need to ask
    // for a rotation before their first call. Matches the shape of
    // `openssl rand -hex 32` (64 lowercase hex chars). The owner can
    // rotate later via POST /api/connectors/:id/api-token/rotate.
    const apiToken = generateApiTokenForConnector();

    await context.env.DB.prepare(
      `INSERT INTO connectors (
        id, tenant_id, name, slug, system_type,
        config, field_mappings, credentials_encrypted, credentials_iv,
        schedule, sample_r2_key, active, api_token,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(
        id, tenantId, name, requestedSlug, systemType,
        config, fieldMappings, credentialsEncrypted, credentialsIv,
        schedule, sampleR2Key, apiToken, user.id
      )
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'connector.created',
      'connector',
      id,
      JSON.stringify({ name, slug: requestedSlug, system_type: systemType }),
      getClientIp(context.request)
    );

    // Phase B3: best-effort R2 bucket provisioning on create. Failure
    // is NON-fatal — the row already exists, columns stay NULL, and the
    // ConnectorDetail "Set up S3 drop" affordance lets the owner retry.
    // Skip silently if the CF env vars aren't configured (local dev).
    if (
      context.env.CLOUDFLARE_ACCOUNT_ID &&
      context.env.CLOUDFLARE_API_TOKEN &&
      context.env.INTAKE_ENCRYPTION_KEY
    ) {
      try {
        const creds = await provisionConnectorBucket(context.env, {
          id,
          slug: requestedSlug,
        });
        const encryptedSecret = await encryptIntakeSecret(
          creds.secret_access_key,
          context.env,
        );
        await context.env.DB.prepare(
          `UPDATE connectors
              SET r2_bucket_name = ?,
                  r2_access_key_id = ?,
                  r2_secret_access_key_encrypted = ?,
                  r2_cf_token_id = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        )
          .bind(
            creds.bucket_name,
            creds.access_key_id,
            encryptedSecret,
            creds.cf_token_id,
            id,
          )
          .run();
      } catch (provisionErr) {
        // Don't block connector creation on a CF API hiccup — surface
        // it in the logs and leave the columns NULL. The UI's "Set up
        // S3 drop" button calls POST /api/connectors/<id>/r2/provision
        // for retry.
        console.warn(
          `R2 provisioning failed for connector ${id} (${requestedSlug}): ${
            provisionErr instanceof Error ? provisionErr.message : String(provisionErr)
          }`,
        );
      }
    }

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
