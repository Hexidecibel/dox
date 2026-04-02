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
      'SELECT id, tenant_id, processing_status FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{ id: string; tenant_id: string; processing_status: string }>();

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
