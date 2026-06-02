import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { produceCoa, produceMultiProductCoa } from './kinds/coa';

/**
 * Public entry points for approving COA queue items. The canonical-entity
 * writes (documents + versions + products + lots + extraction_examples +
 * reviewer captures) live in the `coa` doc-kind producer at
 * `./kinds/coa.ts` (Phase P2). These wrappers keep the existing signatures
 * — the queue API endpoints call them — and delegate to the producer.
 *
 * The interfaces below remain the public contract: callers import
 * QueueItem / *Capture / *Options / *Result from this module.
 */

export interface QueueItem {
  id: string;
  tenant_id: string;
  document_type_id: string | null;
  file_r2_key: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  extracted_text: string | null;
  ai_fields: string | null;
  ai_confidence: string | null;
  confidence_score: number | null;
  product_names: string | null;
  supplier: string | null;
  status: string;
  created_by: string | null;
  tenant_slug: string;
}

/**
 * Per-field source pick captured from the reviewer's UI. Derived at approve
 * time by diffing the final values against text/vlm payloads. chosen_source
 * is one of:
 *   'text'     — final value matches the text-extraction payload
 *   'vlm'      — final value matches the VLM payload
 *   'edited'   — final value matches neither (manual correction)
 *   'dismissed' — reviewer removed the field entirely
 */
export interface FieldPickCapture {
  field_key: string;
  text_value?: string | null;
  vlm_value?: string | null;
  chosen_source: 'text' | 'vlm' | 'edited' | 'dismissed';
  final_value?: string | null;
}

export interface FieldDismissalCapture {
  field_key: string;
  action: 'dismissed' | 'extended';
}

export interface TableEditCapture {
  table_idx: number;
  operation: string;
  detail: unknown;
}

export interface ApproveOptions {
  fields?: Record<string, string>;
  productName?: string;
  userId: string;
  clientIp?: string;
  autoIngested?: boolean;
  /**
   * Which extraction path the user approved. Defaults to 'text' to match the
   * pre-VLM behavior. Recorded in the audit log so we can measure how often
   * reviewers pick the VLM output when dual-run is enabled.
   */
  selectedSource?: 'text' | 'vlm';
  /** Phase 2 capture: per-field source picks derived in the UI. */
  fieldPicks?: FieldPickCapture[];
  /** Phase 2 capture: explicit field dismissals. */
  dismissals?: FieldDismissalCapture[];
  /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
  tableEdits?: TableEditCapture[];
  /**
   * Human-verified supplier override from the reviewer UI. Takes precedence
   * over the raw extraction. `supplierId` (validated against the item's tenant)
   * wins; else `supplierName` is resolved via findOrCreateSupplier; else the
   * legacy item.supplier / approvedFields path is used.
   */
  supplierId?: string;
  supplierName?: string;
}

export interface ApproveResult {
  documentId: string;
  title: string;
  externalRef: string;
  supplierId: string | null;
}

export async function approveQueueItem(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: ApproveOptions
): Promise<ApproveResult> {
  return produceCoa(db, files, item, options);
}

export interface MultiProductApproveOptions {
  sharedFields?: Record<string, string>;
  products: Array<{
    productName: string;
    fields: Record<string, string>;
    tables?: Array<{ name: string; headers: string[]; rows: string[][] }>;
  }>;
  userId: string;
  clientIp?: string;
  /** Which extraction path the user approved — see ApproveOptions.selectedSource. */
  selectedSource?: 'text' | 'vlm';
  /** Phase 2 capture: per-field source picks derived in the UI. */
  fieldPicks?: FieldPickCapture[];
  /** Phase 2 capture: explicit field dismissals. */
  dismissals?: FieldDismissalCapture[];
  /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
  tableEdits?: TableEditCapture[];
  /**
   * Human-verified supplier override from the reviewer UI — see
   * ApproveOptions.supplierId / supplierName for precedence semantics.
   */
  supplierId?: string;
  supplierName?: string;
}

export interface MultiProductApproveResult {
  documents: Array<{
    documentId: string;
    title: string;
    productName: string;
    externalRef: string;
  }>;
  supplierId: string | null;
}

export async function approveMultiProductQueueItem(
  db: D1Database,
  files: R2Bucket,
  item: QueueItem,
  options: MultiProductApproveOptions
): Promise<MultiProductApproveResult> {
  return produceMultiProductCoa(db, files, item, options);
}
