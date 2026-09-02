/**
 * /api/document-requests/:id/lines — the line set of one request.
 *
 * GET  every line, with its `closure` (see below)
 * POST add lines to a DRAFT
 *
 * Adding is draft-only. Once a packet is issued, adding a line is a change to
 * what the supplier was asked for, which is an amendment
 * (POST :id/amend with a full `lines` array) and therefore a new version. A
 * POST that quietly appended to an issued packet would be exactly the silent
 * overwrite the versioning rule exists to prevent.
 *
 * Every line must resolve to a `requirement_id` unless it explicitly declares
 * `line_kind: "free_text"`. The client's reason, verbatim: "A line that
 * resolves to a document type can be satisfied, can drive expiry, and can be
 * counted by gap detection. A line that is only free text produces a document
 * the registry cannot reason about, which quietly turns the portal back into a
 * filing cabinet."
 */

import { generateId, getClientIp } from '../../../lib/db';
import { errorToResponse, BadRequestError } from '../../../lib/permissions';
import {
  auditRequest,
  countLines,
  loadClosures,
  loadLines,
  loadRequest,
  requireComposer,
  resolveLines,
  resolveTenantForRequest,
} from '../../../lib/document-requests';
import type { RequestLineInput } from '../../../../shared/types';
import type { Env, User } from '../../../lib/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);

    const request = await loadRequest(context.env.DB, tenantId, id);
    const lines = await loadLines(context.env.DB, tenantId, id);
    const requirementIds = [
      ...new Set(lines.map((l) => l.requirement_id).filter((v): v is string => !!v)),
    ];
    const closures = await loadClosures(
      context.env.DB,
      tenantId,
      request.supplier_id,
      requirementIds,
    );

    return json({
      lines: lines.map((l) => ({
        ...l,
        // Free-text lines get an empty array, always — nothing in the registry
        // can point at them.
        closure: l.requirement_id ? (closures.get(l.requirement_id) ?? []) : [],
      })),
      counts: countLines(lines),
    });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('List request lines error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireComposer(user);

    const id = context.params.id as string;
    const tenantId = await resolveTenantForRequest(context.env.DB, user, id);
    const request = await loadRequest(context.env.DB, tenantId, id);

    if (request.status !== 'draft') {
      return json(
        {
          error:
            `Lines can only be added to a draft; this request is ${request.status}. ` +
            `Changing what an issued request asks for is an amendment ` +
            `(POST /api/document-requests/${id}/amend), which preserves the original.`,
        },
        409,
      );
    }

    const body = (await context.request.json()) as { lines?: RequestLineInput[] };
    const incoming = Array.isArray(body.lines) ? body.lines : [body as RequestLineInput];
    const resolved = await resolveLines(context.env.DB, tenantId, incoming);
    if (resolved.length === 0) throw new BadRequestError('No lines supplied');

    const existing = await loadLines(context.env.DB, tenantId, id);
    // The partial unique index enforces this too, but a 400 naming the
    // duplicate reads better than a constraint error.
    const already = new Set(
      existing.map((l) => l.requirement_id).filter((v): v is string => !!v),
    );
    for (const l of resolved) {
      if (l.requirement_id && already.has(l.requirement_id)) {
        throw new BadRequestError(`"${l.name}" is already a line on this request`);
      }
    }

    const base = existing.reduce((max, l) => Math.max(max, Number(l.sort_order ?? 0)), -1) + 1;

    await context.env.DB.batch(
      resolved.map((l, i) =>
        context.env.DB.prepare(
          `INSERT INTO request_lines
             (id, tenant_id, request_id, line_kind, requirement_id, name, explanation,
              acceptable_formats, criteria, owner, tier, sort_order, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          generateId(),
          tenantId,
          id,
          l.line_kind,
          l.requirement_id,
          l.name,
          l.explanation,
          l.acceptable_formats,
          l.criteria,
          l.owner,
          l.tier,
          base + i,
          user.id,
          user.id,
        ),
      ),
    );

    await auditRequest(
      context.env.DB,
      user,
      tenantId,
      'document_request_lines_added',
      id,
      {
        added: resolved.length,
        free_text: resolved.filter((l) => l.line_kind === 'free_text').length,
      },
      getClientIp(context.request),
    );

    const lines = await loadLines(context.env.DB, tenantId, id);
    return json({ lines, counts: countLines(lines) }, 201);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Add request lines error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
