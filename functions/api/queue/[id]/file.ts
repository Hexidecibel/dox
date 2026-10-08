import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../../lib/permissions';
import { downloadFile } from '../../../lib/r2';
import { getClientIp } from '../../../lib/db';
import { apiKeyFileRefusal, documentsCitingPacket, documentsFromQueueItem } from '../../../lib/sharing-rule';
import type { Env, User } from '../../../lib/types';

/**
 * GET /api/queue/:id/file
 * Stream the pending file from R2 for preview.
 * Auth: super_admin, org_admin, user
 *
 * THE SHARING RULE (decision C-003, migration 0137). A file still WAITING in
 * the queue, with no documents made from it, is not a document yet: nobody
 * has approved it, it has no type a person confirmed, and the extraction
 * worker (bin/process-worker, which authenticates with an API key) MUST be
 * able to read it. That read is intake and is never asked the rule.
 *
 * Everything else this route serves is the bytes of approved documents, and
 * an API key is asked on BOTH branches: the staging object of an item that is
 * approved, split, or has documents (see the handler), and the fallback.
 *
 * The fallback serves an APPROVED DOCUMENT's bytes. That is the same file
 * `GET /api/documents/:id/download` serves, so the same rule holds: a
 * logged-in reviewer is not asked, an API key reads it only when every
 * document that came from this queue item is "send freely" (C-041, C-042).
 *
 * TWO API-KEY CALLERS READ APPROVED ITEMS, both operator tools working on
 * certificates of analysis, neither of them intake:
 *   - the read-only replay harness (bin/parity-coa -> the worker's parity mode);
 *   - bin/reprocess-multisublot, which re-queues APPROVED items so the worker
 *     re-reads them.
 * A COA type is "send freely" by default, so both keep working. An approved
 * item whose document is untyped, or of a type that is not "send freely", now
 * answers a stated 403 to a key (the worker records it as that item's error).
 * Nothing can tell the worker's key from any other key, so there is no
 * narrower rule to write; the fix for such an item is to give its document a
 * type, or to run the replay from a logged-in session.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const queueId = context.params.id as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const item = await context.env.DB.prepare(
      'SELECT id, tenant_id, file_r2_key, file_name, mime_type, status, packet_split_at FROM processing_queue WHERE id = ?'
    )
      .bind(queueId)
      .first<{
        id: string;
        tenant_id: string;
        file_r2_key: string;
        file_name: string;
        mime_type: string;
        status: string | null;
        packet_split_at: string | null;
      }>();

    if (!item) {
      throw new NotFoundError('Queue item not found');
    }

    requireTenantAccess(user, item.tenant_id);

    // THE STAGING OBJECT IS NOT ALWAYS "NOT A DOCUMENT YET" (migration 0137).
    // It outlives approval in three ways, and each one is a whole original:
    //   - the records path (a multi-lot certificate) keeps it on purpose, so
    //     the whole certificate can be sent with an order;
    //   - a split packet's parent keeps it as the record of what arrived;
    //   - any item that has produced documents and whose object was not moved.
    // So an API key is asked the rule on THIS branch too, whenever the item is
    // approved, is a split packet, or has documents made from it: the strictest
    // rule of every document that came from this file (C-041, C-042), and
    // "locked" when it is one of those and no document can be found. An item
    // still waiting, with no documents, is what intake reads and stays open.
    const madeFromIt = [
      ...new Set([
        ...(await documentsFromQueueItem(context.env.DB, item.tenant_id, queueId)),
        ...(await documentsCitingPacket(context.env.DB, item.tenant_id, queueId)),
      ]),
    ];
    if (item.status === 'approved' || item.packet_split_at || madeFromIt.length > 0) {
      const refusal = await apiKeyFileRefusal(context.env.DB, context.data, {
        user,
        tenantId: item.tenant_id,
        documentIds: madeFromIt,
        route: 'queue/file (staging object of an item with documents)',
        clientIp: getClientIp(context.request),
      });
      if (refusal) return refusal;
    }

    let file = await downloadFile(context.env.FILES, item.file_r2_key);
    let source = 'queue';
    let scoped = false;

    if (!file) {
      // APPROVE MOVES THE FILE; IT DOES NOT DESTROY IT.
      //
      // The approve path (functions/lib/kinds/coa.ts) downloads the staging
      // object, re-uploads the same bytes under a permanent document_versions
      // key, and only then deletes the staging copy. So a 404 here means
      // "this item was approved", NOT "the bytes are gone" — 451 of 457
      // approved prod items still have a live version behind them.
      //
      // Without this fallback every re-extraction, parity replay and accuracy
      // measurement silently sees an empty corpus for anything already
      // approved, and reads it as data loss. That misdiagnosis cost a full
      // session; hence the fallback rather than a comment telling you to
      // resolve the key by hand.
      //
      // Producers write external_ref as `queue-<id>` (single doc) or
      // `queue-<id>-<lot_key>` (per-record/sublot), so the prefix match finds
      // both. Ordering by file_size DESC prefers the FULL original over a
      // page-scoped per-record PDF, which is what a replay wants.
      const fallback = await context.env.DB.prepare(
        `SELECT dv.r2_key, dv.file_name, dv.mime_type, dv.file_size,
                (SELECT COUNT(*) FROM documents d2
                  WHERE d2.external_ref LIKE 'queue-' || ? || '%') AS doc_count
           FROM documents d
           JOIN document_versions dv ON dv.document_id = d.id
          WHERE d.external_ref LIKE 'queue-' || ? || '%'
          ORDER BY dv.file_size DESC, dv.version_number ASC
          LIMIT 1`
      )
        .bind(queueId, queueId)
        .first<{
          r2_key: string;
          file_name: string;
          mime_type: string;
          file_size: number;
          doc_count: number;
        }>();

      if (fallback) {
        const refusal = await apiKeyFileRefusal(context.env.DB, context.data, {
          user,
          tenantId: item.tenant_id,
          documentIds: madeFromIt,
          route: 'queue/file (approved document fallback)',
          clientIp: getClientIp(context.request),
        });
        if (refusal) return refusal;
        file = await downloadFile(context.env.FILES, fallback.r2_key);
        if (file) {
          source = 'document';
          // >1 produced document means the item was split per record, so the
          // bytes we serve are one page-scoped slice, not the original bundle.
          // Callers replaying multi-record extraction must know that.
          scoped = fallback.doc_count > 1;
        }
      }
    }

    if (!file) {
      throw new NotFoundError('File not found in storage');
    }

    return new Response(file.body, {
      headers: {
        'Content-Type': item.mime_type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${item.file_name}"`,
        'Cache-Control': 'private, max-age=300',
        // Lets a replay harness distinguish original bytes from a page-scoped
        // slice instead of silently grading the wrong thing.
        'X-File-Source': source,
        'X-File-Scoped': scoped ? 'true' : 'false',
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
