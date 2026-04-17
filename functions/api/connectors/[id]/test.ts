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
 */
const REQUIRED_CONFIG_FIELDS: Record<string, string[]> = {
  email: [],
  api_poll: ['endpoint_url'],
  webhook: [],
  file_watch: ['r2_prefix'],
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
 * POST /api/connectors/:id/test
 * Validate connector configuration. Returns `{ success, message, warnings[] }`.
 * Missing-but-required fields raise a 400; soft configuration concerns
 * (e.g. an email connector with no subject filter at all) come back in
 * `warnings` so the UI can surface them without blocking the user.
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

    // Validate config is parseable JSON
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(connector.config as string || '{}');
    } catch {
      throw new BadRequestError('Connector config is not valid JSON');
    }

    // Validate required fields per connector type
    const connectorType = connector.connector_type as string;
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
      JSON.parse(connector.field_mappings as string || '{}');
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

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Connector configuration is valid',
        warnings: [],
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
