/**
 * Connector OUTPUT data types — the {orders[], customers[], errors[]} shape
 * produced by every connector parser.
 *
 * These are pure data interfaces (no Worker globals, no D1/R2 types) so they
 * can be shared between the Cloudflare Worker connector pipeline and the
 * standalone Node extraction worker. The runtime context/input types that DO
 * depend on Worker globals (ConnectorContext, ConnectorInput, etc.) stay in
 * functions/lib/connectors/types.ts, which re-exports everything here so its
 * existing importers are unaffected.
 */

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
  /**
   * LLM self-rated confidence in this record, 0.0–1.0. Drives the
   * stage-vs-commit routing in the orchestrator (default threshold 0.7).
   * Absent when the source is non-LLM (CSV header-based parsing); the
   * orchestrator treats absence as `1.0` (high confidence) so deterministic
   * parsers stay on the commit path.
   */
  _confidence?: number;
}

export interface ParsedOrderItem {
  product_name?: string;
  product_code?: string;
  quantity?: number;
  lot_number?: string;
  /** Per-item confidence; same semantics as ParsedOrder._confidence. */
  _confidence?: number;
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
  /** Per-customer confidence; same semantics as ParsedOrder._confidence. */
  _confidence?: number;
}

/**
 * A parsed shipment line — the WMS hop (Phase P4). A shipment binds an order
 * line to the physical lot that was actually shipped against it. The WMS knows
 * "order N, product P → lot L"; that binding is what lets a COA (which certifies
 * a lot) flow back to the order line and onward to the customer report.
 */
export interface ParsedShipment {
  /** Order this shipment fulfills (matches orders.order_number). */
  order_number: string;
  /** Product name as it appears on the shipment doc (fuzzy-matched to a line). */
  product_name?: string;
  /** Product/SKU code — preferred join key when present (exact match). */
  product_code?: string;
  /** The lot actually shipped. This is the binding the WMS provides. */
  lot_number: string;
  /** Shipped quantity (informational; stored only if a column exists). */
  quantity?: number;
  /** Shipment/line status (informational; stored only if a column exists). */
  status?: string;
}

export interface ConnectorError {
  record_index?: number;
  field?: string;
  message: string;
}

/**
 * Source routing enums (migration 0067). A source's `origin_kind` says
 * whether documents come from an external supplier or an internal system;
 * `output_kind` says which downstream record the worker should produce.
 * The worker routes extraction by these (and resolves the extraction
 * profile from supplier_id + document_type_id). Shared so the REST
 * handlers, frontend wizard, and worker all validate against one list.
 */
export const VALID_OUTPUT_KINDS = ['coa', 'order', 'shipment'] as const;
export type OutputKind = (typeof VALID_OUTPUT_KINDS)[number];

export const VALID_ORIGIN_KINDS = ['supplier', 'internal'] as const;
export type OriginKind = (typeof VALID_ORIGIN_KINDS)[number];

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
