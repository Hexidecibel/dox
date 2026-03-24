import { verifyPassword, hashPassword } from '../../lib/auth';
import { logAudit, getClientIp } from '../../lib/db';
import { validatePassword } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    const body = (await context.request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!body.currentPassword || !body.newPassword) {
      return new Response(
        JSON.stringify({ error: 'currentPassword and newPassword are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate new password complexity
    const passwordCheck = validatePassword(body.newPassword);
    if (!passwordCheck.valid) {
      return new Response(
        JSON.stringify({ error: passwordCheck.errors.join('. ') }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch current password hash
    const record = await context.env.DB.prepare(
      'SELECT password_hash FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first<{ password_hash: string }>();

    if (!record) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const valid = await verifyPassword(body.currentPassword, record.password_hash);
    if (!valid) {
      return new Response(
        JSON.stringify({ error: 'Current password is incorrect' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const newHash = await hashPassword(body.newPassword);

    await context.env.DB.prepare(
      "UPDATE users SET password_hash = ?, force_password_change = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(newHash, user.id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      user.tenant_id,
      'password_changed',
      'user',
      user.id,
      null,
      getClientIp(context.request)
    );

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
