import { generateId, logAudit, getClientIp } from '../../../lib/db';
import { decryptCredentials } from '../../../lib/connectors/crypto';
import type { Env } from '../../../lib/types';

/**
 * POST /api/webhooks/connectors/:connectorId
 *
 * Public webhook endpoint for external systems to push data into connectors.
 * Authentication is via HMAC signature verification or IP allowlist (no JWT/API key).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const connectorId = context.params.connectorId as string;

  try {
    // 1. Fetch connector
    const connector = await context.env.DB.prepare(
      `SELECT id, tenant_id, type, config, field_mappings, credentials_encrypted, credentials_iv, active
       FROM connectors WHERE id = ?`
    ).bind(connectorId).first<{
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
      return jsonResponse({ error: 'Not found' }, 404);
    }

    if (!connector.active) {
      return jsonResponse({ error: 'Connector is not active' }, 400);
    }

    if (connector.type !== 'webhook') {
      return jsonResponse({ error: 'Connector is not a webhook type' }, 400);
    }

    const config = JSON.parse(connector.config || '{}');

    // 2. Verify webhook signature or IP allowlist
    const rawBody = await context.request.text();

    // Decrypt credentials for signature verification
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

    const signatureMethod = config.signature_method as string | undefined;
    const signatureHeader = config.signature_header as string | undefined;

    if (signatureMethod && signatureHeader) {
      // HMAC signature verification
      const receivedSignature = context.request.headers.get(signatureHeader);
      if (!receivedSignature) {
        return jsonResponse({ error: 'Missing signature header' }, 401);
      }

      const signingSecret = credentials?.webhook_secret as string | undefined;
      if (!signingSecret) {
        console.error(`Connector ${connectorId} has signature verification configured but no webhook_secret in credentials`);
        return jsonResponse({ error: 'Webhook configuration error' }, 500);
      }

      const isValid = await verifySignature(signatureMethod, signingSecret, rawBody, receivedSignature);
      if (!isValid) {
        return jsonResponse({ error: 'Invalid signature' }, 401);
      }
    } else if (config.ip_allowlist) {
      // IP allowlist verification
      const clientIp = getClientIp(context.request);
      const allowlist = (config.ip_allowlist as string[]) || [];

      if (allowlist.length > 0 && !allowlist.includes(clientIp)) {
        return jsonResponse({ error: 'IP not allowed' }, 403);
      }
    } else {
      // No auth configured — reject
      return jsonResponse({ error: 'No webhook authentication configured' }, 403);
    }

    // 3. Parse request body
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    // 4. Collect relevant headers
    const headers: Record<string, string> = {};
    for (const [key, value] of context.request.headers.entries()) {
      // Forward content and custom headers, skip internal ones
      const lk = key.toLowerCase();
      if (lk.startsWith('x-') || lk === 'content-type') {
        headers[key] = value;
      }
    }

    // 5. Audit the webhook receipt
    await logAudit(
      context.env.DB,
      'system',
      connector.tenant_id,
      'connector.webhook_received',
      'connector',
      connector.id,
      JSON.stringify({
        source_ip: getClientIp(context.request),
      }),
      getClientIp(context.request)
    );

    // 6. For now, return acknowledgement — full orchestrator execution
    //    will be wired up when the webhook connector executor is implemented.
    return jsonResponse({
      success: true,
      connector_id: connector.id,
      message: 'Webhook received and verified. Webhook connector execution is not yet implemented.',
    }, 200);
  } catch (err) {
    console.error('Webhook connector error:', err);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
};

/**
 * Verify an HMAC signature against the request body.
 */
async function verifySignature(
  method: string,
  secret: string,
  body: string,
  receivedSignature: string
): Promise<boolean> {
  if (method !== 'hmac_sha256') {
    console.error(`Unsupported signature method: ${method}`);
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Support both raw hex and prefixed formats (e.g., "sha256=...")
  const normalizedReceived = receivedSignature.replace(/^sha256=/, '').toLowerCase();
  const normalizedExpected = expected.toLowerCase();

  // Constant-time comparison
  if (normalizedReceived.length !== normalizedExpected.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < normalizedReceived.length; i++) {
    result |= normalizedReceived.charCodeAt(i) ^ normalizedExpected.charCodeAt(i);
  }

  return result === 0;
}

function jsonResponse(data: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
