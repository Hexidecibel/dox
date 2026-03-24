import { hashPassword } from '../../lib/auth';
import { validatePassword } from '../../lib/validation';
import type { Env } from '../../lib/types';

/**
 * Hash a token using SHA-256.
 */
async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = (await context.request.json()) as {
      token?: string;
      newPassword?: string;
    };

    if (!body.token || !body.newPassword) {
      return new Response(
        JSON.stringify({ error: 'Token and new password are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate password complexity
    const passwordCheck = validatePassword(body.newPassword);
    if (!passwordCheck.valid) {
      return new Response(
        JSON.stringify({ error: passwordCheck.errors.join('. ') }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const tokenHash = await hashToken(body.token);

    // Look up the reset token
    const resetRecord = await context.env.DB.prepare(
      'SELECT id, user_id, expires_at FROM password_resets WHERE token_hash = ?'
    )
      .bind(tokenHash)
      .first<{ id: string; user_id: string; expires_at: string }>();

    if (!resetRecord) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired reset link' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check expiration
    if (new Date(resetRecord.expires_at) < new Date()) {
      // Clean up expired token
      await context.env.DB.prepare('DELETE FROM password_resets WHERE id = ?')
        .bind(resetRecord.id)
        .run();

      return new Response(
        JSON.stringify({ error: 'Reset link has expired. Please request a new one.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Hash new password and update user
    const newHash = await hashPassword(body.newPassword);

    await context.env.DB.prepare(
      "UPDATE users SET password_hash = ?, force_password_change = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(newHash, resetRecord.user_id)
      .run();

    // Delete the used reset token
    await context.env.DB.prepare('DELETE FROM password_resets WHERE id = ?')
      .bind(resetRecord.id)
      .run();

    // Revoke all existing sessions for this user
    await context.env.DB.prepare(
      'UPDATE sessions SET revoked = 1 WHERE user_id = ?'
    )
      .bind(resetRecord.user_id)
      .run();

    return new Response(
      JSON.stringify({ success: true, message: 'Password has been reset successfully' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
