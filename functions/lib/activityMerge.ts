/**
 * activityMerge — pure, testable helpers for the unified Activity feed.
 *
 * The `/api/activity` endpoint runs 4 separate SELECTs (one per event type),
 * hands each result set off to a row->event mapper, then hands the 4 arrays
 * to {@link mergeActivityEvents} which sorts by timestamp and paginates.
 *
 * Keeping the merge pure lets us unit-test the sort + pagination behaviour
 * without booting the Workers pool.
 */

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

export type ActivityEventType =
  | 'connector_run'
  | 'document_ingest'
  | 'order_created'
  | 'audit';

export interface ConnectorRunEvent {
  type: 'connector_run';
  id: string;
  timestamp: string; // ISO — used as the sort key (started_at)
  connector_id: string;
  connector_name: string | null;
  status: 'running' | 'success' | 'partial' | 'error';
  records_found: number;
  records_created: number;
  records_updated: number;
  records_errored: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  tenant_id: string;
}

export interface DocumentIngestEvent {
  type: 'document_ingest';
  id: string;
  timestamp: string; // created_at
  file_name: string;
  source: string | null;
  sender_email: string | null;
  processing_status: 'queued' | 'processing' | 'ready' | 'error';
  review_status: 'pending' | 'approved' | 'rejected';
  confidence: number | null;
  document_type_name: string | null;
  supplier: string | null;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  tenant_id: string;
}

export interface OrderCreatedEvent {
  type: 'order_created';
  id: string;
  timestamp: string; // created_at
  order_number: string;
  customer_name: string | null;
  customer_number: string | null;
  connector_run_id: string | null;
  connector_id: string | null;
  connector_name: string | null;
  status: string;
  created_at: string;
  tenant_id: string;
}

export interface AuditActivityEvent {
  type: 'audit';
  id: string;
  timestamp: string; // created_at
  action: string;
  user_id: string | null;
  user_name: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
  tenant_id: string | null;
}

export type ActivityEvent =
  | ConnectorRunEvent
  | DocumentIngestEvent
  | OrderCreatedEvent
  | AuditActivityEvent;

// ---------------------------------------------------------------------------
// Merge + pagination
// ---------------------------------------------------------------------------

/**
 * Merge any number of pre-sorted or unsorted event arrays into a single
 * array, sorted by `timestamp` DESC (most recent first), then apply
 * limit + offset.
 *
 * The caller must ensure each event carries a valid ISO-like timestamp
 * string in `timestamp`. Strings that parse to NaN sort last.
 */
export function mergeActivityEvents(
  inputs: ActivityEvent[][],
  limit: number,
  offset: number,
): { events: ActivityEvent[]; totalMerged: number } {
  const merged: ActivityEvent[] = [];
  for (const group of inputs) {
    for (const ev of group) merged.push(ev);
  }

  merged.sort((a, b) => {
    const ta = parseTs(a.timestamp);
    const tb = parseTs(b.timestamp);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });

  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);
  return {
    events: merged.slice(safeOffset, safeOffset + safeLimit),
    totalMerged: merged.length,
  };
}

function parseTs(s: string): number {
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" which
  // Date.parse accepts but treats as local — we want UTC. Coerce
  // by swapping the space to "T" and appending a Z if missing.
  if (!s) return NaN;
  let iso = s;
  if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) iso = `${iso}Z`;
  return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// Row mappers — one per source table. Kept here so the handler stays thin
// and the mappers are individually testable.
// ---------------------------------------------------------------------------

export interface ConnectorRunRowShape {
  id: string;
  connector_id: string;
  tenant_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  records_found: number | null;
  records_created: number | null;
  records_updated: number | null;
  records_errored: number | null;
  error_message: string | null;
  connector_name?: string | null;
}

export function connectorRunRowToEvent(row: ConnectorRunRowShape): ConnectorRunEvent {
  return {
    type: 'connector_run',
    id: row.id,
    timestamp: row.started_at,
    connector_id: row.connector_id,
    connector_name: row.connector_name ?? null,
    status: row.status as ConnectorRunEvent['status'],
    records_found: row.records_found ?? 0,
    records_created: row.records_created ?? 0,
    records_updated: row.records_updated ?? 0,
    records_errored: row.records_errored ?? 0,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    tenant_id: row.tenant_id,
  };
}

export interface QueueRowShape {
  id: string;
  tenant_id: string;
  file_name: string;
  source: string | null;
  source_detail: string | null;
  processing_status: string;
  status: string;
  confidence_score: number | null;
  document_type_name?: string | null;
  supplier: string | null;
  created_at: string;
  reviewed_at: string | null;
  error_message: string | null;
}

export function queueRowToEvent(row: QueueRowShape): DocumentIngestEvent {
  let senderEmail: string | null = null;
  if (row.source_detail) {
    try {
      const parsed =
        typeof row.source_detail === 'string' ? JSON.parse(row.source_detail) : row.source_detail;
      if (parsed && typeof parsed === 'object' && typeof parsed.sender === 'string') {
        senderEmail = parsed.sender;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    type: 'document_ingest',
    id: row.id,
    timestamp: row.created_at,
    file_name: row.file_name,
    source: row.source,
    sender_email: senderEmail,
    processing_status: row.processing_status as DocumentIngestEvent['processing_status'],
    review_status: row.status as DocumentIngestEvent['review_status'],
    confidence: row.confidence_score,
    document_type_name: row.document_type_name ?? null,
    supplier: row.supplier,
    created_at: row.created_at,
    completed_at: row.reviewed_at,
    error_message: row.error_message,
    tenant_id: row.tenant_id,
  };
}

export interface OrderRowShape {
  id: string;
  tenant_id: string;
  order_number: string;
  customer_name: string | null;
  customer_number: string | null;
  connector_id: string | null;
  connector_run_id: string | null;
  connector_name?: string | null;
  status: string;
  created_at: string;
}

export function orderRowToEvent(row: OrderRowShape): OrderCreatedEvent {
  return {
    type: 'order_created',
    id: row.id,
    timestamp: row.created_at,
    order_number: row.order_number,
    customer_name: row.customer_name,
    customer_number: row.customer_number,
    connector_run_id: row.connector_run_id,
    connector_id: row.connector_id,
    connector_name: row.connector_name ?? null,
    status: row.status,
    created_at: row.created_at,
    tenant_id: row.tenant_id,
  };
}

export interface AuditRowShape {
  id: number | string;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
  user_name?: string | null;
}

export function auditRowToEvent(row: AuditRowShape): AuditActivityEvent {
  return {
    type: 'audit',
    id: String(row.id),
    timestamp: row.created_at,
    action: row.action,
    user_id: row.user_id,
    user_name: row.user_name ?? null,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    created_at: row.created_at,
    tenant_id: row.tenant_id,
  };
}
