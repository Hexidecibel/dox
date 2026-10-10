/**
 * GET    /api/update-requests/public/:token
 * POST   /api/update-requests/public/:token
 *
 * Public, unauthenticated endpoints for the recipient form at /u/<token>.
 * The token IS the auth gate; tokens are 256-bit random and single-use
 * semantically (status flips to 'responded' after submit).
 *
 * 404 covers EVERY non-fillable case: missing token, status != pending,
 * expired, archived row/sheet, a request whose row or sheet is not in the
 * request's own tenant, an inactive organisation, Records switched off. Same
 * status code and body so a token can't be probed for lifecycle state.
 *
 * What the page is given is an allow-list built field by field (C-123,
 * C-124): the sender's NAME (never an email), only the requested columns that
 * an outsider may fill, and their current values with a reference shown as a
 * name. What it sends back is coerced by column type and any id is checked
 * against the tenant (C-125).
 *
 * Rate limit: 30 reads and 5 submits per IP per request per hour. Every read
 * is audited (C-130).
 */
import { logAudit, getClientIp } from '../../../lib/db';
import { checkRateLimit, recordAttempt } from '../../../lib/ratelimit';
import { errorToResponse, BadRequestError, NotFoundError } from '../../../lib/permissions';
import {
  parseFieldsRequested,
  buildRequestFields,
  publicCurrentValues,
  cleanUpdateRequestSubmission,
  getUnavailableReason,
  applyUpdateRequestSubmission,
  markRequestResponded,
  parseRowData,
} from '../../../lib/records/updateRequests';
import { logRecordsActivity } from '../../../lib/records/helpers';
import {
  publicNotFound,
  publicSenderName,
  rateLimited,
  recordsPublicAvailable,
  takePublicView,
} from '../../../lib/records/publicView';
import { handleUpdateRequestResponse } from '../../../lib/records/workflows';
import { loadPublicBrand } from '../../../lib/tenant-brand';
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
/** Generous for a person refreshing the page; tight enough to stop a scraper. */
const VIEWS_PER_HOUR = 30;

