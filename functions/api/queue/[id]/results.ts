import {
  requireRole,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { sendEmail } from '../../../lib/email';
import { logAudit, getClientIp } from '../../../lib/db';
import { resolveExistingSupplierId } from '../../../lib/suppliers';
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
      processing_status?: 'queued' | 'processing' | 'ready' | 'error';
      extracted_text?: string;
      ai_fields?: string;
      // P0: optional structured records sidecar (JSON string). Persisted to
      // the ai_records column for a later phase to consume; no COA behavior
      // change. Accept-and-ignore semantics if the column is somehow absent.
      ai_records?: string;
      ai_confidence?: string;
      confidence_score?: number;
      // Doc-R1: LLM self-rated numeric confidence (0..1). Null/undefined when
      // the model didn't emit one. Distinct from confidence_score (heuristic).
      confidence?: number | null;
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
      // The text model the router ACTUALLY served, including quantization
      // (e.g. "unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q5_K_M"). Mirrors vlm_model.
      // See migration 0082 — without this the served model lived only in
      // worker logs, which is how a grading pass got scored against the
      // wrong quantization after a silent failover.
      text_model?: string | null;
      // Phase 3 sidecars
      learned_field_hints?: string | null;
      uncertainty?: string | null;
    };

    if (!body.processing_status || !['queued', 'processing', 'ready', 'error'].includes(body.processing_status)) {
      throw new BadRequestError('processing_status must be "queued", "processing", "ready", or "error"');
    }

    // Verify queue item exists
    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, document_type_id, processing_status, source, source_detail, file_name, status, attempts, output_kind, source_id, connector_run_id FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{ id: string; tenant_id: string; document_type_id: string | null; processing_status: string; source: string | null; source_detail: string | null; file_name: string; status: string; attempts: number; output_kind: string | null; source_id: string | null; connector_run_id: string | null }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    // Worker resets stuck items by sending processing_status='queued'. Bump
    // the attempts counter on each reset; after MAX_ATTEMPTS, force the item
    // to 'error' so it stops bouncing back into the work pool.
    const MAX_ATTEMPTS = 3;
    let effectiveStatus = body.processing_status;
    let attemptsBump = 0;
    let forcedErrorMessage: string | null = null;
    if (body.processing_status === 'queued') {
      const nextAttempts = (item.attempts ?? 0) + 1;
      if (nextAttempts > MAX_ATTEMPTS) {
        effectiveStatus = 'error';
        forcedErrorMessage = `exceeded retry cap (${MAX_ATTEMPTS} attempts)`;
      } else {
        attemptsBump = 1;
      }
    }

    // Build update query dynamically based on provided fields
    const updates: string[] = ['processing_status = ?'];
    const params: (string | number | null)[] = [effectiveStatus];
    if (attemptsBump) {
      updates.push('attempts = attempts + 1');
    }

    if (body.extracted_text !== undefined) {
      updates.push('extracted_text = ?');
      params.push(body.extracted_text);
    }

    if (body.ai_fields !== undefined) {
      updates.push('ai_fields = ?');
      params.push(body.ai_fields);
    }

    if (body.ai_records !== undefined) {
      updates.push('ai_records = ?');
      params.push(body.ai_records);
    }

    if (body.ai_confidence !== undefined) {
      updates.push('ai_confidence = ?');
      params.push(body.ai_confidence);
    }

    if (body.confidence_score !== undefined) {
      updates.push('confidence_score = ?');
      params.push(body.confidence_score);
    }

    // Doc-R1: LLM self-rated numeric confidence. Clamp to [0, 1]; preserve
    // null (which means "no signal available" — auto-approve will NOT fire).
    if (body.confidence !== undefined) {
      let conf: number | null = null;
      if (body.confidence !== null && typeof body.confidence === 'number' && isFinite(body.confidence)) {
        conf = Math.max(0, Math.min(1, body.confidence));
      }
      updates.push('confidence = ?');
      params.push(conf);
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

    if (forcedErrorMessage !== null) {
      updates.push('error_message = ?');
      params.push(forcedErrorMessage);
    } else if (body.error_message !== undefined) {
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

    // Text-path provenance — same accept-and-store contract as vlm_model.
    // Anti-silent-degradation: every extraction records the model+quant that
    // produced it, so a later grading run can never be scored against a
    // backend that swapped underneath us (migration 0082).
    if (body.text_model !== undefined) {
      updates.push('text_model = ?');
      params.push(body.text_model);
    }

    if (body.learned_field_hints !== undefined) {
      updates.push('learned_field_hints = ?');
      params.push(body.learned_field_hints);
    }

    if (body.uncertainty !== undefined) {
      updates.push('uncertainty = ?');
      params.push(body.uncertainty);
    }

    params.push(queueId);

    await context.env.DB.prepare(
      `UPDATE processing_queue SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...params)
      .run();

    // Audit log when the worker promotes document_type_guess → document_type_id.
    // This only fires when the queue item previously had no doctype set and
    // the worker resolved one (typically from an exact fuzzyMatchDocType hit).
    if (
      body.document_type_id &&
      !item.document_type_id &&
      body.document_type_id !== item.document_type_id
    ) {
      try {
        await logAudit(
          context.env.DB,
          user.id,
          item.tenant_id,
          'queue_item.doctype_promoted',
          'processing_queue',
          queueId,
          JSON.stringify({
            document_type_id: body.document_type_id,
            document_type_guess: body.document_type_guess ?? null,
          }),
          getClientIp(context.request)
        );
      } catch {
        // Non-fatal — audit failure shouldn't break the worker.
      }
    }

    // --- Dispatch by output_kind (Review Queue v2) ---
    // The worker tags each queued item with what it extracted:
    //   coa (or NULL)  → review-assist below (template pre-fill, supplier resolve).
    //   order          → review only; ingestOrders runs on HUMAN approve.
    //   shipment       → review only; produceShipment runs on HUMAN approve.
    //
    // NO auto-produce. order/shipment now mirror COA exactly: the worker's
    // structured records (body.ai_records) + confidence are persisted onto the
    // queue item by the column update above, and the item stays in the same
    // pending/needs-review status a COA item lands in. The producers
    // (ingestOrders / produceShipment) run ONLY when a human approves the
    // reviewed records — see functions/api/queue/[id].ts#handleRecordsApprove.
    // The connector_runs rollup accounting moved there too.
    const kind = item.output_kind || 'coa';

    if (body.processing_status === 'ready' && (kind === 'order' || kind === 'shipment')) {
      // Records + confidence already persisted by the dynamic column update
      // above. Nothing to produce here — leave the item pending for review.
      return new Response(
        JSON.stringify({ success: true, id: queueId, processing_status: body.processing_status }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --- COA review-assist (NO auto-ingest) ---
    //
    // Auto-ingest of COA documents has been REMOVED: every COA item now stays
    // in the queue for human review, exactly like a low-confidence item. What
    // remains here is *assist* work that pre-fills the review form and helps
    // the reviewer:
    //   - pre-resolve a matched KNOWN supplier and store its id on the queue
    //     item (review UI pre-selects the verified supplier); raw `supplier`
    //     text is still written by the column update above.
    //   - resolve + attach the matching extraction_template and apply its
    //     field-mapping to populate the item's ai_fields (pre-filled form).
    //   - confidence is already computed + persisted by the column update.
    // We never call approveQueueItem from this handler anymore.
    if (body.processing_status === 'ready') {
      try {
        // 1. Resolve supplier from the posted supplier name via the shared
        //    read-only, alias-aware resolver (slug → name → normalized → alias,
        //    guarded by the plausibility filter). Returns null for unknown/junk.
        const supplierId: string | null = await resolveExistingSupplierId(
          context.env.DB,
          item.tenant_id,
          body.supplier
        );

        // Persist the pre-resolved known supplier id so the review UI can
        // pre-select the verified supplier. Leave null when unknown/junk.
        if (supplierId) {
          await context.env.DB.prepare(
            'UPDATE processing_queue SET supplier_id = ? WHERE id = ?'
          ).bind(supplierId, queueId).run();
        }

        // 2. Look up document_type_id (from body update or existing queue item)
        const docTypeId = body.document_type_id || item.document_type_id;

        // 3. Template lookup — attach + pre-fill the review form. No gate check,
        //    no auto-ingest; the template is only used as review assist now.
        if (supplierId && docTypeId) {
          const template = await context.env.DB.prepare(
            `SELECT et.id, et.field_mappings
             FROM extraction_templates et
             WHERE et.tenant_id = ? AND et.supplier_id = ? AND et.document_type_id = ?`
          ).bind(item.tenant_id, supplierId, docTypeId).first<{
            id: string;
            field_mappings: string;
          }>();

          if (template) {
            // Store template_id on queue item so the reviewer sees the match.
            await context.env.DB.prepare(
              'UPDATE processing_queue SET template_id = ? WHERE id = ?'
            ).bind(template.id, queueId).run();

            const fieldMappings = JSON.parse(template.field_mappings) as Array<{
              field_key: string;
              tier: string;
              required: boolean;
              aliases?: string[];
            }>;

            const aiFields = body.ai_fields ? JSON.parse(body.ai_fields) : {};

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

            // Apply the template field-mapping onto ai_fields so the review
            // form is pre-filled with normalized field_keys. We only fill keys
            // that the template maps and the extraction actually produced; we
            // do not clobber existing extracted values.
            const mappedFields: Record<string, unknown> = { ...aiFields };
            let changed = false;
            for (const mapping of fieldMappings) {
              if (mappedFields[mapping.field_key] != null && String(mappedFields[mapping.field_key]).trim() !== '') {
                continue;
              }
              const value = fuzzyFindValue(mapping.field_key, mapping.aliases || []);
              if (value != null) {
                mappedFields[mapping.field_key] = value;
                changed = true;
              }
            }

            if (changed) {
              await context.env.DB.prepare(
                'UPDATE processing_queue SET ai_fields = ? WHERE id = ?'
              ).bind(JSON.stringify(mappedFields), queueId).run();
            }
          }
        }
      } catch (assistErr) {
        // Non-fatal — review assist must never fail the results update. The
        // item simply lands in review without the pre-fill / pre-resolved
        // supplier.
        console.error('COA review-assist failed:', assistErr);
      }

      // --- Send result email for email-sourced documents ---
      if (item.source === 'email' && item.source_detail) {
        try {
          const sourceDetail = JSON.parse(item.source_detail as string);
          const senderEmail = sourceDetail.sender;

          if (senderEmail && context.env.RESEND_API_KEY) {
            const confidence = body.confidence_score || 0;
            const fileName = item.file_name;

            // COA auto-ingest has been removed — every processed COA document
            // now lands in the Review Queue, so this is always the
            // needs-review/link notification path.
            const subject = `[SupDox] Review Needed: ${fileName}`;
            const htmlBody = `
                <div style="font-family:sans-serif;max-width:600px">
                  <h2 style="color:#ed6c02">Document Needs Review</h2>
                  <p><strong>${fileName}</strong> was processed but needs human review before it can be ingested (${Math.round(confidence * 100)}% confidence).</p>
                  <p><a href="https://supdox.com/review" style="display:inline-block;padding:10px 20px;background:#1976d2;color:white;text-decoration:none;border-radius:4px">Go to Review Queue</a></p>
                  <p style="color:#666;font-size:14px">Once reviewed and approved, you'll receive a confirmation with the extracted details.</p>
                </div>`;

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
