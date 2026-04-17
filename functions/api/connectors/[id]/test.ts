import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';

/**
 * Hard requirements per connector type — config keys that MUST be present
 * for the connector to have any chance of working. Keep this list
 * conservative: anything optional belongs in the "warnings" list below, not
 * here.
 *
 * Email connectors are validated separately via {@link validateEmailConfig}
 * below — they must have at least one `subject_patterns` entry OR a non-empty
 * `sender_filter`. An email connector with neither is greedy (matches every
 * inbound email for its tenant) which is almost always a misconfiguration.
 *
 * file_watch no longer requires r2_prefix since the manual-run path uploads
 * a file inline — the prefix is only used by the (future) R2 bucket watcher.
 */
const REQUIRED_CONFIG_FIELDS: Record<string, string[]> = {
  email: [],
  api_poll: ['endpoint_url'],
  webhook: [],
  file_watch: [],
};

/**
 * Shared validation for email-connector config. Exported so the create/update
 * handlers enforce the exact same rule — "must have patterns OR a sender
 * filter, otherwise it's greedy" — without drift.
 *
 * Returns `null` when the config is acceptable, or an `{ error, code }` tuple
 * that the caller should surface as a 400 response body.
 */
export function validateEmailConfig(
  config: Record<string, unknown>,
): { error: string; code: string } | null {
  const subjectPatterns = Array.isArray(config.subject_patterns)
    ? (config.subject_patterns as unknown[]).filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0,
      )
    : [];
  const senderFilter = typeof config.sender_filter === 'string' ? config.sender_filter.trim() : '';
  if (subjectPatterns.length === 0 && senderFilter.length === 0) {
    return {
      error:
        'Email connector requires at least one subject pattern or a sender filter',
      code: 'empty_email_config',
    };
  }
  return null;
}

/**
 * Build the public origin for the app. Derived from the request URL so the
 * response stays correct on staging vs prod. For local dev the helper just
 * strips the protocol+host off the current request.
 */
function publicOrigin(request: Request): string {
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'https://supdox.com';
  }
}

/**
 * Live probe for a file_watch connector. Verifies the stored sample is
 * reachable in R2 and returns the file's metadata + a rough row count if
 * the source_type is plain text. On failure the probe returns an error
 * payload without throwing — tests prefer soft feedback over 500s.
 */
async function probeFileWatch(
  env: Env,
  connector: { id: string; sample_r2_key: string | null },
): Promise<{
  probe: string;
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
}> {
  if (!connector.sample_r2_key) {
    return {
      probe: 'file_watch',
      ok: false,
      message:
        'No stored sample yet. Upload a CSV/TSV/XLSX/PDF in the wizard to seed this connector.',
      details: {},
    };
  }
  if (!env.FILES) {
    return {
      probe: 'file_watch',
      ok: false,
      message: 'R2 binding (FILES) is not configured on this environment.',
      details: { sample_r2_key: connector.sample_r2_key },
    };
  }

  const object = await env.FILES.get(connector.sample_r2_key);
  if (!object) {
    return {
      probe: 'file_watch',
      ok: false,
      message:
        'Stored sample is no longer reachable in R2 (may have expired). Re-upload a fresh sample.',
      details: { sample_r2_key: connector.sample_r2_key },
    };
  }

  const sourceType = (object.customMetadata?.source_type as string) || 'unknown';
  const originalName = (object.customMetadata?.original_name as string) || 'sample';
  const size = object.size ?? 0;

  // Count rows on the cheap for text-shaped samples. Don't attempt this for
  // binary formats — PDF/XLSX row counts would require loading the parser.
  let rowCount: number | null = null;
  if (sourceType === 'csv' || sourceType === 'text') {
    try {
      const text = await object.text();
      // Subtract 1 for the header row; clamp at 0.
      rowCount = Math.max(0, text.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1);
    } catch {
      rowCount = null;
    }
  }

  return {
    probe: 'file_watch',
    ok: true,
    message: `Stored sample OK: ${originalName} (${size} bytes)`,
    details: {
      sample_r2_key: connector.sample_r2_key,
      source_type: sourceType,
      file_name: originalName,
      size,
      row_count: rowCount,
    },
  };
}

/**
 * Live probe for an email connector. Verifies an email_domain_mappings row
 * exists for the tenant and reports the inbound address. Missing mapping
 * is a warning, not a hard failure — the connector can still work if
 * subject patterns match.
 */
