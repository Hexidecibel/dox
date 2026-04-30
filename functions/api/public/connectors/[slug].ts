/**
 * GET /api/public/connectors/:slug?token=<public_link_token>
 *
 * Phase B4 — public, unauthenticated read of the bare-minimum info
 * the public drop form needs to render: connector name, tenant name,
 * and the accepted-types list. Allowlisted in `_middleware.ts` so the
 * JWT gate doesn't short-circuit it.
 *
 * The route is single-use: the only legitimate caller is the public
 * drop page at `/drop/:slug/:token`. Auth is the unguessable
 * `?token=` query param matched against `connectors.public_link_token`
 * (constant-time). On mismatch we return 404 with the same generic
 * message as a missing connector — the route is not designed to be
 * a probe surface.
 *
 * Deliberately omitted from the response: field mappings, run history,
 * api_token, R2 creds, anything from `config`. Vendors filling the
 * form should not be able to enumerate connector internals.
 */

import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';
import {
  ACCEPTED_CONNECTOR_FILE_EXTENSIONS,
} from '../../../../shared/connectorFileTypes';
import type { Env } from '../../../lib/types';

const TEXT_SIZE_LIMIT = 5 * 1024 * 1024;
const BINARY_SIZE_LIMIT = 10 * 1024 * 1024;

function notFound(): Response {
  // Generic "not active" message — same shape regardless of cause
  // (missing connector / wrong token / expired / revoked) so the
  // route can't be used to enumerate connectors.
  return new Response(
    JSON.stringify({ error: 'This link is not active' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Constant-time string compare; same shape as the drop endpoint's.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

interface ConnectorRow {
  id: string;
  name: string;
  slug: string | null;
  tenant_id: string;
  active: number;
  deleted_at: string | null;
  public_link_token: string | null;
  public_link_expires_at: number | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const slug = context.params.slug as string;
  if (!slug) return notFound();

  const url = new URL(context.request.url);
  const providedToken = (url.searchParams.get('token') || '').trim();
  if (!providedToken) return notFound();

  const connector = await resolveConnectorHandle<ConnectorRow>(
    context.env.DB,
    slug,
    {
      columns:
        'id, name, slug, tenant_id, active, deleted_at, ' +
        'public_link_token, public_link_expires_at',
    },
  );

  if (!connector || connector.deleted_at !== null || !connector.active) {
    return notFound();
  }
  if (!connector.public_link_token) return notFound();
  if (!constantTimeEquals(providedToken, connector.public_link_token)) {
    return notFound();
  }
  if (
    connector.public_link_expires_at !== null &&
    connector.public_link_expires_at < Math.floor(Date.now() / 1000)
  ) {
    return notFound();
  }

  // Tenant lookup is non-fatal — if it fails we still render with a
  // blank tenant name. The tenant table is small, so this stays cheap.
  let tenantName: string | null = null;
  try {
    const tenant = await context.env.DB.prepare(
      'SELECT name FROM tenants WHERE id = ?',
    )
      .bind(connector.tenant_id)
      .first<{ name: string }>();
    tenantName = tenant?.name ?? null;
  } catch {
    tenantName = null;
  }

  return new Response(
    JSON.stringify({
      connector: {
        name: connector.name,
        slug: connector.slug,
      },
      tenant: {
        name: tenantName,
      },
      accepted_extensions: ACCEPTED_CONNECTOR_FILE_EXTENSIONS,
      max_size_bytes: {
        text: TEXT_SIZE_LIMIT,
        binary: BINARY_SIZE_LIMIT,
      },
      expires_at: connector.public_link_expires_at,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Don't let CDN cache a vendor-facing token-gated payload.
        'Cache-Control': 'no-store',
      },
    },
  );
};
