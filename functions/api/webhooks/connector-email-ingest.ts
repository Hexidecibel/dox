import { logAudit, getClientIp, generateId } from '../../lib/db';
import { BadRequestError, errorToResponse } from '../../lib/permissions';
import { computeChecksum } from '../../lib/r2';
import { enqueueDocument } from '../../lib/intake/enqueue';
import { createConnectorRunHeader } from '../../lib/intake/connectorRunHeader';
import type { Env, User } from '../../lib/types';

interface EmailAttachmentPayload {
  filename: string;
  content_base64: string;
  content_type: string;
  size: number;
}

interface ConnectorEmailIngestBody {
  // Primary connector identifier. Either `connector_id` (UUID) or
  // `connector_slug` (vendor-friendly handle from migration 0050) MUST
  // be provided. The email-worker (Phase B0.6) sends both for safety.
  connector_id?: string;
  connector_slug?: string;
  tenant_id: string;
  subject: string;
  sender: string;
  body: string;
  html?: string;
  attachments?: EmailAttachmentPayload[];
}

/**
 * POST /api/webhooks/connector-email-ingest
 *
 * Receives email data routed from the Cloudflare Email Worker.
 * Authenticated via API key (X-API-Key header from the email worker).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const payload: ConnectorEmailIngestBody = await context.request.json();

    // Validate required fields. Either connector_id or connector_slug
    // must identify the target connector.
    if ((!payload.connector_id && !payload.connector_slug) || !payload.tenant_id || !payload.sender) {
      return errorToResponse(new BadRequestError('Missing required fields: connector_id|connector_slug, tenant_id, sender'));
    }

    // 1. Fetch the connector. Phase B0 universal model: any active
    //    connector can be the target of an email ingest — no per-type
    //    gate. The dispatch path discriminator is `input.type = 'email'`
    //    on the orchestrator call below. Phase B0.6 added the slug
    //    fallback so the email-worker can resolve by either identifier.
    const connectorCols =
      'id, name, tenant_id, active, output_kind, supplier_id, document_type_id';
    type ConnectorRow = {
      id: string;
      name: string | null;
      tenant_id: string;
      active: number;
      output_kind: string | null;
      supplier_id: string | null;
      document_type_id: string | null;
    };
    const connector = payload.connector_id
      ? await context.env.DB.prepare(
          `SELECT ${connectorCols} FROM connectors WHERE id = ?`
        ).bind(payload.connector_id).first<ConnectorRow>()
      : await context.env.DB.prepare(
          `SELECT ${connectorCols} FROM connectors WHERE slug = ?`
        ).bind(payload.connector_slug!).first<ConnectorRow>();

    if (!connector) {
      return jsonResponse({ error: 'Connector not found' }, 404);
    }

    if (!connector.active) {
      return jsonResponse({ error: 'Connector is not active' }, 400);
    }

    // 2. Verify tenant access
    if (connector.tenant_id !== payload.tenant_id) {
      return jsonResponse({ error: 'Tenant mismatch' }, 403);
    }

    // Verify the API key user has access to this tenant
    if (user.role !== 'super_admin' && user.tenant_id !== connector.tenant_id) {
      return jsonResponse({ error: 'Access denied' }, 403);
    }

    // 3. Decode attachments from base64 into ArrayBuffers.
    const attachments = (payload.attachments || []).map((att) => {
      const binaryString = atob(att.content_base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return {
        filename: att.filename || 'attachment',
        content: bytes.buffer as ArrayBuffer,
        contentType: att.content_type || 'application/octet-stream',
        size: att.size ?? bytes.byteLength,
      };
    });

    if (attachments.length === 0) {
      // No attachments to enqueue. We still 200 (the email arrived and was
      // routed correctly), just with an empty queued list.
      await logAudit(
        context.env.DB,
        user.id,
        connector.tenant_id,
        'connector.email_ingest',
        'connector',
        connector.id,
        JSON.stringify({
          sender: payload.sender,
          subject: payload.subject,
          attachments: 0,
        }),
        getClientIp(context.request)
      );
      return jsonResponse({ queued: true, run_id: null, items: [] }, 200);
    }

    // 4. Connectors → Sources: one batch ROLLUP HEADER for the whole email,
    //    then one enqueue per attachment under that run. Nothing auto-ingests;
    //    each attachment flows through the worker → Review Queue.
    const connectorRunId = await createConnectorRunHeader(context.env.DB, {
      connectorId: connector.id,
      tenantId: connector.tenant_id,
      source: 'email',
    });

    const sourceDetail = `email:${payload.sender}`;
    const items: { queue_id: string; file_name: string }[] = [];
    for (const att of attachments) {
      const checksum = await computeChecksum(att.content);
      const safeName = att.filename
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 200);
      const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const r2Key = `connector-drops/${connector.id}/${isoStamp}-${generateId().slice(0, 8)}-${safeName}`;
      await context.env.FILES.put(r2Key, att.content, {
        httpMetadata: { contentType: att.contentType },
        customMetadata: {
          connector_id: connector.id,
          tenant_id: connector.tenant_id,
          source: 'email',
          original_name: att.filename,
        },
      });

      const { queueId } = await enqueueDocument(context.env.DB, {
        id: generateId(),
        tenantId: connector.tenant_id,
        documentTypeId: connector.document_type_id,
        fileR2Key: r2Key,
        fileName: att.filename,
        fileSize: att.size,
        mimeType: att.contentType,
        checksum,
        createdBy: user.id,
        source: 'email',
        sourceDetail,
        outputKind: connector.output_kind,
        sourceId: connector.id,
        supplierId: connector.supplier_id,
        connectorRunId,
      });

      try {
        await context.env.DB.prepare(
          `INSERT OR IGNORE INTO connector_processed_keys
             (id, connector_id, r2_key, processed_at, run_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(generateId(), connector.id, r2Key, Date.now(), connectorRunId)
          .run();
      } catch (err) {
        console.warn(`email-ingest: failed to write processed_keys for ${r2Key}:`, err);
      }

      items.push({ queue_id: queueId, file_name: att.filename });
    }

    // 5. Audit log
    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id,
      'connector.email_ingest',
      'connector',
      connector.id,
      JSON.stringify({
        run_id: connectorRunId,
        sender: payload.sender,
        subject: payload.subject,
        attachments: items.length,
      }),
      getClientIp(context.request)
    );

    return jsonResponse({
      queued: true,
      run_id: connectorRunId,
      items,
    }, 200);
  } catch (err) {
    console.error('Connector email ingest error:', err);
    if (err instanceof BadRequestError) {
      return errorToResponse(err);
    }
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
};

function jsonResponse(data: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
