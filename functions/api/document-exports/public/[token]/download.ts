/**
 * GET /api/document-exports/public/:token/download
 *
 * The zip, for the recipient of an export email. Same archive and same
 * manifest as the signed-in download — one zipper, not two.
 *
 * THE DOCUMENT SET COMES FROM THE LINK, NEVER FROM THE REQUEST. There is no id
 * parameter here to tamper with: `loadExportLinkDocuments` reads the frozen
 * list the send recorded, so a forwarded link cannot be edited into covering
 * anything else.
 *
 * Rate limited harder than the landing read: this one moves megabytes.
 */
import { logAudit, getClientIp } from '../../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../../lib/ratelimit';
import {
  buildExportZip,
  exportSizeRefusal,
  exportZipFileName,
  zipResponseBody,
  loadExportLinkDocuments,
  loadUsableExportLink,
  recordExportLinkView,
} from '../../../../lib/document-export';
import type { Env } from '../../../../lib/types';

const RATE_LIMIT_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'These documents are no longer available' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';
    const link = await loadUsableExportLink(context.env.DB, token);
    if (!link) return notFound();

    const rlKey = `document_export_download:${link.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    const rows = await loadExportLinkDocuments(context.env.DB, link);
    if (rows.length === 0) return notFound();

    const refusal = exportSizeRefusal(rows);
    if (refusal) {
      // Only reachable if a version grew after the send; the sender was
      // refused at send time. Still says the number out loud.
      return new Response(JSON.stringify({ error: refusal, code: 'export_too_large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(link.tenant_id)
      .first<{ name: string }>();
    const sender = await context.env.DB.prepare('SELECT name, email FROM users WHERE id = ?')
      .bind(link.created_by)
      .first<{ name: string | null; email: string | null }>();

    const built = await buildExportZip(context.env.FILES, rows, {
      tenant_name: tenant?.name ?? '',
      exported_by: sender?.name || sender?.email || '',
      exported_at: link.created_at,
      on_behalf_of: link.on_behalf_of,
    });
    if (built.entries.length === 0) return notFound();

    await recordExportLinkView(context.env.DB, link.id, 'download');
    await logAudit(
      context.env.DB,
      null,
      link.tenant_id,
      'document_export_link.download',
      'document_export_link',
      link.id,
      JSON.stringify({
        document_ids: built.entries.map((e) => e.row.document_id),
        document_count: built.entries.length,
        ip,
      }),
      ip,
    );

    return new Response(zipResponseBody(built.zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${exportZipFileName()}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Document export link download error:', err);
    return notFound();
  }
};
