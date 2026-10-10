/**
 * GET /api/records/attachments/:attachmentId/download
 *
 * Authenticated download of a record-row attachment. Tenant-scoped:
 * super_admin can pull any tenant's attachment; everyone else is
 * confined to their own tenant via requireTenantAccess.
 *
 * Mirrors the documents/[id]/download.ts pattern: fetch row → check
 * tenant → stream R2 body with the right Content-Type / Disposition.
 *
 * `?preview=true` returns Content-Disposition: inline so an <img> /
 * <iframe> in the drawer can render the file directly -- BUT ONLY for a
 * type that is inert in a browser tab (`mayServeInline`: PNG, JPEG, GIF,
 * WebP, PDF). Anything else is a download whatever the query string says
 * (C-140): an attachment can come from a public form, and an SVG or an HTML
 * file drawn inline here would run in the signed-in person's session.
 *
 * Every response says `nosniff`, so a stored type is never second-guessed
 * into something executable, and carries a CSP that lets the file do nothing
 * (no script, no subresource, no form) on this origin. The PDF case leaves
 * `sandbox` off because browsers' own PDF viewers do not run under it.
 */

import { logAudit, getClientIp } from '../../../../lib/db';
import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../../lib/permissions';
import { downloadFile } from '../../../../lib/r2';
import { mayServeInline } from '../../../../lib/records/fileType';
import type { Env, User } from '../../../../lib/types';
import type { RecordRowAttachmentRow } from '../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const attachmentId = context.params.attachmentId as string;
    const url = new URL(context.request.url);
    const isPreview = url.searchParams.get('preview') === 'true';

    const att = await context.env.DB.prepare(
      `SELECT * FROM records_row_attachments
       WHERE id = ?
         AND row_id IS NOT NULL
         AND pending_token IS NULL`,
    )
      .bind(attachmentId)
      .first<RecordRowAttachmentRow>();
    if (!att) throw new NotFoundError('Attachment not found');

    requireTenantAccess(user, att.tenant_id);

    const r2Object = await downloadFile(context.env.FILES, att.r2_key);
    if (!r2Object) {
      return new Response(
        JSON.stringify({ error: 'File not found in storage' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }

    await logAudit(
      context.env.DB,
      user.id,
      att.tenant_id,
      'records_attachment_downloaded',
      'records_row_attachment',
      attachmentId,
      JSON.stringify({ row_id: att.row_id, file_name: att.file_name }),
      getClientIp(context.request),
    );

    const storedType = (att.mime_type || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    const inline = isPreview && mayServeInline(storedType);
    // The name was typed or uploaded by somebody; it goes in a quoted header.
    const safeName = (att.file_name || 'download').replace(/[\r\n"\\]/g, '_');
    const disposition = inline ? 'inline' : `attachment; filename="${safeName}"`;

    const headers: Record<string, string> = {
      // A type that will not be drawn is sent as a plain download.
      'Content-Type': inline ? storedType : mayServeInline(storedType) ? storedType : 'application/octet-stream',
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        storedType === 'application/pdf'
          ? "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
          : "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    };
    if (att.file_size != null) headers['Content-Length'] = String(att.file_size);
    if (att.checksum) headers['ETag'] = `"${att.checksum}"`;

    return new Response(r2Object.body, { headers });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Attachment download error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
