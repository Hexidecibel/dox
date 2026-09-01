import { logAudit, getClientIp } from '../../lib/db';
import { canViewAudit, errorToResponse, ForbiddenError } from '../../lib/permissions';
import { buildAuditFilters } from '../../lib/audit-filters';
import type { Env, User } from '../../lib/types';

interface AuditRow {
  id: number;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

/**
 * Rows fetched per D1 round trip while streaming. Small enough that no single
 * query result sits in memory for long; large enough that a 100k-row export
 * is 200 queries, not 100k.
 */
const BATCH_SIZE = 500;

/**
 * Hard ceiling on an export. Not a memory limit (we stream), but a guard
 * against a single request pinning a Worker for an unbounded time. If an
 * auditor genuinely needs more, they narrow by date range — which is what
 * they wanted anyway. The cap is reported in the audit record and in a
 * response header so a truncated export is never silently truncated.
 */
const MAX_ROWS = 100000;

const CSV_HEADERS = [
  'id',
  'timestamp',
  'user_id',
  'user_name',
  'user_email',
  'tenant_id',
  'action',
  'resource_type',
  'resource_id',
  'ip_address',
  'details',
];

/**
 * RFC 4180 field: always quoted, embedded quotes doubled. Quoting
 * unconditionally is what makes the `details` column safe — it is a JSON blob
 * and routinely carries commas, double quotes and newlines.
 */
function csvField(val: string | number | null): string {
  if (val === null || val === undefined) return '""';
  return `"${String(val).replace(/"/g, '""')}"`;
}

function csvLine(fields: (string | number | null)[]): string {
  return fields.map(csvField).join(',');
}

function rowToLine(r: AuditRow): string {
  return csvLine([
    r.id,
    r.created_at,
    r.user_id,
    r.user_name,
    r.user_email,
    r.tenant_id,
    r.action,
    r.resource_type,
    r.resource_id,
    r.ip_address,
    r.details,
  ]);
}

/**
 * GET /api/audit/export
 *
 * CSV export of audit rows, honouring every filter GET /api/audit supports
 * (tenant_id, action comma-list, userId, resourceType, dateFrom, dateTo) via
 * the shared buildAuditFilters(). Permissions are identical to the read path:
 * super_admin sees all (optionally narrowed), org_admin is pinned to their own
 * tenant, user/reader get 403.
 *
 * Volume: the list endpoint caps at 200 rows/page, which is unusable for an
 * auditor. This endpoint instead STREAMS the CSV — it keyset-paginates through
 * the result set BATCH_SIZE rows at a time and pushes each chunk into the
 * response body, so no unbounded result set is ever materialised in the
 * Worker's memory. (functions/api/reports/generate.ts loads its whole result
 * set with a single .all(); that is fine for a document list, but the audit
 * log is the table that grows without bound.)
 *
 * Keyset, not OFFSET: paging is `a.id < ?` ordered by id DESC, never
 * `LIMIT/OFFSET`. audit_log.id is INTEGER PRIMARY KEY AUTOINCREMENT so id
 * order is insertion order, and created_at is only second-resolution — many
 * rows share a timestamp, so an OFFSET walk (or a created_at keyset) could
 * duplicate or drop rows across batch boundaries. An audit export that
 * quietly loses a row is exactly the defect this feature exists to prevent.
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;

    if (!canViewAudit(user)) {
      throw new ForbiddenError('Insufficient permissions');
    }

    const url = new URL(context.request.url);
    const { whereClause, params, applied } = buildAuditFilters(user, url.searchParams);

    const db = context.env.DB;

    // Snapshot the result set BEFORE anything else touches the table: the row
    // count for the audit record, and the highest matching id, which becomes
    // the keyset ceiling. Pinning the ceiling is what makes the export a
    // consistent point-in-time snapshot — it excludes both concurrent writes
    // and the `audit.export` row this request is about to write, so the CSV
    // the auditor receives contains exactly the `matched` rows we told them
    // it would.
    const snapshot = await db
      .prepare(`SELECT COUNT(*) as total, COALESCE(MAX(a.id), 0) as max_id FROM audit_log a ${whereClause}`)
      .bind(...params)
      .first<{ total: number; max_id: number }>();
    const matched = snapshot?.total || 0;
    const ceilingId = snapshot?.max_id || 0;
    const truncated = matched > MAX_ROWS;

    // Exporting the audit log is itself an auditable event. Written BEFORE the
    // stream starts, not after: a client that aborts the download has still
    // read whatever bytes were sent, so the "who exported what, when" record
    // must not depend on the download completing.
    // Mirrors the report.generate convention in functions/api/reports/generate.ts.
    await logAudit(
      db,
      user.id,
      applied.tenantId || user.tenant_id,
      'audit.export',
      'audit',
      null,
      JSON.stringify({
        format: 'csv',
        matched,
        exported: truncated ? MAX_ROWS : matched,
        truncated,
        filters: applied,
      }),
      getClientIp(context.request)
    );

    const selectSql = `
      SELECT
        a.id,
        a.user_id,
        a.tenant_id,
        a.action,
        a.resource_type,
        a.resource_id,
        a.details,
        a.ip_address,
        a.created_at,
        u.name as user_name,
        u.email as user_email
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ${whereClause}${whereClause ? ' AND' : ' WHERE'} a.id < ?
      ORDER BY a.id DESC
      LIMIT ?
    `;

    const encoder = new TextEncoder();
    // Exclusive cursor, starting just past the snapshot ceiling.
    let cursor = ceilingId + 1;
    let emitted = 0;
    let wroteHeader = false;
    let done = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (done) return;

        if (!wroteHeader) {
          wroteHeader = true;
          controller.enqueue(encoder.encode(csvLine(CSV_HEADERS) + '\n'));
          return;
        }

        if (emitted >= MAX_ROWS) {
          done = true;
          controller.close();
          return;
        }

        const batchLimit = Math.min(BATCH_SIZE, MAX_ROWS - emitted);

        let rows: AuditRow[];
        try {
          const result = await db
            .prepare(selectSql)
            .bind(...params, cursor, batchLimit)
            .all<AuditRow>();
          rows = result.results || [];
        } catch (err) {
          done = true;
          controller.error(err);
          return;
        }

        if (rows.length === 0) {
          done = true;
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(rows.map(rowToLine).join('\n') + '\n'));

        emitted += rows.length;
        cursor = rows[rows.length - 1].id;

        // Short batch means we've reached the end of the result set.
        if (rows.length < batchLimit) {
          done = true;
          controller.close();
        }
      },
    });

    const date = new Date().toISOString().split('T')[0];

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-log-${date}.csv"`,
        'Cache-Control': 'no-store',
        // So a truncated export is visibly truncated, not silently.
        'X-Audit-Export-Matched': String(matched),
        'X-Audit-Export-Limit': String(MAX_ROWS),
        'X-Audit-Export-Truncated': truncated ? 'true' : 'false',
      },
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
