/**
 * POST /api/supplier-requests/public/:token/upload
 *
 * The unauthenticated upload behind /r/:token. One file per request, streamed
 * straight to R2, claimed against one or more items of the ask.
 *
 * THIS IS THE MOMENT THE PAGE EXISTS FOR.
 * ---------------------------------------
 * A supplier who has lived with the incumbent's portal has uploaded the same
 * allergen statement seven times, once per checklist row, and been thanked
 * seven times for it. `request_upload_lines` (migration 0092) is a many-to-many
 * on purpose, so one file can close seven rows, and the response says so in a
 * sentence. That sentence is the product argument delivered to the one person
 * who has felt the absence of it.
 *
 * WHY THERE IS NO TURNSTILE HERE — a deliberate decision, not an omission.
 * ----------------------------------------------------------------------
 * The records public form verifies Turnstile on submit; the public drop page
 * does not. Three things put this route on the drop side of that line:
 *
 *   1. The gate is already 32 bytes of entropy that must have been mailed to
 *      the holder. A form slug is a short public string an attacker can find
 *      and enumerate — that is what Turnstile is compensating for there, and
 *      it is not the situation here.
 *   2. The existing anonymous upload path skips Turnstile for an explicitly
 *      stated reason: "would be hostile to UX on a mobile camera flow." The
 *      first design constraint on this page is that a plant QA manager can
 *      photograph a certificate at their desk and have it work. A challenge
 *      widget between them and that is a supplier lost.
 *   3. The blast radius of abuse is a rate-limited pile of files in one
 *      tenant's R2 prefix, attached to one ask, that no one has reviewed. It
 *      cannot publish a document, cannot change a status a reviewer reads as
 *      truth, and cannot move the progress number.
 *
 * If abuse ever appears, the proportionate answer is per-link throttling or
 * revoking the link, both of which already exist. Reconsider only with evidence.
 *
 * SECURITY POSTURE
 *   - 404 on every "not available" reason, matching the read route.
 *   - Per (link, IP) rate limit, in a bucket disjoint from the read limiter so
 *     an upload session cannot lock the supplier out of reading their own page.
 *   - Size cap and MIME allowlist enforced server-side; the browser's accept=
 *     attribute is UX only.
 *   - An arrival is NOT a document. `request_uploads.document_id` stays NULL
 *     until a human reviews it, per the standing rule that nothing auto-ingests.
 *   - Claimed lines move to `received` and never to `accepted`, so nothing a
 *     supplier does can move the progress number they are shown.
 *
 * READING IS NOT DECIDING (migration 0094).
 * ----------------------------------------
 * The two bullets above are the rule, and they are unchanged. What changed is
 * that "nothing auto-ingests" had been implemented here as "nothing is even
 * read". Every other door in this codebase — the manual upload, the email
 * webhook, the connector drop, the S3 poller — enqueues its arrival on
 * `processing_queue` the moment it lands, so the worker extracts it and a
 * human approves the extraction afterwards. This door did not, which meant the
 * per-supplier extraction instructions and the spec-limit checking applied to
 * every intake path except the newest and most visible one.
 *
 * So the file is now enqueued on arrival, through the SAME shared helper every
 * other door uses (`functions/lib/intake/enqueue.ts`), and nothing else moves:
 *
 *   - `supplier_id` is passed, because this door knows it from the link. That
 *     is what makes the worker load the right (supplier, doc-type) extraction
 *     profile rather than extracting blind.
 *   - `created_by` is NULL. A supplier is not a user, and the column is a
 *     nullable FK to `users(id)` — a sentinel string would be an FK violation.
 *   - Lines still go to `received`, never `accepted`.
 *     `request_uploads.document_id` still stays NULL until a human approves.
 *   - A failed enqueue does NOT fail the upload. The supplier's file is in R2
 *     and their lines have moved; throwing that away because a queue INSERT
 *     failed would be the worst trade available. It is logged to the audit log
 *     as `request_link.enqueue_failed` — an operator-visible surface — and
 *     `request_uploads.queue_id` stays NULL, which is exactly the state a
 *     re-enqueue sweep would look for.
 */

