import { generateApiKey, hashApiKey, generateId } from '../../lib/auth';
import { logAudit, getClientIp } from '../../lib/db';
import { requireRole, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    let query: string;
    const bindings: string[] = [];

    if (currentUser.role === 'super_admin') {
      query = `SELECT ak.*, u.name as user_name, u.email as user_email
               FROM api_keys ak
               JOIN users u ON ak.user_id = u.id
               ORDER BY ak.created_at DESC`;
    } else {
      query = `SELECT ak.*, u.name as user_name, u.email as user_email
               FROM api_keys ak
               JOIN users u ON ak.user_id = u.id
               WHERE ak.tenant_id = ?
               ORDER BY ak.created_at DESC`;
      bindings.push(currentUser.tenant_id!);
    }

    const result = await context.env.DB.prepare(query)
      .bind(...bindings)
      .all();

    return new Response(JSON.stringify(result.results), {
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const currentUser = context.data.user as User;
    requireRole(currentUser, 'super_admin', 'org_admin');

    const body = (await context.request.json()) as {
      name?: string;
      tenantId?: string;
      permissions?: string[];
      expiresAt?: string;
    };

    if (!body.name || !body.name.trim()) {
      return new Response(
        JSON.stringify({ error: 'name is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // org_admin can only create keys scoped to their tenant
    let tenantId: string | null = null;
    if (currentUser.role === 'org_admin') {
      tenantId = currentUser.tenant_id;
    } else if (body.tenantId) {
      tenantId = body.tenantId;
    }

    const { key, prefix } = generateApiKey();
    const keyHash = await hashApiKey(key);
    const id = generateId();
    const permissions = JSON.stringify(body.permissions || ['*']);

    await context.env.DB.prepare(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, user_id, tenant_id, permissions, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.name.trim(),
        keyHash,
        prefix,
        currentUser.id,
        tenantId,
        permissions,
        body.expiresAt || null
      )
      .run();

    await logAudit(
      context.env.DB,
      currentUser.id,
      tenantId,
      'api_key.created',
      'api_key',
      id,
      JSON.stringify({ name: body.name, prefix }),
      getClientIp(context.request)
    );

    const apiKey = await context.env.DB.prepare(
      `SELECT ak.*, u.name as user_name, u.email as user_email
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.id = ?`
    )
      .bind(id)
      .first();

    return new Response(
      JSON.stringify({ apiKey, key }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
