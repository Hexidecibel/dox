import {
  requireRole,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { sendEmail } from '../../../lib/email';
import type { Env, User } from '../../../lib/types';

/**
 * PUT /api/queue/:id/results
 * Called by the local process worker to post extraction results.
 * Auth: API key or JWT (super_admin, org_admin, user).
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const body = (await context.request.json()) as {
      processing_status?: 'processing' | 'ready' | 'error';
      extracted_text?: string;
      ai_fields?: string;
      ai_confidence?: string;
      confidence_score?: number;
      product_names?: string;
      tables?: string;
      summary?: string;
      supplier?: string | null;
      error_message?: string;
      document_type_id?: string | null;
      document_type_guess?: string | null;
      // VLM dual-run fields (optional, populated when QWEN_VLM_MODE != 'off')
      vlm_extracted_fields?: string | null;
      vlm_extracted_tables?: string | null;
      vlm_confidence?: number | null;
      vlm_error?: string | null;
      vlm_model?: string | null;
      vlm_duration_ms?: number | null;
      vlm_extracted_at?: string | null;
    };

    if (!body.processing_status || !['processing', 'ready', 'error'].includes(body.processing_status)) {
      throw new BadRequestError('processing_status must be "processing", "ready", or "error"');
    }

    // Verify queue item exists
    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, document_type_id, processing_status, source, source_detail, file_name FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{ id: string; tenant_id: string; document_type_id: string | null; processing_status: string; source: string | null; source_detail: string | null; file_name: string }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = ['processing_status = ?'];
    const params: (string | number | null)[] = [body.processing_status];

    if (body.extracted_text !== undefined) {
      updates.push('extracted_text = ?');
      params.push(body.extracted_text);
    }

    if (body.ai_fields !== undefined) {
      updates.push('ai_fields = ?');
      params.push(body.ai_fields);
    }

    if (body.ai_confidence !== undefined) {
      updates.push('ai_confidence = ?');
      params.push(body.ai_confidence);
    }

    if (body.confidence_score !== undefined) {
      updates.push('confidence_score = ?');
      params.push(body.confidence_score);
    }

    if (body.product_names !== undefined) {
      updates.push('product_names = ?');
      params.push(body.product_names);
    }

    if (body.tables !== undefined) {
      updates.push('tables = ?');
      params.push(body.tables);
    }

    if (body.summary !== undefined) {
      updates.push('summary = ?');
      params.push(body.summary);
    }

    if (body.supplier !== undefined) {
      updates.push('supplier = ?');
      params.push(body.supplier);
    }

    if (body.error_message !== undefined) {
      updates.push('error_message = ?');
      params.push(body.error_message);
    }

    if (body.document_type_id !== undefined) {
      updates.push('document_type_id = ?');
      params.push(body.document_type_id);
    }

    if (body.document_type_guess !== undefined) {
      updates.push('document_type_guess = ?');
      params.push(body.document_type_guess);
    }

    // VLM dual-run columns — accepted but never required.
    // Any column not provided is left unchanged (preserves backward compat).
    if (body.vlm_extracted_fields !== undefined) {
      updates.push('vlm_extracted_fields = ?');
      params.push(body.vlm_extracted_fields);
    }

    if (body.vlm_extracted_tables !== undefined) {
      updates.push('vlm_extracted_tables = ?');
      params.push(body.vlm_extracted_tables);
    }

    if (body.vlm_confidence !== undefined) {
      updates.push('vlm_confidence = ?');
      params.push(body.vlm_confidence);
    }

    if (body.vlm_error !== undefined) {
      updates.push('vlm_error = ?');
      params.push(body.vlm_error);
    }

    if (body.vlm_model !== undefined) {
      updates.push('vlm_model = ?');
      params.push(body.vlm_model);
    }

    if (body.vlm_duration_ms !== undefined) {
      updates.push('vlm_duration_ms = ?');
      params.push(body.vlm_duration_ms);
    }

    if (body.vlm_extracted_at !== undefined) {
      updates.push('vlm_extracted_at = ?');
      params.push(body.vlm_extracted_at);
    }

    params.push(queueId);

    await context.env.DB.prepare(
      `UPDATE processing_queue SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    // --- Template matching & auto-ingest ---
    let wasAutoIngested = false;
    if (body.processing_status === 'ready') {
      try {
        // 1. Resolve supplier from the posted supplier name
        let supplierId: string | null = null;
        const supplierName = body.supplier;
        if (supplierName) {
          const slug = supplierName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

          // Try slug match
          let supplier = await context.env.DB.prepare(
            'SELECT id FROM suppliers WHERE tenant_id = ? AND slug = ?'
          ).bind(item.tenant_id, slug).first<{ id: string }>();

          // Try name match
          if (!supplier) {
            supplier = await context.env.DB.prepare(
              'SELECT id FROM suppliers WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
            ).bind(item.tenant_id, supplierName).first<{ id: string }>();
          }

          // Alias matching skipped — slug + name is sufficient for this hot path

          if (supplier) {
            supplierId = supplier.id;
          }
        }

        // 2. Look up document_type_id (from body update or existing queue item)
        const docTypeId = body.document_type_id || item.document_type_id;

        // 3. Template lookup
        if (supplierId && docTypeId) {
          const template = await context.env.DB.prepare(
            `SELECT et.*, dt.auto_ingest as dt_auto_ingest
             FROM extraction_templates et
             LEFT JOIN document_types dt ON et.document_type_id = dt.id
             WHERE et.tenant_id = ? AND et.supplier_id = ? AND et.document_type_id = ?`
          ).bind(item.tenant_id, supplierId, docTypeId).first<{
            id: string;
            field_mappings: string;
            auto_ingest_enabled: number;
            confidence_threshold: number;
            dt_auto_ingest: number;
          }>();

          if (template) {
            // Store template_id on queue item
            await context.env.DB.prepare(
              'UPDATE processing_queue SET template_id = ? WHERE id = ?'
            ).bind(template.id, queueId).run();

            // 4. Check auto-ingest gates
            const fieldMappings = JSON.parse(template.field_mappings) as Array<{
              field_key: string;
              tier: string;
              required: boolean;
              aliases?: string[];
            }>;

            const aiFields = body.ai_fields ? JSON.parse(body.ai_fields) : {};
            const confidenceScore = body.confidence_score || 0;

            // Fuzzy field name matching for OCR typos (e.g., log_number vs lot_number)
            const levenshtein = (a: string, b: string): number => {
              const m = a.length, n = b.length;
              if (m === 0) return n;
              if (n === 0) return m;
              const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
                Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
              );
              for (let i = 1; i <= m; i++) {
                for (let j = 1; j <= n; j++) {
                  d[i][j] = a[i - 1] === b[j - 1]
                    ? d[i - 1][j - 1]
                    : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
                }
              }
              return d[m][n];
            };

            const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

            const fuzzyFindValue = (fieldKey: string, aliases: string[]): unknown => {
              // 1. Exact match on field_key
              if (aiFields[fieldKey] != null) return aiFields[fieldKey];
              // 2. Exact match on aliases
              for (const alias of aliases) {
                if (aiFields[alias] != null) return aiFields[alias];
              }
              // 3. Fuzzy match: find AI field keys within edit distance threshold
              const targets = [fieldKey, ...aliases];
              const aiKeys = Object.keys(aiFields);
              for (const target of targets) {
                const normTarget = normalize(target);
                for (const aiKey of aiKeys) {
                  const normAiKey = normalize(aiKey);
                  const dist = levenshtein(normTarget, normAiKey);
                  // Allow distance 1 for short keys (<=6 normalized chars), distance 2 for longer
                  const threshold = normTarget.length <= 6 ? 1 : 2;
                  if (dist > 0 && dist <= threshold) {
                    return aiFields[aiKey];
                  }
                }
              }
              return null;
            };

            // Check all required fields are present
            const requiredFieldsMet = fieldMappings
              .filter(f => f.required)
              .every(f => {
                const value = fuzzyFindValue(f.field_key, f.aliases || []);
                return value != null && String(value).trim() !== '';
              });

            const shouldAutoIngest =
              template.auto_ingest_enabled === 1 &&
              template.dt_auto_ingest === 1 &&
              confidenceScore >= template.confidence_threshold &&
              requiredFieldsMet;

            if (shouldAutoIngest) {
              const { approveQueueItem } = await import('../../../lib/queue-approve');

              // Build fields from template mappings
              const mappedFields: Record<string, string> = {};
              for (const mapping of fieldMappings) {
                const value = fuzzyFindValue(mapping.field_key, mapping.aliases || []);
                if (value != null) {
                  mappedFields[mapping.field_key] = String(value);
                }
              }

              // Find product name from template field with tier='product_name'
              const productNameField = fieldMappings.find(f => f.tier === 'product_name');
              const productName = productNameField ?
                (mappedFields[productNameField.field_key] || null) : null;

              // Re-fetch full queue item for approve function
              const fullItem = await context.env.DB.prepare(
                `SELECT pq.*, t.slug as tenant_slug
                 FROM processing_queue pq
                 LEFT JOIN tenants t ON pq.tenant_id = t.id
                 WHERE pq.id = ?`
              ).bind(queueId).first();

              if (fullItem) {
                await approveQueueItem(
                  context.env.DB,
                  context.env.FILES,
                  fullItem as any,
                  {
                    fields: mappedFields,
                    productName: productName || undefined,
                    userId: user.id,
                    autoIngested: true,
                  }
                );

                // Mark as auto-ingested
                await context.env.DB.prepare(
                  'UPDATE processing_queue SET auto_ingested = 1 WHERE id = ?'
                ).bind(queueId).run();
                wasAutoIngested = true;
              }
            }
          }
        }
      } catch (autoIngestErr) {
        // Non-fatal — log but don't fail the results update
        console.error('Auto-ingest check failed:', autoIngestErr);
      }

      // --- Send result email for email-sourced documents ---
      if (item.source === 'email' && item.source_detail) {
        try {
          const sourceDetail = JSON.parse(item.source_detail as string);
          const senderEmail = sourceDetail.sender;

          if (senderEmail && context.env.RESEND_API_KEY) {
            const aiFields = body.ai_fields ? JSON.parse(body.ai_fields) : {};
            const confidence = body.confidence_score || 0;
            const fileName = item.file_name;

            let subject: string;
            let htmlBody: string;

            if (wasAutoIngested) {
              const fieldRows = Object.entries(aiFields)
                .filter(([, v]) => v != null && String(v).trim() !== '')
                .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-weight:600">${(k as string).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</td><td style="padding:4px 0">${v}</td></tr>`)
                .join('');

              subject = `[SupDox] Document Processed: ${fileName}`;
              htmlBody = `
                <div style="font-family:sans-serif;max-width:600px">
                  <h2 style="color:#2e7d32">Document Auto-Processed</h2>
                  <p><strong>${fileName}</strong> was automatically processed and ingested (${Math.round(confidence * 100)}% confidence).</p>
                  <table style="border-collapse:collapse;margin:16px 0">${fieldRows}</table>
                  <p style="color:#666;font-size:14px">This document was processed automatically based on a saved template. You can view it in the <a href="https://supdox.com/documents">document library</a>.</p>
                </div>`;
            } else {
              subject = `[SupDox] Review Needed: ${fileName}`;
              htmlBody = `
                <div style="font-family:sans-serif;max-width:600px">
                  <h2 style="color:#ed6c02">Document Needs Review</h2>
                  <p><strong>${fileName}</strong> was processed but needs human review before it can be ingested (${Math.round(confidence * 100)}% confidence).</p>
                  <p><a href="https://supdox.com/review" style="display:inline-block;padding:10px 20px;background:#1976d2;color:white;text-decoration:none;border-radius:4px">Go to Review Queue</a></p>
                  <p style="color:#666;font-size:14px">Once reviewed and approved, you'll receive a confirmation with the extracted details.</p>
                </div>`;
            }

            await sendEmail(context.env.RESEND_API_KEY, {
              to: senderEmail,
              subject,
              html: htmlBody,
            });
          }
        } catch (emailErr) {
          console.error('Result email failed:', emailErr);
          // Non-fatal
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, id: queueId, processing_status: body.processing_status }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Update queue results error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
