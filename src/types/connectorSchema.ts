/**
 * Frontend-facing request/response types for the file-first connector wizard.
 *
 * These mirror the Wave 1 backend shapes in
 *   - functions/api/connectors/discover-schema.ts
 *   - functions/api/connectors/preview-extraction.ts
 *   - functions/lib/connectors/schemaDiscovery.ts
 *
 * All field-mapping types are imported from the single source of truth at
 * `shared/fieldMappings.ts` — do not redeclare them here.
 */

import type { ConnectorFieldMappings } from '../../shared/fieldMappings';

// =============================================================================
// /api/connectors/discover-schema
// =============================================================================

export type DetectedFieldType = 'string' | 'number' | 'date' | 'id' | 'email' | 'phone';

export interface DetectedField {
  /** Original source column header as it appeared in the file. */
  name: string;
  /** Heuristic-inferred type of the column. */
  inferred_type: DetectedFieldType;
  /** Up to 5 unique sample values from the first rows. */
  sample_values: string[];
  /** Aliases discovery thinks this column is known by (CSV: just `[name]`). */
  inferred_aliases: string[];
  /** Best-guess target field (core key or extended sentinel). */
  candidate_target?: string;
  /** Confidence score [0..1] for the candidate target. */
  confidence?: number;
  /** Sheet name (XLSX only; undefined for CSV). */
  sheet_name?: string;
}

export type ConnectorSampleSourceType = 'csv' | 'xlsx' | 'pdf' | 'eml' | 'text';

export interface DiscoverSchemaResponse {
  /** R2 key of the stored sample — pass back to preview-extraction. */
  sample_id: string;
  source_type: ConnectorSampleSourceType;
  file_name: string;
  size: number;
  /** Unix ms epoch when the temp sample will be garbage-collected. */
  expires_at: number;
  detected_fields: DetectedField[];
  sample_rows: Record<string, string>[];
  layout_hint: string;
  warnings: string[];
  suggested_mappings: ConnectorFieldMappings;
}

// =============================================================================
// /api/connectors/preview-extraction
// =============================================================================

export interface PreviewExtractionRequest {
  sample_id: string;
  field_mappings: ConnectorFieldMappings;
  connector_type?: string;
  limit?: number;
}

export interface PreviewRow {
  order_number: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  primary_metadata?: Record<string, unknown>;
  extended_metadata?: Record<string, unknown>;
  source_data: Record<string, unknown>;
}

export interface PreviewCustomer {
  customer_number: string;
  name: string;
  email: string | null;
  contacts?: Array<{
    name: string | null;
    email: string;
    role: string | null;
  }>;
}

export interface PreviewExtractionError {
  message: string;
  row?: number;
  field?: string;
}

export interface PreviewExtractionResponse {
  rows: PreviewRow[];
  customers: PreviewCustomer[];
  errors: PreviewExtractionError[];
  warnings: string[];
  total_rows_in_sample: number;
  total_customers_in_sample: number;
  duration_ms: number;
}
