import { getClientIp } from '../../lib/db';
import { checkRateLimit, recordAttempt } from '../../lib/ratelimit';
import { sendEmail, buildPasswordResetEmail } from '../../lib/email';
import { sanitizeString, validateEmail } from '../../lib/validation';
import type { Env } from '../../lib/types';

const MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW = 900; // 15 minutes

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
  const successMessage = 'If an account exists with that email, a reset link has been sent';

  try {
    const body = (await context.request.json()) as { email?: string };

    if (!body.email) {
      return new Response(
        JSON.stringify({ message: successMessage }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const email = sanitizeString(body.email).toLowerCase();

    if (!validateEmail(email)) {
      return new Response(
        JSON.stringify({ message: successMessage }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const ip = getClientIp(context.request) || 'unknown';
    const rateLimitKey = `forgot:${ip}`;

    // Check rate limit
    const rateCheck = await checkRateLimit(
      context.env.DB,
      rateLimitKey,
      MAX_ATTEMPTS,
      RATE_LIMIT_WINDOW
    );

    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Always record the attempt
    await recordAttempt(context.env.DB, rateLimitKey, RATE_LIMIT_WINDOW);

    // Look up user
    const user = await context.env.DB.prepare(
      'SELECT id, name, email, active FROM users WHERE email = ?'
    )
      .bind(email)
      .first<{ id: string; name: string; email: string; active: number }>();

    if (!user || !user.active) {
      // Don't leak whether email exists
      return new Response(
        JSON.stringify({ message: successMessage }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Generate reset token
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const resetToken = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const tokenHash = await hashToken(resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Clean up any existing reset tokens for this user
    await context.env.DB.prepare(
      'DELETE FROM password_resets WHERE user_id = ?'
    )
      .bind(user.id)
      .run();

    // Store hashed token
    await context.env.DB.prepare(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES (?, ?, ?)`
    )
      .bind(user.id, tokenHash, expiresAt)
      .run();

    // Send reset email
    if (context.env.RESEND_API_KEY) {
      const origin = new URL(context.request.url).origin;
      const resetUrl = `${origin}/reset-password?token=${resetToken}`;

      const { subject, html } = buildPasswordResetEmail({
        userName: user.name,
        resetUrl,
      });

      await sendEmail(context.env.RESEND_API_KEY, {
        to: user.email,
        subject,
        html,
      });
    }

    return new Response(
      JSON.stringify({ message: successMessage }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({ message: successMessage }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
};
