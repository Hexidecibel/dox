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
 *
 * ?source=packet (rules table H1, migration 0126): instead of the version's own
 * file, the ORIGINAL PACKET that version was split out of -- "a reviewer must
 * be able to walk from any single document back to what the supplier actually
 * sent". Same access rule as the document itself (the packet belongs to the
 * same tenant), audited as its own action. 404 when the version was not split
 * from a packet or the packet's file is gone.
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

    if (url.searchParams.get('source') === 'packet') {
      const packetId = (version as { source_packet_queue_id?: string | null }).source_packet_queue_id;
      const packet = packetId
        ? await context.env.DB.prepare(
            'SELECT id, file_r2_key, file_name, mime_type FROM processing_queue WHERE id = ? AND tenant_id = ?'
          )
            .bind(packetId, doc.tenant_id)
            .first<{ id: string; file_r2_key: string; file_name: string; mime_type: string }>()
        : null;
      const packetObject = packet ? await downloadFile(context.env.FILES, packet.file_r2_key) : null;
      if (!packet || !packetObject) {
        return new Response(
          JSON.stringify({ error: 'This version was not split from a packet on file' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      await logAudit(
        context.env.DB,
        user.id,
        doc.tenant_id,
        'document_packet_source_downloaded',
        'document_version',
        version.id,
        JSON.stringify({ document_id: docId, version: versionNumber, packet_queue_id: packet.id, file_name: packet.file_name }),
        getClientIp(context.request)
      );
      const packetName = packet.file_name.replace(/"/g, '');
      return new Response(packetObject.body, {
        headers: {
          'Content-Type': packet.mime_type || 'application/pdf',
          'Content-Disposition': isPreview ? 'inline' : `attachment; filename="${packetName}"`,
        },
      });
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
