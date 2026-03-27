import { requireRole, errorToResponse } from '../../lib/permissions';
import { sendEmail } from '../../lib/email';
import type { Env, User } from '../../lib/types';

/**
 * POST /api/expirations/notify
 * Triggers expiration notification emails. super_admin only.
 *
 * Queries for expirations within 30 days, groups by tenant,
 * finds org_admin users for each tenant, and sends summary emails.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin');

    const apiKey = context.env.RESEND_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Email service not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get all expirations within 30 days (including already expired)
    const expirations = await context.env.DB.prepare(`
      SELECT
        dp.id as link_id,
        dp.document_id,
        dp.product_id,
        dp.expires_at,
        dp.notes,
        d.title as document_title,
        d.tenant_id,
        p.name as product_name,
        t.name as tenant_name
      FROM document_products dp
      JOIN documents d ON dp.document_id = d.id
      JOIN products p ON dp.product_id = p.id
      LEFT JOIN tenants t ON d.tenant_id = t.id
      WHERE dp.expires_at IS NOT NULL
        AND dp.expires_at <= date('now', '+30 days')
        AND d.status = 'active'
      ORDER BY dp.expires_at ASC
    `).all();

    if (!expirations.results || expirations.results.length === 0) {
      return new Response(
        JSON.stringify({ sent: 0, message: 'No expiring documents found' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Group by tenant
    const byTenant = new Map<string, { tenantName: string; items: any[] }>();
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const row of expirations.results as any[]) {
      const tenantId = row.tenant_id as string;
      if (!byTenant.has(tenantId)) {
        byTenant.set(tenantId, { tenantName: row.tenant_name || 'Unknown', items: [] });
      }

      const expiresDate = new Date(row.expires_at + (row.expires_at.includes('T') ? '' : 'T00:00:00Z'));
      const daysRemaining = Math.floor((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      byTenant.get(tenantId)!.items.push({
        document_title: row.document_title,
        product_name: row.product_name,
        expires_at: row.expires_at,
        days_remaining: daysRemaining,
      });
    }

    // For each tenant, find org_admin users and send emails
    let totalSent = 0;
    const errors: string[] = [];

    for (const [tenantId, data] of byTenant) {
      const admins = await context.env.DB.prepare(
        `SELECT email, name FROM users WHERE tenant_id = ? AND role = 'org_admin' AND active = 1`
      )
        .bind(tenantId)
        .all();

      if (!admins.results || admins.results.length === 0) {
        continue;
      }

      const emailContent = buildExpirationEmail({
        tenantName: data.tenantName,
        items: data.items,
      });

      for (const admin of admins.results as any[]) {
        const sent = await sendEmail(apiKey, {
          to: admin.email,
          subject: emailContent.subject,
          html: emailContent.html,
        });
        if (sent) {
          totalSent++;
        } else {
          errors.push(`Failed to send to ${admin.email}`);
        }
      }
    }

    return new Response(
      JSON.stringify({
        sent: totalSent,
        tenants_notified: byTenant.size,
        ...(errors.length > 0 ? { errors } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Expiration notify error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

function buildExpirationEmail(params: {
  tenantName: string;
  items: Array<{ document_title: string; product_name: string; expires_at: string; days_remaining: number }>;
}): { subject: string; html: string } {
  const expiredCount = params.items.filter((i) => i.days_remaining < 0).length;
  const criticalCount = params.items.filter((i) => i.days_remaining >= 0 && i.days_remaining <= 14).length;

  const subject = `Document Expiration Alert — ${params.tenantName} (${params.items.length} document${params.items.length === 1 ? '' : 's'})`;

  // Group items by product
  const byProduct = new Map<string, typeof params.items>();
  for (const item of params.items) {
    if (!byProduct.has(item.product_name)) {
      byProduct.set(item.product_name, []);
    }
    byProduct.get(item.product_name)!.push(item);
  }

  let productRows = '';
  for (const [productName, items] of byProduct) {
    productRows += `
      <tr>
        <td colspan="3" style="padding:12px 16px 4px;font-weight:600;color:#333;border-bottom:1px solid #eee;">
          ${escapeHtml(productName)}
        </td>
      </tr>`;
    for (const item of items) {
      const statusColor = item.days_remaining < 0 ? '#d32f2f' : item.days_remaining <= 14 ? '#e65100' : '#f9a825';
      const statusText =
        item.days_remaining < 0
          ? `Expired ${Math.abs(item.days_remaining)}d ago`
          : item.days_remaining === 0
            ? 'Expires today'
            : `${item.days_remaining}d remaining`;

      productRows += `
      <tr>
        <td style="padding:8px 16px 8px 32px;color:#555;">${escapeHtml(item.document_title)}</td>
        <td style="padding:8px 16px;color:#555;">${item.expires_at}</td>
        <td style="padding:8px 16px;color:${statusColor};font-weight:500;">${statusText}</td>
      </tr>`;
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:40px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#1976d2;padding:24px 32px;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:600;">Dox</h1>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;color:#333;font-size:18px;">Document Expiration Alert</h2>
        <p style="margin:0 0 16px;color:#555;line-height:1.6;">
          The following documents for <strong>${escapeHtml(params.tenantName)}</strong> are expiring soon or have already expired.
        </p>
        ${expiredCount > 0 ? `<p style="margin:0 0 8px;color:#d32f2f;font-weight:500;">${expiredCount} document${expiredCount === 1 ? '' : 's'} already expired</p>` : ''}
        ${criticalCount > 0 ? `<p style="margin:0 0 16px;color:#e65100;font-weight:500;">${criticalCount} document${criticalCount === 1 ? '' : 's'} expiring within 14 days</p>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;">
          <tr style="background:#f5f5f5;">
            <th style="padding:10px 16px;text-align:left;font-size:13px;color:#666;">Document</th>
            <th style="padding:10px 16px;text-align:left;font-size:13px;color:#666;">Expires</th>
            <th style="padding:10px 16px;text-align:left;font-size:13px;color:#666;">Status</th>
          </tr>
          ${productRows}
        </table>
        <p style="margin:24px 0 0;color:#888;font-size:14px;">
          Please review and update these documents as needed.
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
