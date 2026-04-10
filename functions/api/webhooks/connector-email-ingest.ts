import { generateId, logAudit, getClientIp } from '../../lib/db';
import { BadRequestError, errorToResponse } from '../../lib/permissions';
import { executeConnectorRun } from '../../lib/connectors/orchestrator';
import { decryptCredentials } from '../../lib/connectors/crypto';
import type { Env, User } from '../../lib/types';
import type { EmailAttachment } from '../../lib/connectors/types';

interface EmailAttachmentPayload {
  filename: string;
  content_base64: string;
  content_type: string;
  size: number;
}

interface ConnectorEmailIngestBody {
  connector_id: string;
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

    // Validate required fields
    if (!payload.connector_id || !payload.tenant_id || !payload.sender) {
      return errorToResponse(new BadRequestError('Missing required fields: connector_id, tenant_id, sender'));
    }

    // 1. Fetch the connector
    const connector = await context.env.DB.prepare(
      `SELECT id, tenant_id, type, config, field_mappings, credentials_encrypted, credentials_iv, active
       FROM connectors WHERE id = ?`
    ).bind(payload.connector_id).first<{
      id: string;
      tenant_id: string;
      type: string;
      config: string;
      field_mappings: string;
      credentials_encrypted: string | null;
      credentials_iv: string | null;
      active: number;
    }>();

    if (!connector) {
      return jsonResponse({ error: 'Connector not found' }, 404);
    }

    if (!connector.active) {
      return jsonResponse({ error: 'Connector is not active' }, 400);
    }

    if (connector.type !== 'email') {
      return jsonResponse({ error: 'Connector is not an email type' }, 400);
    }

    // 2. Verify tenant access
    if (connector.tenant_id !== payload.tenant_id) {
      return jsonResponse({ error: 'Tenant mismatch' }, 403);
    }

    // Verify the API key user has access to this tenant
    if (user.role !== 'super_admin' && user.tenant_id !== connector.tenant_id) {
      return jsonResponse({ error: 'Access denied' }, 403);
    }

    // 3. Parse attachments from base64
    const attachments: EmailAttachment[] = (payload.attachments || []).map((att) => {
      const binaryString = atob(att.content_base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return {
        filename: att.filename,
        content: bytes.buffer as ArrayBuffer,
        contentType: att.content_type,
        size: att.size,
      };
    });

    // 4. Parse connector config and field mappings
    const config = JSON.parse(connector.config || '{}');
    const fieldMappings = JSON.parse(connector.field_mappings || '{}');

    // Decrypt credentials if present
    let credentials: Record<string, unknown> | undefined;
    if (connector.credentials_encrypted && connector.credentials_iv && context.env.CONNECTOR_ENCRYPTION_KEY) {
      credentials = await decryptCredentials(
        connector.credentials_encrypted,
        connector.credentials_iv,
        context.env.CONNECTOR_ENCRYPTION_KEY,
        connector.tenant_id,
        connector.id
      );
    }

    // 5. Build ConnectorInput and execute
    const result = await executeConnectorRun({
      db: context.env.DB,
      r2: context.env.FILES,
      tenantId: connector.tenant_id,
      connectorId: connector.id,
      connectorType: connector.type as 'email',
      config,
      fieldMappings,
      credentials,
      input: {
        type: 'email',
        body: payload.body || '',
        html: payload.html,
        subject: payload.subject || 'Email Ingest',
        sender: payload.sender,
        attachments,
      },
      userId: user.id,
      qwenUrl: context.env.QWEN_URL,
      qwenSecret: context.env.QWEN_SECRET,
    });

    // 6. Audit log
    await logAudit(
      context.env.DB,
      user.id,
      connector.tenant_id,
      'connector.email_ingest',
      'connector',
      connector.id,
      JSON.stringify({
        run_id: result.runId,
        status: result.status,
        sender: payload.sender,
        subject: payload.subject,
        attachments: (payload.attachments || []).length,
      }),
      getClientIp(context.request)
    );

    return jsonResponse({
      success: true,
      run_id: result.runId,
      status: result.status,
      orders_created: result.ordersCreated,
      customers_created: result.customersCreated,
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
