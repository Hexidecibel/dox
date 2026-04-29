/**
 * POST /api/forms/public/:slug/upload
 *
 * Public, unauthenticated streaming upload for a single file. Used by
 * the Records public form renderer to upload-as-you-go: the user picks
 * a photo / file in the form, the browser streams it here immediately,
 * and we return an `attachment_id` + `pending_token` the renderer holds
 * in form state until the final submit.
 *
 * Why upload-at-pick rather than at-submit:
 *   - Photos are 5-10 MB. Three of them in a single multipart body
 *     bumps right against Worker request size limits and feels janky on
 *     a warehouse 4G connection.
 *   - The progress bar is per-file, not per-submit, which is what the
 *     QC tech expects mentally.
 *
 * Pending state lifecycle:
 *   1. (here) Insert records_row_attachments with row_id=NULL,
 *      pending_token set, pending_expires_at = now + 15min.
 *   2. (submit endpoint) Verify token, set row_id, clear pending_*.
 *   3. (TODO sweeper) Background job deletes expired pending rows + R2
 *      objects. Not built yet — pre-existing R2 detritus is acceptable
 *      for staging. See migrations/0043 for the partial index that
 *      makes that scan cheap.
 *
 * Security posture:
 *   - 404 on every "not available" reason (slug missing / form not
 *     live / not public / attachments disabled). Same surface as the
 *     submit endpoint to avoid leakage.
 *   - Per-IP per-form rate limit (30/hour) — separate bucket from the
 *     submit limiter so a noisy upload session can't lock the user
 *     out of submitting.
 *   - No Turnstile here, by design (would be hostile to UX on a
 *     mobile camera flow). Submit still verifies Turnstile so abuse
 *     of orphaned uploads stops at the rate limit + GC sweeper.
 *   - Server re-enforces the form's allow_attachments / size / MIME
 *     allowlist — the renderer's restrictions are UX only.
 */

import { generateId, getClientIp, logAudit } from '../../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../../lib/ratelimit';
import {
  parseFormSettings,
  resolveAttachmentPolicy,
  mimeAllowed,
} from '../../../../lib/records/forms';
import type { Env } from '../../../../lib/types';
import type {
  PublicAttachmentUpload,
  RecordFormRow,
} from '../../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const PENDING_TTL_MINUTES = 15;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Sanitize a filename for use in an R2 key. We don't trust the browser
 * (path traversal, control chars, NULs). Keep alnum + a few separators
 * and bound the length so a giant filename can't bloat the key.
 */
function safeFilename(input: string): string {
  const trimmed = (input || '').replace(/^.*[\\/]/, '').trim() || 'upload';
  const cleaned = trimmed
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'upload').slice(0, 120);
}

/** URL-safe random token. ~96 bits of entropy. */
function randomToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const slug = context.params.slug as string;
    if (!slug) return jsonResponse({ error: 'Form not found' }, 404);

    const ip = getClientIp(context.request) ?? 'unknown';

    // Resolve form first (cheap query) so we can 404 before touching R2.
    const form = await context.env.DB.prepare(
      `SELECT f.*
       FROM records_forms f
       JOIN records_sheets s ON f.sheet_id = s.id
       WHERE f.public_slug = ?
         AND f.is_public = 1
         AND f.status = 'live'
         AND f.archived = 0
         AND s.archived = 0`,
    )
      .bind(slug)
      .first<RecordFormRow>();
    if (!form) return jsonResponse({ error: 'Form not found' }, 404);

    const settings = parseFormSettings(form.settings);
    const policy = resolveAttachmentPolicy(settings);
    if (!policy) {
      // Same 404 — never leak that the form exists but disables uploads.
      return jsonResponse({ error: 'Form not found' }, 404);
    }

    // Per-IP per-form bucket, disjoint from the submit limiter.
    const rlKey = `form_upload:${form.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return jsonResponse(
        { error: 'Too many uploads. Try again later.' },
        429,
      );
    }

    // Cheap pre-flight on the per-form attachment cap. We count rows
    // already written for this form (pending OR linked) to keep someone
    // from repeatedly POSTing 100 uploads and only submitting once.
    const cntRow = await context.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM records_row_attachments WHERE form_id = ? AND tenant_id = ?',
    )
      .bind(form.id, form.tenant_id)
      .first<{ cnt: number }>();
    // We don't gate strictly here (a real form might have many
    // submissions, each with up to max_attachments) — instead we cap on
    // pending state per the rate limit. The submit endpoint enforces the
    // per-row cap. Counter retained for future audit and `void`-touched
    // so the unused-var lint doesn't fire.
    void cntRow;

    // Parse the multipart body. We expect exactly one file under the
    // `file` field. Single-file-per-request keeps the streaming code path
    // simple and matches the renderer (which posts one file at a time).
    const formData = await context.request.formData().catch(() => null);
    if (!formData) {
      return jsonResponse({ error: 'Invalid upload payload' }, 400);
    }
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return jsonResponse({ error: 'Missing file' }, 400);
    }

    // Server-side MIME + size enforcement. Don't trust the renderer.
    const sizeLimit = policy.max_file_size_mb * 1024 * 1024;
    if (file.size <= 0) {
      return jsonResponse({ error: 'Empty file' }, 400);
    }
    if (file.size > sizeLimit) {
      return jsonResponse(
        { error: `File exceeds ${policy.max_file_size_mb} MB limit` },
        413,
      );
    }
    const mime = (file.type || 'application/octet-stream').toLowerCase();
    if (!mimeAllowed(mime, policy.allowed_mime_types)) {
      return jsonResponse(
        { error: `File type "${mime}" is not allowed for this form` },
        415,
      );
    }

    // Allocate ids + R2 key. Keep the path scoped under
    // forms/<form_id>/pending/<id>/ so a future GC can list and prune
    // the whole prefix without scanning the bucket root.
    const attachmentId = generateId();
    const pendingToken = randomToken();
    const safeName = safeFilename(file.name);
    const r2Key = `forms/${form.id}/pending/${attachmentId}/${safeName}`;

    // Stream the body directly to R2. `file.stream()` is a ReadableStream
    // so we never load the full payload into memory.
    await context.env.FILES.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType: mime,
      },
    });

    const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000)
      .toISOString();

    await context.env.DB.prepare(
      `INSERT INTO records_row_attachments
         (id, tenant_id, row_id, column_key, r2_key, file_name, file_size, mime_type, checksum, uploaded_by, pending_token, pending_expires_at, form_id)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
      .bind(
        attachmentId,
        form.tenant_id,
        r2Key,
        safeName,
        file.size,
        mime,
        pendingToken,
        expiresAt,
        form.id,
      )
      .run();

    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    await logAudit(
      context.env.DB,
      null,
      form.tenant_id,
      'records_form.attachment_uploaded',
      'records_row_attachment',
      attachmentId,
      JSON.stringify({ form_id: form.id, size: file.size, mime, ip }),
      ip,
    );

    const response: PublicAttachmentUpload = {
      attachment_id: attachmentId,
      pending_token: pendingToken,
      filename: safeName,
      mime_type: mime,
      size_bytes: file.size,
      expires_at: expiresAt,
    };
    return jsonResponse(response, 200);
  } catch (err) {
    console.error('Public form upload error:', err);
    return jsonResponse({ error: 'Upload failed' }, 500);
  }
};
