import {
  requireRole,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
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
    };

    if (!body.processing_status || !['processing', 'ready', 'error'].includes(body.processing_status)) {
      throw new BadRequestError('processing_status must be "processing", "ready", or "error"');
    }

    // Verify queue item exists
    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, document_type_id, processing_status FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{ id: string; tenant_id: string; document_type_id: string | null; processing_status: string }>();

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

    params.push(queueId);

    await context.env.DB.prepare(
      `UPDATE processing_queue SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    // --- Template matching & auto-ingest ---
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

            // Check all required fields are present
            const requiredFieldsMet = fieldMappings
              .filter(f => f.required)
              .every(f => {
                const value = aiFields[f.field_key] ||
                  (f.aliases || []).map((a: string) => aiFields[a]).find((v: unknown) => v != null);
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
                const value = aiFields[mapping.field_key] ||
                  (mapping.aliases || []).map((a: string) => aiFields[a]).find((v: unknown) => v != null);
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
              }
            }
          }
        }
      } catch (autoIngestErr) {
        // Non-fatal — log but don't fail the results update
        console.error('Auto-ingest check failed:', autoIngestErr);
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
