import { generateId, logAudit } from '../../lib/db';
import { computeChecksum } from '../../lib/r2';
import type { Env } from '../../lib/types';

/**
 * POST /api/webhooks/email-ingest
 * Receives POSTs from Mailgun/SendGrid inbound parse.
 * Authenticated via X-Webhook-Secret header (not JWT).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    // 1. Verify webhook secret
    const secret = context.request.headers.get('X-Webhook-Secret');
    if (!secret || secret !== context.env.EMAIL_WEBHOOK_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse multipart form data (Mailgun/SendGrid format)
    const formData = await context.request.formData();

    // Common fields from email parse webhooks:
    const from = (formData.get('from') as string) || (formData.get('sender') as string) || '';
    const subject = (formData.get('subject') as string) || '';

    // 3. Extract sender domain
    const domainMatch = from.match(/@([^>\s]+)/);
    if (!domainMatch) {
      return new Response(JSON.stringify({ error: 'Could not parse sender domain' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const domain = domainMatch[1].toLowerCase().trim();

    // 4. Look up tenant by domain
    const mapping = await context.env.DB.prepare(
      'SELECT * FROM email_domain_mappings WHERE domain = ? AND active = 1'
    )
      .bind(domain)
      .first<{
        id: string;
        domain: string;
        tenant_id: string;
        default_user_id: string | null;
        active: number;
      }>();

    if (!mapping) {
      return new Response(JSON.stringify({ error: 'Unknown sender domain', domain }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 5. Get the default user for this mapping (or fall back to first org_admin of tenant)
    let userId = mapping.default_user_id;
    if (!userId) {
      const admin = await context.env.DB.prepare(
        'SELECT id FROM users WHERE tenant_id = ? AND role IN (?, ?) AND active = 1 LIMIT 1'
      )
        .bind(mapping.tenant_id, 'org_admin', 'super_admin')
        .first<{ id: string }>();
      userId = admin?.id || null;
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: 'No user found for tenant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 6. Process attachments
    const results: Array<{ fileName: string; documentId?: string; status: string; error?: string }> = [];
    const skipKeys = new Set(['from', 'to', 'subject', 'body-plain', 'body-html', 'sender', 'recipient', 'stripped-text', 'stripped-html']);

    // Mailgun sends attachments as 'attachment-1', 'attachment-2', etc.
    // SendGrid sends them as 'attachment1', 'attachment2', etc. or in 'attachments' field
    for (const [key, value] of formData.entries()) {
      if (value instanceof File && value.size > 0) {
        // Skip non-attachment form fields
        if (skipKeys.has(key)) continue;

        try {
          const fileBuffer = await value.arrayBuffer();
          const docId = generateId();
          const versionId = generateId();
          const ext = value.name?.split('.').pop() || '';
          const fileName = value.name || `attachment.${ext}`;

          // Get tenant slug for R2 key
          const tenant = await context.env.DB.prepare(
            'SELECT slug FROM tenants WHERE id = ?'
          )
            .bind(mapping.tenant_id)
            .first<{ slug: string }>();
          const tenantSlug = tenant?.slug || 'unknown';
          const r2Key = `${tenantSlug}/${docId}/1/${fileName}`;

          // Store file in R2
          await context.env.FILES.put(r2Key, fileBuffer, {
            httpMetadata: { contentType: value.type || 'application/octet-stream' },
            customMetadata: { originalName: fileName, uploadedBy: userId },
          });

          const checksum = await computeChecksum(fileBuffer);
          const externalRef = `email-${domain}-${Date.now()}-${fileName}`;

          // Create document
          await context.env.DB.prepare(
            `INSERT INTO documents (id, tenant_id, title, description, current_version, status, created_by, external_ref, source_metadata)
             VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?)`
          )
            .bind(
              docId,
              mapping.tenant_id,
              fileName,
              `Ingested via email from ${from}`,
              userId,
              externalRef,
              JSON.stringify({ source: 'email', from, subject, domain })
            )
            .run();

          // Create version
          await context.env.DB.prepare(
            `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              versionId,
              docId,
              fileName,
              value.size,
              value.type || 'application/octet-stream',
              r2Key,
              checksum,
              userId
            )
            .run();

          await logAudit(
            context.env.DB,
            userId,
            mapping.tenant_id,
            'document.email_ingested',
            'document',
            docId,
            JSON.stringify({ from, subject, fileName, domain }),
            null
          );

          results.push({ fileName, documentId: docId, status: 'created' });
        } catch (err: any) {
          results.push({ fileName: value.name || 'unknown', status: 'error', error: err.message });
        }
      }
    }

    return new Response(JSON.stringify({ results, processed: results.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Email ingest webhook error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
