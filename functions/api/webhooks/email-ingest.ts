import { generateId, logAudit } from '../../lib/db';
import { uploadFile } from '../../lib/r2';
import { extractText } from '../../lib/extract';
import { extractFields } from '../../lib/llm';
import { computeConfidenceScore } from '../../lib/confidence';
import { sendEmail, buildEmailIngestSummaryEmail } from '../../lib/email';
import { resolveExistingSupplierId } from '../../lib/suppliers';
import type { Env } from '../../lib/types';

const ALLOWED_TYPES = [
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
];

interface EmailIngestResult {
  fileName: string;
  status: 'ingested' | 'queued' | 'skipped' | 'error';
  documentId?: string;
  queueId?: string;
  confidence?: number;
  error?: string;
}

/**
 * POST /api/webhooks/email-ingest
 * Mailgun inbound parse webhook. Receives emails with attachments,
 * maps sender domain to tenant, extracts fields via LLM, and either
 * auto-ingests (high confidence) or queues for review (low confidence).
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const formData = await context.request.formData();

    // 1. Verify Mailgun signature (if EMAIL_WEBHOOK_SECRET is set)
    if (context.env.EMAIL_WEBHOOK_SECRET) {
      const timestamp = formData.get('timestamp') as string;
      const token = formData.get('token') as string;
      const signature = formData.get('signature') as string;

      if (!timestamp || !token || !signature) {
        return jsonResponse({ error: 'Missing signature fields' }, 200);
      }

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(context.env.EMAIL_WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signed = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(timestamp + token)
      );
      const expected = Array.from(new Uint8Array(signed))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      if (expected !== signature) {
        return jsonResponse({ error: 'Invalid signature' }, 200);
      }
    }

    // 2. Extract sender email and domain
    const senderRaw = (formData.get('sender') || formData.get('from')) as string;
    if (!senderRaw) {
      return jsonResponse({ error: 'No sender' }, 200);
    }

    const senderEmail = senderRaw.match(/<([^>]+)>/)?.[1] || senderRaw.trim();
    const senderDomain = senderEmail.split('@')[1]?.toLowerCase();

    if (!senderDomain) {
      return jsonResponse({ error: 'Could not determine sender domain' }, 200);
    }

    // 3. Look up email domain mapping
    const mapping = await context.env.DB.prepare(
      `SELECT edm.tenant_id, edm.default_user_id, edm.default_document_type_id,
              t.slug AS tenant_slug, t.name AS tenant_name,
              t.extraction_context AS extraction_context
       FROM email_domain_mappings edm
       JOIN tenants t ON t.id = edm.tenant_id
       WHERE edm.domain = ? AND edm.active = 1`
    )
      .bind(senderDomain)
      .first<{
        tenant_id: string;
        default_user_id: string;
        default_document_type_id: string | null;
        tenant_slug: string;
        tenant_name: string;
        extraction_context: string | null;
      }>();

    if (!mapping) {
      console.log(`No email domain mapping for: ${senderDomain}`);
      return jsonResponse({ message: 'No tenant mapping for this domain' }, 200);
    }

    // 4. Verify default user exists and is active
    const defaultUser = await context.env.DB.prepare(
      'SELECT id FROM users WHERE id = ? AND active = 1'
    )
      .bind(mapping.default_user_id)
      .first<{ id: string }>();

    if (!defaultUser) {
      console.log(`Default user ${mapping.default_user_id} not found or inactive`);
      return jsonResponse({ error: 'Default user not found or inactive' }, 200);
    }

    // 5. Resolve the default document type id (used to scope few-shot
    //    examples). Auto-ingest config is no longer consulted: email docs
    //    always go to review.
    const documentTypeId = mapping.default_document_type_id || null;

    // 6. Few-shot examples fetched per-file after supplier detection (moved below)

    // 7. Collect attachments from form data
    const subject = (formData.get('subject') as string) || 'Email Ingest';
    const attachments: File[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith('attachment') && value instanceof File) {
        attachments.push(value);
      }
    }

    if (attachments.length === 0) {
      return jsonResponse({ message: 'No attachments found' }, 200);
    }

    // 8. Process each attachment
    const results: EmailIngestResult[] = [];

    for (let i = 0; i < attachments.length; i++) {
      const file = attachments[i];
      const fileName = file.name || `attachment-${i + 1}`;

      try {
        // Validate file type
        const mimeType = file.type || 'application/octet-stream';
        if (!ALLOWED_TYPES.includes(mimeType)) {
          results.push({
            fileName,
            status: 'skipped',
            error: `Unsupported file type: ${mimeType}`,
          });
          continue;
        }

        const fileData = await file.arrayBuffer();

        // Extract text
        const text = await extractText(fileData.slice(0), mimeType, fileName);

        // Extract fields via LLM
        let fields: Record<string, string | null> = {};
        let productNames: string[] = [];
        let confidence: 'high' | 'medium' | 'low' = 'low';
        let confidenceScore = 0.3;
        let supplier: string | null = null;

        if (text) {
          // The tenant's editable extraction_context occupies the industry-layer
          // slot. When null, extractFields falls back to the seeded default dairy
          // context (no regression).
          const tenantContext = mapping.extraction_context || undefined;

          // Initial extraction (no few-shot — need supplier first)
          const initialExtraction = await extractFields(text, context.env, {
            industryPrompt: tenantContext,
          });

          // Detect supplier from extracted fields
          const supplierKeys = ['supplier_name', 'supplier', 'manufacturer', 'vendor', 'company', 'from'];
          supplier = supplierKeys.map(k => initialExtraction.fields[k]).find(v => v != null && String(v).trim() !== '') as string | undefined || null;

          // Fetch supplier-aware few-shot examples
          let fewShotExamples: { input_text: string; corrected_output: string }[] = [];
          if (documentTypeId) {
            if (supplier) {
              const supplierExResult = await context.env.DB.prepare(
                `SELECT input_text, corrected_output FROM extraction_examples
                 WHERE document_type_id = ? AND tenant_id = ? AND supplier = ? AND score >= 0.7
                 ORDER BY score DESC, created_at DESC LIMIT 3`
              ).bind(documentTypeId, mapping.tenant_id, supplier).all();
              fewShotExamples = (supplierExResult.results || []).map(e => ({
                input_text: e.input_text as string,
                corrected_output: e.corrected_output as string,
              }));
            }

            if (fewShotExamples.length < 3) {
              const remaining = 3 - fewShotExamples.length;
              const otherExResult = await context.env.DB.prepare(
                `SELECT input_text, corrected_output FROM extraction_examples
                 WHERE document_type_id = ? AND tenant_id = ? AND (supplier IS NULL OR supplier != ?) AND score >= 0.7
                 ORDER BY score DESC, created_at DESC LIMIT ?`
              ).bind(documentTypeId, mapping.tenant_id, supplier || '', remaining).all();
              fewShotExamples = [...fewShotExamples, ...(otherExResult.results || []).map(e => ({
                input_text: e.input_text as string,
                corrected_output: e.corrected_output as string,
              }))];
            }
          }

          // Re-extract with few-shot examples if available
          const extraction = fewShotExamples.length > 0
            ? await extractFields(text, context.env, {
                examples: fewShotExamples.map(e => ({ text: e.input_text, result: e.corrected_output })),
                industryPrompt: tenantContext,
              })
            : initialExtraction;

          fields = extraction.fields;
          productNames = extraction.products;
          confidence = extraction.confidence;
          confidenceScore = computeConfidenceScore(extraction.confidence, extraction.fields);
        }

        // COA auto-ingest from email has been REMOVED. Every email-sourced
        // document is now QUEUED for human review — identical to an uploaded
        // doc — regardless of confidence, training-readiness, or the doc type's
        // auto_ingest flag. We pre-resolve a KNOWN supplier id (alias-aware,
        // read-only) and stash it on the queue item so the review UI can
        // pre-select the verified supplier, but we never create a document or
        // supplier here.
        {
          // === ALWAYS QUEUE FOR REVIEW ===
          const queueId = generateId();
          const r2Key = `pending/${mapping.tenant_slug}/${queueId}/${fileName}`;

          await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

          // Pre-resolve a known supplier (read-only; null for unknown/junk).
          let resolvedSupplierId: string | null = null;
          if (supplier) {
            try {
              resolvedSupplierId = await resolveExistingSupplierId(
                context.env.DB,
                mapping.tenant_id,
                supplier
              );
            } catch {
              // Non-critical — leave null, reviewer resolves manually.
            }
          }

          await context.env.DB.prepare(
            `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, extracted_text, ai_fields, ai_confidence, confidence_score, product_names, supplier, supplier_id, source, source_detail, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, 'pending', ?)`
          )
            .bind(
              queueId,
              mapping.tenant_id,
              documentTypeId || '',
              r2Key,
              fileName,
              file.size,
              mimeType,
              text ? text.substring(0, 100_000) : null,
              JSON.stringify(fields),
              confidence,
              confidenceScore,
              JSON.stringify(productNames),
              supplier,
              resolvedSupplierId,
              JSON.stringify({ sender: senderEmail, subject }),
              mapping.default_user_id
            )
            .run();

          // Audit log
          await logAudit(
            context.env.DB,
            mapping.default_user_id,
            mapping.tenant_id,
            'document.queued',
            'processing_queue',
            queueId,
            JSON.stringify({
              source: 'email',
              sender: senderEmail,
              file_name: fileName,
              confidence: confidenceScore,
            }),
            context.request.headers.get('cf-connecting-ip') || 'webhook'
          );

          results.push({
            fileName,
            status: 'queued',
            queueId,
            confidence: confidenceScore,
          });
        }
      } catch (err) {
        console.error(`Email ingest error for ${fileName}:`, err);
        results.push({
          fileName,
          status: 'error',
          error: err instanceof Error ? err.message : 'Processing failed',
        });
      }
    }

    // 9. Send summary email back to sender
    if (context.env.RESEND_API_KEY && results.length > 0) {
      try {
        const { subject: emailSubject, html } =
          buildEmailIngestSummaryEmail({
            senderName: senderEmail,
            tenantName: mapping.tenant_name,
            results,
          });
        await sendEmail(context.env.RESEND_API_KEY, {
          to: senderEmail,
          subject: emailSubject,
          html,
        });
      } catch {
        // Non-critical — don't fail the webhook if email send fails
      }
    }

    return jsonResponse({ message: 'Processed', results }, 200);
  } catch (err) {
    console.error('Email ingest error:', err);
    // Always return 200 to prevent email provider retries
    return jsonResponse({ error: 'Internal error' }, 200);
  }
};

function jsonResponse(
  data: Record<string, unknown>,
  status: number
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
