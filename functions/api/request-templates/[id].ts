/**
 * /api/request-templates/:id — one saved composed set.
 *
 * GET    the template and its lines
 * PUT    rename / redescribe, and optionally REPLACE the line set
 * DELETE retire (soft)
 *
 * DELETE IS A SOFT-DELETE, matching `requirements` rather than
 * `supplier_requirements`. The difference is whether anything points at the
 * row: nothing points at an applicability row, so 0087 hard-deletes it; but
 * `document_requests.origin_ref` records which template composed a draft, and
 * hard-deleting would leave that provenance dangling on requests that have
 * already gone out. `active = 0` stops it being offered without erasing what it
 * produced.
 */

import { getClientIp, logAudit } from '../../lib/db';
import { errorToResponse, NotFoundError } from '../../lib/permissions';
import {
  requireComposer,
  resolveLines,
  templateLineInsertStatements,
} from '../../lib/document-requests';
import { sanitizeString } from '../../lib/validation';
import type { RequestTemplateLineRow, RequestTemplateRow } from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadTemplate(
  db: D1Database,
  user: User,
  id: string,
): Promise<RequestTemplateRow> {
  const row =
    user.role === 'super_admin'
      ? await db
          .prepare('SELECT * FROM request_templates WHERE id = ?')
          .bind(id)
          .first<RequestTemplateRow>()
      : await db
          .prepare('SELECT * FROM request_templates WHERE id = ? AND tenant_id = ?')
          .bind(id, user.tenant_id)
          .first<RequestTemplateRow>();
  if (!row) throw new NotFoundError('Template not found');
  return row;
}

async function templateLines(db: D1Database, id: string): Promise<RequestTemplateLineRow[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM request_template_lines WHERE template_id = ? ORDER BY sort_order, rowid',
    )
    .bind(id)
    .all<RequestTemplateLineRow>();
  return rows.results ?? [];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const template = await loadTemplate(context.env.DB, user, id);
    return json({ template: { ...template, lines: await templateLines(context.env.DB, id) } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Get request template error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * PUT — a `lines` array REPLACES the set wholesale.
 *
 * Editing a template is not an amendment and is deliberately not versioned:
 * nothing has been committed to anyone. A template is configuration, and the
 * requests it has already composed are snapshots that this edit cannot reach.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const existing = await loadTemplate(context.env.DB, user, id);
    const tenantId = existing.tenant_id;

    const body = (await context.request.json()) as {
      name?: string;
      description?: string | null;
      default_due_in_days?: number | null;
      active?: number | boolean;
      lines?: unknown;
    };

    const name = body.name === undefined ? existing.name : sanitizeString(body.name);
    if (!name) return json({ error: 'name cannot be empty' }, 400);

    const statements = [
      context.env.DB.prepare(
        `UPDATE request_templates
            SET name = ?, description = ?, default_due_in_days = ?, active = ?,
                updated_at = datetime('now'), updated_by = ?
          WHERE id = ? AND tenant_id = ?`,
      ).bind(
        name,
        body.description === undefined
          ? existing.description
          : (body.description ? sanitizeString(body.description) : null),
        body.default_due_in_days === undefined
          ? existing.default_due_in_days
          : (typeof body.default_due_in_days === 'number' ? body.default_due_in_days : null),
        body.active === undefined ? existing.active : (body.active ? 1 : 0),
        user.id,
        id,
        tenantId,
      ),
    ];

    if (body.lines !== undefined) {
      const lines = await resolveLines(context.env.DB, tenantId, body.lines);
      statements.push(
        context.env.DB.prepare(
          'DELETE FROM request_template_lines WHERE template_id = ? AND tenant_id = ?',
        ).bind(id, tenantId),
        ...templateLineInsertStatements(context.env.DB, tenantId, id, lines, user.id),
      );
    }

    await context.env.DB.batch(statements);

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'request_template_updated',
      'request_template',
      id,
      JSON.stringify({ name, lines_replaced: body.lines !== undefined }),
      getClientIp(context.request),
    );

    const template = await loadTemplate(context.env.DB, user, id);
    return json({ template: { ...template, lines: await templateLines(context.env.DB, id) } });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Update request template error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const existing = await loadTemplate(context.env.DB, user, id);

    await context.env.DB.prepare(
      `UPDATE request_templates
          SET active = 0, updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND tenant_id = ?`,
    )
      .bind(user.id, id, existing.tenant_id)
      .run();

    await logAudit(
      context.env.DB,
      user.id,
      existing.tenant_id,
      'request_template_retired',
      'request_template',
      id,
      JSON.stringify({ name: existing.name }),
      getClientIp(context.request),
    );

    return json({ success: true });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Retire request template error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
