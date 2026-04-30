import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import { normalizeFieldMappings } from '../../../../shared/fieldMappings';
import {
  ACCEPTED_CONNECTOR_FILE_EXTENSIONS,
  classifyConnectorFile,
} from '../../../../shared/connectorFileTypes';
import { decryptCredentials } from '../../../lib/connectors/crypto';
import { executeConnectorRun } from '../../../lib/connectors/orchestrator';

/**
 * POST /api/connectors/:id/run
 *
 * Manual run trigger (universal-doors model, Phase B0). Always consumes a
 * multipart `file` upload and dispatches it through the file_watch intake
 * path of the orchestrator. The connector itself is typeless — any active
 * connector can be the target. Email/webhook/api_poll-specific intake
 * happens via their own endpoints (`webhooks/connector-email-ingest`,
 * `webhooks/connectors/:id`, future `connectors/:id/drop`); this route is
 * the manual-upload door.
 */

const TEXT_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB for CSV / TSV / TXT
const BINARY_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB for XLSX / PDF

/**
 * Wrap the shared classifier with the per-kind size limits the server
 * enforces. The accepted-extension list itself lives in
 * shared/connectorFileTypes.ts so the drop zone and this endpoint can't
 * drift apart.
 */
function classifyFile(fileName: string, contentType: string): {
  kind: 'text' | 'binary' | 'unknown';
  limit: number;
} {
  const { kind } = classifyConnectorFile(fileName, contentType);
  if (kind === 'text') return { kind, limit: TEXT_SIZE_LIMIT };
  if (kind === 'binary') return { kind, limit: BINARY_SIZE_LIMIT };
  return { kind: 'unknown', limit: TEXT_SIZE_LIMIT };
}

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

    if (!connector.active) {
      throw new BadRequestError('Cannot run an inactive connector');
    }

    // Manual upload door — always uses the file_watch intake path. The
    // body is multipart with a single `file` field.
    const contentType = context.request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestError(
        'Manual run requires multipart/form-data with a `file` field',
      );
    }

    const formData = await context.request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      throw new BadRequestError('file is required (multipart form field "file")');
    }

    const { kind, limit } = classifyFile(file.name, file.type);
    if (kind === 'unknown') {
      throw new BadRequestError(
        `Unsupported file type: ${file.name}. Accepted: ${ACCEPTED_CONNECTOR_FILE_EXTENSIONS.join(', ')}`,
      );
    }
    if (file.size > limit) {
      throw new BadRequestError(
        `File too large (${file.size} bytes, limit ${limit}). Split the file and try again.`,
      );
    }

    const buffer = await file.arrayBuffer();

    // Parse the stored connector config and decrypt any credentials — the
    // orchestrator expects a ConnectorContext-shaped config.
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse((connector.config as string) || '{}');
    } catch {
      config = {};
    }

    let credentials: Record<string, unknown> | undefined;
    if (
      connector.credentials_encrypted &&
      connector.credentials_iv &&
      context.env.CONNECTOR_ENCRYPTION_KEY
    ) {
      try {
        credentials = await decryptCredentials(
          connector.credentials_encrypted as string,
          connector.credentials_iv as string,
          context.env.CONNECTOR_ENCRYPTION_KEY,
          connector.tenant_id as string,
          connector.id as string,
        );
      } catch {
        credentials = undefined;
      }
    }

    // Normalize field_mappings so the executor sees a v2 shape.
    const fieldMappings = normalizeFieldMappings(
      typeof connector.field_mappings === 'string'
        ? JSON.parse(connector.field_mappings as string || '{}')
        : connector.field_mappings,
    );

    // Delegate to the orchestrator. The file_watch executor will handle
    // parsing the buffer; the orchestrator writes orders / customers /
    // connector_runs and updates the connector's last_run_at.
    const result = await executeConnectorRun({
      db: context.env.DB,
      r2: context.env.FILES,
      tenantId: connector.tenant_id as string,
      connectorId: connector.id as string,
      config,
      fieldMappings,
      credentials,
      input: {
        type: 'file_watch',
        fileName: file.name,
        contentType: file.type || undefined,
        content: buffer,
      },
      // Manual drag-drop on the connector detail page rides the same
      // executor as the API drop and R2 poller — `source` is the only
      // signal that distinguishes them downstream.
      source: 'manual',
      userId: user.id,
      qwenUrl: context.env.QWEN_URL,
      qwenSecret: context.env.QWEN_SECRET,
    });

    // Fetch the persisted run row so we can return the counts straight from
    // the DB (single source of truth — avoids drift between orchestrator's
    // in-memory counters and what the list endpoint would surface).
    const run = await context.env.DB.prepare(
      `SELECT id, status, started_at, completed_at,
              records_found, records_created, records_updated, records_errored,
              error_message
       FROM connector_runs WHERE id = ?`,
    )
      .bind(result.runId)
      .first<{
        id: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        records_found: number;
        records_created: number;
        records_updated: number;
        records_errored: number;
        error_message: string | null;
      }>();

    return new Response(
      JSON.stringify({
        run,
        run_id: result.runId,
        status: result.status,
        rows_processed: run?.records_found ?? 0,
        rows_inserted: result.ordersCreated,
        rows_skipped: run?.records_errored ?? 0,
        customers_created: result.customersCreated,
        errors: result.errors,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Run connector error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