import { generateId, getClientIp, logAudit } from '../../../../lib/db';
import { enqueueSupplierUpload } from '../../../../lib/request-arrivals';
import { computeChecksum } from '../../../../lib/r2';
import { checkRateLimit, recordAttempt } from '../../../../lib/ratelimit';
import { buildProgress } from '../../../../lib/document-requests';
import {
  buildUploadMessage,
  loadCurrentRequestForLink,
  loadUsableRequestLink,
  resolveItemRefs,
} from '../../../../lib/request-links';
import type { Env } from '../../../../lib/types';
import type { RequestLineRow, SupplierUploadResult } from '../../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 40;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/**
 * 25 MB. A phone photograph of a certificate is 3-8 MB and a scanned
 * multi-page audit report is rarely past 20; the cap is set above the real
 * documents and below the point where a Worker request gets unhappy.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * What a supplier may send.
 *
 * HEIC and HEIF are in the list because they are what an iPhone produces by
 * default, and a mobile-first upload path that rejects the default iPhone
 * format is not mobile-first. Archives are deliberately absent: a zip is a
 * container whose contents nobody has looked at, and the review step this
 * feeds expects one document.
 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

/**
 * Extension fallback for the mobile reality that a browser often sends
 * `application/octet-stream` (or nothing at all) for a HEIC straight off the
 * camera roll. Without this, the allowlist would reject exactly the upload the
 * page was designed around. The inferred type is what gets stored, so the
 * record still says something true.
 */
const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function notFound(): Response {
  return json({ error: 'This request is no longer available' }, 404);
}

/**
 * Sanitize a filename for use in an R2 key. The browser is not trusted: path
 * traversal, control characters and NULs all arrive in real filenames.
 */
function safeFilename(input: string): string {
  const trimmed = (input || '').replace(/^.*[\\/]/, '').trim() || 'upload';
  const cleaned = trimmed
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'upload').slice(0, 120);
}

function resolveMime(declared: string, fileName: string): string | null {
  const mime = (declared || '').toLowerCase().split(';')[0].trim();
  if (mime && mime !== 'application/octet-stream' && ALLOWED_MIME.has(mime)) return mime;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const inferred = EXTENSION_MIME[ext];
  if (inferred) return inferred;
  return null;
}

/**
 * The item handles the browser claimed this file covers.
 *
 * Accepts either repeated `item_refs` fields or one JSON array, because a
 * hand-rolled multipart body from a supplier's own integration will do one and
 * our own page does the other, and refusing either would be a support call.
 */
