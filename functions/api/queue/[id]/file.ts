import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { downloadFile } from '../../../lib/r2';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/queue/:id/file
 * Stream the pending file from R2 for preview.
 * Auth: super_admin, org_admin, user
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, file_r2_key, file_name, mime_type FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{
        id: string;
        tenant_id: string;
        file_r2_key: string;
        file_name: string;
        mime_type: string;
      }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    const file = await downloadFile(context.env.FILES, item.file_r2_key);
    if (!file) {
      throw new NotFoundError('File not found in storage');
    }

    return new Response(file.body, {
      headers: {
        'Content-Type': item.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${item.file_name}"`,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Queue file download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
