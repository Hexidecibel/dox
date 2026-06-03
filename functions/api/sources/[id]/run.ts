import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User } from '../../../lib/types';
import {
  ACCEPTED_CONNECTOR_FILE_EXTENSIONS,
  classifyConnectorFile,
} from '../../../../shared/connectorFileTypes';
import { resolveConnectorHandle } from '../../../lib/connectors/resolveHandle';
import { computeChecksum } from '../../../lib/r2';
import { enqueueDocument } from '../../../lib/intake/enqueue';
import { createConnectorRunHeader } from '../../../lib/intake/connectorRunHeader';
import { generateId } from '../../../lib/db';

/**
 * POST /api/sources/:id/run
 *
 * Manual run trigger (Connectors → Sources model). Always consumes a
 * multipart `file` upload. Instead of running the synchronous orchestrator,
 * the file is stored to R2 and ENQUEUED into `processing_queue` — the same
 * path manual uploads take — so the connector doc flows through the worker →
 * Review Queue. Nothing auto-ingests. The connector itself is typeless; its
 * routing fields (output_kind/supplier_id/document_type_id) tag the queue row.
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
    // Phase B0.5: accept slug or id in the path. The resolver tries
    // slug first, then id — admin tooling that already passes the id
    // keeps working unchanged.
    const connectorHandle = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin');

    const connector = await resolveConnectorHandle(
      context.env.DB,
      connectorHandle,
    );

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
    const checksum = await computeChecksum(buffer);

    // Store the file to R2 under the same convention the API-drop door uses
    // (connector-drops/<id>/<iso>-<filename>) so the retry path's
    // lookupOriginalKey / refetchSourceBytes can recover it later.
    const safeName = (file.name || 'file')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 200);
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const r2Key = `connector-drops/${connector.id as string}/${isoStamp}-${safeName}`;
    await context.env.FILES.put(r2Key, buffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
      customMetadata: {
        connector_id: connector.id as string,
        tenant_id: connector.tenant_id as string,
        source: 'manual',
        original_name: file.name,
      },
    });

    // Create the batch ROLLUP HEADER. Counts get filled in later by
    // accumulateRunRollup as items are approved out of the Review Queue.
    const connectorRunId = await createConnectorRunHeader(context.env.DB, {
      connectorId: connector.id as string,
      tenantId: connector.tenant_id as string,
      source: 'manual',
    });

    // Enqueue into processing_queue — same path manual uploads take. The
    // worker picks it up and routes it into the kind-aware Review Queue.
    const { queueId } = await enqueueDocument(context.env.DB, {
      id: generateId(),
      tenantId: connector.tenant_id as string,
      documentTypeId: (connector.document_type_id as string | null) ?? null,
      fileR2Key: r2Key,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      checksum,
      createdBy: user.id,
      source: 'manual',
      sourceDetail: connector.name ? `connector:${connector.name as string}` : `connector:${connector.id as string}`,
      outputKind: (connector.output_kind as string | null) ?? null,
      sourceId: connector.id as string,
      supplierId: (connector.supplier_id as string | null) ?? null,
      connectorRunId,
    });

    // Mark the R2 key processed so the poller doesn't double-enqueue if the
    // same file also lands in a watched bucket.
    try {
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO connector_processed_keys
           (id, connector_id, r2_key, processed_at, run_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(generateId(), connector.id as string, r2Key, Date.now(), connectorRunId)
        .run();
    } catch (err) {
      console.warn(`run: failed to write processed_keys for ${r2Key}:`, err);
    }

    return new Response(
      JSON.stringify({
        queued: true,
        queue_id: queueId,
        run_id: connectorRunId,
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
