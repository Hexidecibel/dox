import {
  BadRequestError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';
import {
  mergeActivityEvents,
  connectorRunRowToEvent,
  queueRowToEvent,
  orderRowToEvent,
  auditRowToEvent,
  type ActivityEvent,
  type ActivityEventType,
  type ConnectorRunRowShape,
  type QueueRowShape,
  type OrderRowShape,
  type AuditRowShape,
} from '../../lib/activityMerge';

/** Max allowed window in days — anything larger is rejected to keep queries cheap. */
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

type SourceFilter = 'email' | 'api' | 'import' | 'file_watch' | 'all';
type StatusFilter = 'success' | 'error' | 'partial' | 'running' | 'queued' | 'all';
type EventTypeFilter = ActivityEventType | 'all';

interface ActivityFilters {
  from: string;
  to: string;
  connectorId: string | null;
  source: SourceFilter;
  status: StatusFilter;
  eventType: EventTypeFilter;
  tenantId: string | 'all' | null;
}

function parseFilters(url: URL, user: User): ActivityFilters {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3600 * 1000);

  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');

  const from = rawFrom ? new Date(rawFrom) : defaultFrom;
  const to = rawTo ? new Date(rawTo) : now;

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new BadRequestError('from/to must be valid ISO dates');
  }
  if (to.getTime() <= from.getTime()) {
    throw new BadRequestError('to must be after from');
  }
  const windowDays = (to.getTime() - from.getTime()) / (1000 * 3600 * 24);
  if (windowDays > MAX_WINDOW_DAYS) {
    throw new BadRequestError(`date range exceeds ${MAX_WINDOW_DAYS} days`);
  }

  const source = (url.searchParams.get('source') || 'all') as SourceFilter;
  const status = (url.searchParams.get('status') || 'all') as StatusFilter;
  const eventType = (url.searchParams.get('event_type') || 'all') as EventTypeFilter;

  // Tenant scoping:
  //  - super_admin may pass ?tenant_id=all to see across all tenants,
  //    or a specific tenant id, or omit it (defaults to 'all').
  //  - everyone else is locked to their own tenant.
  let tenantId: ActivityFilters['tenantId'];
  if (user.role === 'super_admin') {
    const raw = url.searchParams.get('tenant_id');
    if (raw === 'all' || raw === null || raw === '') {
      tenantId = 'all';
    } else {
      tenantId = raw;
    }
  } else {
    if (!user.tenant_id) {
      throw new BadRequestError('user has no tenant assignment');
    }
    tenantId = user.tenant_id;
  }

  return {
    // Store as SQLite-friendly "YYYY-MM-DD HH:MM:SS" so string compares
    // against datetime('now') columns behave correctly. We also keep the
    // ISO form for the filters_applied echo.
    from: toSqliteDatetime(from),
    to: toSqliteDatetime(to),
    connectorId: url.searchParams.get('connector_id'),
    source,
    status,
    eventType,
    tenantId,
  };
}

/**
 * Convert a JS Date into SQLite's `datetime('now')` text format —
 * "YYYY-MM-DD HH:MM:SS" (UTC, no timezone suffix). This lets us do
 * lexicographic comparisons against columns stored via datetime('now').
 */
function toSqliteDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function parseLimitOffset(url: URL): { limit: number; offset: number } {
  const limitRaw = parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10);
  const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Math.min(Math.max(isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw, 1), MAX_LIMIT);
  const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);
  return { limit, offset };
}

/**
 * Shared helper: inject a tenant-scoping clause. When `tenantId === 'all'`
 * we return empty strings so the caller can omit the clause entirely.
 */
function tenantClause(
  tenantId: ActivityFilters['tenantId'],
  column: string,
): { clause: string; params: string[] } {
  if (tenantId === 'all' || tenantId === null) {
    return { clause: '', params: [] };
  }
  return { clause: `${column} = ?`, params: [tenantId] };
}

// ---------------------------------------------------------------------------
// Source-table query builders
// ---------------------------------------------------------------------------

