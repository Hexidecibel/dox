/**
 * GET    /api/update-requests/public/:token
 * POST   /api/update-requests/public/:token
 *
 * Public, unauthenticated endpoints for the recipient form at /u/<token>.
 * The token IS the auth gate; tokens are 256-bit random and single-use
 * semantically (status flips to 'responded' after submit).
 *
 * 404 covers EVERY non-fillable case: missing token, status != pending,
 * expired, archived row/sheet, etc. Same status code so a token can't
 * be probed for lifecycle state.
 *
 * Rate limit: 5 submits per IP per token per hour. Catches accidental
 * dupes from refresh-after-submit and discourages abuse.
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
import {
  parseFieldsRequested,
  buildRequestFields,
  pickCurrentValues,
  getUnavailableReason,
  applyUpdateRequestSubmission,
  markRequestResponded,
  parseRowData,
} from '../../../lib/records/updateRequests';
import { logRecordsActivity } from '../../../lib/records/helpers';
import type { Env } from '../../../lib/types';
import type {
  PublicUpdateRequestSubmitRequest,
  PublicUpdateRequestSubmitResponse,
  PublicUpdateRequestView,
  RecordColumnRow,
  RecordUpdateRequestRow,
} from '../../../../shared/types';

const RATE_LIMIT_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Request not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve a token to its full request + the surrounding context the
 * GET/POST handlers both need (sheet name, row data, sender info,
 * columns). Returns null when ANY component is missing — the public
 * 404 hides which.
 */
