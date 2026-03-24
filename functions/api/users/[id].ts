import { logAudit, getClientIp } from '../../lib/db';
import { errorToResponse, ForbiddenError } from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { computeDiff } from '../../lib/diff';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const targetId = context.params.id as string;

    const target = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first();

    if (!target) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetUser = target as unknown as User & { last_login_at: string | null; created_at: string };

    // Access control
    if (currentUser.role === 'super_admin') {
      // can see any user
    } else if (currentUser.role === 'org_admin') {
      if (targetUser.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError('Cannot view users outside your tenant');
      }
    } else {
      // user/reader can only see themselves
      if (targetId !== currentUser.id) {
        throw new ForbiddenError('You can only view your own profile');
      }
    }

    return new Response(JSON.stringify(target), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const targetId = context.params.id as string;

    const target = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first();

    if (!target) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetUser = target as unknown as User;

    const body = (await context.request.json()) as {
      name?: string;
      role?: string;
      active?: number;
      tenant_id?: string;
      email?: string;
    };

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (currentUser.role === 'super_admin') {
      // Can update any field on any user
      if (body.name !== undefined) { updates.push('name = ?'); values.push(sanitizeString(body.name)); }
      if (body.email !== undefined) { updates.push('email = ?'); values.push(sanitizeString(body.email).toLowerCase()); }
      if (body.role !== undefined) { updates.push('role = ?'); values.push(body.role); }
      if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active); }
      if (body.tenant_id !== undefined) { updates.push('tenant_id = ?'); values.push(body.tenant_id || null); }
    } else if (currentUser.role === 'org_admin') {
      // Can update users in their own tenant
      if (targetUser.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError('Cannot modify users outside your tenant');
      }
      // Cannot modify other org_admins
      if (targetUser.role === 'org_admin' && targetId !== currentUser.id) {
        throw new ForbiddenError('Cannot modify other org admins');
      }
      // Cannot set super_admin or org_admin roles
      if (body.role !== undefined && (body.role === 'super_admin' || body.role === 'org_admin')) {
        throw new ForbiddenError('Cannot assign admin roles');
      }

      if (body.name !== undefined) { updates.push('name = ?'); values.push(sanitizeString(body.name)); }
      if (body.email !== undefined) { updates.push('email = ?'); values.push(sanitizeString(body.email).toLowerCase()); }
      if (body.role !== undefined) { updates.push('role = ?'); values.push(body.role); }
      if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active); }
    } else {
      // Regular user/reader can only update their own name
      if (targetId !== currentUser.id) {
        throw new ForbiddenError('You can only update your own profile');
      }
      if (body.name !== undefined) { updates.push('name = ?'); values.push(sanitizeString(body.name)); }
      // Ignore role, active, tenant_id, email changes for regular users
    }

    if (updates.length === 0) {
      return new Response(
        JSON.stringify({ error: 'No valid fields to update' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    updates.push("updated_at = datetime('now')");
    values.push(targetId);

    // Compute diff on safe fields (never include password_hash)
    // Build new values based on what will actually be written
    const newValues: Record<string, any> = {
      name: targetUser.name,
      role: targetUser.role,
      active: targetUser.active,
      tenant_id: targetUser.tenant_id,
    };
    // Apply updates that were actually queued
    for (const u of updates) {
      if (u === "updated_at = datetime('now')") continue;
      const field = u.split(' = ')[0];
      if (field === 'name' && body.name !== undefined) newValues.name = sanitizeString(body.name);
      if (field === 'role' && body.role !== undefined) newValues.role = body.role;
      if (field === 'active' && body.active !== undefined) newValues.active = body.active;
      if (field === 'tenant_id' && body.tenant_id !== undefined) newValues.tenant_id = body.tenant_id || null;
    }

    const diff = computeDiff(
      targetUser as unknown as Record<string, any>,
      newValues,
      ['name', 'role', 'active', 'tenant_id']
    );

    await context.env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    )
      .bind(...values)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      currentUser.tenant_id,
      'user_updated',
      'user',
      targetId,
      JSON.stringify({ changes: diff }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active, last_login_at, created_at FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first();

    return new Response(JSON.stringify(updated), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    const targetId = context.params.id as string;

    const target = await context.env.DB.prepare(
      'SELECT id, email, name, role, tenant_id, active FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first();

    if (!target) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const targetUser = target as unknown as User;

    if (currentUser.role === 'super_admin') {
      // Can deactivate any user
    } else if (currentUser.role === 'org_admin') {
      if (targetUser.tenant_id !== currentUser.tenant_id) {
        throw new ForbiddenError('Cannot deactivate users outside your tenant');
      }
      if (targetUser.role === 'org_admin' || targetUser.role === 'super_admin') {
        throw new ForbiddenError('Cannot deactivate admins');
      }
    } else {
      throw new ForbiddenError('Insufficient permissions');
    }

    await context.env.DB.prepare(
      "UPDATE users SET active = 0, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(targetId)
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      currentUser.tenant_id,
      'user_deactivated',
      'user',
      targetId,
      null,
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
