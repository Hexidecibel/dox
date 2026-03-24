import { hashPassword } from '../../../lib/auth';
import { logAudit, getClientIp } from '../../../lib/db';
import { requireRole, errorToResponse } from '../../../lib/permissions';
import { sendEmail, buildAdminResetEmail } from '../../../lib/email';
import type { Env, User } from '../../../lib/types';

/**
 * Generate a random temporary password that meets complexity requirements.
 */
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const special = '!@#$%&*';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);

  let password = '';
  for (const b of bytes) {
    password += chars[b % chars.length];
  }

  // Ensure complexity: inject one uppercase, one lowercase, one digit
  const inject = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ'[bytes[0] % 24],
    'abcdefghjkmnpqrstuvwxyz'[bytes[1] % 23],
    '23456789'[bytes[2] % 8],
    special[bytes[3] % special.length],
  ];

  return inject.join('') + password.slice(4);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    const targetUserId = (context.params as { id: string }).id;

    // Look up the target user
    const targetUser = await context.env.DB.prepare(
      'SELECT id, email, name, tenant_id, role FROM users WHERE id = ?'
    )
      .bind(targetUserId)
      .first<{ id: string; email: string; name: string; tenant_id: string | null; role: string }>();

    if (!targetUser) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // org_admin can only reset passwords for users in their own tenant
    if (currentUser.role === 'org_admin') {
      if (!targetUser.tenant_id || targetUser.tenant_id !== currentUser.tenant_id) {
        return new Response(
          JSON.stringify({ error: 'You can only reset passwords for users in your organization' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // org_admin cannot reset super_admin or org_admin passwords
      if (targetUser.role === 'super_admin' || targetUser.role === 'org_admin') {
        return new Response(
          JSON.stringify({ error: 'Insufficient permissions to reset this user\'s password' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Update password and force password change
    await context.env.DB.prepare(
      "UPDATE users SET password_hash = ?, force_password_change = 1, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(passwordHash, targetUserId)
      .run();

    // Revoke all existing sessions
    await context.env.DB.prepare(
      'UPDATE sessions SET revoked = 1 WHERE user_id = ?'
    )
      .bind(targetUserId)
      .run();

    // Audit log
    await logAudit(
      context.env.DB,
      currentUser.id,
      targetUser.tenant_id,
      'user.password_reset',
      'user',
      targetUserId,
      JSON.stringify({ resetBy: currentUser.email }),
      getClientIp(context.request)
    );

    // Send email notification if Resend is configured
    let emailSent = false;
    if (context.env.RESEND_API_KEY) {
      const loginUrl = new URL(context.request.url).origin + '/login';
      const { subject, html } = buildAdminResetEmail({
        userName: targetUser.name,
        adminName: currentUser.name,
        tempPassword,
        loginUrl,
      });

      emailSent = await sendEmail(context.env.RESEND_API_KEY, {
        to: targetUser.email,
        subject,
        html,
      });
    }

    return new Response(
      JSON.stringify({ temporaryPassword: tempPassword, emailSent }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Admin password reset error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
