import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { ConnectorFieldMappings } from '../../../shared/fieldMappings';

// === Connector Output Types ===
//
// The pure {orders[], customers[], errors[]} output shapes live in
// shared/connectorOutput.ts so the standalone Node extraction worker can import
// the exact same types. Re-exported here so existing importers of this module
// (orchestrator, queue-approve, parsers, tests) are unaffected.
export type {
  ParsedOrder,
  ParsedOrderItem,
  ParsedContact,
  ParsedCustomer,
  ConnectorError,
  ConnectorOutput,
} from '../../../shared/connectorOutput';
import type { ConnectorOutput } from '../../../shared/connectorOutput';

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
  /**
   * Reviewer-authored natural-language guidance from the connector row
   * (migration 0061). The email/file_watch parser prepends this to the Qwen
   * system prompt for every order/customer extraction so connector-specific
   * quirks ("CODE DATE column is expiration_date", "ignore lines starting
   * with X") can be taught without redeploying. Empty/undefined means no
   * extra guidance; the parser falls back to the static prompt.
   */
  extractionInstructions?: string;
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
