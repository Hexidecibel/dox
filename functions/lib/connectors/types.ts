import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { ConnectorFieldMappings } from '../../../shared/fieldMappings';

// === Connector Output Types ===

export interface ParsedOrder {
  order_number: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  items: ParsedOrderItem[];
  /** Raw, untouched source row — preserved verbatim for audit. */
  source_data: Record<string, unknown>;
  /**
   * Canonical-core fields AFTER field-mapping was applied. Mirrors the
   * documents.primary_metadata pattern so consumers can index/search without
   * reparsing source_data. Keys are CoreFieldKey values from fieldMappings.ts.
   */
  primary_metadata?: Record<string, unknown>;
  /**
   * User-defined extended fields. Keys come from the connector's
   * field_mappings.extended[].key entries. Populated by parseCSVAttachment,
   * parseWithAI, and preview-extraction.
   */
  extended_metadata?: Record<string, unknown>;
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

/**
 * Runtime context handed to a connector executor. `fieldMappings` is ALWAYS
 * the v2 shape — callers MUST run their raw stored JSON through
 * `normalizeFieldMappings()` before constructing a ConnectorContext.
 */
export interface ConnectorContext {
  db: D1Database;
  r2?: R2Bucket;
  tenantId: string;
  connectorId: string;
  config: Record<string, unknown>;
  fieldMappings: ConnectorFieldMappings;
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
  | {
      type: 'file_watch';
      /** R2 key if the file was uploaded to R2 first; null/absent when the
       * file content is carried inline via the `content` field (manual
       * run path from the REST API). */
      r2Key?: string | null;
      fileName: string;
      /** Content type like text/csv, application/pdf, etc. */
      contentType?: string;
      /** Inline file bytes. Only one of r2Key / content should be set at a
       * time — if both are present, content wins and r2Key is treated as
       * metadata only. */
      content?: ArrayBuffer;
    };

export type ConnectorExecuteFn = (
  ctx: ConnectorContext,
  input: ConnectorInput,
) => Promise<ConnectorOutput>;
