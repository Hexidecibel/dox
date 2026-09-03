import { requireRole, requireTenantAccess, BadRequestError, errorToResponse } from '../../lib/permissions';
import { generateId, logAudit, getClientIp } from '../../lib/db';
import type { Env, User } from '../../lib/types';
import type {
  DocumentTypeRequirementRow,
  DocumentTypeRequirementsResponse,
  ReplaceDocumentTypeRequirementsResponse,
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
 * IT WAS READ ONLY UNTIL THE WIZARD'S TEACHING SCREEN ASKED FOR A WRITER, and
 * the original header said so: "when a screen for editing them ships, it will
 * live with the document types it belongs to". That screen is the setup
 * wizard's screen 4, and it does not merely edit the mapping — it IS the
 * lesson. Somebody reads one real specification sheet and ticks the checklist
 * items it closes, and what they tick has to become the tenant's configuration,
 * or the exercise was a quiz with no consequence. So PUT lives here, next to
 * the read, rather than in a second file that would have to repeat the
 * tenant-off-the-type rule below.
 *
 * PUT REPLACES THE WHOLE SET FOR ONE TYPE. Not a merge, and not a per-row
 * POST/DELETE pair: the caller holds a list of ticked boxes and the only thing
 * it can state honestly is the whole list. A merge would leave a box somebody
 * deliberately UNticked still mapped, which on this table means an approved
 * document goes on proposing a line item a human has already said it does not
 * close.
 *
 * `source` CANNOT BE 'pack'. The column has no CHECK (see the migration —
 * producers grow and SQLite cannot alter a CHECK in place), but a human write
 * that claimed to be the pack would destroy the one thing the column is for:
 * telling "the starter pack decided this" apart from "somebody here decided
 * this". So the endpoint's allow-list is 'wizard' and 'human', and 'pack' is
 * writable only by the seeder.
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

/**
 * Resolve the type and authorise against ITS tenant.
 *
 * The TYPE decides the tenant, not the query string or the body. A type id is
 * already owned by exactly one tenant, so reading the tenant off the row and
 * then checking access is stricter than trusting a `tenant_id` parameter, and
 * it leaves a super_admin able to work on any type without naming its tenant.
 * Shared by both verbs so the read and the write cannot drift on the point.
 */
async function resolveType(
  db: D1Database,
  user: User,
  documentTypeId: string,
): Promise<{ id: string; tenant_id: string }> {
  const type = await db
    .prepare('SELECT id, tenant_id FROM document_types WHERE id = ?')
    .bind(documentTypeId)
    .first<{ id: string; tenant_id: string }>();
  if (!type) throw new BadRequestError('Unknown document type');
  requireTenantAccess(user, type.tenant_id);
  return type;
}

/** The mapping as both verbs report it — active items only, checklist order. */
async function listMapping(
  db: D1Database,
  tenantId: string,
  documentTypeId: string,
): Promise<DocumentTypeRequirementRow[]> {
  const rows = await db
    .prepare(
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
    .bind(tenantId, documentTypeId)
    .all<DocumentTypeRequirementRow>();
  return rows.results ?? [];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const documentTypeId = url.searchParams.get('document_type_id');
    if (!documentTypeId) throw new BadRequestError('document_type_id is required');

    const type = await resolveType(context.env.DB, user, documentTypeId);
    const body: DocumentTypeRequirementsResponse = {
      tenant_id: type.tenant_id,
      document_type_id: documentTypeId,
      requirements: await listMapping(context.env.DB, type.tenant_id, documentTypeId),
    };
    return json(body);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('document-type-requirements list error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};

/** What a human-facing write may claim as its provenance. See the header. */
const WRITABLE_SOURCES = new Set(['wizard', 'human']);

/**
 * PUT /api/document-type-requirements
 *
 * Body: `{ document_type_id, requirement_ids: string[], source? }`.
 *
 * Replaces the mapping for ONE type. Scoped to one type on purpose: the wizard
 * teaches with one document and writes what that document's type closes, and a
 * shape that could carry several types would invite a "map all 27" button —
 * which is the data entry the screen exists to replace, and the same mistake
 * `apply-packet` refuses to make for supplier checklists.
 *
 * AN EMPTY LIST IS ACCEPTED. "This type closes nothing" is a real answer and
 * the only way an editor can ever undo a mapping. The wizard never sends it —
 * see `StepTeach.tsx`, which will not spend somebody's pack-seeded mapping on
 * a stray double-click — but the endpoint must not be the thing that forbids it.
 */
export const onRequestPut: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const body = (await context.request.json().catch(() => null)) as {
      document_type_id?: unknown;
      requirement_ids?: unknown;
      source?: unknown;
    } | null;
    if (!body || typeof body !== 'object') throw new BadRequestError('A JSON body is required');

    const documentTypeId = typeof body.document_type_id === 'string' ? body.document_type_id : '';
    if (!documentTypeId) throw new BadRequestError('document_type_id is required');

    if (!Array.isArray(body.requirement_ids)) {
      throw new BadRequestError('requirement_ids must be an array');
    }
    // Deduplicated before anything counts them: the UNIQUE(document_type_id,
    // requirement_id) index would reject a repeated id mid-batch and take the
    // DELETE down with it, leaving the type mapped to nothing at all.
    const requested = [
      ...new Set(
        body.requirement_ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];

    const source = body.source === undefined ? 'human' : String(body.source);
    if (!WRITABLE_SOURCES.has(source)) {
      throw new BadRequestError(
        `source must be one of ${[...WRITABLE_SOURCES].join(', ')} — 'pack' is the seeder's alone`,
      );
    }

    const db = context.env.DB;
    const type = await resolveType(db, user, documentTypeId);

    // Every id must be a requirement OF THIS TENANT. Checked as a set rather
    // than per-row so a cross-tenant id is a 400 naming the problem, not a
    // foreign-key failure surfacing as a 500 — and so a caller can never map a
    // type to another tenant's checklist, which the table's own FKs permit
    // (both point at their own tables, neither at a tenant pairing).
    if (requested.length > 0) {
      const placeholders = requested.map(() => '?').join(', ');
      const owned = await db
        .prepare(
          `SELECT id FROM requirements WHERE tenant_id = ? AND id IN (${placeholders})`,
        )
        .bind(type.tenant_id, ...requested)
        .all<{ id: string }>();
      const ownedIds = new Set((owned.results ?? []).map((r) => r.id));
      const foreign = requested.filter((id) => !ownedIds.has(id));
      if (foreign.length > 0) {
        throw new BadRequestError(
          `${foreign.length} requirement id${foreign.length === 1 ? ' does' : 's do'} not belong to this tenant`,
        );
      }
    }

    const before = await db
      .prepare(
        'SELECT requirement_id FROM document_type_requirements WHERE document_type_id = ?',
      )
      .bind(documentTypeId)
      .all<{ requirement_id: string }>();
    const beforeIds = new Set((before.results ?? []).map((r) => r.requirement_id));

    // One batch: D1 runs the statements in order and rolls the lot back on a
    // failure, so the window in which the type is mapped to nothing does not
    // exist for any other reader.
    const statements: D1PreparedStatement[] = [
      db
        .prepare('DELETE FROM document_type_requirements WHERE document_type_id = ?')
        .bind(documentTypeId),
    ];
    for (const requirementId of requested) {
      statements.push(
        db
          .prepare(
            `INSERT INTO document_type_requirements
               (id, tenant_id, document_type_id, requirement_id, source, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `dtr_${generateId()}`,
            type.tenant_id,
            documentTypeId,
            requirementId,
            source,
            user.id,
          ),
      );
    }
    await db.batch(statements);

    const added = requested.filter((id) => !beforeIds.has(id));
    const removed = [...beforeIds].filter((id) => !requested.includes(id));

    // Audited with the DIFF, not just the new count. A mapping is what makes an
    // approved document mean something, so "seven line items stopped being
    // proposed on the 3rd" has to be answerable a year later, from the log,
    // without a table history nobody keeps.
    await logAudit(
      db,
      user.id,
      type.tenant_id,
      'document_type_requirements.replaced',
      'document_type',
      documentTypeId,
      JSON.stringify({
        source,
        before: beforeIds.size,
        after: requested.length,
        added,
        removed,
      }),
      getClientIp(context.request),
    );

    const responseBody: ReplaceDocumentTypeRequirementsResponse = {
      tenant_id: type.tenant_id,
      document_type_id: documentTypeId,
      requirements: await listMapping(db, type.tenant_id, documentTypeId),
      added: added.length,
      removed: removed.length,
    };
    return json(responseBody);
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('document-type-requirements replace error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