function readRefs(form: FormData): string[] {
  const out = new Set<string>();
  for (const v of form.getAll('item_refs')) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s) continue;
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (Array.isArray(parsed)) {
          for (const p of parsed) if (typeof p === 'string' && p.trim()) out.add(p.trim());
        }
        continue;
      } catch {
        // Fall through and treat it as a literal ref.
      }
    }
    out.add(s);
  }
  return [...out].slice(0, 200);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';
    const db = context.env.DB;

    const link = await loadUsableRequestLink(db, token);
    if (!link) return notFound();

    const rlKey = `request_link_upload:${link.id}:${ip}`;
    const rl = await checkRateLimit(db, rlKey, RATE_LIMIT_PER_HOUR, RATE_LIMIT_WINDOW_SECONDS);
    if (!rl.allowed) {
      return json({ error: 'Too many uploads. Try again shortly.' }, 429);
    }

    const request = await loadCurrentRequestForLink(db, link);
    if (!request) return notFound();
    if (request.status !== 'issued') {
      // Readable, but closed to new files. Said plainly rather than as a 404,
      // because the supplier can still see the page and deserves to know why
      // the button did nothing.
      return json({ error: 'This request has been closed and is no longer taking files.' }, 409);
    }

    const form = await context.request.formData().catch(() => null);
    if (!form) return json({ error: 'Invalid upload' }, 400);

    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'No file was attached.' }, 400);
    if (file.size <= 0) return json({ error: 'That file is empty.' }, 400);
    if (file.size > MAX_BYTES) {
      return json({ error: `Files must be under ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.` }, 413);
    }

    const safeName = safeFilename(file.name);
    const mime = resolveMime(file.type, safeName);
    if (!mime) {
      return json(
        { error: 'We can take PDFs, photos, Word, Excel or plain text. That file type is not one we can read.' },
        415,
      );
    }

    const lines = await db
      .prepare(
        `SELECT * FROM request_lines
          WHERE request_id = ? AND tenant_id = ?
          ORDER BY sort_order, created_at, rowid`,
      )
      .bind(request.id, link.tenant_id)
      .all<RequestLineRow>();
    const allLines = lines.results ?? [];

    // Unknown handles are dropped rather than rejected — an open tab from
    // before an amendment holds stale ones — so the check is that SOMETHING
    // survived, not that everything did.
    const claimedIds = await resolveItemRefs(token, allLines, readRefs(form));
    if (claimedIds.length === 0) {
      return json({ error: 'Tell us which item this file is for, then send it again.' }, 400);
    }
    const claimedSet = new Set(claimedIds);
    const claimedLines = allLines.filter((l) => claimedSet.has(l.id));

    const uploadId = generateId();
    const r2Key = `requests/${request.id}/uploads/${uploadId}/${safeName}`;

    // Buffered rather than streamed, because the intake queue's contract
    // includes a SHA-256 checksum (it is what the duplicate check compares
    // against) and there is no honest way to produce one without the bytes.
    // The 25 MB cap above is what makes this safe; the manual-upload door
    // buffers the same way at four times the size.
    const bytes = await file.arrayBuffer();
    const checksum = await computeChecksum(bytes);
    await context.env.FILES.put(r2Key, bytes, {
      httpMetadata: { contentType: mime },
    });

    const labelRaw = form.get('uploader_label');
    const uploaderLabel =
      typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, 120) : null;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const statements = [
      db
        .prepare(
          `INSERT INTO request_uploads
             (id, tenant_id, link_id, request_id, supplier_id, r2_key, file_name,
              file_size, mime_type, checksum, uploaded_at, uploader_ip, uploader_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uploadId,
          link.tenant_id,
          link.id,
          request.id,
          link.supplier_id,
          r2Key,
          safeName,
          file.size,
          mime,
          checksum,
          now,
          ip,
          uploaderLabel,
        ),
      ...claimedLines.map((l) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO request_upload_lines (id, tenant_id, upload_id, line_id)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(generateId(), link.tenant_id, uploadId, l.id),
      ),
      // `received`, never `accepted`. A file arriving is a fact; a file being
      // good enough is a judgement, and only a reviewer makes it. This is the
      // line that keeps the progress number honest, so the WHERE clause is
      // deliberately unconditional on the current status: re-sending against an
      // already-accepted item reopens it for review, which is the correct
      // reading of "here is a newer certificate".
      //
      // `accepted_document_id` goes with it (migration 0104). A reopened line
      // is not accepted FROM anything any more; leaving the pointer would have
      // the request screen name last year's certificate as the basis of a
      // verdict the newer file has just put back in question.
      ...claimedLines.map((l) =>
        db
          .prepare(
            `UPDATE request_lines
                SET status = 'received', status_changed_at = ?, updated_at = ?,
                    accepted_document_id = NULL
              WHERE id = ? AND tenant_id = ?`,
          )
          .bind(now, now, l.id, link.tenant_id),
      ),
      db
        .prepare(`UPDATE request_links SET last_upload_at = ? WHERE id = ?`)
        .bind(now, link.id),
    ];
    await db.batch(statements);

    await recordAttempt(db, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    await logAudit(
      db,
      null,
      link.tenant_id,
      'request_link.upload',
      'request_upload',
      uploadId,
      JSON.stringify({
        request_id: request.id,
        link_id: link.id,
        supplier_id: link.supplier_id,
        covered_line_count: claimedLines.length,
        file_name: safeName,
        size: file.size,
        mime,
        ip,
      }),
      ip,
    );

    // -----------------------------------------------------------------------
    // Enqueue for extraction. See READING IS NOT DECIDING in the header.
    // -----------------------------------------------------------------------
    // Everything above this point is already committed: the bytes are in R2,
    // the upload row exists, and the claimed lines have moved to `received`.
    // That ordering is the whole safety argument — this block cannot fail the
    // upload, because the upload is already done. The try/catch is belt to
    // that braces.
    //
    // EXACT DUPLICATES (0108): if these bytes are already approved or already
    // waiting in the Review Queue, the helper links this arrival to that
    // document / queue item instead of making a second card. The supplier's
    // response below is deliberately identical either way: their file was
    // received, their lines say `received`, and nothing about our internal
    // records crosses to them.
    await enqueueSupplierUpload(db, {
      tenantId: link.tenant_id,
      supplierId: link.supplier_id,
      requestId: request.id,
      linkId: link.id,
      uploadId,
      r2Key,
      fileName: safeName,
      fileSize: file.size,
      mimeType: mime,
      checksum,
      ip,
    });

    // Progress is recomputed from the freshly-written statuses rather than
    // adjusted in memory, so the number the supplier sees is the number the
    // database holds. It will not have moved — that is the point.
    const after = allLines.map((l) =>
      claimedSet.has(l.id) ? ({ ...l, status: 'received' } as RequestLineRow) : l,
    );
    const progress = buildProgress(after);
    const coveredItems = claimedLines.map((l) => l.name);

    const result: SupplierUploadResult = {
      file_name: safeName,
      covered_count: claimedLines.length,
      covered_items: coveredItems,
      message: buildUploadMessage(coveredItems.length, allLines.length),
      progress,
    };
    return json(result, 200);
  } catch (err) {
    console.error('Supplier request upload error:', err);
    return json({ error: 'That upload did not go through. Please try again.' }, 500);
  }
};

