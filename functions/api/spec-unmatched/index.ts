/**
 * GET /api/spec-unmatched — the printed test names this tenant's configuration
 * does not recognise, with what each one costs.
 *
 * THE GAP THIS CLOSES. `bin/recheck-spec-limits` has reported these since the
 * feature shipped, and that report is how an eight-spelling gap covering
 * hundreds of results was found on the live tenant. A CLI finding is only worth
 * what somebody does with it, and the person who maintains the aliases does not
 * have a terminal. The derivation is shared verbatim with the CLI
 * (`shared/unmatchedAnalytes.ts`), so the screen and the script cannot drift
 * into disagreeing about which spellings are being skipped.
 *
 * A BOUNDED SCAN, AND IT SAYS SO. The answer comes from replaying the spec
 * engine over approved documents' stored extraction, so it is a corpus read, not
 * an index lookup. It is capped at the most recent `DOC_SCAN_CAP` documents and
 * the response carries `scan_truncated` — the same contract as
 * `functions/lib/search-coverage.ts`, for the same reason: a partial answer
 * presented as a complete one is worse than a smaller one that admits its edges.
 * The page fetches it once, on demand.
 *
 * org_admin+, because it reads across every document in the tenant and because
 * the actions it leads to (adding an alias, creating an analyte) are already
 * org_admin+.
 */

import { requireRole, errorToResponse } from '../../lib/permissions';
import { loadSpecConfig } from '../../lib/spec-warnings';
import { scanUnmatchedAnalytes } from '../../../shared/unmatchedAnalytes';
import type { UnmatchedScanDocument } from '../../../shared/unmatchedAnalytes';
import type { Env, User } from '../../lib/types';

/**
 * How many documents one read replays. 2,000 covers the live tenant's whole
 * approved corpus (522 documents, 265 KB of stored extraction) several times
 * over; past that the read is bounded and says it was.
 */
export const DOC_SCAN_CAP = 2000;

/** Groups per page. The panel shows a screenful and pages for the rest. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * An absent parameter is the DEFAULT, not the minimum. `Number(null)` is 0 and
 * `Number('')` is 0, both finite, so a naive parse silently clamps an omitted
 * `limit` or `scan` to 1 — a one-document scan reported as a complete answer,
 * which is the precise failure this endpoint exists to avoid.
 */
function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface IgnoredSpelling {
  id: string;
  name_key: string;
  name_raw: string;
  reason: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

/**
 * Spellings a person has said are not tests (migration 0114). Its own try/catch:
 * an environment that has not taken 0114 must lose the dismissals, never the
 * panel — the gap list is the part that matters.
 */
export async function loadIgnored(db: D1Database, tenantId: string): Promise<IgnoredSpelling[]> {
  try {
    const res = await db
      .prepare(
        `SELECT i.id, i.name_key, i.name_raw, i.reason, i.created_at, i.created_by,
                u.name AS created_by_name
           FROM spec_unmatched_ignores i
      LEFT JOIN users u ON u.id = i.created_by
          WHERE i.tenant_id = ?
          ORDER BY i.created_at DESC`
      )
      .bind(tenantId)
      .all();
    return ((res.results ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name_key: String(r.name_key),
      name_raw: String(r.name_raw),
      reason: r.reason == null ? null : String(r.reason),
      created_at: String(r.created_at ?? ''),
      created_by: r.created_by == null ? null : String(r.created_by),
      created_by_name: r.created_by_name == null ? null : String(r.created_by_name),
    }));
  } catch (err) {
    console.error(
      '[spec-unmatched] loading dismissals failed (migration 0114 not applied?):',
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantId =
      user.role === 'super_admin' ? url.searchParams.get('tenant_id') : user.tenant_id!;
    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'tenant_id is required for super_admin' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const pageSize = intParam(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = intParam(url.searchParams.get('offset'), 0, 0, 1_000_000);
    const scanCap = intParam(url.searchParams.get('scan'), DOC_SCAN_CAP, 1, DOC_SCAN_CAP);
    const includeIgnored = url.searchParams.get('include_ignored') === '1';

    const [config, ignored] = await Promise.all([
      loadSpecConfig(context.env.DB, tenantId),
      loadIgnored(context.env.DB, tenantId),
    ]);

    // Most recent first, so the example document a person is offered is the
    // freshest certificate printing that spelling. One extra row is asked for
    // to detect the cap without a second COUNT query.
    const docRes = await context.env.DB.prepare(
      `SELECT d.id, d.title, d.supplier_id, d.document_type_id, d.extended_metadata,
              s.name AS supplier_name
         FROM documents d
    LEFT JOIN suppliers s ON s.id = d.supplier_id
        WHERE d.tenant_id = ?
          AND d.status = 'active'
          AND d.extended_metadata IS NOT NULL
        ORDER BY d.created_at DESC
        LIMIT ?`
    )
      .bind(tenantId, scanCap + 1)
      .all();

    const rows = (docRes.results ?? []) as Record<string, unknown>[];
    const truncated = rows.length > scanCap;
    const documents: UnmatchedScanDocument[] = rows.slice(0, scanCap).map((r) => ({
      id: String(r.id),
      title: r.title == null ? null : String(r.title),
      supplier_id: r.supplier_id == null ? null : String(r.supplier_id),
      supplier_name: r.supplier_name == null ? null : String(r.supplier_name),
      document_type_id: r.document_type_id == null ? null : String(r.document_type_id),
      extended_metadata: r.extended_metadata,
    }));

    const scan = scanUnmatchedAnalytes(documents, config.tests, config.limits, {
      unitPolicy: config.unitPolicy,
      ignoreKeys: ignored.map((i) => i.name_key),
    });

    return new Response(
      JSON.stringify({
        unmatched: scan.groups.slice(offset, offset + pageSize),
        total_groups: scan.total_groups,
        total_results: scan.total_results,
        documents_scanned: scan.documents_scanned,
        documents_with_results: scan.documents_with_results,
        scan_truncated: truncated,
        scan_cap: scanCap,
        limit: pageSize,
        offset,
        // The count is always sent, the list only when asked for: a dismissal
        // must never be invisible, but it must not take up the panel either.
        ignored_count: ignored.length,
        ...(includeIgnored ? { ignored } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Unmatched analyte scan error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
