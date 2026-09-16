/**
 * POST /api/document-exports/zip
 *
 * Take the documents somebody selected in search and hand back one archive.
 *
 * ROLE: the same bar as downloading a document one at a time — any
 * authenticated member of the tenant, READER INCLUDED. A reader may already
 * open every one of these files individually (see
 * `functions/api/documents/[id]/download.ts`, which has no role check); making
 * the zip stricter would only teach people to download eleven files by hand.
 *
 * TENANT ISOLATION IS IN THE SQL. `loadExportDocuments` scopes by tenant, so
 * an id belonging to somebody else comes back as *missing*, indistinguishable
 * from an id that never existed.
 *
 * ONE AUDIT ROW PER EXPORT, NAMING EVERY DOCUMENT. The help text has claimed
 * for a while that exports in this portal are provable; for the client-side
 * CSV button on /reports that was not true. It is true here: the row carries
 * the id list, the count, the byte total and anything that was asked for and
 * could not be included.
 *
 * VERSION PINNING IS IMPLICIT AND DELIBERATE: the CURRENT version of each
 * document, which is what the person was looking at in search. A pinned
 * historical set is what bundles are for.
 */
import { logAudit, getClientIp } from '../../lib/db';
import { requireTenantAccess, errorToResponse, BadRequestError } from '../../lib/permissions';
import {
  EXPORT_MAX_DOCUMENTS,
  buildExportZip,
  exportSizeRefusal,
  exportZipFileName,
  zipResponseBody,
  exportTotalBytes,
  loadExportDocuments,
  normalizeExportIds,
} from '../../lib/document-export';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const body = (await context.request.json()) as {
      document_ids?: unknown;
      tenant_id?: unknown;
    };

    const ids = normalizeExportIds(body.document_ids);
    if (ids.length === 0) {
      throw new BadRequestError('Select at least one document to export.');
    }
    if (ids.length > EXPORT_MAX_DOCUMENTS) {
      return json(
        {
          error:
            `One export covers at most ${EXPORT_MAX_DOCUMENTS} documents, and ` +
            `this selection is larger. Send it in smaller batches.`,
          code: 'export_too_many_documents',
          limit: EXPORT_MAX_DOCUMENTS,
        },
        413,
      );
    }

    const tenantId =
      typeof body.tenant_id === 'string' && body.tenant_id ? body.tenant_id : user.tenant_id;
    if (!tenantId) throw new BadRequestError('No organization selected for this export.');
    requireTenantAccess(user, tenantId);

    const { rows, missing_ids } = await loadExportDocuments(context.env.DB, tenantId, ids);
    if (rows.length === 0) {
      return json({ error: 'None of those documents are available to export.' }, 404);
    }

    const refusal = exportSizeRefusal(rows);
    if (refusal) {
      return json({ error: refusal, code: 'export_too_large' }, 413);
    }

    const tenant = await context.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(tenantId)
      .first<{ name: string }>();

    const built = await buildExportZip(context.env.FILES, rows, {
      tenant_name: tenant?.name ?? '',
      exported_by: user.name || user.email,
      exported_at: new Date().toISOString(),
    });

    if (built.entries.length === 0) {
      return json({ error: 'No files could be retrieved for those documents.' }, 404);
    }

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'document_export.zip',
      'document_export',
      null,
      JSON.stringify({
        document_ids: built.entries.map((e) => e.row.document_id),
        document_count: built.entries.length,
        total_bytes: exportTotalBytes(built.entries.map((e) => e.row)),
        requested_ids: ids,
        missing_ids,
        unavailable_ids: built.unavailable.map((r) => r.document_id),
      }),
      getClientIp(context.request),
    );

    const fileName = exportZipFileName();
    return new Response(zipResponseBody(built.zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // The counts the body cannot carry: a caller that asked for twelve and
        // got eleven can see that without opening the archive.
        'X-Export-Documents': String(built.entries.length),
        'X-Export-Missing': String(missing_ids.length + built.unavailable.length),
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Document export zip error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
