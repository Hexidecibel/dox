/**
 * /api/request-templates — a composed set, saved and re-issued.
 *
 * WHY A SEPARATE RESOURCE AND NOT `?is_template=1` ON /api/document-requests
 * -------------------------------------------------------------------------
 * Because it is a separate TABLE, and it is a separate table because a template
 * is a different thing wearing the same clothes: no supplier, no due date, no
 * assigned buyer, no issued_at, no version chain, and lines with no status. The
 * full argument is in migration 0090's header, but the short version is that a
 * flag would force `document_requests.supplier_id` to become nullable — losing
 * the single most valuable constraint on that table — and would put
 * `AND is_template = 0` in every query in the feature forever, where the first
 * one that forgets it issues a template to a supplier.
 *
 * The cost is this file: a second, smaller CRUD surface. That is the trade, and
 * it is deliberately kept small — a template line is the composable SUBSET of a
 * request line, same column names and types, so instantiation is a copy rather
 * than a translation.
 *
 * ROLE GATE mirrors /api/supplier-requirements: reading is open to any
 * authenticated user of the tenant, writing is super_admin | org_admin.
 */

import { generateId, getClientIp, logAudit } from '../../lib/db';
import { errorToResponse, BadRequestError } from '../../lib/permissions';
import {
  loadLines,
  requireComposer,
  resolveLines,
  resolveRequestTenant,
  templateLineInsertStatements,
  type ResolvedLine,
} from '../../lib/document-requests';
import { slugifyVocab } from '../../lib/registry-vocab';
import { sanitizeString } from '../../lib/validation';
import type {
  CreateRequestTemplateRequest,
  RequestTemplateDetail,
  RequestTemplateLineRow,
  RequestTemplateListResponse,
  RequestTemplateRow,
} from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/request-templates — ?include_inactive=1, ?tenant_id= (super_admin) */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      const t = url.searchParams.get('tenant_id');
      if (t) {
        conditions.push('t.tenant_id = ?');
        params.push(t);
      }
    } else {
      conditions.push('t.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    const raw = url.searchParams.get('include_inactive');
    if (!(raw === '1' || raw === 'true' || raw === 'yes')) {
      conditions.push('t.active = 1');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const templates = await context.env.DB.prepare(
      `SELECT t.* FROM request_templates t ${where} ORDER BY t.name`,
    )
      .bind(...params)
      .all<RequestTemplateRow>();

    const rows = templates.results ?? [];
    const byTemplate = new Map<string, RequestTemplateLineRow[]>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      const lineRows = await context.env.DB.prepare(
        `SELECT * FROM request_template_lines
          WHERE template_id IN (${placeholders})
          ORDER BY sort_order, rowid`,
      )
        .bind(...ids)
        .all<RequestTemplateLineRow>();
      for (const l of lineRows.results ?? []) {
        const list = byTemplate.get(l.template_id) ?? [];
        list.push(l);
        byTemplate.set(l.template_id, list);
      }
    }

    const body: RequestTemplateListResponse = {
      templates: rows.map(
        (t): RequestTemplateDetail => ({ ...t, lines: byTemplate.get(t.id) ?? [] }),
      ),
      total: rows.length,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List request templates error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/request-templates
 *
 * Body: name, slug?, description?, default_due_in_days?, and EITHER `lines[]`
 * or `from_request_id` (snapshot an existing composed request's lines).
 *
 * `from_request_id` is the "save this packet so we can send it again" gesture,
 * and it is a snapshot: later edits to the template do not reach back into the
 * request it was taken from, and later amendments to that request do not change
 * the template. A live link between the two would mean editing a template
 * silently rewrote history, which is the thing the versioning rule forbids one
 * table over.
 *
 * `default_due_in_days` is a DURATION, not a date: a template outlives any one
 * deadline. Instantiation turns it into a date.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const body = (await context.request.json()) as CreateRequestTemplateRequest;

    const name = body.name ? sanitizeString(body.name) : '';
    if (!name) return json({ error: 'name is required' }, 400);

    const tenantId = resolveRequestTenant(user, body.tenant_id);
    const slug = slugifyVocab(body.slug ? sanitizeString(body.slug) : name);
    if (!slug) return json({ error: 'name must contain at least one alphanumeric character' }, 400);

    let lines: ResolvedLine[];
    if (body.from_request_id) {
      // Snapshot. Tenant-scoped, so a super_admin naming another tenant's
      // request gets nothing rather than a cross-tenant copy.
      const sourceLines = await loadLines(context.env.DB, tenantId, body.from_request_id);
      if (sourceLines.length === 0) {
        throw new BadRequestError('That request has no lines to save as a template');
      }
      lines = sourceLines.map((l, i) => ({
        line_kind: l.line_kind,
        requirement_id: l.requirement_id,
        name: l.name,
        explanation: l.explanation,
        acceptable_formats: l.acceptable_formats,
        criteria: l.criteria,
        owner: l.owner,
        tier: l.tier,
        sort_order: typeof l.sort_order === 'number' ? l.sort_order : i,
      }));
    } else {
      lines = await resolveLines(context.env.DB, tenantId, body.lines ?? []);
    }

    if (lines.length === 0) {
      throw new BadRequestError('A template must have at least one line');
    }

    const existing = await context.env.DB.prepare(
      'SELECT id FROM request_templates WHERE tenant_id = ? AND slug = ?',
    )
      .bind(tenantId, slug)
      .first();
    if (existing) return json({ error: `A template named "${slug}" already exists` }, 409);

    const id = generateId();
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO request_templates
           (id, tenant_id, name, slug, description, default_due_in_days, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        tenantId,
        name,
        slug,
        body.description ? sanitizeString(body.description) : null,
        typeof body.default_due_in_days === 'number' ? body.default_due_in_days : null,
        user.id,
        user.id,
      ),
      ...templateLineInsertStatements(context.env.DB, tenantId, id, lines, user.id),
    ]);

    await logAudit(
      context.env.DB,
      user.id,
      tenantId,
      'request_template_created',
      'request_template',
      id,
      JSON.stringify({
        name,
        slug,
        line_count: lines.length,
        free_text_lines: lines.filter((l) => l.line_kind === 'free_text').length,
        from_request_id: body.from_request_id ?? null,
      }),
      getClientIp(context.request),
    );

    const template = await context.env.DB.prepare(
      'SELECT * FROM request_templates WHERE id = ?',
    )
      .bind(id)
      .first<RequestTemplateRow>();
    const templateLines = await context.env.DB.prepare(
      'SELECT * FROM request_template_lines WHERE template_id = ? ORDER BY sort_order, rowid',
    )
      .bind(id)
      .all<RequestTemplateLineRow>();

    return json({ template: { ...template, lines: templateLines.results ?? [] } }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Create request template error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