const notFound = () => publicNotFound('Request not found');

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve a token to its request + the surrounding context the GET/POST
 * handlers both need (sheet name, row data, sender's name, columns). Returns
 * null when ANY component is missing — the public 404 hides which.
 *
 * EVERY JOIN CARRIES THE REQUEST'S TENANT. The sheet must be the request's
 * tenant's, the row must be on that sheet AND that tenant's, and the sender
 * is read only as a user of that tenant. A request row that names another
 * tenant's row or sheet -- however it came to exist -- resolves to nothing,
 * so a token can never read or write across tenants. Then the organisation
 * must be active with Records switched on.
 *
 * The sender's email is not selected: nothing on this page needs it.
 */
async function loadRequestContext(
  db: D1Database,
  token: string,
): Promise<{
  request: RecordUpdateRequestRow;
  sheetName: string;
  rowDisplayTitle: string | null;
  rowData: string | null;
  senderName: string | null;
  columns: RecordColumnRow[];
} | null> {
  const req = await db
    .prepare(
      `SELECT r.id, r.tenant_id, r.sheet_id, r.row_id, r.token, r.recipient_email, r.recipient_user_id,
              r.fields_requested, r.message, r.due_date, r.status, r.responded_at, r.expires_at,
              r.created_at, r.created_by_user_id,
              s.name AS sheet_name,
              rr.display_title AS row_display_title, rr.data AS row_data,
              u.name AS sender_name
         FROM records_update_requests r
         JOIN records_sheets s
           ON s.id = r.sheet_id AND s.tenant_id = r.tenant_id AND s.archived = 0
         JOIN records_rows rr
           ON rr.id = r.row_id AND rr.sheet_id = r.sheet_id AND rr.tenant_id = r.tenant_id AND rr.archived = 0
         LEFT JOIN users u
           ON u.id = r.created_by_user_id AND u.tenant_id = r.tenant_id
        WHERE r.token = ?`,
    )
    .bind(token)
    .first<
      RecordUpdateRequestRow & {
        sheet_name: string;
        row_display_title: string | null;
        row_data: string | null;
        sender_name: string | null;
      }
    >();
  if (!req) return null;
  if (!(await recordsPublicAvailable(db, req.tenant_id))) return null;

  const cols = await db
    .prepare(
      `SELECT id, sheet_id, tenant_id, key, label, type, config, required, is_title,
              display_order, width, archived, created_at, updated_at
         FROM records_columns
        WHERE sheet_id = ? AND tenant_id = ? AND archived = 0
        ORDER BY display_order ASC`,
    )
    .bind(req.sheet_id, req.tenant_id)
    .all<RecordColumnRow>();

  return {
    request: req,
    sheetName: req.sheet_name,
    rowDisplayTitle: req.row_display_title,
    rowData: req.row_data,
    senderName: req.sender_name,
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

    const ip = getClientIp(context.request) ?? 'unknown';
    if (!(await takePublicView(context.env.DB, 'records_update_request_view', ctx.request.id, ip, VIEWS_PER_HOUR))) {
      return rateLimited();
    }

    const tenantId = ctx.request.tenant_id;
    const requestedKeys = parseFieldsRequested(ctx.request.fields_requested);
    const fields = buildRequestFields(ctx.columns, requestedKeys);
    const currentValues = await publicCurrentValues(
      context.env.DB,
      tenantId,
      ctx.columns,
      parseRowData(ctx.rowData),
      requestedKeys,
    );

    const view: PublicUpdateRequestView = {
      request: {
        sheet_name: ctx.sheetName,
        row_title: ctx.rowDisplayTitle,
        // A name, or the organisation's. Never an address.
        sender_name: await publicSenderName(context.env.DB, tenantId, ctx.senderName),
        message: ctx.request.message,
        due_date: ctx.request.due_date,
        expires_at: ctx.request.expires_at,
      },
      fields,
      current_values: currentValues,
    };

    // The token is a bearer secret and is not written into the log.
    await logAudit(
      context.env.DB,
      null,
      tenantId,
      'records_update_request.view',
      'records_update_request',
      ctx.request.id,
      JSON.stringify({ fields: fields.length, ip }),
      ip,
    );
    // The organisation's brand (0140), from the tenant of the request this
    // token resolved to. No brand record: the payload is what it was before.
    const brand = await loadPublicBrand(context.env.DB, ctx.request.tenant_id, 'records_update_request');
    if (brand) view.brand = brand;

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

    // Coerce by column type and check every id against the tenant BEFORE
    // anything is written. A refusal here is a 400 that leaves the request
    // pending, so the recipient can correct it and send again.
    const submittedData = await cleanUpdateRequestSubmission(context.env.DB, {
      tenantId: ctx.request.tenant_id,
      columns: ctx.columns,
      requestedKeys: parseFieldsRequested(ctx.request.fields_requested),
      rawData: body.data,
      currentData: parseRowData(ctx.rowData),
    });

    // Apply changes (server enforces fields_requested whitelist).
    const { changes } = await applyUpdateRequestSubmission(context.env.DB, {
      request: ctx.request,
      columns: ctx.columns,
      submittedData,
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

    // If this UR was created by a workflow step, advance the run.
    // Best-effort: never fail the recipient submit on a workflow error.
    try {
      const origin = new URL(context.request.url).origin;
      await handleUpdateRequestResponse(
        { DB: context.env.DB, RESEND_API_KEY: context.env.RESEND_API_KEY ?? null, appOrigin: origin },
        ctx.request.id,
      );
    } catch (err) {
      console.error('Workflow advance after UR submit failed:', err);
    }

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
    // A row that went away between the lookup and the write is the same 404
    // as every other unusable state, not a differently worded one.
    if (err instanceof NotFoundError) return notFound();
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Public update request submit error:', err);
    return jsonResponse({ error: 'Submission failed' }, 500);
  }
};
