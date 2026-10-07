/**
 * Who hears that a document arrived by email -- and it is not automatically
 * whoever sent it.
 *
 * Two mails used to go straight back to the address a document was emailed
 * from: the ingest summary ("we processed 3 attachments") and "Review Needed"
 * (with a link to the Review Queue). The sender of an inbound email is very
 * often a SUPPLIER -- the domain mapping exists precisely so a supplier can
 * mail certificates in -- so a person outside the organization was being sent
 * the organization's processing status, its confidence score for their
 * document, and a link to an internal screen. Nothing in this portal sends to
 * a supplier or a customer without a person deciding to; these two mails were
 * the exceptions nobody had decided on.
 *
 * THE RULE. The sender is answered only when their address is an ACTIVE USER
 * OF THAT TENANT -- someone forwarding from their own mailbox, who can open the
 * link. Anybody else gets nothing, and the tenant's org_admins get an internal
 * notice saying a document arrived from that address. Which of the two
 * happened is audited (`intake.sender_notice`), because "did the supplier get
 * an email from us" is a question somebody will ask.
 *
 * A user of ANOTHER tenant is an outsider here: the match is on the tenant the
 * document landed in, not on having an account somewhere.
 */

import { logAudit } from '../db';
import { escapeHtml, sendEmail } from '../email';
import { resolveTenantAdmins } from '../alert-routing';

export type SenderNoticeKind = 'ingest_summary' | 'review_needed';
/** `sender` = replied to the sender (a tenant user); `org_admins` = internal notice; `nobody` = no recipient at all. */
export type SenderNoticePath = 'sender' | 'org_admins' | 'nobody';

export interface SenderNoticeRouting {
  path: SenderNoticePath;
  recipients: string[];
  senderIsTenantUser: boolean;
}

/** `Name <a@b.c>` or a bare address, lower-cased; null when it is not an address. */
export function normalizeSenderAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const inner = raw.match(/<([^>]+)>/)?.[1] ?? raw;
  const address = inner.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null;
}

/**
 * Decide who is told. Reads only; sends nothing.
 *
 * A failed user lookup is treated as "not a user": the wrong way to fail is to
 * mail an outsider, so an error falls to the internal notice.
 */
export async function resolveSenderNotice(
  db: D1Database,
  tenantId: string,
  senderRaw: string | null | undefined,
): Promise<SenderNoticeRouting> {
  const sender = normalizeSenderAddress(senderRaw);
  let senderIsTenantUser = false;
  if (sender) {
    try {
      const row = await db
        .prepare(`SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND lower(email) = ? LIMIT 1`)
        .bind(tenantId, sender)
        .first<{ id: string }>();
      senderIsTenantUser = !!row;
    } catch (err) {
      console.error('[sender-notice] user lookup failed, treating the sender as outside:', err instanceof Error ? err.message : String(err));
    }
  }
  if (sender && senderIsTenantUser) return { path: 'sender', recipients: [sender], senderIsTenantUser: true };

  const admins = (await resolveTenantAdmins(db, tenantId)).map((a) => a.email).filter(Boolean);
  return admins.length
    ? { path: 'org_admins', recipients: admins, senderIsTenantUser: false }
    : { path: 'nobody', recipients: [], senderIsTenantUser: false };
}

export interface SenderNoticeInput {
  db: D1Database;
  apiKey: string | undefined;
  tenantId: string;
  kind: SenderNoticeKind;
  /** The address the document was mailed from, as received. */
  sender: string | null | undefined;
  /** What the sender reads when they are a tenant user. */
  toSender: { subject: string; html: string };
  /** What the org_admins read when the sender is not. */
  toAdmins: { subject: string; html: string };
  /** For the audit row. */
  actorUserId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  ip?: string | null;
  extra?: Record<string, unknown>;
}

export interface SenderNoticeOutcome extends SenderNoticeRouting {
  /** False when no key is configured, nobody could be told, or the send failed. */
  sent: boolean;
}

/**
 * Route, send (when a mail key is configured) and audit. Never throws: mail
 * about an arrival must not fail the arrival.
 */
