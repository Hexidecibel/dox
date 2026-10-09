/**
 * Telling QA about a document order (migration 0138, decision C-044).
 *
 * THREE CAUSES, ONE MAIL PER SEND, ONCE PER LINE PER CAUSE:
 *
 *   pending_qa  a document needs QA approval and the person sending cannot
 *               give it; it is held until QA releases or refuses it.
 *   missing     sales ordered a document that is not on file.
 *   expired     sales ordered a document whose current copy has expired.
 *
 * NOTHING HERE WRITES TO A SUPPLIER, and nothing here drafts anything to one.
 * AJ: "If sales orders something missing or expired, QA gets notified. Nothing
 * goes to a supplier without QA." The mail goes to the organization's own QA
 * route and says what was asked for; what QA does next is QA's.
 *
 * THE ROUTE IS THE `QA` OWNER ROUTE, WITH NO ADMIN FALLBACK -- the
 * expired-on-arrival pattern (functions/lib/expired-on-arrival.ts). An
 * organization with no QA route gets a `routing_gap` audit row and a separate
 * notice to its administrators and master user that says nobody on a QA route
 * was told; it is never quietly re-broadcast as though QA had been.
 *
 * A LINE IS STAMPED ONLY WHEN A MAIL ACTUALLY LEFT. A notice that could not
 * be sent is tried again on the next send of the order.
 */

import { logAudit } from './db';
import { sendEmail } from './email';
import { resolveAlertRouting, resolveTenantAdmins, type AlertRecipient } from './alert-routing';
import { loadMasterUser } from './renewal-requests';
import { QA_RELEASE_OWNER_LABEL } from './sharing-rule';
import { humanDay } from '../../shared/orderSend';
import type { OrderDocumentQaCause } from '../../shared/orderDocuments';
import type { OrderDocumentQaNotice } from '../../shared/types';

export interface QaNoticeItem {
  order_document_id: string;
  cause: OrderDocumentQaCause;
  product_name: string | null;
  supplier_name: string | null;
  facility_name: string | null;
  document_type_name: string | null;
  document_title: string | null;
  due_date: string | null;
}

