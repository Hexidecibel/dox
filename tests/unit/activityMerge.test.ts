import { describe, it, expect } from 'vitest';
import {
  mergeActivityEvents,
  connectorRunRowToEvent,
  queueRowToEvent,
  orderRowToEvent,
  auditRowToEvent,
  type ActivityEvent,
  type ConnectorRunEvent,
  type DocumentIngestEvent,
  type OrderCreatedEvent,
  type AuditActivityEvent,
} from '../../functions/lib/activityMerge';

function runEvent(id: string, ts: string): ConnectorRunEvent {
  return {
    type: 'connector_run',
    id,
    timestamp: ts,
    connector_id: 'c1',
    connector_name: 'Test',
    status: 'success',
    records_found: 0,
    records_created: 0,
    records_updated: 0,
    records_errored: 0,
    started_at: ts,
    completed_at: null,
    error_message: null,
    tenant_id: 't1',
  };
}

function ingestEvent(id: string, ts: string): DocumentIngestEvent {
  return {
    type: 'document_ingest',
    id,
    timestamp: ts,
    file_name: 'a.pdf',
    source: 'email',
    sender_email: null,
    processing_status: 'ready',
    review_status: 'pending',
    confidence: 0.9,
    document_type_name: null,
    supplier: null,
    created_at: ts,
    completed_at: null,
    error_message: null,
    tenant_id: 't1',
  };
}

function orderEvent(id: string, ts: string): OrderCreatedEvent {
  return {
    type: 'order_created',
    id,
    timestamp: ts,
    order_number: `ORD-${id}`,
    customer_name: null,
    customer_number: null,
    connector_run_id: null,
    connector_id: null,
    connector_name: null,
    status: 'pending',
    created_at: ts,
    tenant_id: 't1',
  };
}

function auditEvent(id: string, ts: string): AuditActivityEvent {
  return {
    type: 'audit',
    id,
    timestamp: ts,
    action: 'document.ingested',
    user_id: 'u1',
    user_name: null,
    resource_type: null,
    resource_id: null,
    created_at: ts,
    tenant_id: 't1',
  };
}

describe('mergeActivityEvents', () => {
  it('sorts a mixed set of events by timestamp DESC', () => {
    const runs = [runEvent('r1', '2026-04-10T10:00:00Z'), runEvent('r2', '2026-04-12T10:00:00Z')];
    const ingests = [ingestEvent('i1', '2026-04-11T10:00:00Z')];
    const orders = [orderEvent('o1', '2026-04-13T10:00:00Z')];
    const audit = [auditEvent('a1', '2026-04-09T10:00:00Z')];

    const { events, totalMerged } = mergeActivityEvents([runs, ingests, orders, audit], 10, 0);

    expect(totalMerged).toBe(5);
    expect(events.map((e) => e.id)).toEqual(['o1', 'r2', 'i1', 'r1', 'a1']);
  });

  it('applies limit and offset after merge', () => {
    const a: ActivityEvent[] = [
      runEvent('r1', '2026-04-13T01:00:00Z'),
      runEvent('r2', '2026-04-13T02:00:00Z'),
      runEvent('r3', '2026-04-13T03:00:00Z'),
      runEvent('r4', '2026-04-13T04:00:00Z'),
      runEvent('r5', '2026-04-13T05:00:00Z'),
    ];
    // Page 1: limit 2 offset 0 → r5, r4
    const p1 = mergeActivityEvents([a], 2, 0);
    expect(p1.events.map((e) => e.id)).toEqual(['r5', 'r4']);
    expect(p1.totalMerged).toBe(5);

    // Page 2: limit 2 offset 2 → r3, r2
    const p2 = mergeActivityEvents([a], 2, 2);
    expect(p2.events.map((e) => e.id)).toEqual(['r3', 'r2']);
    expect(p2.totalMerged).toBe(5);

    // Page 3: limit 2 offset 4 → r1 (only 1 left)
    const p3 = mergeActivityEvents([a], 2, 4);
    expect(p3.events.map((e) => e.id)).toEqual(['r1']);
  });

  it('handles SQLite-style "YYYY-MM-DD HH:MM:SS" timestamps as UTC', () => {
    const e1 = runEvent('r1', '2026-04-10 10:00:00');
    const e2 = runEvent('r2', '2026-04-10 11:00:00');
    const { events } = mergeActivityEvents([[e1, e2]], 10, 0);
    expect(events.map((e) => e.id)).toEqual(['r2', 'r1']);
  });

  it('returns empty when inputs are empty', () => {
    const { events, totalMerged } = mergeActivityEvents([[], [], [], []], 10, 0);
    expect(events).toEqual([]);
    expect(totalMerged).toBe(0);
  });

  it('is resilient to invalid timestamps (sorts them last)', () => {
    const a = runEvent('bad', 'not-a-date');
    const b = runEvent('good', '2026-04-13T10:00:00Z');
    const { events } = mergeActivityEvents([[a, b]], 10, 0);
    expect(events[0].id).toBe('good');
    expect(events[1].id).toBe('bad');
  });
});

