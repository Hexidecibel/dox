import {
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

/**
 * GET /api/activity/event?type=X&id=Y
 *
 * Drilldown into a single activity event. Returns the full row plus any
 * expensive-to-join extras (e.g. orders created by a connector run) that
 * would blow up the list query if we embedded them there.
 *
 * Supported types:
 *   connector_run      — full row + details JSON + orders from this run
 *   document_ingest    — full processing_queue row + parsed source_detail
 *   order_created      — full order row + source_data + connector run
 *   audit              — full audit_log row + parsed details JSON
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    const url = new URL(context.request.url);
    const type = url.searchParams.get('type');
    const id = url.searchParams.get('id');

    if (!type || !id) {
      throw new BadRequestError('type and id query params are required');
    }

    switch (type) {
      case 'connector_run':
        return new Response(
          JSON.stringify({ event: await fetchConnectorRun(context.env.DB, id, user) }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      case 'document_ingest':
        return new Response(
          JSON.stringify({ event: await fetchDocumentIngest(context.env.DB, id, user) }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      case 'order_created':
        return new Response(
          JSON.stringify({ event: await fetchOrder(context.env.DB, id, user) }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      case 'audit':
        return new Response(
          JSON.stringify({ event: await fetchAudit(context.env.DB, id, user) }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      default:
        throw new BadRequestError(`unknown event type: ${type}`);
    }
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Activity event error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

function enforceTenant(user: User, rowTenantId: string | null | undefined): void {
  if (user.role === 'super_admin') return;
  if (rowTenantId !== user.tenant_id) {
    throw new NotFoundError('Event not found');
  }
}

function parseJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function fetchConnectorRun(db: D1Database, id: string, user: User) {
  const row = await db
    .prepare(
      `SELECT cr.*, c.name as connector_name, c.connector_type
       FROM connector_runs cr
       LEFT JOIN connectors c ON c.id = cr.connector_id
       WHERE cr.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) throw new NotFoundError('Connector run not found');
  enforceTenant(user, row.tenant_id as string | null);

  // Attach orders that were created as part of this run
  const orders = await db
    .prepare(
      `SELECT id, order_number, customer_name, customer_number, status, created_at
       FROM orders
       WHERE connector_run_id = ?
       ORDER BY created_at ASC
       LIMIT 500`,
    )
    .bind(id)
    .all();

  return {
    ...row,
    details: parseJson(row.details),
    orders: orders.results || [],
  };
}

async function fetchDocumentIngest(db: D1Database, id: string, user: User) {
  const row = await db
    .prepare(
      `SELECT pq.*, dt.name as document_type_name, u.name as reviewed_by_name
       FROM processing_queue pq
       LEFT JOIN document_types dt ON dt.id = pq.document_type_id
       LEFT JOIN users u ON u.id = pq.reviewed_by
       WHERE pq.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) throw new NotFoundError('Document ingest not found');
  enforceTenant(user, row.tenant_id as string | null);

  return {
    ...row,
    source_detail: parseJson(row.source_detail),
    ai_fields: parseJson(row.ai_fields),
    ai_confidence: parseJson(row.ai_confidence),
    tables: parseJson(row.tables),
  };
}

async function fetchOrder(db: D1Database, id: string, user: User) {
  const row = await db
    .prepare(
      `SELECT o.*, c.name as connector_name, c.connector_type
       FROM orders o
       LEFT JOIN connectors c ON c.id = o.connector_id
       WHERE o.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) throw new NotFoundError('Order not found');
  enforceTenant(user, row.tenant_id as string | null);

  // If the order came from a connector run, include that run's started_at
  let connectorRun: unknown = null;
  if (row.connector_run_id) {
    connectorRun = await db
      .prepare(
        `SELECT id, status, started_at, completed_at, records_created, records_errored
         FROM connector_runs
         WHERE id = ?`,
      )
      .bind(row.connector_run_id as string)
      .first();
  }

  return {
    ...row,
    source_data: parseJson(row.source_data),
    primary_metadata: parseJson(row.primary_metadata),
    extended_metadata: parseJson(row.extended_metadata),
    connector_run: connectorRun,
  };
}

async function fetchAudit(db: D1Database, id: string, user: User) {
  const row = await db
    .prepare(
      `SELECT a.*, u.name as user_name, u.email as user_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) throw new NotFoundError('Audit entry not found');
  enforceTenant(user, row.tenant_id as string | null);

  return {
    ...row,
    details: parseJson(row.details),
  };
}