export async function sendSenderNotice(input: SenderNoticeInput): Promise<SenderNoticeOutcome> {
  let routing: SenderNoticeRouting = { path: 'nobody', recipients: [], senderIsTenantUser: false };
  let sent = false;
  let sendError: string | null = null;
  try {
    routing = await resolveSenderNotice(input.db, input.tenantId, input.sender);
    if (input.apiKey && routing.recipients.length) {
      const mail = routing.path === 'sender' ? input.toSender : input.toAdmins;
      sent = await sendEmail(input.apiKey, { to: routing.recipients, subject: mail.subject, html: mail.html });
      if (!sent) sendError = 'send_failed';
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  try {
    await logAudit(
      input.db,
      input.actorUserId ?? null,
      input.tenantId,
      'intake.sender_notice',
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify({
        kind: input.kind,
        path: routing.path,
        sender: normalizeSenderAddress(input.sender) ?? (input.sender ? String(input.sender).slice(0, 200) : null),
        sender_is_tenant_user: routing.senderIsTenantUser,
        recipients: routing.recipients,
        sent,
        ...(input.apiKey ? {} : { not_sent_reason: 'no_mail_key' }),
        ...(sendError ? { error: sendError } : {}),
        ...(input.extra ?? {}),
      }),
      input.ip ?? null,
    );
  } catch (err) {
    console.error('[sender-notice] audit failed:', err instanceof Error ? err.message : String(err));
  }
  return { ...routing, sent };
}

/** "Go to Review Queue" for a link built from the request's own origin. */
export function reviewQueueUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/review`;
}

/** The "Review Needed" mail, for a tenant user who mailed the document in themselves. */
export function buildReviewNeededEmail(params: { fileName: string; confidence: number; origin: string }): { subject: string; html: string } {
  const file = escapeHtml(params.fileName);
  return {
    subject: `[SupDox] Review Needed: ${params.fileName}`,
    html: `
                <div style="font-family:sans-serif;max-width:600px">
                  <h2 style="color:#ed6c02">Document Needs Review</h2>
                  <p><strong>${file}</strong> was processed but needs human review before it can be ingested (${Math.round(params.confidence * 100)}% confidence).</p>
                  <p><a href="${escapeHtml(reviewQueueUrl(params.origin))}" style="display:inline-block;padding:10px 20px;background:#1976d2;color:white;text-decoration:none;border-radius:4px">Go to Review Queue</a></p>
                  <p style="color:#666;font-size:14px">Nothing is filed until a person approves it in the Review Queue.</p>
                </div>`,
  };
}

/**
 * The internal notice: a document arrived by email from an address that is not
 * one of this organization's users. Says who it came from and that they were
 * NOT answered, so nobody assumes the supplier heard back.
 */
export function buildArrivedByEmailNotice(params: {
  sender: string | null | undefined;
  tenantName?: string | null;
  files: Array<{ fileName: string; status?: string; detail?: string | null }>;
  origin: string;
}): { subject: string; html: string } {
  const from = normalizeSenderAddress(params.sender) ?? 'an unknown address';
  const n = params.files.length;
  const rows = params.files
    .map(
      (f) => `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(f.fileName)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${escapeHtml(f.detail ?? f.status ?? '')}</td>
            </tr>`,
    )
    .join('\n');
  return {
    subject: `[SupDox] ${n} document${n === 1 ? '' : 's'} arrived by email from ${from}`,
    html: `
                <div style="font-family:sans-serif;max-width:600px">
                  <h2 style="color:#1976d2">${n === 1 ? 'A document' : `${n} documents`} arrived by email</h2>
                  <p>From <strong>${escapeHtml(from)}</strong>${params.tenantName ? `, for ${escapeHtml(params.tenantName)}` : ''}.</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;margin:0 0 16px;">${rows}</table>
                  <p><a href="${escapeHtml(reviewQueueUrl(params.origin))}" style="display:inline-block;padding:10px 20px;background:#1976d2;color:white;text-decoration:none;border-radius:4px">Go to Review Queue</a></p>
                  <p style="color:#666;font-size:14px">That address is not one of your users, so nothing was sent back to it. You are receiving this as an organization admin.</p>
                </div>`,
  };
}
