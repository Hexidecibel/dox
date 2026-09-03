import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import type {
  DocumentTypeRequirementRow,
  DocumentTypeRequirementsResponse,
} from '../../../shared/types';

/**
 * GET /api/document-type-requirements?document_type_id=…
 *
 * The READ side of migration 0100 — "what would a document of this type be
 * proposed to close?".
 *
 * `functions/lib/requirement-defaults.ts` is the writer, and it runs at the
 * moment a `documents` row appears: on approve, on ingest, on a type change.
 * That is correct for the producer and useless for anything that needs to state
 * the CONSEQUENCE before a human has decided anything — the setup wizard's last
 * screen watches a document being read and has to be able to say "approving
 * this will propose these three line items" without approving it, and a screen
 * that computed that number any other way would be inventing it.
 *
 * READ ONLY, DELIBERATELY. There is no POST or DELETE here: mappings arrive
 * from a starter pack (`INSERT OR IGNORE` on a deterministic id) and, when a
 * screen for editing them ships, it will live with the document types it
 * belongs to. Adding a write path now would create a second producer before
 * anything has asked for one.
 *
 * Role: super_admin, org_admin — this is registry configuration, the same tier
 * as /api/requirements and /api/document-types' write half.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const documentTypeId = url.searchParams.get('document_type_id');
    if (!documentTypeId) throw new BadRequestError('document_type_id is required');

    // The TYPE decides the tenant, not the query string. A type id is already
    // owned by exactly one tenant, so reading the tenant off the row and then
    // checking access is stricter than trusting a `tenant_id` parameter and
    // leaves a super_admin able to inspect any type without naming its tenant.
    const type = await context.env.DB.prepare(
      'SELECT id, tenant_id FROM document_types WHERE id = ?',
    )
      .bind(documentTypeId)
      .first<{ id: string; tenant_id: string }>();
    if (!type) throw new BadRequestError('Unknown document type');
    requireTenantAccess(user, type.tenant_id);

    const rows = await context.env.DB.prepare(
      `SELECT dtr.requirement_id,
              dtr.source,
              r.name AS requirement_name,
              r.slug AS requirement_slug,
              r.checklist AS requirement_checklist
         FROM document_type_requirements dtr
         JOIN requirements r ON r.id = dtr.requirement_id
        WHERE dtr.tenant_id = ? AND dtr.document_type_id = ?
          -- A retired checklist item is not something an approval will close,
          -- so it must not be counted in a sentence that says it will. The
          -- producer does not filter on active at all: it writes a suggestion a
          -- human still resolves. But a PREVIEW that over-counts is worse than
          -- one that under-counts.
          AND r.active = 1
        ORDER BY r.checklist, r.sort_order, r.name`,
    )
      .bind(type.tenant_id, documentTypeId)
      .all<DocumentTypeRequirementRow>();

    const body: DocumentTypeRequirementsResponse = {
      tenant_id: type.tenant_id,
      document_type_id: documentTypeId,
      requirements: rows.results ?? [],
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('document-type-requirements list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
