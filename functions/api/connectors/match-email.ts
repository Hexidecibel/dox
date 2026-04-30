import {
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env } from '../../lib/types';
import { subjectMatches, senderMatches } from '../../lib/connectors/matchEmail';

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

    // Phase B0 universal model: any active connector can route inbound
    // email if it has email-scoping config (subject_patterns or
    // sender_filter). The match loop below already filters out connectors
    // that don't actually carry that config, so a `WHERE` filter on a
    // connector_type column would be redundant — and the column is gone
    // post-migration 0048 anyway.
    const connectors = await context.env.DB.prepare(
      `SELECT id, name, config FROM connectors
       WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL`
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

      // Phase B0 universal model: a connector is only an email-routing
      // candidate if it has at least one email-scoping field set. Skipping
      // unconfigured connectors here replaces the historical
      // `connector_type = 'email'` SQL filter — same effect, but driven
      // off the actual scoping config rather than a per-row tag.
      const senderFilterRaw = typeof config.sender_filter === 'string'
        ? (config.sender_filter as string).trim()
        : '';
      const subjectPatterns = Array.isArray(config.subject_patterns)
        ? (config.subject_patterns as unknown[]).filter(
            (p): p is string => typeof p === 'string' && p.trim().length > 0,
          )
        : [];
      if (senderFilterRaw.length === 0 && subjectPatterns.length === 0) {
        // No email scoping configured — connector hasn't opted into the
        // email door. Skip.
        continue;
      }

      // Check sender filter (case-insensitive, via shared helper).
      // Preserve historical behavior: a set filter with no sender = skip.
      if (senderFilterRaw.length > 0) {
        if (!sender) continue;
        if (!senderMatches(sender, senderFilterRaw)) continue;
      }

      // Check subject patterns (case-insensitive, via shared helper).
      // Preserve historical behavior: configured patterns with no subject = skip.
      if (subjectPatterns.length > 0) {
        if (!subject) continue;
        if (!subjectMatches(subject, subjectPatterns)) continue;
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
