/**
 * The three emails of the supplier renewal send (migration 0133).
 *
 *   1. the request itself -- to the SUPPLIER, only ever after one approval;
 *   2. "a supplier request is waiting for your approval" -- to the approver,
 *      when the owner digest is not already carrying that line;
 *   3. "we have stopped writing to this supplier" -- the internal escalation.
 *
 * Only the first leaves the organisation, and its content is not decided
 * here: the body is the text a person approved and the link block is fixed
 * wording from shared/renewalRequestTemplate.ts. This file only dresses that
 * plain text as HTML, escaping every character of it.
 */

import {
  formatRenewalDate,
  renewalRequestLinkBlock,
  renewalStageLabel,
} from '../../shared/renewalRequestTemplate';

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SHELL_OPEN = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">`;
const SHELL_CLOSE = `
  </table>
</body>
</html>`;

/**
 * The supplier's email. `body` is the approved plain text, verbatim; the link
 * block is appended below it and is the same wording the stored `sent_body`
 * carries, so what the record says left is what left.
 */
export function buildRenewalRequestSupplierEmail(params: {
  tenantName: string;
  body: string;
  linkUrl: string;
}): { html: string } {
  const [lead, , ...rest] = renewalRequestLinkBlock(params.linkUrl).split('\n');
  const footer = rest.filter((l) => l.trim().length > 0).join(' ');
  const html = `${SHELL_OPEN}
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">${escapeHtml(params.tenantName)}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <div style="margin:0 0 24px;color:#333;line-height:1.6;white-space:pre-wrap;">${escapeHtml(params.body.replace(/\s+$/, ''))}</div>
        <p style="margin:0 0 8px;color:#333;line-height:1.6;">${escapeHtml(lead)}</p>
        <p style="margin:0 0 8px;"><a href="${escapeHtml(params.linkUrl)}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Upload the document</a></p>
        <p style="margin:8px 0 0;color:#666;font-size:12px;word-break:break-all;">${escapeHtml(params.linkUrl)}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">${escapeHtml(footer)}</p>
      </td>
    </tr>${SHELL_CLOSE}`;
  return { html };
}

/** One draft waiting for a person, as the approver is told about it. */
export interface ApprovalNoticeItem {
  document_title: string;
  supplier_name: string;
  stage: string;
  due_date: string;
  /** Who is expected to approve; null when any admin may. */
  approver_name: string | null;
  review_url: string | null;
}

/**
 * The block added to an owner digest (D-049: the internal alert and the draft
 * arrive as ONE notification when the approver is already a recipient).
 */
export function renderApprovalBlockHtml(items: ApprovalNoticeItem[]): string {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (i) => `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(i.document_title)}<br><span style="color:#666;font-size:12px;">to ${escapeHtml(i.supplier_name)} &middot; ${escapeHtml(renewalStageLabel(i.stage))} &middot; due ${escapeHtml(formatRenewalDate(i.due_date))}</span></td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${i.approver_name ? `Waiting for ${escapeHtml(i.approver_name)}` : 'Waiting for an administrator'}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;">${i.review_url ? `<a href="${escapeHtml(i.review_url)}" style="color:#1A365D;font-weight:600;">Review and send</a>` : ''}</td>
            </tr>`,
    )
    .join('\n');
  return `<h3 style="margin:24px 0 8px;color:#333;font-size:16px;">Supplier request${items.length === 1 ? '' : 's'} waiting for approval</h3>
        <p style="margin:0 0 12px;color:#555;line-height:1.6;font-size:14px;">A renewal request to the supplier has been drafted. <strong>Nothing is sent to a supplier until a person approves it.</strong></p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin:0 0 24px;">
          ${rows}
        </table>`;
}

export function renderApprovalBlockText(items: ApprovalNoticeItem[]): string {
  if (items.length === 0) return '';
  return (
    `\nSupplier request${items.length === 1 ? '' : 's'} waiting for approval (nothing is sent to a supplier until a person approves it):\n` +
    items
      .map(
        (i) =>
          `- ${i.document_title} -> ${i.supplier_name} (${renewalStageLabel(i.stage)}, due ${i.due_date})` +
          (i.review_url ? `\n  ${i.review_url}` : ''),
      )
      .join('\n') +
    '\n'
  );
}

/** The approver's own notice, when no owner digest carried the line. */
export function buildRenewalApprovalNoticeEmail(
  items: ApprovalNoticeItem[],
  tenantName: string,
): { subject: string; html: string } {
  const n = items.length;
  const subject = `SupDox: ${n} supplier renewal request${n === 1 ? '' : 's'} waiting for your approval`;
  const html = `${SHELL_OPEN}
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 32px 32px;">
        ${renderApprovalBlockHtml(items)}
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">Automated notice from SupDox for ${escapeHtml(tenantName)}.</p>
      </td>
    </tr>${SHELL_CLOSE}`;
  return { subject, html };
}

export interface EscalationNoticeItem {
  document_title: string;
  supplier_name: string;
  due_date: string;
  days_past_due: number;
  /** How many requests actually reached the supplier in this cycle (0-4). */
  emails_sent: number;
}

/** "We have stopped writing to the supplier" -- internal, once per cycle. */
export function buildRenewalEscalationEmail(
  items: EscalationNoticeItem[],
  tenantName: string,
  reviewUrl: string | null,
): { subject: string; html: string } {
  const n = items.length;
  const subject = `SupDox: ${n} supplier renewal${n === 1 ? '' : 's'} unanswered - no further reminders will be sent`;
  const rows = items
    .map(
      (i) => `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(i.document_title)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${escapeHtml(i.supplier_name)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#d32f2f;">${escapeHtml(formatRenewalDate(i.due_date))}<br><span style="color:#999;font-size:12px;">${i.days_past_due} days ago</span></td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${i.emails_sent === 0 ? 'No request was approved' : `${i.emails_sent} request${i.emails_sent === 1 ? '' : 's'} sent`}</td>
            </tr>`,
    )
    .join('\n');
  const html = `${SHELL_OPEN}
    <tr>
      <td style="background:#8a1c1c;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox - supplier renewal escalated</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 24px;color:#555;line-height:1.6;">
          ${n === 1 ? 'This document' : 'These documents'} for <strong>${escapeHtml(tenantName)}</strong> expired and no replacement has been accepted. The portal has <strong>stopped drafting reminders to the supplier</strong>; what happens next is a decision for a person.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin:0 0 24px;">
          ${rows}
        </table>
        ${reviewUrl ? `<p style="margin:0;"><a href="${escapeHtml(reviewUrl)}" style="color:#1A365D;font-weight:600;">Open Renewals</a></p>` : ''}
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">Automated escalation from SupDox for ${escapeHtml(tenantName)}. Nothing was sent to the supplier.</p>
      </td>
    </tr>${SHELL_CLOSE}`;
  return { subject, html };
}
