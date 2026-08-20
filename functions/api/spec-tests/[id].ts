/**
 * Update or remove one analyte. See `spec-tests/index.ts` for why the alias list
 * is the important field here.
 */

import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { sanitizeString } from '../../lib/validation';
import { normalizeAliases } from './index';
import type { Env, User } from '../../lib/types';

async function loadTest(db: D1Database, id: string) {
  const row = await db.prepare('SELECT * FROM spec_tests WHERE id = ?').bind(id).first();
  if (!row) throw new NotFoundError('Analyte not found');
  return row as Record<string, unknown>;
}

/** PUT /api/spec-tests/:id — org_admin+ within the owning tenant. */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const specTest = await loadTest(context.env.DB, context.params.id as string);
    requireTenantAccess(user, specTest.tenant_id as string);

    const body = (await context.request.json()) as {
      name?: string;
      aliases?: unknown;
      default_unit?: string | null;
      notes?: string | null;
    };

    const updates: string[] = [];
    const params: (string | null)[] = [];

    if (body.name !== undefined) {
      const name = sanitizeString(body.name).trim();
      if (!name) {
        return new Response(JSON.stringify({ error: 'name cannot be empty' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const clash = await context.env.DB.prepare(
        'SELECT id FROM spec_tests WHERE tenant_id = ? AND LOWER(name) = LOWER(?) AND id != ?'
      )
        .bind(specTest.tenant_id as string, name, specTest.id as string)
        .first();
      if (clash) {
        return new Response(JSON.stringify({ error: 'That analyte already exists' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      updates.push('name = ?');
      params.push(name);
    }
    if (body.aliases !== undefined) {
      updates.push('aliases = ?');
      params.push(normalizeAliases(body.aliases));
    }
    if (body.default_unit !== undefined) {
      updates.push('default_unit = ?');
      params.push(body.default_unit ? sanitizeString(body.default_unit) : null);
    }
    if (body.notes !== undefined) {
      updates.push('notes = ?');
      params.push(body.notes ? sanitizeString(body.notes) : null);
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: 'No fields to update' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    updates.push("updated_at = datetime('now')", 'updated_by = ?');
    params.push(user.id);

    await context.env.DB.prepare(`UPDATE spec_tests SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...params, specTest.id as string)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      specTest.tenant_id as string,
      'spec_test.updated',
      'spec_tests',
      specTest.id as string,
      JSON.stringify({ fields: updates.length }),
      getClientIp(context.request)
    );

    const updated = await context.env.DB.prepare('SELECT * FROM spec_tests WHERE id = ?')
      .bind(specTest.id as string)
      .first();

    return new Response(JSON.stringify({ specTest: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update spec test error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/**
 * DELETE /api/spec-tests/:id — org_admin+.
 *
 * Deleting an analyte cascades to its limits (FK ON DELETE CASCADE), which
 * silently stops checks that were running. Callers are told how many limits go
 * with it so the UI can say so before the click.
 */
export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const specTest = await loadTest(context.env.DB, context.params.id as string);
    requireTenantAccess(user, specTest.tenant_id as string);

    const count = await context.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM spec_limits WHERE spec_test_id = ?'
    )
      .bind(specTest.id as string)
      .first<{ n: number }>();

    await context.env.DB.prepare('DELETE FROM spec_tests WHERE id = ?')
      .bind(specTest.id as string)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      specTest.tenant_id as string,
      'spec_test.deleted',
      'spec_tests',
      specTest.id as string,
      JSON.stringify({ name: specTest.name, limits_removed: count?.n ?? 0 }),
      getClientIp(context.request)
    );

    return new Response(JSON.stringify({ success: true, limits_removed: count?.n ?? 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Delete spec test error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
