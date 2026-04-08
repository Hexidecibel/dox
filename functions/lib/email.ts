interface SendEmailOptions {
  to: string;
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
        to: [options.to],
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
