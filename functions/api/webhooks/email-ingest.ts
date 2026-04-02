import { generateId, logAudit } from '../../lib/db';
import { uploadFile, computeChecksum, buildR2Key } from '../../lib/r2';
import { extractText } from '../../lib/extract';
import { extractFields } from '../../lib/llm';
import { computeConfidenceScore } from '../../lib/confidence';
import { sendEmail, buildEmailIngestSummaryEmail } from '../../lib/email';
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
              t.slug AS tenant_slug, t.name AS tenant_name
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

    // 5. Load document type config (naming, threshold)
    const documentTypeId = mapping.default_document_type_id || null;
    let docTypeName: string | null = null;
    let autoIngestEnabled = false;

    if (documentTypeId) {
      const docType = await context.env.DB.prepare(
        'SELECT id, name, auto_ingest FROM document_types WHERE id = ? AND active = 1'
      )
        .bind(documentTypeId)
        .first<{
          id: string;
          name: string;
          auto_ingest: number;
        }>();

      if (docType) {
        docTypeName = docType.name;
        autoIngestEnabled = !!(docType.auto_ingest);
      }
    }

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
        const fileBytes = new Uint8Array(fileData);

        // Extract text
        const text = await extractText(fileData.slice(0), mimeType, fileName);

        // Extract fields via LLM
        let fields: Record<string, string | null> = {};
        let productNames: string[] = [];
        let confidence: 'high' | 'medium' | 'low' = 'low';
        let confidenceScore = 0.3;
        let supplier: string | null = null;
        let trainingReady = false;

        const MIN_TRAINING_EXAMPLES = 3;

        if (text) {
          // Initial extraction (no few-shot — need supplier first)
          const initialExtraction = await extractFields(text, context.env);

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
            ? await extractFields(text, context.env, fewShotExamples)
            : initialExtraction;

          fields = extraction.fields;
          productNames = extraction.products;
          confidence = extraction.confidence;
          confidenceScore = computeConfidenceScore(extraction.confidence, extraction.fields);

          // Count training examples for training gate
          if (documentTypeId) {
            let exampleCount = 0;
            if (supplier) {
              const supplierExamples = await context.env.DB.prepare(
                `SELECT COUNT(*) as count FROM extraction_examples
                 WHERE document_type_id = ? AND tenant_id = ? AND supplier = ? AND score >= 0.7`
              ).bind(documentTypeId, mapping.tenant_id, supplier).first();
              exampleCount = (supplierExamples?.count as number) || 0;
            }

            if (exampleCount < MIN_TRAINING_EXAMPLES) {
              const allExamples = await context.env.DB.prepare(
                `SELECT COUNT(*) as count FROM extraction_examples
                 WHERE document_type_id = ? AND tenant_id = ? AND score >= 0.7`
              ).bind(documentTypeId, mapping.tenant_id).first();
              exampleCount = (allExamples?.count as number) || 0;
            }

            trainingReady = exampleCount >= MIN_TRAINING_EXAMPLES;
          }
        }

        // Decide: auto-ingest or queue for review
        // Training gate: if not enough training examples, ALWAYS queue for review
        if (autoIngestEnabled && trainingReady && confidenceScore >= 0.7) {
          // === AUTO-INGEST: high confidence ===
          const checksum = await computeChecksum(fileData);
          const docId = generateId();
          const versionId = generateId();
          const externalRef = `email-${Date.now()}-${i}-${senderDomain}`;
          const title = fileName.replace(/\.[^/.]+$/, '');

          // Build primary_metadata from extracted fields
          const primaryMetadata: Record<string, string | null> = {};
          for (const [k, v] of Object.entries(fields)) {
            if (v != null) primaryMetadata[k] = v;
          }
          const primaryMetadataStr = Object.keys(primaryMetadata).length > 0 ? JSON.stringify(primaryMetadata) : null;

          // Resolve supplier
          let supplierId: string | null = null;
          if (supplier) {
            try {
              // Simple lookup-or-create inline
              const slug = supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
              let existingSupplier = await context.env.DB.prepare(
                'SELECT id FROM suppliers WHERE tenant_id = ? AND slug = ?'
              ).bind(mapping.tenant_id, slug).first<{ id: string }>();

              if (!existingSupplier) {
                existingSupplier = await context.env.DB.prepare(
                  'SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
                ).bind(mapping.tenant_id, supplier).first<{ id: string }>();
              }

              if (existingSupplier) {
                supplierId = existingSupplier.id;
              } else {
                const newSupplierId = generateId();
                await context.env.DB.prepare(
                  'INSERT INTO suppliers (id, tenant_id, name, slug) VALUES (?, ?, ?, ?)'
                ).bind(newSupplierId, mapping.tenant_id, supplier, slug).run();
                supplierId = newSupplierId;
              }
            } catch {
              // Non-critical
            }
          }

          // Use original filename as-is (metadata is searchable separately)
          const displayFileName = fileName;

          // Upload to R2
          const r2Key = buildR2Key(
            mapping.tenant_slug,
            docId,
            1,
            displayFileName
          );
          await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

          // Insert document
          await context.env.DB.prepare(
            `INSERT INTO documents (id, tenant_id, title, current_version, status, created_by, external_ref, source_metadata, document_type_id, supplier_id, primary_metadata)
             VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              docId,
              mapping.tenant_id,
              title,
              mapping.default_user_id,
              externalRef,
              JSON.stringify({
                source: 'email',
                sender: senderEmail,
                subject,
              }),
              documentTypeId,
              supplierId,
              primaryMetadataStr
            )
            .run();

          // Insert version
          await context.env.DB.prepare(
            `INSERT INTO document_versions (id, document_id, version_number, file_name, file_size, mime_type, r2_key, checksum, uploaded_by, extracted_text)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              versionId,
              docId,
              displayFileName,
              file.size,
              mimeType,
              r2Key,
              checksum,
              mapping.default_user_id,
              text ? text.substring(0, 100_000) : null
            )
            .run();

          // Resolve and link products
          if (productNames.length > 0) {
            try {
              const placeholders = productNames.map(() => '?').join(',');
              const productResults = await context.env.DB.prepare(
                `SELECT id, name FROM products WHERE tenant_id = ? AND name IN (${placeholders}) AND active = 1`
              )
                .bind(mapping.tenant_id, ...productNames)
                .all();

              for (const product of productResults.results || []) {
                await context.env.DB.prepare(
                  `INSERT INTO document_products (id, document_id, product_id)
                   VALUES (?, ?, ?)
                   ON CONFLICT(document_id, product_id) DO NOTHING`
                )
                  .bind(generateId(), docId, product.id as string)
                  .run();
              }
            } catch {
              // Non-critical — don't fail the ingest if product linking fails
            }
          }

          // Audit log
          await logAudit(
            context.env.DB,
            mapping.default_user_id,
            mapping.tenant_id,
            'document.ingested',
            'document',
            docId,
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
            status: 'ingested',
            documentId: docId,
            confidence: confidenceScore,
          });
        } else {
          // === LOW CONFIDENCE: queue for review ===
          const queueId = generateId();
          const r2Key = `pending/${mapping.tenant_slug}/${queueId}/${fileName}`;

          await uploadFile(context.env.FILES, r2Key, fileData, mimeType);

          await context.env.DB.prepare(
            `INSERT INTO processing_queue (id, tenant_id, document_type_id, file_r2_key, file_name, file_size, mime_type, extracted_text, ai_fields, ai_confidence, confidence_score, product_names, supplier, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
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
