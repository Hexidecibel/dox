import PostalMime from 'postal-mime';

interface Env {
  DOX_API_BASE: string;
  EMAIL_DOMAIN: string;
  EMAIL_INGEST_API_KEY: string;
  RESEND_API_KEY: string;
  // D1 binding for connector slug lookup (Phase B0.6). Optional so the
  // worker can still boot in environments where the binding hasn't been
  // wired yet — code that uses `env.DB` is guarded.
  DB?: D1Database;
}

// Allowed MIME types for document attachments
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/json',
  'image/png',
  'image/jpeg',
]);

// Map extensions to MIME types as fallback
const EXT_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

interface AttachmentResult {
  fileName: string;
  status: 'queued' | 'skipped' | 'error';
  error?: string;
  queueId?: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const senderEmail = message.from;
    const recipientEmail = message.to;

    console.log(`Email received: from=${senderEmail} to=${recipientEmail}`);

    // 1. Extract local part of recipient address. This is the slug used
    //    for both the new connector-slug routing path (Phase B0.6) and
    //    the legacy tenant-slug fallback below.
    const slug = extractSlug(recipientEmail, env.EMAIL_DOMAIN);
    if (!slug) {
      console.error(`Could not extract slug from: ${recipientEmail}`);
      await sendReply(env, senderEmail, 'Delivery Failed',
        `The address ${recipientEmail} is not a valid document inbox. Expected format: {organization}@${env.EMAIL_DOMAIN}`);
      return;
    }

