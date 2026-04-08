import PostalMime from 'postal-mime';

interface Env {
  DOX_API_BASE: string;
  EMAIL_DOMAIN: string;
  EMAIL_INGEST_API_KEY: string;
  RESEND_API_KEY: string;
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

    // 1. Extract tenant slug from recipient
    const slug = extractSlug(recipientEmail, env.EMAIL_DOMAIN);
    if (!slug) {
      console.error(`Could not extract tenant slug from: ${recipientEmail}`);
      await sendReply(env, senderEmail, 'Delivery Failed',
        `The address ${recipientEmail} is not a valid document inbox. Expected format: {organization}@${env.EMAIL_DOMAIN}`);
      return;
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
        from: 'Dox <noreply@cush.rocks>',
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