async function queryConnectorRuns(
  db: D1Database,
  filters: ActivityFilters,
): Promise<ActivityEvent[]> {
  if (filters.eventType !== 'all' && filters.eventType !== 'connector_run') return [];
  // connector_runs doesn't have a "source" concept beyond the connector type,
  // so if the caller is filtering by source we only return rows for connectors
  // that match. To keep things simple we skip connector_runs when a non-'all'
  // source filter other than the connector's own type is applied. We do this
  // by joining connectors.connector_type and matching it.
  const conds: string[] = ['cr.started_at >= ?', 'cr.started_at <= ?'];
  const params: (string | number)[] = [filters.from, filters.to];

  const tc = tenantClause(filters.tenantId, 'cr.tenant_id');
  if (tc.clause) {
    conds.push(tc.clause);
    params.push(...tc.params);
  }

  if (filters.connectorId) {
    conds.push('cr.connector_id = ?');
    params.push(filters.connectorId);
  }

  if (filters.status !== 'all') {
    // Only pass through statuses that connector_runs actually supports.
    if (['success', 'error', 'partial', 'running'].includes(filters.status)) {
      conds.push('cr.status = ?');
      params.push(filters.status);
    } else {
      // e.g. 'queued' — connector_runs never has that value, so skip this source.
      return [];
    }
  }

  if (filters.source !== 'all') {
    conds.push('c.connector_type = ?');
    params.push(filters.source);
  }

  const sql = `
    SELECT cr.id, cr.connector_id, cr.tenant_id, cr.status, cr.started_at,
           cr.completed_at, cr.records_found, cr.records_created,
           cr.records_updated, cr.records_errored, cr.error_message,
           c.name as connector_name
    FROM connector_runs cr
    LEFT JOIN connectors c ON c.id = cr.connector_id
    WHERE ${conds.join(' AND ')}
    ORDER BY cr.started_at DESC
    LIMIT 500
  `;
  const result = await db.prepare(sql).bind(...params).all<ConnectorRunRowShape>();
  return (result.results || []).map(connectorRunRowToEvent);
}

async function queryDocumentIngests(
  db: D1Database,
  filters: ActivityFilters,
): Promise<ActivityEvent[]> {
  if (filters.eventType !== 'all' && filters.eventType !== 'document_ingest') return [];

  const conds: string[] = ['pq.created_at >= ?', 'pq.created_at <= ?'];
  const params: (string | number)[] = [filters.from, filters.to];

  const tc = tenantClause(filters.tenantId, 'pq.tenant_id');
  if (tc.clause) {
    conds.push(tc.clause);
    params.push(...tc.params);
  }

  if (filters.source !== 'all') {
    conds.push('pq.source = ?');
    params.push(filters.source);
  }

  if (filters.status !== 'all') {
    // Map shared status vocabulary onto processing_queue's two columns.
    if (['queued', 'error'].includes(filters.status)) {
      conds.push('pq.processing_status = ?');
      params.push(filters.status);
    } else if (filters.status === 'success') {
      conds.push("pq.processing_status = 'ready' AND pq.status = 'approved'");
    } else if (filters.status === 'partial') {
      conds.push("pq.processing_status = 'ready' AND pq.status = 'pending'");
    } else if (filters.status === 'running') {
      conds.push("pq.processing_status = 'processing'");
    }
  }

  // connector_id has no meaning for processing_queue itself — skip entirely
  // when a specific connector is requested.
  if (filters.connectorId) return [];

  const sql = `
    SELECT pq.id, pq.tenant_id, pq.file_name, pq.source, pq.source_detail,
           pq.processing_status, pq.status, pq.confidence_score, pq.supplier,
           pq.created_at, pq.reviewed_at, pq.error_message,
           dt.name as document_type_name
    FROM processing_queue pq
    LEFT JOIN document_types dt ON dt.id = pq.document_type_id
    WHERE ${conds.join(' AND ')}
    ORDER BY pq.created_at DESC
    LIMIT 500
  `;
  const result = await db.prepare(sql).bind(...params).all<QueueRowShape>();
  return (result.results || []).map(queueRowToEvent);
}

