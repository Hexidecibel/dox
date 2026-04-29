/**
 * POST /api/forms/public/:slug/submit
 *
 * Public, unauthenticated submission. Steps:
 *   1. Verify Cloudflare Turnstile token via siteverify (server-side).
 *   2. Per-IP, per-form rate limit (10 / hour by default; tunable).
 *   3. Resolve form by slug, confirm live + public.
 *   4. Validate payload against field_config (required fields, types).
 *   5. Persist a new records_rows row (display_title, refs, activity).
 *   6. Insert a records_form_submissions row.
 *   7. Best-effort broadcast to the SheetSession DO so live viewers see
 *      the new row appear.
 *   8. Return { success, thank_you_message?, redirect_url? }.
 *
 * The handler is the only path through which the public can write to a
 * tenant's sheet, so we bias hard toward minimal information leakage:
 * 404 instead of 403 on offline/non-public forms; never echo back the
 * server-side row id; rate limit even before auth-equivalent work.
 */
import { logAudit, getClientIp } from '../../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../../lib/ratelimit';
import { errorToResponse } from '../../../../lib/permissions';
import {
  validateSubmission,
  verifyEntityRefIds,
  createRowFromSubmission,
  verifyTurnstileToken,
  broadcastRowInserted,
  parseFormSettings,
} from '../../../../lib/records/forms';
import type { Env } from '../../../../lib/types';
import type {
  PublicFormSubmitRequest,
  PublicFormSubmitResponse,
  RecordColumnRow,
  RecordFormRow,
} from '../../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const slug = context.params.slug as string;
    if (!slug) return jsonResponse({ error: 'Form not found' }, 404);

    const ip = getClientIp(context.request) ?? 'unknown';

    // Parse the body early — we'll need turnstile token + data + we
    // want to fail fast on malformed JSON.
    let body: PublicFormSubmitRequest;
    try {
      body = (await context.request.json()) as PublicFormSubmitRequest;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    // ---- Resolve form (404 covers all "unavailable" cases). ----
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

    // ---- Rate limit per IP per form. Generous but not unlimited. ----
    const rlKey = `form_submit:${form.id}:${ip}`;
    const rl = await checkRateLimit(
      context.env.DB,
      rlKey,
      RATE_LIMIT_PER_HOUR,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      return jsonResponse(
        { error: 'Rate limit exceeded. Try again later.' },
        429,
      );
    }

    // ---- Verify Turnstile token. ----
    const tokenOk = await verifyTurnstileToken(
      context.env.TURNSTILE_SECRET,
      body.turnstile_token ?? '',
      ip,
    );
    if (!tokenOk) {
      // Record the attempt so abusers don't bypass the limiter by
      // failing turnstile in a tight loop.
      await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);
      return jsonResponse(
        { error: 'Captcha verification failed. Please try again.' },
        400,
      );
    }

    // ---- Load columns + validate the payload against field_config. ----
    const colsResult = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
      .bind(form.sheet_id)
      .all<RecordColumnRow>();
    const columns = colsResult.results ?? [];

    let cleanData;
    try {
      cleanData = validateSubmission(body.data, form, columns);
      // Cross-tenant guard: ensure any entity-ref ids in the submission
      // belong to this form's tenant. Cheap (one query per ref field)
      // and prevents drive-by submission of ids enumerated elsewhere.
      await verifyEntityRefIds(
        context.env.DB,
        form.tenant_id,
        form,
        columns,
        cleanData,
      );
    } catch (err) {
      // BadRequestError from validateSubmission/verifyEntityRefIds
      // carries the user-facing message.
      const httpErr = errorToResponse(err);
      if (httpErr) return httpErr;
      throw err;
    }

    // ---- Persist row + submission record. ----
    const rowId = await createRowFromSubmission(context.env.DB, {
      sheetId: form.sheet_id,
      tenantId: form.tenant_id,
      formId: form.id,
      columns,
      data: cleanData,
    });

    const submitterMeta = {
      ip,
      user_agent: context.request.headers.get('User-Agent') ?? null,
      email:
        typeof body.submitter_email === 'string' && body.submitter_email
          ? body.submitter_email
          : null,
    };

    await context.env.DB.prepare(
      `INSERT INTO records_form_submissions
         (tenant_id, form_id, sheet_id, row_id, submitter_metadata, turnstile_verified)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
      .bind(
        form.tenant_id,
        form.id,
        form.sheet_id,
        rowId,
        JSON.stringify(submitterMeta),
      )
      .run();

    // Record attempt only AFTER a successful submit so legitimate users
    // who bounce off Turnstile a couple times don't get throttled.
    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    await logAudit(
      context.env.DB,
      null,
      form.tenant_id,
      'records_form.submitted',
      'records_form',
      form.id,
      JSON.stringify({ row_id: rowId, ip }),
      ip,
    );

    // Best-effort live update — never blocks the response.
    void broadcastRowInserted(context.env.SHEET_SESSION, form.sheet_id, rowId);

    const settings = parseFormSettings(form.settings);
    const response: PublicFormSubmitResponse = {
      success: true,
      thank_you_message: settings.thank_you_message ?? null,
      redirect_url: settings.redirect_url ?? null,
    };
    return jsonResponse(response, 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Public form submit error:', err);
    return jsonResponse({ error: 'Submission failed' }, 500);
  }
};