    // 1b. Connector slug routing (Phase B0.6). The connectors table now
    //     carries its own slug column (migration 0050). If the local
    //     part matches an active connector slug, route directly to the
    //     connector-email-ingest webhook. This is the new primary path
    //     for vendor-facing addresses (e.g. `acme-orders@supdox.com`).
    //
    //     If the lookup misses or the D1 binding isn't configured, we
    //     fall through to the legacy tenant-slug + match-email path
    //     below — preserving COA smart-upload and pre-B0.6 connector
    //     setups that relied on subject/sender filters.
    if (env.DB) {
      try {
        const connectorRow = await env.DB.prepare(
          `SELECT id, tenant_id, active, deleted_at FROM connectors WHERE slug = ?`
        ).bind(slug).first<{
          id: string;
          tenant_id: string;
          active: number;
          deleted_at: string | null;
        }>();

        if (connectorRow && connectorRow.active && !connectorRow.deleted_at) {
          console.log(`route=connector-slug:${slug} connector_id=${connectorRow.id}`);

          // Parse the email up front — we need attachments + subject/body.
          const rawEmail = await streamToArrayBuffer(message.raw);
          const parser = new PostalMime();
          const parsed = await parser.parse(rawEmail);
          const subject = parsed.subject || '(no subject)';
          const senderName = parsed.from?.name || senderEmail;

          const attachmentPayloads = (parsed.attachments || [])
            .filter(att => {
              if (att.disposition === 'inline') return false;
              const content = att.content;
              const size = typeof content === 'string' ? content.length : content.byteLength;
              return size >= 1024;
            })
            .map(att => {
              const content = att.content;
              const bytes = content instanceof ArrayBuffer
                ? new Uint8Array(content)
                : typeof content === 'string'
                  ? new TextEncoder().encode(content)
                  : new Uint8Array(content);
              return {
                filename: att.filename || 'attachment',
                content_base64: btoa(String.fromCharCode(...bytes)),
                content_type: att.mimeType || 'application/octet-stream',
                size: bytes.byteLength,
              };
            });

          const ingestRes = await fetch(
            `${env.DOX_API_BASE}/api/webhooks/connector-email-ingest`,
            {
              method: 'POST',
              headers: {
                'X-API-Key': env.EMAIL_INGEST_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                connector_id: connectorRow.id,
                connector_slug: slug,
                tenant_id: connectorRow.tenant_id,
                subject,
                sender: senderEmail,
                body: parsed.text || '',
                html: parsed.html || '',
                attachments: attachmentPayloads,
              }),
            }
          );

          if (ingestRes.ok) {
            const result = await ingestRes.json() as {
              run_id: string; status: string;
              orders_created: number; customers_created: number;
            };
            console.log(`Connector slug ingest complete: run=${result.run_id} status=${result.status} orders=${result.orders_created}`);
            await sendReply(env, senderEmail, `Report Processed`,
              `Hi ${senderName},\n\n` +
              `Your email "${subject}" was processed by the ${slug} connector.\n\n` +
              `Results: ${result.orders_created} order(s) created, ${result.customers_created} customer(s) created.\n\n` +
              `— SupDox`);
          } else {
            const errText = await ingestRes.text().catch(() => 'Unknown error');
            console.error(`Connector slug ingest failed: ${ingestRes.status} ${errText}`);
            await sendReply(env, senderEmail, `Processing Error`,
              `Hi ${senderName},\n\n` +
              `Your email "${subject}" was received but processing failed. Our team has been notified.\n\n` +
              `— SupDox`);
          }
          return; // Connector slug path is terminal — do NOT fall through.
        }

        console.log(`route=legacy:no-connector-slug-match slug=${slug}`);
      } catch (err) {
        // Lookup error — log and fall through. We never want a D1 hiccup
        // to break inbound mail handling.
        console.error(`route=legacy:connector-slug-lookup-error slug=${slug}:`, err);
      }
    } else {
      console.log(`route=legacy:no-db-binding slug=${slug}`);
    }

    // 2. Validate tenant exists
    let tenant: { id: string; name: string; slug: string } | null = null;
    try {
      const res = await fetch(`${env.DOX_API_BASE}/api/tenants/by-slug/${encodeURIComponent(slug)}`, {
        headers: { 'X-API-Key': env.EMAIL_INGEST_API_KEY },
      });
      if (res.ok) {
        const data = await res.json() as { tenant: { id: string; name: string; slug: string } };
        tenant = data.tenant;
      }
    } catch (err) {
      console.error('Tenant lookup failed:', err);
    }

    if (!tenant) {
      console.error(`Tenant not found for slug: ${slug}`);
      await sendReply(env, senderEmail, 'Unknown Organization',
        `No organization found for "${slug}". Please check the email address and try again.`);
      return;
    }

    // 3. Parse email
    const rawEmail = await streamToArrayBuffer(message.raw);
    const parser = new PostalMime();
    const parsed = await parser.parse(rawEmail);

    const subject = parsed.subject || '(no subject)';
    const senderName = parsed.from?.name || senderEmail;

    // 3b. Check if any connector matches this email
    try {
      const matchParams = new URLSearchParams({
        subject: subject,
        sender: senderEmail,
        tenant_slug: slug,
      });
      const matchRes = await fetch(
        `${env.DOX_API_BASE}/api/connectors/match-email?${matchParams}`,
        { headers: { 'X-API-Key': env.EMAIL_INGEST_API_KEY } }
      );

      if (matchRes.ok) {
        const matchData = await matchRes.json() as { matched: boolean; connector_id?: string };

        if (matchData.matched && matchData.connector_id) {
          console.log(`Connector match found: ${matchData.connector_id} for email from ${senderEmail}`);

          // Route to connector email ingest instead of document processing
          const attachmentPayloads = (parsed.attachments || [])
            .filter(att => {
              if (att.disposition === 'inline') return false;
              const content = att.content;
              const size = typeof content === 'string' ? content.length : content.byteLength;
              return size >= 1024;
            })
            .map(att => {
              const content = att.content;
              const bytes = content instanceof ArrayBuffer
                ? new Uint8Array(content)
                : typeof content === 'string'
                  ? new TextEncoder().encode(content)
                  : new Uint8Array(content);
              return {
                filename: att.filename || 'attachment',
                content_base64: btoa(String.fromCharCode(...bytes)),
                content_type: att.mimeType || 'application/octet-stream',
                size: bytes.byteLength,
              };
            });

          const ingestRes = await fetch(
            `${env.DOX_API_BASE}/api/webhooks/connector-email-ingest`,
            {
              method: 'POST',
              headers: {
                'X-API-Key': env.EMAIL_INGEST_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                connector_id: matchData.connector_id,
                tenant_id: tenant.id,
                subject: subject,
                sender: senderEmail,
                body: parsed.text || '',
                html: parsed.html || '',
                attachments: attachmentPayloads,
              }),
            }
          );

          if (ingestRes.ok) {
            const result = await ingestRes.json() as {
              run_id: string; status: string;
              orders_created: number; customers_created: number;
            };
            console.log(`Connector ingest complete: run=${result.run_id} status=${result.status} orders=${result.orders_created}`);

            await sendReply(env, senderEmail, `Report Processed — ${tenant.name}`,
              `Hi ${senderName},\n\n` +
              `Your email "${subject}" was processed as a connector report.\n\n` +
              `Results: ${result.orders_created} order(s) created, ${result.customers_created} customer(s) created.\n\n` +
              `— SupDox`);
          } else {
            const errText = await ingestRes.text().catch(() => 'Unknown error');
            console.error(`Connector ingest failed: ${ingestRes.status} ${errText}`);
            await sendReply(env, senderEmail, `Processing Error — ${tenant.name}`,
              `Hi ${senderName},\n\n` +
              `Your email "${subject}" was received but processing failed. Our team has been notified.\n\n` +
              `— SupDox`);
          }

          return; // Don't continue to document processing
        }
      }
    } catch (err) {
      // If connector matching fails, fall through to normal document processing
      console.error('Connector match check failed, falling through to document processing:', err);
    }

    // 4. Filter attachments
    const validAttachments = (parsed.attachments || []).filter(att => {
      // Skip inline images (email signatures, etc.)
      if (att.disposition === 'inline') return false;
      // Skip tiny files (likely signatures or icons)
      const content = att.content;
      const size = typeof content === 'string' ? content.length : content.byteLength;
      if (size < 1024) return false;
      // Check MIME type
      const mimeType = resolveMimeType(att.mimeType, att.filename ?? undefined);
      return mimeType !== null;
    });

    if (validAttachments.length === 0) {
      console.log(`No valid attachments from ${senderEmail} for ${tenant.slug}`);
      await sendReply(env, senderEmail, 'No Documents Found',
        `Your email "${subject}" was received but contained no document attachments.\n\n` +
        `Supported formats: PDF, Word, Excel, CSV, images (PNG/JPEG).`);
      return;
    }

    console.log(`Processing ${validAttachments.length} attachments for tenant ${tenant.slug}`);

    // 5. POST each attachment to /api/documents/process
    const results: AttachmentResult[] = [];

    for (const att of validAttachments) {
      const fileName = att.filename || 'attachment.pdf';
      const mimeType = resolveMimeType(att.mimeType, fileName) || 'application/octet-stream';

      try {
        const form = new FormData();
        const blob = new Blob([att.content], { type: mimeType });
        form.append('files', blob, fileName);
        form.append('tenant_id', tenant.id);
        form.append('source', 'email');
        form.append('source_detail', JSON.stringify({
          sender: senderEmail,
          sender_name: senderName,
          subject: subject,
          received_at: new Date().toISOString(),
        }));

        const res = await fetch(`${env.DOX_API_BASE}/api/documents/process`, {
          method: 'POST',
          headers: { 'X-API-Key': env.EMAIL_INGEST_API_KEY },
          body: form,
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => 'Unknown error');
          throw new Error(`API ${res.status}: ${errBody.substring(0, 200)}`);
        }

        const data = await res.json() as { queued: boolean; items: { id: string; file_name: string }[] };
        const queueId = data.items?.[0]?.id;

        results.push({ fileName, status: 'queued', queueId });
        console.log(`  Queued: ${fileName} (${queueId})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        results.push({ fileName, status: 'error', error: errMsg });
        console.error(`  Error: ${fileName}: ${errMsg}`);
      }
    }

    // 6. Send summary email
    const queued = results.filter(r => r.status === 'queued').length;
    const errors = results.filter(r => r.status === 'error').length;

    const summaryRows = results.map(r => {
      const icon = r.status === 'queued' ? '✅' : '❌';
      const detail = r.error ? ` — ${r.error}` : '';
      return `${icon} ${r.fileName}${detail}`;
    }).join('\n');

    await sendReply(env, senderEmail, `Documents Received — ${tenant.name}`,
      `Hi ${senderName},\n\n` +
      `Your email "${subject}" was processed. ${queued} document(s) queued for processing` +
      (errors > 0 ? `, ${errors} error(s)` : '') + `.\n\n` +
      `${summaryRows}\n\n` +
      `Documents will be available in the ${tenant.name} portal after AI processing completes.\n\n` +
      `— Dox`);

    // 7. Log (just console for now — email_ingest_log requires D1 which we don't have)
    console.log(`Email ingest complete: ${senderEmail} → ${tenant.slug}, ${queued} queued, ${errors} errors`);
  },
};

// === Helpers ===

function extractSlug(recipient: string, domain: string): string | null {
  const lower = recipient.toLowerCase();
  const suffix = `@${domain.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return null;
  const slug = lower.slice(0, -suffix.length).trim();
  return slug.length > 0 ? slug : null;
}

function resolveMimeType(mimeType: string | undefined, fileName: string | undefined): string | null {
  // Try the declared MIME type first
  if (mimeType && ALLOWED_TYPES.has(mimeType)) {
    return mimeType;
  }
  // Fall back to extension
  if (fileName) {
    const ext = '.' + fileName.split('.').pop()?.toLowerCase();
    const resolved = EXT_TO_MIME[ext];
    if (resolved) return resolved;
  }
  return null;
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

async function sendReply(
  env: Env,
  to: string,
  subject: string,
  text: string
): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`No RESEND_API_KEY, skipping reply to ${to}: ${subject}`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SupDox <noreply@supdox.com>',
        to: [to],
        subject: `[Dox] ${subject}`,
        text,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`Resend error: ${res.status} ${errText}`);
    }
  } catch (err) {
    console.error('Failed to send reply:', err);
  }
}
