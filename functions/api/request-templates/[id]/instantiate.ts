/**
 * POST /api/request-templates/:id/instantiate — turn a saved set into a DRAFT.
 *
 * This is the template half of "compose once, re-issue many". It is a FEEDER,
 * not a shortcut: it produces an ordinary draft with `origin = 'template'` and
 * `origin_ref` pointing back at the template, and that draft is issued through
 * POST /api/document-requests/:id/issue like every other draft. There is no
 * "instantiate and send" — a second issue path is the one thing the composer
 * refuses to have, and it is also what would let a saved set go out without a
 * person looking at it.
 *
 * Instantiation is a SNAPSHOT. The lines are copied, not referenced, so a later
 * edit to the template cannot reach back into packets already composed from it,
 * and amending one of those packets cannot rewrite the template. `origin_ref`
 * records where it came from without creating a live link.
 *
 * `default_due_in_days` becomes a real date here — the template stores a
 * duration because it outlives any one deadline, and only an instance has a
 * deadline. An explicit `due_date` in the body wins.
 */

import { getClientIp } from '../../../lib/db';
import { errorToResponse, NotFoundError } from '../../../lib/permissions';
import {
  auditRequest,
  composeRequest,
  loadRequestDetail,
  requireComposer,
  templateLinesToResolved,
} from '../../../lib/document-requests';
import { sanitizeString } from '../../../lib/validation';
import type {
  InstantiateRequestTemplateRequest,
  RequestTemplateLineRow,
  RequestTemplateRow,
} from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** today + n days, as YYYY-MM-DD. */
function dueInDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;

    const template =
      user.role === 'super_admin'
        ? await context.env.DB.prepare('SELECT * FROM request_templates WHERE id = ?')
            .bind(id)
            .first<RequestTemplateRow>()
        : await context.env.DB.prepare(
            'SELECT * FROM request_templates WHERE id = ? AND tenant_id = ?',
          )
            .bind(id, user.tenant_id)
            .first<RequestTemplateRow>();
    if (!template) throw new NotFoundError('Template not found');

    const tenantId = template.tenant_id;

    const body = (await context.request.json()) as InstantiateRequestTemplateRequest;
    if (!body.supplier_id) return json({ error: 'supplier_id is required' }, 400);

    const lineRows = await context.env.DB.prepare(
      'SELECT * FROM request_template_lines WHERE template_id = ? ORDER BY sort_order, rowid',
    )
      .bind(id)
      .all<RequestTemplateLineRow>();
    const lines = templateLinesToResolved(lineRows.results ?? []);
    if (lines.length === 0) {
      return json({ error: 'This template has no lines' }, 400);
    }

    const dueDate =
      body.due_date !== undefined && body.due_date !== null
        ? body.due_date
        : typeof template.default_due_in_days === 'number'
          ? dueInDays(template.default_due_in_days)
          : null;

    const newId = await composeRequest(context.env.DB, tenantId, user, {
      supplierId: body.supplier_id,
      title: body.title ? sanitizeString(body.title) : template.name,
      intro: body.intro ? sanitizeString(body.intro) : (template.description ?? null),
      dueDate,
      assignedTo: body.assigned_to ?? null,
      origin: 'template',
      originRef: template.id,
      lines,
    });

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_composed',
      newId,
      {
        supplier_id: body.supplier_id,
        origin: 'template',
        origin_ref: template.id,
        template_name: template.name,
        line_count: lines.length,
        free_text_lines: lines.filter((l) => l.line_kind === 'free_text').length,
      },
      getClientIp(context.request),
    );

    const request = await loadRequestDetail(context.env.DB, tenantId, newId);
    return json({ request }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Instantiate request template error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
