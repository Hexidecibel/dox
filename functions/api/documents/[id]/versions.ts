import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import type { Env, User, Document } from '../../../lib/types';

/**
 * GET /api/documents/:id/versions
 * List all versions for a document.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;

    // Fetch the document to verify access
    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    // Fetch all versions with uploader info
    const results = await context.env.DB.prepare(
      `SELECT dv.*, u.name as uploader_name, u.email as uploader_email
       FROM document_versions dv
       LEFT JOIN users u ON dv.uploaded_by = u.id
       WHERE dv.document_id = ?
       ORDER BY dv.version_number DESC`
    )
      .bind(docId)
      .all();

    return new Response(
      JSON.stringify({
        versions: results.results,
        document_id: docId,
        current_version: doc.current_version,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('List versions error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
