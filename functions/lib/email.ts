import type { ExpirationRow, ExpirationStatus } from './expirations';

interface SendEmailOptions {
  /** A single address or a list — a list sends one email to all recipients. */
  to: string | string[];
  subject: string;
  html: string;
}

export async function sendEmail(apiKey: string, options: SendEmailOptions): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SupDox <noreply@supdox.com>',
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function buildInvitationEmail(params: {
  inviterName: string;
  orgName: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
  role: string;
}): { subject: string; html: string } {
  const roleLabel = params.role.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const subject = `You've been invited to ${params.orgName} on Dox`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1976d2;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Dox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Welcome to ${params.orgName}</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          ${params.inviterName} has invited you to join <strong>${params.orgName}</strong> on the Dox as a <strong>${roleLabel}</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:6px;margin:0 0 24px;">
          <tr>
            <td style="padding:20px;">
              <p style="margin:0 0 8px;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Your login credentials</p>
              <p style="margin:0 0 4px;color:#333;"><strong>Email:</strong> ${params.email}</p>
              <p style="margin:0 0 4px;color:#333;"><strong>Temporary Password:</strong> <code style="background:#e8e8e8;padding:2px 6px;border-radius:3px;">${params.tempPassword}</code></p>
              <p style="margin:0;color:#333;"><strong>Role:</strong> ${roleLabel}</p>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 24px;color:#d32f2f;font-size:14px;">
          Please change your password after your first login.
        </p>
        <a href="${params.loginUrl}" style="display:inline-block;background:#1976d2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Sign In
        </a>
        <p style="margin:24px 0 0;color:#999;font-size:12px;">
          If the button doesn't work, copy and paste this URL into your browser:<br>
          <a href="${params.loginUrl}" style="color:#1976d2;">${params.loginUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          This is an automated message from Dox. Please do not reply.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

export function buildPasswordResetEmail(params: {
  userName: string;
  resetUrl: string;
}): { subject: string; html: string } {
  const subject = 'Password Reset Request — Dox';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1976d2;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Dox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Password Reset Request</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          Hi ${params.userName},
        </p>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          We received a request to reset your password. Click the button below to choose a new password.
        </p>
        <a href="${params.resetUrl}" style="display:inline-block;background:#1976d2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Reset Password
        </a>
        <p style="margin:24px 0 0;color:#888;font-size:14px;line-height:1.6;">
          This link expires in 1 hour.
        </p>
        <p style="margin:12px 0 0;color:#888;font-size:14px;line-height:1.6;">
          If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
        </p>
        <p style="margin:24px 0 0;color:#999;font-size:12px;">
          If the button doesn't work, copy and paste this URL into your browser:<br>
          <a href="${params.resetUrl}" style="color:#1976d2;">${params.resetUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          This is an automated message from Dox. Please do not reply.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

/**
 * Build an "X asked you to update Y" email. Used by the Records update
 * request flow (Phase 2 Slice 2). Friendly tone — the recipient is most
 * often an external supplier/customer, not a power user.
 */
export function buildUpdateRequestEmail(params: {
  recipientName: string | null;
  senderName: string;
  senderEmail: string;
  sheetName: string;
  rowTitle: string | null;
  message: string | null;
  dueDate: string | null;
  fieldCount: number;
  publicUrl: string;
}): { subject: string; html: string } {
  const subject = `${params.senderName} asked you to update ${params.sheetName}`;
  const greeting = params.recipientName ? `Hi ${params.recipientName},` : 'Hi,';
  const rowLine = params.rowTitle ? ` for <strong>${escapeHtml(params.rowTitle)}</strong>` : '';
  const fieldNoun = params.fieldCount === 1 ? '1 field' : `${params.fieldCount} fields`;
  const messageBlock = params.message
    ? `<p style="margin:0 0 16px;color:#555;line-height:1.6;font-style:italic;">"${escapeHtml(params.message)}"</p>`
    : '';
  const dueLine = params.dueDate
    ? `<p style="margin:0 0 16px;color:#555;line-height:1.6;">They'd like a response by <strong>${escapeHtml(formatFriendlyDate(params.dueDate))}</strong>.</p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Quick update needed</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          ${greeting}
        </p>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          <strong>${escapeHtml(params.senderName)}</strong> (${escapeHtml(params.senderEmail)}) is asking you to fill in ${fieldNoun}${rowLine} on <strong>${escapeHtml(params.sheetName)}</strong>.
        </p>
        ${messageBlock}
        ${dueLine}
        <a href="${params.publicUrl}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Open the form
        </a>
        <p style="margin:24px 0 0;color:#999;font-size:12px;">
          If the button doesn't work, copy and paste this URL into your browser:<br>
          <a href="${params.publicUrl}" style="color:#1A365D;">${params.publicUrl}</a>
        </p>
        <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
          This link is unique to you. You can fill it in later — no account needed.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          This is an automated message from SupDox. If you weren't expecting it, you can ignore it.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

/**
 * Build an "X needs your sign-off on Y" email. Used by the Records
 * workflow engine when an approval step has an external assignee_email.
 * Mirrors the visual treatment of buildUpdateRequestEmail so external
 * approvers and update-request recipients see a consistent brand.
 */
export function buildApprovalRequestEmail(params: {
  recipientName: string | null;
  senderName: string;
  senderEmail: string;
  workflowName: string;
  stepName: string;
  message: string | null;
  sheetName: string;
  rowTitle: string | null;
  publicUrl: string;
}): { subject: string; html: string } {
  const subject = `${params.senderName} needs your sign-off on ${params.workflowName}`;
  const greeting = params.recipientName ? `Hi ${params.recipientName},` : 'Hi,';
  const rowLine = params.rowTitle ? ` for <strong>${escapeHtml(params.rowTitle)}</strong>` : '';
  const messageBlock = params.message
    ? `<p style="margin:0 0 16px;color:#555;line-height:1.6;font-style:italic;">"${escapeHtml(params.message)}"</p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Sign-off needed</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          ${greeting}
        </p>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          <strong>${escapeHtml(params.senderName)}</strong> (${escapeHtml(params.senderEmail)}) needs your approval on the <strong>${escapeHtml(params.stepName)}</strong> step of the <strong>${escapeHtml(params.workflowName)}</strong> workflow${rowLine} on <strong>${escapeHtml(params.sheetName)}</strong>.
        </p>
        ${messageBlock}
        <a href="${params.publicUrl}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Review and decide
        </a>
        <p style="margin:24px 0 0;color:#999;font-size:12px;">
          If the button doesn't work, copy and paste this URL into your browser:<br>
          <a href="${params.publicUrl}" style="color:#1A365D;">${params.publicUrl}</a>
        </p>
        <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
          This link is unique to you. No account needed -- just click to approve or reject.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          This is an automated message from SupDox. If you weren't expecting it, you can ignore it.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

/** Minimal HTML escape for interpolated strings in emails. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Best-effort friendly date — falls back to the raw string if unparseable. */
function formatFriendlyDate(iso: string): string {
  try {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function buildAdminResetEmail(params: {
  userName: string;
  adminName: string;
  tempPassword: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const subject = 'Your Password Has Been Reset — Dox';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1976d2;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Dox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Your Password Has Been Reset</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          Hi ${params.userName},
        </p>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          Your password has been reset by <strong>${params.adminName}</strong>. Please use the temporary password below to sign in.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:6px;margin:0 0 24px;">
          <tr>
            <td style="padding:20px;">
              <p style="margin:0 0 8px;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">New temporary password</p>
              <p style="margin:0;color:#333;"><code style="background:#e8e8e8;padding:2px 6px;border-radius:3px;font-size:16px;">${params.tempPassword}</code></p>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 24px;color:#d32f2f;font-size:14px;">
          Please change your password after signing in.
        </p>
        <a href="${params.loginUrl}" style="display:inline-block;background:#1976d2;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;">
          Sign In
        </a>
        <p style="margin:24px 0 0;color:#999;font-size:12px;">
          If the button doesn't work, copy and paste this URL into your browser:<br>
          <a href="${params.loginUrl}" style="color:#1976d2;">${params.loginUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          This is an automated message from Dox. Please do not reply.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

/**
 * Build the renewal-alert summary email (Phase-4 renewal engine). Lists each
 * expiring/expired/overdue registry document with its due date, owner, category
 * and status. Matches the visual style of the other builders. Returns a plain-
 * text alternative alongside the HTML.
 */
export function buildRenewalAlertEmail(
  docs: ExpirationRow[],
  tenantName: string,
): { subject: string; html: string; text: string } {
  const count = docs.length;
  const subject = `SupDox: ${count} document${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} renewal attention`;

  const statusLabel = (s: ExpirationStatus): string => {
    switch (s) {
      case 'expired': return 'Expired';
      case 'overdue': return 'Overdue';
      case 'expiring': return 'Expiring soon';
      case 'stale': return 'Stale';
      default: return 'Current';
    }
  };
  const statusColor = (s: ExpirationStatus): string => {
    switch (s) {
      case 'expired': return '#d32f2f';
      case 'overdue': return '#d32f2f';
      case 'expiring': return '#ed6c02';
      default: return '#666';
    }
  };
  const daysText = (d: number | null): string => {
    if (d == null) return '';
    if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago`;
    if (d === 0) return 'today';
    return `in ${d} day${d === 1 ? '' : 's'}`;
  };

  const rows = docs.map((d) => {
    return `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(d.title)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${escapeHtml(d.primary_category_name || '—')}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${escapeHtml(d.owner || '—')}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(d.renewal_due_date || '—')}<br><span style="color:#999;font-size:12px;">${escapeHtml(daysText(d.days_until))}</span></td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;color:${statusColor(d.status)};">${statusLabel(d.status)}</td>
            </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1A365D;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Renewal attention needed</h2>
        <p style="margin:0 0 24px;color:#555;line-height:1.6;">
          ${count} document${count === 1 ? '' : 's'} for <strong>${escapeHtml(tenantName)}</strong> ${count === 1 ? 'is' : 'are'} expiring, overdue, or already expired. Review and renew as needed.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin:0 0 24px;">
          <tr style="background:#f8f9fa;">
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Document</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Category</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Owner</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Due</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Status</th>
          </tr>
          ${rows}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          Automated renewal alert from SupDox for ${escapeHtml(tenantName)}.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = docs.map((d) => {
    const parts = [
      d.title,
      d.primary_category_name ? `[${d.primary_category_name}]` : '',
      d.owner ? `owner: ${d.owner}` : '',
      `due ${d.renewal_due_date || '—'} (${daysText(d.days_until)})`,
      statusLabel(d.status).toUpperCase(),
    ].filter(Boolean);
    return `- ${parts.join(' · ')}`;
  });
  const text = `Renewal attention needed for ${tenantName}\n\n${count} document${count === 1 ? '' : 's'} expiring, overdue, or expired:\n\n${textLines.join('\n')}\n`;

  return { subject, html, text };
}

export function buildEmailIngestSummaryEmail(params: {
  senderName: string;
  tenantName: string;
  results: Array<{ fileName: string; status: string; documentId?: string; queueId?: string; confidence?: number; error?: string }>;
}): { subject: string; html: string } {
  const { senderName, tenantName, results } = params;
  const subject = `Dox: ${results.length} document${results.length === 1 ? '' : 's'} processed from your email`;

  const statusIcon = (status: string) => {
    if (status === 'ingested') return '&#x2705;';
    if (status === 'queued') return '&#x23F3;';
    return '&#x274C;';
  };

  const statusLabel = (status: string) => {
    if (status === 'ingested') return 'Ingested';
    if (status === 'queued') return 'Queued for Review';
    return 'Error';
  };

  const rows = results.map(r => {
    let detail = '';
    if (r.status === 'ingested' && r.confidence !== undefined) {
      detail = `Confidence: ${Math.round(r.confidence * 100)}%`;
    } else if (r.status === 'queued') {
      detail = 'Needs manual review before ingestion';
    } else if (r.status === 'error' && r.error) {
      detail = r.error;
    }

    return `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${r.fileName}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${statusIcon(r.status)} ${statusLabel(r.status)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${detail}</td>
            </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1976d2;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Dox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Email Ingest Summary</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          Hi ${senderName},
        </p>
        <p style="margin:0 0 24px;color:#555;line-height:1.6;">
          We received your email and processed ${results.length} attachment${results.length === 1 ? '' : 's'}. Here's a summary:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin:0 0 24px;">
          <tr style="background:#f8f9fa;">
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">File</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Status</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Details</th>
          </tr>
          ${rows}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          Processed by Dox for ${tenantName}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

/**
 * Out-of-spec alert — a COA arrived whose test result falls outside an
 * acceptance limit.
 *
 * ONE EMAIL PER DOCUMENT, listing every failing result. A twelve-record COA
 * with a failing analyte in each is one event; twelve emails is how a safety
 * signal gets filtered to a folder nobody opens.
 *
 * The subject line names the analyte when there is only one, because that is
 * the sentence a QA manager needs to read on a phone without opening anything.
 */
export function buildSpecAlertEmail(params: {
  tenantName: string;
  documentTitle: string;
  documentId: string;
  supplierName: string | null;
  failures: Array<{
    test: string;
    value: string | null;
    limit: string | null;
    /** 'printed' = the COA's own stated limit; 'limit' = ours. */
    source: 'printed' | 'limit';
  }>;
  appUrl?: string;
}): { subject: string; html: string; text: string } {
  const { tenantName, documentTitle, documentId, supplierName, failures } = params;
  const n = failures.length;

  const subject =
    n === 1
      ? `SupDox: out-of-spec ${failures[0].test} on ${documentTitle}`
      : `SupDox: ${n} out-of-spec results on ${documentTitle}`;

  const sourceLabel = (s: 'printed' | 'limit') =>
    s === 'limit' ? 'our limit' : "the COA's own limit";

  const rows = failures
    .map(
      (f) => `<tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;font-weight:600;">${escapeHtml(f.test)}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#d32f2f;font-weight:600;">${escapeHtml(f.value || '—')}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#333;">${escapeHtml(f.limit || '—')}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">${sourceLabel(f.source)}</td>
            </tr>`
    )
    .join('\n');

  const link = params.appUrl ? `${params.appUrl.replace(/\/$/, '')}/documents/${documentId}` : null;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#8B1A1A;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">SupDox — out of spec</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">${n === 1 ? 'A result is' : `${n} results are`} outside the acceptance limit</h2>
        <p style="margin:0 0 24px;color:#555;line-height:1.6;">
          <strong>${escapeHtml(documentTitle)}</strong>${supplierName ? ` from <strong>${escapeHtml(supplierName)}</strong>` : ''} came in with ${n === 1 ? 'a test result' : 'test results'} outside the limit${n === 1 ? '' : 's'} on file for ${escapeHtml(tenantName)}.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;overflow:hidden;margin:0 0 24px;">
          <tr style="background:#f8f9fa;">
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Test</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Result</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Limit</th>
            <th style="padding:10px 12px;text-align:left;color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #eee;">Against</th>
          </tr>
          ${rows}
        </table>
        ${link ? `<p style="margin:0 0 8px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1A365D;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Open the document</a></p>` : ''}
        <p style="margin:16px 0 0;color:#777;font-size:13px;line-height:1.6;">
          These values were read from the document and compared against the limits on file. SupDox does not reject or hold anything on its own — this is for a person to look at.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background:#f8f9fa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:12px;text-align:center;">
          Automated spec alert from SupDox for ${escapeHtml(tenantName)}.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = failures.map(
    (f) => `- ${f.test}: ${f.value || '—'} (limit ${f.limit || '—'}, ${sourceLabel(f.source)})`
  );
  const text = `Out of spec — ${documentTitle}${supplierName ? ` from ${supplierName}` : ''}\n\n${textLines.join('\n')}\n${link ? `\n${link}\n` : ''}\nSupDox does not reject or hold anything on its own — this is for a person to look at.\n`;

  return { subject, html, text };
}
