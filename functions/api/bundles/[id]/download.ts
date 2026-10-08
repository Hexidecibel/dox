import { zipSync } from 'fflate';
import { logAudit, getClientIp } from '../../../lib/db';
import {
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { readExportBytes, uniqueFileName } from '../../../lib/document-export';
import {
  auditQaRelease,
  exitActorForRequest,
  judgeDocumentsForExit,
  refusedHeaderValue,
  sharingRefusedResponse,
} from '../../../lib/sharing-rule';
import type { SharingRefusal } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

/** The file inside the archive that says what was left out, when anything was. */
export const BUNDLE_NOT_INCLUDED_NAME = 'NOT-INCLUDED.txt';

interface BundleItemRow {
  document_id: string;
  version_number: number | null;
  current_version: number | null;
  file_name: string | null;
  r2_key: string | null;
}

/** What `NOT-INCLUDED.txt` says about a file that storage does not hold. */
export const BUNDLE_FILE_MISSING_MESSAGE = 'The file is not in storage.';

function notIncludedText(
  bundleName: string,
  refused: SharingRefusal[],
  unavailable: { title: string; document_type_name: string | null }[],
): string {
  const n = refused.length + unavailable.length;
  const lines = [
    `Bundle: ${bundleName}`,
    '',
    `${n} document${n === 1 ? ' is' : 's are'} in this bundle but not in this archive:`,
    '',
  ];
  for (const r of refused) {
    lines.push(`- ${r.title || 'Untitled document'}${r.document_type_name ? ` (${r.document_type_name})` : ''}`);
    lines.push(`  ${r.message}`);
  }
  for (const u of unavailable) {
    lines.push(`- ${u.title || 'Untitled document'}${u.document_type_name ? ` (${u.document_type_name})` : ''}`);
    lines.push(`  ${BUNDLE_FILE_MISSING_MESSAGE}`);
  }
  lines.push('');
  return lines.join('\r\n');
}

/**
 * GET /api/bundles/:id/download
 * Download all documents in a bundle as a ZIP file.
 *
 * THE SHARING RULE (decision C-003, migration 0137). A bundle ZIP is a
 * compliance package built to be handed to somebody, so it is an exit like
 * the search ZIP and asks the same question through the same function
 * (`judgeDocumentsForExit`, exit `bundle`): a locked document never goes in;
 * one that needs QA approval goes in only when a QA releaser downloads the
 * bundle, and that download is recorded as the approval; an API key gets
 * "send freely" documents only.
 *
 * A PACKAGE MISSING A DOCUMENT MUST NOT LOOK COMPLETE. What was kept back is
 * named inside the archive (NOT-INCLUDED.txt), in the `X-Bundle-Refused`
 * headers and in the audit row; when nothing may go the answer is a 403 that
 * names every document. A file that storage does not hold is said the same
 * way (`X-Bundle-Unavailable`). A deleted document is not in the bundle.
 *
 * AUDITED. This route used to hand over a whole bundle and write nothing --
 * the one way out of the portal with no record. It now writes one
 * `bundle.downloaded` row naming every document that went.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const bundleId = context.params.id as string;
    const db = context.env.DB;

    const bundle = await db
      .prepare('SELECT * FROM document_bundles WHERE id = ?')
      .bind(bundleId)
      .first();

    if (!bundle) {
      throw new NotFoundError('Bundle not found');
    }

    const tenantId = bundle.tenant_id as string;
    requireTenantAccess(user, tenantId);

    // Get all items with their file info. The document must be this
    // organization's: a bundle row is data, and data is not trusted to have
    // stayed inside its own tenant. A DELETED document is not served -- the
    // search export has always filtered it, and this route never did.
    const items = await db
      .prepare(
        `SELECT bi.document_id, bi.version_number, d.current_version,
                dv.file_name, dv.r2_key
           FROM document_bundle_items bi
           INNER JOIN documents d ON bi.document_id = d.id AND d.tenant_id = ?
                  AND d.status != 'deleted'
           LEFT JOIN document_versions dv ON dv.document_id = d.id
             AND dv.version_number = COALESCE(bi.version_number, d.current_version)
          WHERE bi.bundle_id = ?
          ORDER BY bi.sort_order ASC, bi.created_at ASC`,
      )
      .bind(tenantId, bundleId)
      .all<BundleItemRow>();

    const rows = items.results ?? [];
    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Bundle has no items' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const actor = await exitActorForRequest(db, context.data, user, tenantId);
    const judged = await judgeDocumentsForExit(
      db,
      tenantId,
      rows.map((r) => r.document_id),
      'bundle',
      actor,
    );
    const allowed = new Set(judged.allowed);
    const clientIp = getClientIp(context.request);

    if (allowed.size === 0 && judged.refused.length > 0) {
      await logAudit(
        db,
        user.id,
        tenantId,
        'bundle.download_refused',
        'bundle',
        bundleId,
        JSON.stringify({ refused: judged.refused, via: actor.method }),
        clientIp,
      );
      return sharingRefusedResponse(judged.refused);
    }

    // Build files object for ZIP
    const files: Record<string, Uint8Array> = {};
    const taken = new Set<string>([BUNDLE_NOT_INCLUDED_NAME]);
    const sent: { document_id: string; version_number: number | null; file_name: string }[] = [];
    const unavailable: string[] = [];
    for (const item of rows) {
      if (!allowed.has(item.document_id)) continue;
      const buffer = await readExportBytes(context.env.FILES, item.r2_key);
      if (!buffer) {
        unavailable.push(item.document_id);
        continue;
      }
      const name = uniqueFileName(taken, item.file_name || 'unnamed');
      files[name] = new Uint8Array(buffer);
      sent.push({
        document_id: item.document_id,
        version_number: item.version_number ?? item.current_version,
        file_name: name,
      });
    }

    if (sent.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No files could be retrieved' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // A file missing from storage is left out too, and that is SAID in the
    // same three places as a refusal: the note in the archive, a header, and
    // the audit row. It used to be recorded only in the audit row.
    if (judged.refused.length > 0 || unavailable.length > 0) {
      files[BUNDLE_NOT_INCLUDED_NAME] = new TextEncoder().encode(
        notIncludedText(
          String(bundle.name ?? ''),
          judged.refused,
          unavailable.map((id) => ({
            title: judged.rules.get(id)?.title ?? '',
            document_type_name: judged.rules.get(id)?.document_type_name ?? null,
          })),
        ),
      );
    }

    const zipped = zipSync(files);

    await logAudit(
      db,
      user.id,
      tenantId,
      'bundle.downloaded',
      'bundle',
      bundleId,
      JSON.stringify({
        bundle_name: bundle.name,
        documents: sent,
        document_count: sent.length,
        unavailable_ids: unavailable,
        refused: judged.refused.map((r) => ({ document_id: r.document_id, rule: r.rule, reason: r.reason })),
        qa_released_ids: judged.qa_released,
        via: actor.method,
      }),
      clientIp,
    );
    const went = new Set(sent.map((s) => s.document_id));
    await auditQaRelease(db, {
      userId: user.id,
      tenantId,
      exit: 'bundle',
      documentIds: judged.qa_released.filter((id) => went.has(id)),
      resourceType: 'bundle',
      resourceId: bundleId,
      clientIp,
    });

    // Sanitize bundle name for filename
    const safeName = (bundle.name as string)
      .replace(/[^a-zA-Z0-9_\-. ]/g, '')
      .trim() || 'bundle';

    return new Response(zipped, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeName}.zip"`,
        'X-Bundle-Documents': String(sent.length),
        'X-Bundle-Refused': String(judged.refused.length),
        ...(judged.refused.length > 0 ? { 'X-Bundle-Refused-Ids': refusedHeaderValue(judged.refused) } : {}),
        // Files storage does not hold: how many, and which documents.
        'X-Bundle-Unavailable': String(unavailable.length),
        ...(unavailable.length > 0 ? { 'X-Bundle-Unavailable-Ids': unavailable.join(',') } : {}),
      },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Download bundle error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
