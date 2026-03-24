import { logAudit, getClientIp } from '../../../lib/db';
import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { downloadFile } from '../../../lib/r2';
import type { Env, User, Document, DocumentVersion } from '../../../lib/types';

/**
 * GET /api/documents/:id/download
 * Download a document version file.
 * Optional ?version=N query param (defaults to current version).
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const docId = context.params.id as string;
    const url = new URL(context.request.url);
    const requestedVersion = url.searchParams.get('version');
    const isPreview = url.searchParams.get('preview') === 'true';

    // Fetch document
    const doc = await context.env.DB.prepare(
      'SELECT * FROM documents WHERE id = ? AND status != \'deleted\''
    )
      .bind(docId)
      .first<Document>();

    if (!doc) {
      throw new NotFoundError('Document not found');
    }

    requireTenantAccess(user, doc.tenant_id);

    if (doc.current_version === 0) {
      return new Response(
        JSON.stringify({ error: 'No versions uploaded yet' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Determine which version to download
    const versionNumber = requestedVersion
      ? parseInt(requestedVersion, 10)
      : doc.current_version;

    if (isNaN(versionNumber) || versionNumber < 1) {
      return new Response(
        JSON.stringify({ error: 'Invalid version number' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch version record
    const version = await context.env.DB.prepare(
      'SELECT * FROM document_versions WHERE document_id = ? AND version_number = ?'
    )
      .bind(docId, versionNumber)
      .first<DocumentVersion>();

    if (!version) {
      throw new NotFoundError(`Version ${versionNumber} not found`);
    }

    // Get file from R2
    const r2Object = await downloadFile(context.env.FILES, version.r2_key);

    if (!r2Object) {
      return new Response(
        JSON.stringify({ error: 'File not found in storage' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Log the download
    await logAudit(
      context.env.DB,
      user.id,
      doc.tenant_id,
      'document_downloaded',
      'document_version',
      version.id,
      JSON.stringify({ document_id: docId, version: versionNumber, file_name: version.file_name }),
      getClientIp(context.request)
    );

    // Return the file with appropriate headers
    const disposition = isPreview ? 'inline' : `attachment; filename="${version.file_name}"`;
    return new Response(r2Object.body, {
      headers: {
        'Content-Type': version.mime_type || 'application/octet-stream',
        'Content-Disposition': disposition,
        'Content-Length': String(version.file_size),
        'ETag': version.checksum ? `"${version.checksum}"` : '',
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Download error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
