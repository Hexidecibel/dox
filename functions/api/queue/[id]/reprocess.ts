import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  BadRequestError,
  errorToResponse,
} from '../../../lib/permissions';
import { logAudit, getClientIp } from '../../../lib/db';
import type { Env, User } from '../../../lib/types';

/**
 * POST /api/queue/:id/reprocess
 *
 * User-initiated reset for rows that have hit `processing_status='error'`.
 *
 * The worker's automated reset path goes through PUT /api/queue/:id/results
 * with body.processing_status='queued' and is intentionally capped by the
 * retry guard added in c27c0da — after MAX_ATTEMPTS the row is forced back
 * to 'error' so a stuck item can't bounce forever. That guard is correct for
 * the worker but means a human who wants to retry a Qwen 502 has no recovery
 * short of direct SQL.
 *
 * This endpoint bypasses the retry cap by zeroing `attempts` and clearing
 * `error_message`. Only acts on rows currently in 'error'; everything else
 * is a 400 so users can't accidentally re-queue a ready/in-flight row.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, processing_status, file_name FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{ id: string; tenant_id: string; processing_status: string; file_name: string }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    if (item.processing_status !== 'error') {
      throw new BadRequestError(
        `Cannot reprocess: item is in '${item.processing_status}', not 'error'`
      );
    }

    await context.env.DB.prepare(
      `UPDATE processing_queue
       SET processing_status = 'queued',
           attempts = 0,
           error_message = NULL
       WHERE id = ?`
    )
      .bind(queueId)
      .run();

    try {
      await logAudit(
        context.env.DB,
        user.id,
        item.tenant_id,
        'queue_item.reprocess',
        'processing_queue',
        queueId,
        JSON.stringify({ file_name: item.file_name, actor: 'user' }),
        getClientIp(context.request)
      );
    } catch {
      // Non-fatal — audit failure shouldn't block the reset.
    }

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Reprocess queue item error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