async function queryOrdersCreated(
  db: D1Database,
  filters: ActivityFilters,
): Promise<ActivityEvent[]> {
  if (filters.eventType !== 'all' && filters.eventType !== 'order_created') return [];

  const conds: string[] = ['o.created_at >= ?', 'o.created_at <= ?'];
  const params: (string | number)[] = [filters.from, filters.to];

  const tc = tenantClause(filters.tenantId, 'o.tenant_id');
  if (tc.clause) {
    conds.push(tc.clause);
    params.push(...tc.params);
  }

  if (filters.connectorId) {
    conds.push('o.connector_id = ?');
    params.push(filters.connectorId);
  }

  // For order_created, map 'source' filter onto "orders that came from a
  // connector of this type". 'api' / 'import' fall back to "no connector".
  if (filters.source !== 'all') {
    if (filters.source === 'email' || filters.source === 'file_watch') {
      conds.push('c.connector_type = ?');
      params.push(filters.source);
    } else if (filters.source === 'api' || filters.source === 'import') {
      // manual/API-created orders have no connector_id
      conds.push('o.connector_id IS NULL');
    }
  }

  if (filters.status !== 'all') {
    // Order status vocabulary is entirely different — only match when the
    // filter intersects with a real order status.
    const orderStatuses = ['pending', 'enriched', 'matched', 'fulfilled', 'delivered', 'error'];
    if (orderStatuses.includes(filters.status)) {
      conds.push('o.status = ?');
      params.push(filters.status);
    } else if (filters.status !== 'success' && filters.status !== 'error') {
      // queued/partial/running are not order statuses — skip this source
      return [];
    } else if (filters.status === 'success') {
      // Treat fulfilled/delivered as "success"
      conds.push("o.status IN ('fulfilled', 'delivered')");
    }
  }

  const sql = `
    SELECT o.id, o.tenant_id, o.order_number, o.customer_name, o.customer_number,
           o.connector_id, o.connector_run_id, o.status, o.created_at,
           c.name as connector_name
    FROM orders o
    LEFT JOIN connectors c ON c.id = o.connector_id
    WHERE ${conds.join(' AND ')}
    ORDER BY o.created_at DESC
    LIMIT 500
  `;
  const result = await db.prepare(sql).bind(...params).all<OrderRowShape>();
  return (result.results || []).map(orderRowToEvent);
}

async function queryAuditEvents(
  db: D1Database,
  filters: ActivityFilters,
): Promise<ActivityEvent[]> {
  if (filters.eventType !== 'all' && filters.eventType !== 'audit') return [];
  // The audit log is opt-in — when the caller is browsing "all" events
  // we include it, but when they're filtering by any source/connector
  // or status we skip it (audit has its own vocabulary and no source).
  if (
    filters.connectorId ||
    filters.source !== 'all' ||
    filters.status !== 'all'
  ) {
    // Still include when the user *explicitly* asked for audit only —
    // filters are then treated as "not applicable, return anything".
    if (filters.eventType !== 'audit') return [];
  }

  const conds: string[] = ['a.created_at >= ?', 'a.created_at <= ?'];
  const params: (string | number)[] = [filters.from, filters.to];

  const tc = tenantClause(filters.tenantId, 'a.tenant_id');
  if (tc.clause) {
    conds.push(tc.clause);
    params.push(...tc.params);
  }

  const sql = `
    SELECT a.id, a.user_id, a.tenant_id, a.action, a.resource_type,
           a.resource_id, a.created_at, u.name as user_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${conds.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT 500
  `;
  const result = await db.prepare(sql).bind(...params).all<AuditRowShape>();
  return (result.results || []).map(auditRowToEvent);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/activity
 *
 * Unified feed combining connector_runs, processing_queue (document ingests),
 * orders and audit_log, scoped to the authenticated user's tenant.
 *
 * Query params (all optional):
 *   from, to            ISO date window. Default: last 24h. Max: 90 days.
 *   connector_id        Filter to a specific connector
 *   source              email | api | import | file_watch | all (default)
 *   status              success | error | partial | running | queued | all
 *   event_type          connector_run | document_ingest | order_created | audit | all
 *   limit               1..200 (default 50)
 *   offset              0+ (default 0)
 *   tenant_id           super_admin only — 'all' or a specific tenant id
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);

    const filters = parseFilters(url, user);
    const { limit, offset } = parseLimitOffset(url);

    const [runs, ingests, orders, audit] = await Promise.all([
      queryConnectorRuns(context.env.DB, filters),
      queryDocumentIngests(context.env.DB, filters),
      queryOrdersCreated(context.env.DB, filters),
      queryAuditEvents(context.env.DB, filters),
    ]);

    const { events, totalMerged } = mergeActivityEvents(
      [runs, ingests, orders, audit],
      limit,
      offset,
    );

    return new Response(
      JSON.stringify({
        events,
        total_count: totalMerged,
        limit,
        offset,
        filters_applied: {
          from: filters.from,
          to: filters.to,
          connector_id: filters.connectorId,
          source: filters.source,
          status: filters.status,
          event_type: filters.eventType,
          tenant_id: filters.tenantId,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Activity list error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
