import { hashPassword, generateId } from '../../lib/auth';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import { sendEmail, buildInvitationEmail } from '../../lib/email';
import { validatePassword, validateEmail, sanitizeString } from '../../lib/validation';
import type { Env, User } from '../../lib/types';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      email?: string;
      name?: string;
      role?: string;
      tenantId?: string;
      password?: string;
    };

    if (!body.email || !body.name || !body.role || !body.password) {
      return new Response(
        JSON.stringify({ error: 'email, name, role, and password are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validRoles = ['super_admin', 'org_admin', 'user', 'reader'];
    if (!validRoles.includes(body.role)) {
      return new Response(
        JSON.stringify({ error: `role must be one of: ${validRoles.join(', ')}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Sanitize inputs
    const name = sanitizeString(body.name);
    const email = sanitizeString(body.email).toLowerCase();
    const tenantId = body.tenantId ? sanitizeString(body.tenantId) : undefined;

    // Validate email format
    if (!validateEmail(email)) {
      return new Response(
        JSON.stringify({ error: 'Invalid email format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // org_admin can only create user/reader roles within their own tenant
    if (currentUser.role === 'org_admin') {
      if (body.role === 'super_admin' || body.role === 'org_admin') {
        return new Response(
          JSON.stringify({ error: 'Org admins can only create user or reader roles' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (tenantId && tenantId !== currentUser.tenant_id) {
        return new Response(
          JSON.stringify({ error: 'Org admins can only create users within their own tenant' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Force tenant to org_admin's own tenant if not specified
      if (!tenantId) {
        body.tenantId = currentUser.tenant_id ?? undefined;
      }
    }

    // Validate password complexity
    const passwordCheck = validatePassword(body.password);
    if (!passwordCheck.valid) {
      return new Response(
        JSON.stringify({ error: passwordCheck.errors.join('. ') }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check for existing user with same email
    const existing = await context.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    )
      .bind(email)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({ error: 'A user with this email already exists' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // If a tenantId is provided, verify the tenant exists
    const resolvedTenantId = body.tenantId || tenantId;
    if (resolvedTenantId) {
      const tenant = await context.env.DB.prepare(
        'SELECT id FROM tenants WHERE id = ?'
      )
        .bind(resolvedTenantId)
        .first();

      if (!tenant) {
        return new Response(
          JSON.stringify({ error: 'Tenant not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const id = generateId();
    const passwordHash = await hashPassword(body.password);

    await context.env.DB.prepare(
      `INSERT INTO users (id, email, name, role, tenant_id, password_hash, active, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`
    )
      .bind(id, email, name, body.role, resolvedTenantId || null, passwordHash)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      resolvedTenantId || null,
      'user_created',
      'user',
      id,
      JSON.stringify({ email, role: body.role }),
      getClientIp(context.request)
    );

    // Send invitation email if Resend API key is configured
    let emailSent = false;
    if (context.env.RESEND_API_KEY) {
      let orgName = 'Dox';
      if (resolvedTenantId) {
        const tenant = await context.env.DB.prepare(
          'SELECT name FROM tenants WHERE id = ?'
        )
          .bind(resolvedTenantId)
          .first<{ name: string }>();
        if (tenant) orgName = tenant.name;
      }

      const loginUrl = new URL(context.request.url).origin + '/login';
      const { subject, html } = buildInvitationEmail({
        inviterName: currentUser.name,
        orgName,
        email,
        tempPassword: body.password,
        loginUrl,
        role: body.role,
      });

      emailSent = await sendEmail(context.env.RESEND_API_KEY, { to: email, subject, html });
    }

    return new Response(
      JSON.stringify({
        user: {
          id,
          email,
          name,
          role: body.role,
          tenant_id: resolvedTenantId || null,
        },
        emailSent,
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;

    console.error('Register error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
