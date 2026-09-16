// R2Bucket from the ambient global, not the package — see the note at the top
// of functions/lib/kinds/coa.ts.
import type { D1Database } from '@cloudflare/workers-types';
import { produceCoa, produceMultiProductCoa } from './kinds/coa';
import type { RenewalWrite } from './renewal-proposal';

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
  /**
   * JSON array of ExtractedTable from the flat/legacy extraction path
   * (processing_queue.tables). Present at runtime on every caller — the
   * approve handler selects `pq.*` — and read by produceCoa so an approved
   * single-record COA persists its test tables into
   * documents.extended_metadata.
   */
  tables?: string | null;
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
  /** `string | null` because that is what `getClientIp` returns and what
   *  `produceCoa` accepts; declaring it `string | undefined` made every
   *  caller a type error that the R2Bucket mismatch used to hide. */
  clientIp?: string | null;
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
  /**
   * The renewal decision a reviewer confirmed on the approve screen
   * (migration 0097), already compared against the server-recomputed proposal
   * by `resolveRenewalDecision`. Absent means nobody answered the question, and
   * the producer then writes NO renewal columns at all — which is the honest
   * record of "not reviewed" and is distinct from a reviewer answering "this
   * does not renew".
   */
  renewal?: RenewalWrite;
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
  /** `string | null` because that is what `getClientIp` returns and what
   *  `produceCoa` accepts; declaring it `string | undefined` made every
   *  caller a type error that the R2Bucket mismatch used to hide. */
  clientIp?: string | null;
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
  /**
   * The renewal decision a reviewer confirmed on the approve screen
   * (migration 0097), already compared against the server-recomputed proposal
   * by `resolveRenewalDecision`. Absent means nobody answered the question, and
   * the producer then writes NO renewal columns at all — which is the honest
   * record of "not reviewed" and is distinct from a reviewer answering "this
   * does not renew".
   */
  renewal?: RenewalWrite;
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
