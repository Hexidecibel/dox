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

export interface ParsedContact {
  name?: string;
  email: string;
  role?: string;
  is_primary?: boolean;
}

export interface ParsedCustomer {
  customer_number: string;
  name: string;
  /** Primary contact email. Back-compat: may be derived from contacts[0]. */
  email?: string;
  /** Full contact list — registry rows often have 2-5 entries per customer. */
  contacts?: ParsedContact[];
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
  /**
   * Informational messages that are NOT errors (e.g. "processed N pages in
   * M chunks, extracted K orders / J customers"). Separate channel so the
   * orchestrator's status calc doesn't mislabel successful runs as `partial`.
   */
  info?: string[];
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
