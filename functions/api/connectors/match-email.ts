import {
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env } from '../../lib/types';

/**
 * GET /api/connectors/match-email
 * Match an incoming email to a connector based on subject patterns and sender filter.
 * Accessible via API key (used by the email worker).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);
    const subject = url.searchParams.get('subject');
    const sender = url.searchParams.get('sender');
    const tenantSlug = url.searchParams.get('tenant_slug');

    if (!tenantSlug) {
      throw new BadRequestError('tenant_slug is required');
    }

    // Look up tenant by slug
    const tenant = await context.env.DB.prepare(
      'SELECT id FROM tenants WHERE slug = ? AND active = 1'
    )
      .bind(tenantSlug)
      .first<{ id: string }>();

    if (!tenant) {
      return new Response(
        JSON.stringify({ matched: false, reason: 'Tenant not found' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Find active email-type connectors for this tenant
    const connectors = await context.env.DB.prepare(
      `SELECT id, name, config FROM connectors
       WHERE tenant_id = ? AND connector_type = 'email' AND active = 1`
    )
      .bind(tenant.id)
      .all();

    for (const conn of connectors.results || []) {
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(conn.config as string || '{}');
      } catch {
        continue;
      }

      // Check sender filter
      const senderFilter = config.sender_filter as string | undefined;
      if (senderFilter && sender) {
        try {
          const senderRegex = new RegExp(senderFilter, 'i');
          if (!senderRegex.test(sender)) {
            continue;
          }
        } catch {
          // Invalid regex in config, skip sender check
        }
      }

      // Check subject patterns
      const subjectPatterns = config.subject_patterns as string[] | undefined;
      if (subjectPatterns && Array.isArray(subjectPatterns) && subject) {
        let subjectMatched = false;
        for (const pattern of subjectPatterns) {
          try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(subject)) {
              subjectMatched = true;
              break;
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }

        if (!subjectMatched) {
          continue;
        }
      }

      // Connector matched
      return new Response(
        JSON.stringify({
          matched: true,
          connector_id: conn.id,
          connector_name: conn.name,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ matched: false }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Match email error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