describe('row mappers', () => {
  it('connectorRunRowToEvent fills defaults for null counts', () => {
    const ev = connectorRunRowToEvent({
      id: 'r1',
      connector_id: 'c1',
      tenant_id: 't1',
      status: 'success',
      started_at: '2026-04-13T00:00:00Z',
      completed_at: null,
      records_found: null,
      records_created: null,
      records_updated: null,
      records_errored: null,
      error_message: null,
      connector_name: 'My Connector',
    });
    expect(ev.type).toBe('connector_run');
    expect(ev.records_found).toBe(0);
    expect(ev.records_created).toBe(0);
    expect(ev.connector_name).toBe('My Connector');
  });

  it('queueRowToEvent parses sender out of source_detail JSON', () => {
    const ev = queueRowToEvent({
      id: 'q1',
      tenant_id: 't1',
      file_name: 'coa.pdf',
      source: 'email',
      source_detail: JSON.stringify({ sender: 'alice@acme.test', subject: 'COA' }),
      processing_status: 'ready',
      status: 'pending',
      confidence_score: 0.91,
      supplier: 'Acme',
      created_at: '2026-04-13T00:00:00Z',
      reviewed_at: null,
      error_message: null,
      document_type_name: 'COA',
    });
    expect(ev.type).toBe('document_ingest');
    expect(ev.sender_email).toBe('alice@acme.test');
    expect(ev.document_type_name).toBe('COA');
  });

  it('queueRowToEvent tolerates malformed source_detail', () => {
    const ev = queueRowToEvent({
      id: 'q1',
      tenant_id: 't1',
      file_name: 'coa.pdf',
      source: 'email',
      source_detail: 'not-json',
      processing_status: 'ready',
      status: 'pending',
      confidence_score: null,
      supplier: null,
      created_at: '2026-04-13T00:00:00Z',
      reviewed_at: null,
      error_message: null,
      document_type_name: null,
    });
    expect(ev.sender_email).toBeNull();
  });

  it('orderRowToEvent passes through connector_run_id', () => {
    const ev = orderRowToEvent({
      id: 'o1',
      tenant_id: 't1',
      order_number: 'SO-123',
      customer_name: 'Acme',
      customer_number: 'K001',
      connector_id: 'c1',
      connector_run_id: 'run1',
      connector_name: 'ERP Poll',
      status: 'pending',
      created_at: '2026-04-13T00:00:00Z',
    });
    expect(ev.type).toBe('order_created');
    expect(ev.connector_run_id).toBe('run1');
    expect(ev.connector_name).toBe('ERP Poll');
  });

  it('auditRowToEvent coerces numeric id to string', () => {
    const ev = auditRowToEvent({
      id: 42,
      user_id: 'u1',
      tenant_id: 't1',
      action: 'user.login',
      resource_type: null,
      resource_id: null,
      created_at: '2026-04-13T00:00:00Z',
      user_name: 'Alice',
    });
    expect(ev.type).toBe('audit');
    expect(ev.id).toBe('42');
    expect(ev.user_name).toBe('Alice');
  });
});