export interface QaNoticeArgs {
  tenantId: string;
  tenantName: string;
  appUrl: string;
  order: { id: string; order_number: string; customer_name: string | null };
  requestedBy: { id: string; name: string | null; email: string };
  items: QaNoticeItem[];
  clientIp: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CAUSE_HEADINGS: Record<OrderDocumentQaCause, string> = {
  pending_qa: 'Waiting for your approval',
  missing: 'Ordered, and not on file',
  expired: 'Ordered, and expired',
};

/** The internal notice. Internal names are fine here: it never leaves the organization. */
export function buildOrderDocumentQaEmail(params: {
  tenantName: string;
  appUrl: string;
  order: QaNoticeArgs['order'];
  requestedBy: QaNoticeArgs['requestedBy'];
  items: QaNoticeItem[];
  routingGap?: boolean;
}): { subject: string; html: string } {
  const pending = params.items.filter((i) => i.cause === 'pending_qa').length;
  const absent = params.items.length - pending;
  const bits: string[] = [];
  if (pending > 0) bits.push(`${pending} waiting for QA approval`);
  if (absent > 0) bits.push(`${absent} missing or expired`);
  const subject = `${params.tenantName}: order ${params.order.order_number} - ${bits.join(', ')}`;

  const base = params.appUrl.replace(/\/$/, '');
  const orderUrl = `${base}/orders/${params.order.id}`;
  const waitingUrl = `${base}/orders/waiting-for-qa`;
  const who = params.requestedBy.name || params.requestedBy.email;

  const row = (i: QaNoticeItem) => {
    const what = [i.document_type_name ?? 'Document', i.supplier_name, i.facility_name ? `plant ${i.facility_name}` : null]
      .filter(Boolean)
      .map((s) => escapeHtml(String(s)))
      .join(' &middot; ');
    const detail = [
      i.product_name ? `For ${i.product_name}` : null,
      i.document_title ? `"${i.document_title}"` : null,
      i.cause === 'expired' && i.due_date ? `expired ${humanDay(i.due_date)}` : null,
    ]
      .filter(Boolean)
      .map((s) => escapeHtml(String(s)))
      .join(' &middot; ');
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
        <div style="color:#333;font-weight:600;">${what}</div>
        ${detail ? `<div style="color:#666;font-size:13px;">${detail}</div>` : ''}
      </td></tr>`;
  };

  const section = (cause: OrderDocumentQaCause) => {
    const list = params.items.filter((i) => i.cause === cause);
    if (list.length === 0) return '';
    return `<p style="margin:16px 0 8px;color:#333;font-weight:600;">${CAUSE_HEADINGS[cause]} (${list.length})</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${list.map(row).join('')}</table>`;
  };

  const gap = params.routingGap
    ? `<p style="margin:0 0 16px;padding:12px 16px;background:#fff8e1;border-left:3px solid #f59e0b;color:#333;line-height:1.6;">
         Nobody is on the QA owner route, so nobody in QA was told about this. You are getting it as an administrator.
         Add a QA route under Settings &gt; Owner Routing so these reach the right person.
       </p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr><td style="background:#1A365D;padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Document order ${escapeHtml(params.order.order_number)}</h1>
      <p style="margin:6px 0 0;color:#cbd5e0;font-size:13px;">${escapeHtml(params.tenantName)}${params.order.customer_name ? ` &middot; for ${escapeHtml(params.order.customer_name)}` : ''}</p>
    </td></tr>
    <tr><td style="padding:32px;">
      ${gap}
      <p style="margin:0 0 8px;color:#555;line-height:1.6;">${escapeHtml(who)} sent a document order that needs QA.</p>
      ${section('pending_qa')}
      ${section('missing')}
      ${section('expired')}
      <p style="margin:24px 0 0;text-align:center;">
        <a href="${escapeHtml(pending > 0 ? waitingUrl : orderUrl)}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;">${pending > 0 ? 'Review what is waiting' : 'Open the order'}</a>
      </p>
      <p style="margin:16px 0 0;color:#666;font-size:13px;line-height:1.6;">
        The order: <a href="${escapeHtml(orderUrl)}">${escapeHtml(orderUrl)}</a><br>
        Nothing has been sent or drafted to a supplier. A document that is missing or expired is yours to request.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

/** The organization's administrators plus its master user, each address once. */
async function gapRecipients(db: D1Database, tenantId: string): Promise<AlertRecipient[]> {
  const admins = await resolveTenantAdmins(db, tenantId);
  const seen = new Set(admins.map((a) => a.email.toLowerCase()));
  try {
    const master = await loadMasterUser(db, tenantId);
    if (master && master.email && !seen.has(master.email.toLowerCase())) {
      admins.push({ email: master.email, name: master.name });
    }
  } catch {
    // No master user to add.
  }
  return admins;
}

async function stamp(db: D1Database, tenantId: string, items: QaNoticeItem[]): Promise<void> {
  const stmt = db.prepare(
    `UPDATE order_documents
        SET qa_notified_at = datetime('now'), qa_notified_cause = ?, updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?`,
  );
  for (let i = 0; i < items.length; i += 50) {
    await db.batch(items.slice(i, i + 50).map((it) => stmt.bind(it.cause, it.order_document_id, tenantId)));
  }
}

/**
 * Tell QA about the lines given. Returns null when there is nothing to tell.
 * Never throws: the order's own send has already happened by the time this
 * runs, and a notice must not turn it into an error.
 */
export async function notifyQaAboutOrderDocuments(
  db: D1Database,
  apiKey: string | undefined,
  args: QaNoticeArgs,
): Promise<OrderDocumentQaNotice | null> {
  if (args.items.length === 0) return null;
  const notice: OrderDocumentQaNotice = { line_count: args.items.length, sent: false, via: 'none', recipients: [] };
  try {
    // Only the owner route is asked. The (supplier, document type) assignment
    // rung is for a review queue's owner, not for who may release a document.
    const routing = await resolveAlertRouting(db, {
      tenantId: args.tenantId,
      ownerLabel: QA_RELEASE_OWNER_LABEL,
      adminFallback: false,
    });
    const details = {
      order_id: args.order.id,
      order_number: args.order.order_number,
      requested_by: args.requestedBy.id,
      lines: args.items.map((i) => ({ order_document_id: i.order_document_id, cause: i.cause })),
    };

    if (routing.recipients.length === 0) {
      notice.via = 'routing_gap';
      await logAudit(
        db,
        args.requestedBy.id,
        args.tenantId,
        'order.documents_qa_notice.routing_gap',
        'order',
        args.order.id,
        JSON.stringify({ owner_label: QA_RELEASE_OWNER_LABEL, ...details }),
        args.clientIp,
      );
      if (!apiKey) return notice;
      const admins = await gapRecipients(db, args.tenantId);
      if (admins.length === 0) return notice;
      const mail = buildOrderDocumentQaEmail({ ...args, routingGap: true });
      if (await sendEmail(apiKey, { to: admins.map((a) => a.email), subject: mail.subject, html: mail.html })) {
        notice.sent = true;
        notice.recipients = admins.map((a) => a.email);
        await stamp(db, args.tenantId, args.items);
      }
      return notice;
    }

    notice.via = 'owner_route';
    if (!apiKey) return notice;
    const mail = buildOrderDocumentQaEmail(args);
    const to = routing.recipients.map((r) => r.email);
    if (await sendEmail(apiKey, { to, subject: mail.subject, html: mail.html })) {
      notice.sent = true;
      notice.recipients = to;
      await stamp(db, args.tenantId, args.items);
      await logAudit(
        db,
        args.requestedBy.id,
        args.tenantId,
        'order.documents_qa_notified',
        'order',
        args.order.id,
        JSON.stringify({ ...details, recipients: to }),
        args.clientIp,
      );
    }
    return notice;
  } catch (err) {
    console.error('[order-document-notices] notice failed:', err instanceof Error ? err.message : String(err));
    return notice;
  }
}

// ---------------------------------------------------------------------------
// Telling the person who asked (C-070)
// ---------------------------------------------------------------------------

export interface RequesterNoticeLine {
  /** `order_documents.pending_requested_by`: who pressed the send that asked. */
  requested_by: string | null;
  document_type_name: string | null;
  document_title: string | null;
  product_name: string | null;
  supplier_name: string | null;
}

export interface RequesterNoticeArgs {
  tenantId: string;
  tenantName: string;
  appUrl: string;
  order: { id: string; order_number: string; customer_name: string | null };
  /** The QA person who decided. */
  actor: { id: string; name: string | null; email: string };
  decision: 'released' | 'refused';
  /** Released: who the documents were mailed to. */
  recipients?: string[];
  /** Refused: QA's note. */
  note?: string | null;
  lines: RequesterNoticeLine[];
  clientIp: string | null;
}

export function buildRequesterNoticeEmail(args: RequesterNoticeArgs, lines: RequesterNoticeLine[]): { subject: string; html: string } {
  const released = args.decision === 'released';
  const n = lines.length;
  const subject = released
    ? `${args.tenantName}: QA released ${n} document${n === 1 ? '' : 's'} on order ${args.order.order_number}`
    : `${args.tenantName}: QA refused a document on order ${args.order.order_number}`;
  const orderUrl = `${args.appUrl.replace(/\/$/, '')}/orders/${args.order.id}`;
  const who = args.actor.name || args.actor.email;
  const rows = lines
    .map((l) => {
      const what = [l.document_type_name ?? 'Document', l.supplier_name].filter(Boolean).map((x) => escapeHtml(String(x))).join(' &middot; ');
      const detail = [l.product_name ? `For ${l.product_name}` : null, l.document_title ? `"${l.document_title}"` : null]
        .filter(Boolean)
        .map((x) => escapeHtml(String(x)))
        .join(' &middot; ');
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">
        <div style="color:#333;font-weight:600;">${what}</div>
        ${detail ? `<div style="color:#666;font-size:13px;">${detail}</div>` : ''}
      </td></tr>`;
    })
    .join('');
  const outcome = released
    ? `<p style="margin:0 0 8px;color:#555;line-height:1.6;">${escapeHtml(who)} released ${n === 1 ? 'this document' : 'these documents'} and the portal mailed a link to: <strong>${escapeHtml((args.recipients ?? []).join(', '))}</strong>. The link works for 30 days.</p>`
    : `<p style="margin:0 0 8px;color:#555;line-height:1.6;">${escapeHtml(who)} refused ${n === 1 ? 'this document' : 'these documents'} for this order. Nothing was sent to the customer.</p>
       <p style="margin:0 0 16px;padding:12px 16px;background:#f8f9fa;border-left:3px solid #1A365D;color:#333;line-height:1.6;white-space:pre-wrap;">${escapeHtml(args.note ?? '')}</p>`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr><td style="background:#1A365D;padding:24px 32px;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Document order ${escapeHtml(args.order.order_number)}</h1>
      <p style="margin:6px 0 0;color:#cbd5e0;font-size:13px;">${escapeHtml(args.tenantName)}${args.order.customer_name ? ` &middot; for ${escapeHtml(args.order.customer_name)}` : ''}</p>
    </td></tr>
    <tr><td style="padding:32px;">
      ${outcome}
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${rows}</table>
      <p style="margin:0;color:#666;font-size:13px;line-height:1.6;">The order: <a href="${escapeHtml(orderUrl)}">${escapeHtml(orderUrl)}</a></p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

/**
 * Tell the person who asked what QA decided: ONE internal mail per act, per
 * asker. "Asker" is whoever pressed the send that put the line in front of QA.
 *
 * INTERNAL ONLY, BY CONSTRUCTION. The address is read from `users` for that
 * user id, and only when the account is an ACTIVE user OF THIS ORGANIZATION.
 * No address from the order, the customer or the request is ever used, so
 * this cannot be turned into a mail to somebody outside. Never to the person
 * who decided (a releaser who asked and released is not told what they did),
 * and an inactive asker is skipped without a word.
 *
 * Never throws: QA's decision has already been recorded and mailed.
 */
export async function notifyRequesterOfDecision(
  db: D1Database,
  apiKey: string | undefined,
  args: RequesterNoticeArgs,
): Promise<{ sent: boolean; recipients: string[] } | null> {
  const byAsker = new Map<string, RequesterNoticeLine[]>();
  for (const line of args.lines) {
    if (!line.requested_by || line.requested_by === args.actor.id) continue;
    const list = byAsker.get(line.requested_by) ?? [];
    list.push(line);
    byAsker.set(line.requested_by, list);
  }
  if (byAsker.size === 0 || !apiKey) return null;
  const told: string[] = [];
  let attempted = false;
  for (const [askerId, lines] of byAsker) {
    try {
      const asker = await db
        .prepare('SELECT id, email FROM users WHERE id = ? AND tenant_id = ? AND active = 1')
        .bind(askerId, args.tenantId)
        .first<{ id: string; email: string | null }>();
      if (!asker || !asker.email) continue;
      attempted = true;
      const mail = buildRequesterNoticeEmail(args, lines);
      const ok = await sendEmail(apiKey, { to: asker.email, subject: mail.subject, html: mail.html });
      if (ok) told.push(asker.email);
      await logAudit(
        db,
        args.actor.id,
        args.tenantId,
        'order.documents_requester_notified',
        'order',
        args.order.id,
        JSON.stringify({
          order_number: args.order.order_number,
          decision: args.decision,
          told_user_id: asker.id,
          sent: ok,
          line_count: lines.length,
        }),
        args.clientIp,
      );
    } catch (err) {
      console.error('[order-document-notices] requester notice failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return attempted ? { sent: told.length > 0, recipients: told } : null;
}
