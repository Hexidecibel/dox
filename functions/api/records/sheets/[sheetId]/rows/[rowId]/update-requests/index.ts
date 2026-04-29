/**
 * GET    /api/records/sheets/:sheetId/rows/:rowId/update-requests
 * POST   /api/records/sheets/:sheetId/rows/:rowId/update-requests
 *
 * Targeted "fill these fields" requests. The POST creates a row in
 * records_update_requests, generates an unguessable token, sends an
 * email to the recipient, and writes an activity entry on the row so
 * the requester can see "You sent an update request to X" in the feed.
 *
 * Email failure NEVER fails the request — RESEND_API_KEY may not be
 * set in dev/staging, and the admin UI shows the public_url so the
 * sender can copy/paste it manually.
 */
import { generateId, logAudit, getClientIp } from '../../../../../../../lib/db';
import {
  requireRole,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../../../../../../lib/permissions';
import {
  loadSheetForUser,
  logRecordsActivity,
} from '../../../../../../../lib/records/helpers';
import {
  generateUpdateRequestToken,
  computeExpiresAt,
  normalizeFieldsRequested,
  hydrateUpdateRequest,
} from '../../../../../../../lib/records/updateRequests';
import { sendEmail, buildUpdateRequestEmail } from '../../../../../../../lib/email';
import type { Env, User } from '../../../../../../../lib/types';
import type {
  CreateUpdateRequestRequest,
  RecordColumnRow,
  RecordUpdateRequestRow,
} from '../../../../../../../../shared/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    await loadSheetForUser(context.env.DB, sheetId, user);

    // Confirm the row belongs to the sheet so we don't accidentally
    // surface another tenant's requests via a tampered URL.
    const row = await context.env.DB.prepare(
      'SELECT id FROM records_rows WHERE id = ? AND sheet_id = ?',
    )
      .bind(rowId, sheetId)
      .first<{ id: string }>();
    if (!row) throw new NotFoundError('Row not found');

    const result = await context.env.DB.prepare(
      `SELECT r.*, u.name as creator_name, rr.display_title as row_display_title
         FROM records_update_requests r
         LEFT JOIN users u ON r.created_by_user_id = u.id
         LEFT JOIN records_rows rr ON r.row_id = rr.id
         WHERE r.row_id = ?
         ORDER BY r.created_at DESC`,
    )
      .bind(rowId)
      .all<RecordUpdateRequestRow & { creator_name: string | null; row_display_title: string | null }>();

    const rows = result.results ?? [];
    const requests = rows.map((r) => hydrateUpdateRequest(r));

    return new Response(
      JSON.stringify({ requests, total: requests.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List update requests error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const sheetId = context.params.sheetId as string;
    const rowId = context.params.rowId as string;

    requireRole(user, 'super_admin', 'org_admin', 'user');

    const sheet = await loadSheetForUser(context.env.DB, sheetId, user);

    const row = await context.env.DB.prepare(
      'SELECT id, display_title FROM records_rows WHERE id = ? AND sheet_id = ? AND archived = 0',
    )
      .bind(rowId, sheetId)
      .first<{ id: string; display_title: string | null }>();
    if (!row) throw new NotFoundError('Row not found');

    const body = (await context.request.json()) as CreateUpdateRequestRequest;

    // Validate recipient_email — basic shape check; trust the renderer
    // for the rest. Lowercase + trim so dedup queries hit consistently.
    const email = (body.recipient_email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@') || email.length > 320) {
      throw new BadRequestError('A valid recipient email is required.');
    }

    // Load columns to validate fields_requested.
    const colsResult = await context.env.DB.prepare(
      'SELECT * FROM records_columns WHERE sheet_id = ? AND archived = 0 ORDER BY display_order ASC',
    )
      .bind(sheetId)
      .all<RecordColumnRow>();
    const columns = colsResult.results ?? [];

    const fieldsRequested = normalizeFieldsRequested(body.fields_requested, columns);

    // Resolve recipient_user_id: if the caller passed one, validate it
    // belongs to the same tenant. If they didn't, look up by email
    // within the tenant — best-effort, not required.
    let recipientUserId: string | null = null;
    if (body.recipient_user_id) {
      const target = await context.env.DB.prepare(
        'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
      )
        .bind(body.recipient_user_id, sheet.tenant_id)
        .first<{ id: string }>();
      if (target) recipientUserId = target.id;
    } else {
      const target = await context.env.DB.prepare(
        'SELECT id FROM users WHERE LOWER(email) = ? AND tenant_id = ?',
      )
        .bind(email, sheet.tenant_id)
        .first<{ id: string }>();
      if (target) recipientUserId = target.id;
    }

    const id = generateId();
    const token = generateUpdateRequestToken();
    const expiresAt = computeExpiresAt(body.expires_at);
    const dueDate =
      typeof body.due_date === 'string' && body.due_date.trim()
        ? body.due_date.trim()
        : null;
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim().slice(0, 2000)
        : null;

    await context.env.DB.prepare(
      `INSERT INTO records_update_requests
         (id, tenant_id, sheet_id, row_id, token, recipient_email, recipient_user_id,
          fields_requested, message, due_date, status, expires_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(
        id,
        sheet.tenant_id,
        sheetId,
        rowId,
        token,
        email,
        recipientUserId,
        JSON.stringify(fieldsRequested),
        message,
        dueDate,
        expiresAt,
        user.id,
      )
      .run();

    // Build the public URL. Origin lives in the request — no env var
    // needed because the recipient form is hosted on the same domain.
    const origin = new URL(context.request.url).origin;
    const publicUrl = `${origin}/u/${token}`;

    // ---- Activity feed entry on the row. ----
    await logRecordsActivity(context.env.DB, {
      tenantId: sheet.tenant_id,
      sheetId,
      rowId,
      actorId: user.id,
      kind: 'update_request_sent',
      details: {
        recipient_email: email,
        field_count: fieldsRequested.length,
        request_id: id,
      },
    });

    await logAudit(
      context.env.DB,
      user.id,
      sheet.tenant_id,
      'records_update_request.created',
      'records_update_request',
      id,
      JSON.stringify({ recipient_email: email, field_count: fieldsRequested.length }),
      getClientIp(context.request),
    );

    // ---- Best-effort email send. RESEND_API_KEY missing -> log + skip. ----
    let emailSent = false;
    if (context.env.RESEND_API_KEY) {
      try {
        const tmpl = buildUpdateRequestEmail({
          recipientName: null,
          senderName: user.name || user.email,
          senderEmail: user.email,
          sheetName: sheet.name,
          rowTitle: row.display_title,
          message,
          dueDate,
          fieldCount: fieldsRequested.length,
          publicUrl,
        });
        emailSent = await sendEmail(context.env.RESEND_API_KEY, {
          to: email,
          subject: tmpl.subject,
          html: tmpl.html,
        });
        if (!emailSent) {
          console.warn(`Update request ${id}: Resend rejected the send`);
        }
      } catch (err) {
        console.error('Update request email send failed:', err);
      }
    } else {
      console.warn(
        `Update request ${id}: RESEND_API_KEY not set; skipping email. Recipient must use copy-link UX.`,
      );
    }

    // Return the full row + token so the client can render the link.
    const inserted = await context.env.DB.prepare(
      `SELECT r.*, u.name as creator_name, rr.display_title as row_display_title
         FROM records_update_requests r
         LEFT JOIN users u ON r.created_by_user_id = u.id
         LEFT JOIN records_rows rr ON r.row_id = rr.id
         WHERE r.id = ?`,
    )
      .bind(id)
      .first<RecordUpdateRequestRow & { creator_name: string | null; row_display_title: string | null }>();

    if (!inserted) {
      // Should never happen — we just wrote it. But surface a meaningful
      // error rather than crashing on the response shape.
      throw new Error('Failed to load just-created update request');
    }

    return new Response(
      JSON.stringify({
        request: hydrateUpdateRequest(inserted),
        public_url: publicUrl,
        email_sent: emailSent,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create update request error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
