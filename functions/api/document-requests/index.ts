/**
 * /api/document-requests — the composer.
 *
 * Migration 0090. `requirements` (0080) is the vocabulary,
 * `supplier_requirements` (0087) says who owes what, and
 * `shared/requirementGap.ts` computes what is missing. This is the endpoint
 * that ASKS for it.
 *
 * The client: "The composer is the primitive. Every checklist source is a
 * feeder into it." A gap report, a saved template, a person typing, and a
 * future draft generator all POST here and all leave through
 * /api/document-requests/:id/issue. `origin` records which feeder it was and
 * selects nothing.
 *
 * Transport only. Every decision lives in functions/lib/document-requests.ts.
 *
 * ROLE GATE — reading mirrors /api/supplier-gaps (any authenticated user of the
 * tenant; an outstanding-requests list is evidence, not configuration), writing
 * mirrors /api/supplier-requirements (super_admin | org_admin, because issuing
 * commits the organization to an outbound ask).
 */

import { getClientIp } from '../../lib/db';
import { errorToResponse } from '../../lib/permissions';
import {
  auditRequest,
  composeRequest,
  countLines,
  isRequestOrigin,
  isRequestStatus,
  loadRequestDetail,
  requireComposer,
  resolveLines,
  resolveRequestTenant,
} from '../../lib/document-requests';
import { sanitizeString } from '../../lib/validation';
import type {
  CreateDocumentRequestRequest,
  DocumentRequestListItem,
  DocumentRequestListResponse,
  DocumentRequestRow,
  RequestLineRow,
} from '../../../shared/types';
import type { Env, User } from '../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/document-requests
 *
 * ?supplier_id=      one supplier's asks
 * ?status=           draft|issued|cancelled|closed
 * ?assigned_to=      one buyer's queue
 * ?include_superseded=1
 *                    include amended-away versions. OFF by default: a list
 *                    that mixes live and superseded versions of the same ask
 *                    double-counts what is outstanding, which is the one thing
 *                    this screen must not do. History is on the detail view.
 * ?tenant_id=        super_admin only
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (user.role === 'super_admin') {
      const t = url.searchParams.get('tenant_id');
      if (t) {
        conditions.push('r.tenant_id = ?');
        params.push(t);
      }
    } else {
      conditions.push('r.tenant_id = ?');
      params.push(user.tenant_id!);
    }

    const supplierId = url.searchParams.get('supplier_id');
    if (supplierId) {
      conditions.push('r.supplier_id = ?');
      params.push(supplierId);
    }

    const status = url.searchParams.get('status');
    if (status) {
      if (!isRequestStatus(status)) {
        return json({ error: 'status must be one of: draft, issued, cancelled, closed' }, 400);
      }
      conditions.push('r.status = ?');
      params.push(status);
    }

    const assignedTo = url.searchParams.get('assigned_to');
    if (assignedTo) {
      conditions.push('r.assigned_to = ?');
      params.push(assignedTo);
    }

    const raw = url.searchParams.get('include_superseded');
    const includeSuperseded = raw === '1' || raw === 'true' || raw === 'yes';
    if (!includeSuperseded) conditions.push('r.superseded_at IS NULL');

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const countRow = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM document_requests r ${where}`,
    )
      .bind(...params)
      .first<{ total: number }>();

    const rows = await context.env.DB.prepare(
      `SELECT r.*, s.name AS supplier_name, u.name AS assigned_to_name
         FROM document_requests r
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN users u ON u.id = r.assigned_to
         ${where}
        ORDER BY COALESCE(r.issued_at, r.created_at) DESC, r.rowid DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all<DocumentRequestRow & { supplier_name: string | null; assigned_to_name: string | null }>();

    const requests = rows.results ?? [];

    // Counts in one extra query rather than one per request: a list of fifty
    // asks must not be fifty round trips.
    const counts = new Map<string, RequestLineRow[]>();
    if (requests.length > 0) {
      const ids = requests.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      const lineRows = await context.env.DB.prepare(
        `SELECT * FROM request_lines WHERE request_id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<RequestLineRow>();
      for (const l of lineRows.results ?? []) {
        const list = counts.get(l.request_id) ?? [];
        list.push(l);
        counts.set(l.request_id, list);
      }
    }

    const body: DocumentRequestListResponse = {
      requests: requests.map(
        (r): DocumentRequestListItem => ({
          ...r,
          counts: countLines(counts.get(r.id) ?? []),
        }),
      ),
      total: countRow?.total ?? 0,
      limit,
      offset,
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List document requests error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/**
 * POST /api/document-requests — compose a DRAFT.
 *
 * Body: supplier_id, title, intro?, due_date?, assigned_to?, origin?,
 * origin_ref?, lines[], tenant_id? (super_admin only).
 *
 * A draft, always. Nothing here issues, whatever the origin — a generator
 * populates a draft a person reviews and issues, and there is no body field
 * that shortcuts that.
 *
 * Each line must resolve to a `requirement_id` unless it explicitly declares
 * `line_kind: "free_text"`. See `resolveLines` for why the escape hatch has to
 * be asked for by name.
 */
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const body = (await context.request.json()) as CreateDocumentRequestRequest;

    if (!body.supplier_id) return json({ error: 'supplier_id is required' }, 400);
    const title = body.title ? sanitizeString(body.title) : '';
    if (!title) return json({ error: 'title is required' }, 400);

    const origin = body.origin ?? 'manual';
    if (!isRequestOrigin(origin)) {
      return json({ error: 'origin must be one of: manual, template, gap, generated' }, 400);
    }

    const tenantId = resolveRequestTenant(user, body.tenant_id);
    const lines = await resolveLines(context.env.DB, tenantId, body.lines ?? []);

    const id = await composeRequest(context.env.DB, tenantId, user, {
      supplierId: body.supplier_id,
      title,
      intro: body.intro ? sanitizeString(body.intro) : null,
      dueDate: body.due_date ?? null,
      assignedTo: body.assigned_to ?? null,
      origin,
      originRef: body.origin_ref ?? null,
      lines,
    });

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_composed',
      id,
      {
        supplier_id: body.supplier_id,
        origin,
        line_count: lines.length,
        free_text_lines: lines.filter((l) => l.line_kind === 'free_text').length,
      },
      getClientIp(context.request),
    );

    const request = await loadRequestDetail(context.env.DB, tenantId, id);
    return json({ request }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Compose document request error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
