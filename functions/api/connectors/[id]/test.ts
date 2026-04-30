import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';
import type { Env, User } from '../../../lib/types';

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
 * Live probe for the manual-upload door — verifies the stored sample is
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
 * Detect whether the request is hitting a staging deployment. Staging
 * doesn't have inbound email wired (see `email-worker/wrangler.staging.toml`)
 * so the probe surfaces a different message there. Defaults to "prod" on
 * unparseable URLs — better to underclaim "staging" than to mislabel a
 * real prod connector as staging.
 */
function isStagingHost(request: Request): boolean {
  try {
    const host = new URL(request.url).host.toLowerCase();
    return host.includes('staging') || host.endsWith('.pages.dev');
  } catch {
    return false;
  }
}

/**
 * Resolve the receive address for an email connector. Mirrors the format
 * baked into `email-worker` (`<slug>@<EMAIL_DOMAIN>`). The domain is
 * inferred from the request host on staging vs prod — keeping this in
 * one place avoids hardcoding `supdox.com` everywhere.
 */
function emailDomainForRequest(request: Request): string {
  return isStagingHost(request) ? 'supdox-staging.com' : 'supdox.com';
}

/**
 * Live probe for an email connector. Validates the config shape (subject
 * patterns or sender filter) and reports the inbound receive address.
 *
 * Note: this probe deliberately does NOT consult `email_domain_mappings`.
 * The connector dispatch path (`functions/api/webhooks/connector-email-ingest.ts`)
 * is sender-agnostic — the receive address itself is the routing key, and
 * any sender can email it. A per-connector sender allowlist may be added
 * later if spam becomes a real problem; for now keeping the probe honest
 * matters more than preserving a misleading "configure mappings first"
 * message that sent users on a wild goose chase.
 */
async function probeEmail(
  env: Env,
  request: Request,
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

  const domain = emailDomainForRequest(request);
  const inboundAddress = tenant?.slug ? `${tenant.slug}@${domain}` : null;
  const staging = isStagingHost(request);

  if (staging) {
    return {
      probe: 'email',
      ok: false,
      message:
        "Email ingestion isn't wired on staging yet. Use the manual upload zone above, or test the email path on prod.",
      details: {
        inbound_address: inboundAddress,
        tenant_name: tenant?.name ?? null,
        environment: 'staging',
      },
    };
  }

  if (!inboundAddress) {
    return {
      probe: 'email',
      ok: false,
      message: 'Tenant slug is unavailable — cannot derive a receive address.',
      details: {
        inbound_address: null,
        tenant_name: tenant?.name ?? null,
        environment: 'production',
      },
    };
  }

  return {
    probe: 'email',
    ok: true,
    message:
      `Send emails with attachments to ${inboundAddress}. The connector will process the attachments. Note: any sender domain is currently accepted.`,
    details: {
      inbound_address: inboundAddress,
      tenant_name: tenant?.name ?? null,
      environment: 'production',
    },
  };
}

// probeWebhook + publicOrigin were dropped in Phase B0. The universal-doors
// model runs a fixed set of probes (file_watch + email) for every connector;
// webhook-specific probing will return when B2's HTTP POST drop endpoint
// lands and warrants a per-connector token-status check.

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
    // Phase B0.5: accept slug or id in the path.
    const connectorHandle = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle<{
      id: string;
      tenant_id: string;
      config: string;
      field_mappings: string;
      sample_r2_key: string | null;
    }>(context.env.DB, connectorHandle);

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

    // Validate field_mappings is parseable
    try {
      JSON.parse(connector.field_mappings || '{}');
    } catch {
      throw new BadRequestError('Connector field_mappings is not valid JSON');
    }

    // Phase B0 universal model: when the user has explicitly set up email
    // scoping (subject_patterns or sender_filter), enforce coherence —
    // wiping both to empty values yields a connector that hoovers up every
    // inbound email for the tenant, which is almost always a mistake.
    // Connectors with no email scoping at all are FINE; the email door
    // simply isn't wired for this connector yet.
    const wantsEmailScoping =
      Array.isArray(config.subject_patterns) ||
      typeof config.sender_filter === 'string';
    if (wantsEmailScoping) {
      const emailErr = validateEmailConfig(config);
      if (emailErr) {
        return new Response(
          JSON.stringify({ error: emailErr.error, code: emailErr.code }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // Universal probe: walk every intake door this connector exposes.
    // For B0 we run the manual-upload (sample) probe + the email probe
    // unconditionally. B2/B3/B4 doors will append their probes here as
    // those slices land. The aggregate result rolls up to the legacy
    // `probe` field (using the first non-OK probe so the UI surfaces the
    // most actionable message) and a new `probes` array carries the full
    // per-door breakdown.
    const probes = [
      await probeFileWatch(context.env, connector),
      await probeEmail(context.env, context.request, connector),
    ];
    // Pick the first non-OK probe to surface as the legacy `probe` field;
    // otherwise the manual-upload probe (most likely to be configured) wins.
    const probe = probes.find((p) => !p.ok) ?? probes[0];

    // Keep `success` tied to config-shape validity (preserving the legacy
    // 200/success=true contract that existing tests and clients rely on).
    // Phase B0 universal model: `probes` carries the full per-door
    // breakdown; the singular `probe` field is the first non-OK door
    // (most actionable for the UI) — preserved for backwards compatibility
    // with the single-Alert rendering on ConnectorDetail.
    const warnings = probes.filter((p) => !p.ok).map((p) => p.message);
    return new Response(
      JSON.stringify({
        success: true,
        message: probe.message,
        warnings,
        probe,
        probes,
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
