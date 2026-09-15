/**
 * POST /api/request-uploads/:id/enqueue — read a file nobody has read yet.
 *
 * The upload door enqueues every arrival for extraction, but deliberately never
 * fails an upload because the queue insert failed (0094). Such an arrival keeps
 * `queue_id IS NULL` and shows as "not read" on the arrivals screen; this is
 * the button behind that state. It uses the same helper the door uses.
 *
 * 409 unless `queue_id` is NULL — an arrival that is already on the queue is
 * reprocessed from the Review Queue, not enqueued twice. 410 when the bytes are
 * gone, because enqueueing a key that names nothing produces a queue item that
 * can only ever fail.
 *
 * ROLE GATE: `requireComposer` (super_admin, org_admin). Putting work on the
 * extraction queue is an operator act, not line work.
 */

import { getClientIp, logAudit } from '../../../lib/db';
import { computeChecksum } from '../../../lib/r2';
import { ConflictError, errorToResponse, NotFoundError } from '../../../lib/permissions';
import { requireComposer } from '../../../lib/document-requests';
import {
  enqueueSupplierUpload,
  loadArrival,
  resolveTenantForUpload,
} from '../../../lib/request-arrivals';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const db = context.env.DB;
    const tenantId = await resolveTenantForUpload(db, user, id);

    const upload = await db
      .prepare(
        `SELECT id, link_id, request_id, supplier_id, r2_key, file_name, file_size,
                mime_type, checksum, queue_id, document_id
           FROM request_uploads WHERE id = ? AND tenant_id = ?`,
      )
      .bind(id, tenantId)
      .first<{
        id: string;
        link_id: string;
        request_id: string;
        supplier_id: string;
        r2_key: string;
        file_name: string;
        file_size: number;
        mime_type: string;
        checksum: string | null;
        queue_id: string | null;
        document_id: string | null;
      }>();
    if (!upload) throw new NotFoundError('Arrival not found');
    if (upload.document_id) {
      throw new ConflictError('This file is already linked to a document, so there is nothing left to read.');
    }
    if (upload.queue_id) {
      throw new ConflictError(
        'This file is already in the Review Queue. Reprocess it from there if it needs reading again.',
      );
    }

    const object = await context.env.FILES.get(upload.r2_key);
    if (!object) {
      return json(
        { error: 'The file itself is no longer stored, so there is nothing to read. Ask the supplier to send it again.' },
        410,
      );
    }
    // Pre-0094 rows may lack a checksum; the queue's duplicate check needs one.
    const checksum = upload.checksum ?? (await computeChecksum(await object.arrayBuffer()));

    const ip = getClientIp(context.request);
    const { queueId, duplicate } = await enqueueSupplierUpload(db, {
      tenantId,
      supplierId: upload.supplier_id,
      requestId: upload.request_id,
      linkId: upload.link_id,
      uploadId: upload.id,
      r2Key: upload.r2_key,
      fileName: upload.file_name,
      fileSize: Number(upload.file_size),
      mimeType: upload.mime_type,
      checksum,
      ip,
      actorId: user.id,
    });
    if (duplicate) {
      // The exact file is already approved or already waiting (0107). The
      // arrival now points at that, and the ledger row can still be sent for
      // review anyway from the Review Queue.
      return json({ arrival: await loadArrival(db, tenantId, upload.id), intake_duplicate: duplicate });
    }
    if (!queueId) {
      return json({ error: 'The file could not be put on the queue. Try again shortly.' }, 500);
    }

    await logAudit(
      db,
      user.id,
      tenantId,
      'request_upload.enqueued',
      'request_upload',
      upload.id,
      JSON.stringify({ queue_id: queueId, request_id: upload.request_id }),
      ip,
    );

    return json({ arrival: await loadArrival(db, tenantId, upload.id), intake_duplicate: null });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Enqueue request upload error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
