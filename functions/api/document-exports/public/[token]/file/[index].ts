/**
 * GET /api/document-exports/public/:token/file/:index
 *
 * One file out of an export, for a recipient who wants the single certificate
 * rather than the whole archive.
 *
 * `index` IS A POSITION IN THE LINK'S OWN LIST, NOT A DOCUMENT ID. That is the
 * whole safety property: the recipient never holds an identifier that means
 * anything outside this export, and an index outside the list is a 404 rather
 * than a lookup. Nothing here reads an id from the request.
 */
import { logAudit, getClientIp } from '../../../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../../../lib/ratelimit';
import {
  loadExportLinkDocuments,
  loadUsableExportLink,
  recordExportLinkView,
} from '../../../../../lib/document-export';
import type { Env } from '../../../../../lib/types';

const RATE_LIMIT_PER_HOUR = 100;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'That file is no longer available' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    const rawIndex = context.params.index as string;
    if (!token || rawIndex === undefined) return notFound();

    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 0) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';
    const link = await loadUsableExportLink(context.env.DB, token);
    if (!link) return notFound();

    const rlKey = `document_export_file:${link.id}:${ip}`;
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
    const row = rows[index];
    if (!row || !row.r2_key) return notFound();

    const obj = await context.env.FILES.get(row.r2_key);
    if (!obj) return notFound();

    await recordExportLinkView(context.env.DB, link.id, 'download');
    await logAudit(
      context.env.DB,
      null,
      link.tenant_id,
      'document_export_link.file',
      'document_export_link',
      link.id,
      JSON.stringify({ document_id: row.document_id, file_name: row.file_name, index, ip }),
      ip,
    );

    return new Response(obj.body, {
      headers: {
        'Content-Type': row.mime_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${row.file_name.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Document export link file error:', err);
    return notFound();
  }
};
