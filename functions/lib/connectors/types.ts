import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

// === Connector Output Types ===

export interface ParsedOrder {
  order_number: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  items: ParsedOrderItem[];
  source_data: Record<string, unknown>;
}

export interface ParsedOrderItem {
  product_name?: string;
  product_code?: string;
  quantity?: number;
  lot_number?: string;
}

export interface ParsedCustomer {
  customer_number: string;
  name: string;
  email?: string;
}

export interface ConnectorError {
  record_index?: number;
  field?: string;
  message: string;
}

export interface ConnectorOutput {
  orders: ParsedOrder[];
  customers: ParsedCustomer[];
  errors: ConnectorError[];
}

// === Connector Context & Input ===

export interface ConnectorContext {
  db: D1Database;
  r2?: R2Bucket;
  tenantId: string;
  connectorId: string;
  config: Record<string, unknown>;
  fieldMappings: Record<string, string>;
  credentials?: Record<string, unknown>;
  qwenUrl?: string;
  qwenSecret?: string;
}

export interface EmailAttachment {
  filename: string;
  content: ArrayBuffer;
  contentType: string;
  size: number;
}

export type ConnectorInput =
  | { type: 'email'; body: string; html?: string; subject: string; sender: string; attachments?: EmailAttachment[] }
  | { type: 'webhook'; payload: unknown; headers: Record<string, string> }
  | { type: 'api_poll' }
  | { type: 'file_watch'; r2Key: string; fileName: string };

export type ConnectorExecuteFn = (
  ctx: ConnectorContext,
  input: ConnectorInput,
) => Promise<ConnectorOutput>;