async function probeEmail(
  env: Env,
  connector: { id: string; tenant_id: string; config: string },
): Promise<{
  probe: string;
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
}> {
  // Validate the config shape (patterns or sender filter).
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(connector.config || '{}');
  } catch {
    config = {};
  }
  const configErr = validateEmailConfig(config);
  if (configErr) {
    return {
      probe: 'email',
      ok: false,
      message: configErr.error,
      details: { code: configErr.code },
    };
  }

  // Resolve the tenant slug for the inbound address.
  const tenant = await env.DB.prepare(
    'SELECT slug, name FROM tenants WHERE id = ?',
  )
    .bind(connector.tenant_id)
    .first<{ slug: string; name: string }>();

  const inboundAddress = tenant?.slug ? `${tenant.slug}@supdox.com` : null;

  // Look up email_domain_mappings rows for this tenant — each row enables
  // ingest from a specific sender domain. Migration 0017 drops this table
  // (its data lives elsewhere in prod); the probe tolerates a missing
  // table as "no mappings configured" rather than 500ing.
  let domains: string[] = [];
  try {
    const mappingRows = await env.DB.prepare(
      `SELECT domain FROM email_domain_mappings WHERE tenant_id = ? AND active = 1`,
    )
      .bind(connector.tenant_id)
      .all<{ domain: string }>();
    domains = (mappingRows.results || []).map((r) => r.domain);
  } catch {
    domains = [];
  }

  if (domains.length === 0) {
    return {
      probe: 'email',
      ok: false,
      message:
        inboundAddress
          ? `No email_domain_mappings configured for this tenant. Emails to ${inboundAddress} will be rejected until a sender-domain row is added.`
          : 'No email_domain_mappings configured and tenant slug is unavailable.',
      details: {
        inbound_address: inboundAddress,
        tenant_name: tenant?.name ?? null,
        sender_domains: [],
      },
    };
  }

  return {
    probe: 'email',
    ok: true,
    message: inboundAddress
      ? `Ready: inbound at ${inboundAddress} (accepts ${domains.length} sender domain${domains.length === 1 ? '' : 's'})`
      : `Ready: ${domains.length} sender domain mapping(s) configured`,
    details: {
      inbound_address: inboundAddress,
      tenant_name: tenant?.name ?? null,
      sender_domains: domains,
    },
  };
}

/**
 * Live probe for a webhook connector. Returns the public webhook URL and
 * a sample curl command the user can paste into their integration. No
 * external call is made — this is informational.
 */
function probeWebhook(
  request: Request,
  connector: { id: string; config: string },
): {
  probe: string;
  ok: boolean;
  message: string;
  details: Record<string, unknown>;
} {
  const origin = publicOrigin(request);
  const webhookUrl = `${origin}/api/webhooks/connectors/${connector.id}`;

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(connector.config || '{}');
  } catch {
    /* ignore */
  }

  const hasAuth =
    !!config.signature_method || (Array.isArray(config.ip_allowlist) && (config.ip_allowlist as unknown[]).length > 0);

  const curl = `curl -X POST ${webhookUrl} \\
  -H "Content-Type: application/json" \\
  ${hasAuth ? '-H "X-Signature: <your-hmac-here>" \\' : '#  (no auth configured yet — see config above)\\'}
  -d '{"order_number": "SO-1", "customer_number": "K-1"}'`;

  return {
    probe: 'webhook',
    ok: true,
    message: hasAuth
      ? 'Webhook endpoint ready. Test with the sample curl below.'
      : 'Webhook URL generated. WARNING: no signature method or IP allowlist configured — the endpoint will reject requests until you add one.',
    details: {
      url: webhookUrl,
      sample_curl: curl,
      auth_configured: hasAuth,
    },
  };
}

/**
 * POST /api/connectors/:id/test
 *
 * Live configuration probe. Returns `{ success, message, warnings[], probe }`.
 * Missing-but-required fields raise a 400; soft configuration concerns
 * produce `probe.ok = false` in the response body so the UI can branch on
 * per-type details (inbound email address, webhook URL, stored sample
 * metadata, etc.) without another round-trip.
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
      .first<{
        id: string;
        tenant_id: string;
        connector_type: string;
        config: string;
        field_mappings: string;
        sample_r2_key: string | null;
      }>();

    if (!connector) {
      throw new NotFoundError('Connector not found');
    }

    requireTenantAccess(user, connector.tenant_id);

    // Validate config is parseable JSON
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(connector.config || '{}');
    } catch {
      throw new BadRequestError('Connector config is not valid JSON');
    }

    // Validate required fields per connector type
    const connectorType = connector.connector_type;
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
      JSON.parse(connector.field_mappings || '{}');
    } catch {
      throw new BadRequestError('Connector field_mappings is not valid JSON');
    }

    // Email connectors must be scoped — no subject patterns AND no sender
    // filter means "match every inbound email for this tenant" which is
    // almost always a mistake. Upgraded from a soft warning to a hard error.
    if (connectorType === 'email') {
      const emailErr = validateEmailConfig(config);
      if (emailErr) {
        return new Response(
          JSON.stringify({ error: emailErr.error, code: emailErr.code }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // Per-type live probe.
    let probe: Awaited<ReturnType<typeof probeFileWatch>>;
    switch (connectorType) {
      case 'file_watch':
        probe = await probeFileWatch(context.env, connector);
        break;
      case 'email':
        probe = await probeEmail(context.env, connector);
        break;
      case 'webhook':
        probe = probeWebhook(context.request, connector);
        break;
      case 'api_poll':
      default:
        probe = {
          probe: connectorType,
          ok: false,
          message: `Live probe for ${connectorType} connectors is not implemented yet.`,
          details: {},
        };
        break;
    }

    // Keep `success` tied to config-shape validity (preserving the legacy
    // 200/success=true contract that existing tests and clients rely on).
    // The probe is additive — callers that want to surface "not ready yet"
    // states should consult `probe.ok` and `probe.message` in the payload.
    return new Response(
      JSON.stringify({
        success: true,
        message: probe.message,
        warnings: probe.ok ? [] : [probe.message],
        probe,
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