async function loadRequestContext(
  db: D1Database,
  token: string,
): Promise<{
  request: RecordUpdateRequestRow;
  sheetName: string;
  rowDisplayTitle: string | null;
  rowData: string | null;
  senderName: string;
  senderEmail: string;
  columns: RecordColumnRow[];
} | null> {
  const req = await db
    .prepare(
      `SELECT r.*, s.name AS sheet_name, s.archived AS sheet_archived,
              rr.display_title AS row_display_title, rr.data AS row_data, rr.archived AS row_archived,
              u.name AS sender_name, u.email AS sender_email
         FROM records_update_requests r
         JOIN records_sheets s ON r.sheet_id = s.id
         JOIN records_rows rr ON r.row_id = rr.id
         LEFT JOIN users u ON r.created_by_user_id = u.id
         WHERE r.token = ?`,
    )
    .bind(token)
    .first<
      RecordUpdateRequestRow & {
        sheet_name: string;
        sheet_archived: number;
        row_display_title: string | null;
        row_data: string | null;
        row_archived: number;
        sender_name: string | null;
        sender_email: string | null;
      }
    >();
  if (!req) return null;
  if (req.sheet_archived === 1 || req.row_archived === 1) return null;

  const cols = await db
    .prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
    .bind(req.sheet_id)
    .all<RecordColumnRow>();

  return {
    request: req,
    sheetName: req.sheet_name,
    rowDisplayTitle: req.row_display_title,
    rowData: req.row_data,
    senderName: req.sender_name ?? 'A teammate',
    senderEmail: req.sender_email ?? '',
    columns: cols.results ?? [],
  };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ctx = await loadRequestContext(context.env.DB, token);
    if (!ctx) return notFound();

    const reason = getUnavailableReason(ctx.request);
    if (reason) {
      // If expired and we hadn't flipped it yet, do that now so the
      // admin list reflects reality.
      if (reason === 'expired' && ctx.request.status === 'pending') {
        try {
          await context.env.DB.prepare(
            `UPDATE records_update_requests SET status = 'expired' WHERE id = ? AND status = 'pending'`,
          )
            .bind(ctx.request.id)
            .run();
        } catch (err) {
          console.error('Failed to flip expired request:', err);
        }
      }
      return notFound();
    }

    const requestedKeys = parseFieldsRequested(ctx.request.fields_requested);
    const fields = buildRequestFields(ctx.columns, requestedKeys);
    const currentData = parseRowData(ctx.rowData);
    const currentValues = pickCurrentValues(currentData, requestedKeys);

    const view: PublicUpdateRequestView = {
      request: {
        sheet_name: ctx.sheetName,
        row_title: ctx.rowDisplayTitle,
        sender_name: ctx.senderName,
        sender_email: ctx.senderEmail,
        message: ctx.request.message,
        due_date: ctx.request.due_date,
        expires_at: ctx.request.expires_at,
      },
      fields,
      current_values: currentValues,
    };

    return new Response(JSON.stringify(view), {
      headers: {
        'Content-Type': 'application/json',
        // Don't cache — the recipient may refresh after submitting and
        // we want the cancelled/responded state to reflect immediately.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Public update request fetch error:', err);
    return notFound();
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const token = context.params.token as string;
    if (!token) return notFound();

    const ip = getClientIp(context.request) ?? 'unknown';

    // Resolve before rate-limiting so we don't burn limiter budget on
    // 404s (those are cheap and not abuse-prone).
    const ctx = await loadRequestContext(context.env.DB, token);
    if (!ctx) return notFound();

    const reason = getUnavailableReason(ctx.request);
    if (reason) return notFound();

    // Rate limit per IP per token. 5/hour is generous for a legitimate
    // refresh-then-submit dance and tight on abuse.
    const rlKey = `update_req_submit:${ctx.request.id}:${ip}`;
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

    let body: PublicUpdateRequestSubmitRequest;
    try {
      body = (await context.request.json()) as PublicUpdateRequestSubmitRequest;
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      throw new BadRequestError('data must be an object');
    }

    // Apply changes (server enforces fields_requested whitelist).
    const { changes } = await applyUpdateRequestSubmission(context.env.DB, {
      request: ctx.request,
      columns: ctx.columns,
      submittedData: body.data,
    });

    // Flip the request to responded — even when no fields actually
    // changed, the recipient's intent was to "fulfill" the request.
    const flipped = await markRequestResponded(context.env.DB, ctx.request.id);
    if (!flipped) {
      // Race: another submit beat us to it. Treat as success — the row
      // is in a coherent state and the recipient sees the same UX.
      console.warn(`Update request ${ctx.request.id}: race during respond; ignoring`);
    }

    // Activity entry — ONE per cell change, mirroring the cell.ts
    // `cell_updated` shape so the existing activity-feed renderer in
    // RowEditPanel resolves dropdown labels, refs, etc the same way.
    // actor_id is NULL because the recipient may not be an authed user;
    // the recipient_email goes in details so the feed can render
    // "external@example.com changed Status: ..." once the renderer is
    // taught to surface details.recipient_email when actor_id is null.
    const recipientLabel = ctx.request.recipient_email;
    for (const change of changes) {
      await logRecordsActivity(context.env.DB, {
        tenantId: ctx.request.tenant_id,
        sheetId: ctx.request.sheet_id,
        rowId: ctx.request.row_id,
        actorId: null,
        kind: 'cell_updated',
        details: {
          column_key: change.column_key,
          from: change.from,
          to: change.to,
          via: 'update_request',
          recipient_email: recipientLabel,
          request_id: ctx.request.id,
        },
      });
    }

    // High-level summary entry: "Bob filled out 3 fields"
    await logRecordsActivity(context.env.DB, {
      tenantId: ctx.request.tenant_id,
      sheetId: ctx.request.sheet_id,
      rowId: ctx.request.row_id,
      actorId: null,
      kind: 'update_request_responded',
      details: {
        recipient_email: recipientLabel,
        fields_updated: changes.length,
        request_id: ctx.request.id,
      },
    });

    await recordAttempt(context.env.DB, rlKey, RATE_LIMIT_WINDOW_SECONDS);

    await logAudit(
      context.env.DB,
      null,
      ctx.request.tenant_id,
      'records_update_request.responded',
      'records_update_request',
      ctx.request.id,
      JSON.stringify({
        recipient_email: recipientLabel,
        fields_updated: changes.length,
        ip,
      }),
      ip,
    );

    const response: PublicUpdateRequestSubmitResponse = {
      success: true,
      fields_updated: changes.length,
    };
    return jsonResponse(response, 200);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Public update request submit error:', err);
    return jsonResponse({ error: 'Submission failed' }, 500);
  }
};
