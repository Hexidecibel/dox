// === Shared Types: Single source of truth for API shapes ===
// Used by both backend (functions/) and frontend (src/)

// === Roles & Enums ===
export type Role = 'super_admin' | 'org_admin' | 'user' | 'reader';
export type DocumentStatus = 'active' | 'archived' | 'deleted';

// === Database Row Types (what D1 returns) ===
export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
  active: number;
  last_login_at: string | null;
  created_at: string;
  force_password_change?: number;
}

export interface ProductRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentProductRow {
  id: string;
  document_id: string;
  product_id: string;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiDocumentProduct extends DocumentProductRow {
  product_name?: string;
  product_slug?: string;
}

export interface DocumentProductListResponse {
  products: ApiDocumentProduct[];
}

export interface ExtractionField {
  name: string;           // "Lot Number" — display label, auto-slugified for API keys
  hint?: string;          // "Usually found in the header or stamp area" — prompt hint for AI extraction
  aliases?: string[];     // ["Batch Number", "Lot #"] — alternate names the field might appear as
}

export interface TemplateFieldMapping {
  field_key: string;
  tier: 'primary' | 'extended' | 'product_name';
  display_order: number;
  required: boolean;
  aliases?: string[];
}

export interface ExtractionTemplateRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  document_type_id: string;
  field_mappings: string; // JSON<TemplateFieldMapping[]>
  auto_ingest_enabled: number;
  confidence_threshold: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  supplier_name?: string;
  document_type_name?: string;
}

/**
 * Per-(supplier, document_type) natural-language extraction guidance authored
 * by reviewers. Prepended to the Qwen system prompt on future extractions so
 * reviewers can explicitly "teach" the model without having to correct every
 * doc.
 */
export interface SupplierExtractionInstructions {
  id: string;
  supplier_id: string;
  document_type_id: string;
  tenant_id: string;
  instructions: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export interface SupplierExtractionInstructionsGetResponse {
  // null when no row exists yet for the (supplier, document_type) pair.
  instructions: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SupplierExtractionInstructionsPutResponse {
  instructions: SupplierExtractionInstructions;
}

export interface DocumentTypeRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  auto_ingest_threshold: number | null; // deprecated, unused
  auto_ingest: number;       // 0 or 1
  extract_tables: number;    // 0 or 1
  active: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string; // JSON string from D1
  current_version: number;
  status: DocumentStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  document_type_id: string | null;
  supplier_id: string | null;
  primary_metadata: string | null; // JSON string
  extended_metadata: string | null; // JSON string
  // Deprecated: old hardcoded fields, still in DB but unused
  lot_number?: string | null;
  po_number?: string | null;
  code_date?: string | null;
  expiration_date?: string | null;
}

export interface SupplierRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  aliases: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ApiSupplier extends SupplierRow {}

export interface SupplierListResponse {
  suppliers: ApiSupplier[];
  total: number;
}

export interface SupplierGetResponse {
  supplier: ApiSupplier;
}

export interface SupplierLookupOrCreateResponse {
  supplier: ApiSupplier;
  created: boolean;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version_number: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  checksum: string | null;
  change_notes: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface AuditEntryRow {
  id: number;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

// === API Response Types (what endpoints actually return) ===

export interface ApiProduct extends ProductRow {}

export interface ApiDocumentType extends DocumentTypeRow {
  tenant_name?: string;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
  active: number;
  last_login_at: string | null;
  created_at: string;
  force_password_change?: number;
  tenant_name?: string | null;
}

export interface ApiTenant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ApiDocument {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string; // JSON string from D1!
  current_version: number;
  status: DocumentStatus;
  created_by: string;
  creator_name?: string;
  creator_email?: string;
  tenant_name?: string;
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  external_ref?: string | null;
  source_metadata?: string | null; // JSON string
  document_type_id: string | null;
  document_type_name?: string;
  document_type_slug?: string;
  supplier_id: string | null;
  supplier_name?: string;
  primary_metadata: string | null; // JSON string
  extended_metadata: string | null; // JSON string
}

export interface ApiDocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  checksum: string | null;
  change_notes: string | null;
  uploaded_by: string;
  uploader_name?: string;
  uploader_email?: string;
  created_at: string;
}

export interface ApiAuditEntry {
  id: number;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

// === API Response Wrappers (what each endpoint actually returns) ===

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: Role;
    tenant_id: string | null;
    force_password_change: number;
  };
}

export interface RegisterResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    tenant_id: string | null;
  };
  emailSent: boolean;
}

export interface DocumentListResponse {
  documents: ApiDocument[];
  total: number;
  limit: number;
  offset: number;
}

export interface DocumentGetResponse {
  document: ApiDocument;
  currentVersion: ApiDocumentVersion | null;
}

export interface DocumentCreateResponse {
  document: ApiDocument;
}

export interface DocumentUpdateResponse {
  document: ApiDocument;
}

export interface DocumentVersionsResponse {
  versions: ApiDocumentVersion[];
  document_id: string;
  current_version: number;
}

export interface DocumentUploadResponse {
  version: ApiDocumentVersion;
}

export interface SearchResponse {
  documents: ApiDocument[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditListResponse {
  entries: ApiAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResetPasswordResponse {
  temporaryPassword: string;
  emailSent: boolean;
}

export interface IngestResponse {
  action: 'created' | 'version_added';
  document: ApiDocument;
  version: ApiDocumentVersion;
}

export interface LookupResponse {
  document: ApiDocument;
  currentVersion: ApiDocumentVersion | null;
}

export interface ProductListResponse {
  products: ApiProduct[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProductGetResponse {
  product: ApiProduct;
}

export interface DocumentTypeListResponse {
  documentTypes: ApiDocumentType[];
}

export interface DocumentTypeGetResponse {
  documentType: ApiDocumentType;
}

// === Frontend-friendly types (after parsing) ===

export interface Document {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[]; // PARSED from JSON string
  current_version: number;
  status: DocumentStatus;
  created_by: string;
  creator_name?: string;
  creator_email?: string;
  tenant_name?: string;
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  external_ref?: string | null;
  source_metadata?: string | null; // JSON string
  documentTypeId: string | null;
  documentTypeName?: string;
  documentTypeSlug?: string;
  supplierId: string | null;
  supplierName?: string;
  primaryMetadata: Record<string, string | null> | null;
  extendedMetadata: Record<string, string | null> | null;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key?: string;
  checksum: string | null;
  change_notes: string | null;
  uploaded_by: string;
  uploader_name?: string;
  uploader_email?: string;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenant_id: string | null;
  active: number;
  last_login_at: string | null;
  created_at: string;
  force_password_change?: number;
  tenant_name?: string | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface AuthPayload {
  token: string;
  user: User;
}

// === API Key Types ===

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  user_id: string;
  tenant_id: string | null;
  permissions: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked: number;
  created_at: string;
  user_name?: string;
  user_email?: string;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  key: string; // Full key, shown only once
}

// === Expiration Types ===

// === Document Bundle Types ===

export interface DocumentBundleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  product_id: string | null;
  status: 'draft' | 'finalized';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentBundleItemRow {
  id: string;
  bundle_id: string;
  document_id: string;
  version_number: number | null;
  sort_order: number;
  created_at: string;
}

export interface ApiBundle extends DocumentBundleRow {
  creator_name?: string;
  product_name?: string;
  item_count?: number;
}

export interface ApiBundleItem extends DocumentBundleItemRow {
  document_title?: string;
  document_type_name?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface BundleListResponse {
  bundles: ApiBundle[];
  total: number;
  limit: number;
  offset: number;
}

export interface BundleGetResponse {
  bundle: ApiBundle;
  items: ApiBundleItem[];
}

// === Document Processing ===
export interface ExtractedTable {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface ProductEntry {
  product_name: string;
  fields: Record<string, string>;
  tables?: ExtractedTable[];
}

export interface ProcessingResult {
  file_name: string;
  file_index: number;
  status: 'success' | 'error';
  error_message?: string;
  extracted_text_preview?: string;
  fields: Record<string, string | null>;
  tables?: ExtractedTable[];
  summary?: string;
  product_names: string[];
  confidence: 'high' | 'medium' | 'low';
  confidence_score: number;
  supplier?: string;
  training_ready: boolean;
  example_count: number;
  checksum?: string;
  duplicate?: {
    document_id: string;
    document_title: string;
    file_name: string;
  };
}

export interface ProcessingResponse {
  results: ProcessingResult[];
  document_type: {
    id: string;
    name: string;
    auto_ingest: boolean;
  };
}

// === Extraction Examples & Processing Queue ===

export interface ExtractionExampleRow {
  id: string;
  document_type_id: string;
  tenant_id: string;
  input_text: string;
  ai_output: string;
  corrected_output: string;
  score: number | null;
  supplier: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ProcessingQueueItem {
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
  document_type_guess: string | null;
  status: 'pending' | 'approved' | 'rejected';
  processing_status: 'queued' | 'processing' | 'ready' | 'error';
  error_message: string | null;
  checksum: string | null;
  tables: string | null;
  summary: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
  template_id: string | null;
  auto_ingested: number;
  source: string | null;
  source_detail: string | null;
  // VLM dual-run extraction (null when QWEN_VLM_MODE=off, which is the default)
  vlm_extracted_fields: string | null;
  vlm_extracted_tables: string | null;
  vlm_confidence: number | null;
  vlm_error: string | null;
  vlm_model: string | null;
  vlm_duration_ms: number | null;
  vlm_extracted_at: string | null;
  // Joined fields from list/get queries
  document_type_name?: string;
  document_type_slug?: string;
  tenant_name?: string;
  tenant_slug?: string;
  created_by_name?: string;
  reviewed_by_name?: string;
}

export interface QueuedResponse {
  queued: true;
  items: Array<{
    id: string;
    file_name: string;
    duplicate?: {
      document_id: string;
      document_title: string;
      file_name: string;
    } | null;
  }>;
  document_type?: {
    id: string;
    name: string;
    auto_ingest: boolean;
  };
}

// === Natural Language Search ===

export interface MetadataFilter {
  field: string;
  operator: 'equals' | 'contains' | 'gt' | 'lt';
  value: string;
}

export interface ParsedQuery {
  keywords: string[];
  document_type_slug: string | null;
  product_names: string[];
  supplier_name: string | null;
  date_from: string | null;
  date_to: string | null;
  metadata_filters: MetadataFilter[];
  expiration_filter: {
    operator: 'before' | 'after' | 'between';
    date1: string;
    date2?: string;
  } | null;
  content_search: string | null;
  intent_summary: string;
}

export interface SearchMatchContext {
  field: string;
  snippet: string;
}

export interface NaturalSearchResponse {
  parsed_query: ParsedQuery;
  results: (Document & {
    relevance_score?: number;
    match_context?: SearchMatchContext[];
  })[];
  total: number;
}

// === Order Natural Language Search ===

export interface OrderNaturalSearchResponse {
  results: Array<{
    id: string;
    tenant_id: string;
    order_number: string;
    po_number: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_number: string | null;
    customer_name_resolved: string | null;
    status: string;
    item_count: number;
    matched_count: number;
    product_names: string | null;
    lot_numbers: string | null;
    created_at: string;
    updated_at: string;
    relevance_score: number;
  }>;
  query_interpretation: {
    original_query: string;
    parsed: Record<string, unknown>;
    explanation: string;
  };
  total: number;
}

// Re-export the open-ended field-mapping shape from its canonical module so
// API types and connector types can pull from a single location.
export type {
  ConnectorFieldMappings,
  FieldMappingCore,
  FieldMappingExtended,
  CoreFieldKey,
  CoreFieldDefinition,
} from './fieldMappings';

// === Connector, Order & Customer Enums ===
export type ConnectorType = 'email' | 'api_poll' | 'webhook' | 'file_watch';
export type SystemType = 'erp' | 'wms' | 'other';
export type ConnectorRunStatus = 'running' | 'success' | 'partial' | 'error';
export type OrderStatus = 'pending' | 'enriched' | 'matched' | 'fulfilled' | 'delivered' | 'error';
export type COADeliveryMethod = 'email' | 'portal' | 'none';

// === Connector Row & API Types ===
export interface ConnectorRow {
  id: string;
  tenant_id: string;
  name: string;
  connector_type: ConnectorType;
  system_type: SystemType;
  config: string; // JSON
  field_mappings: string; // JSON — v2 ConnectorFieldMappings shape (see shared/fieldMappings.ts)
  credentials_encrypted: string | null;
  credentials_iv: string | null;
  schedule: string | null;
  active: number;
  last_run_at: string | null;
  last_error: string | null;
  /** R2 key of the sample file uploaded during the wizard discover-schema step. */
  sample_r2_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiConnector extends Omit<ConnectorRow, 'credentials_encrypted' | 'credentials_iv'> {
  has_credentials: boolean;
  tenant_name?: string;
  created_by_name?: string;
}

export interface ConnectorListResponse {
  connectors: ApiConnector[];
  total: number;
}

export interface ConnectorGetResponse {
  connector: ApiConnector;
}

// === Connector Run Row & API Types ===
export interface ConnectorRunRow {
  id: string;
  connector_id: string;
  tenant_id: string;
  status: ConnectorRunStatus;
  started_at: string;
  completed_at: string | null;
  records_found: number;
  records_created: number;
  records_updated: number;
  records_errored: number;
  error_message: string | null;
  details: string | null; // JSON
  created_at: string;
}

export interface ApiConnectorRun extends ConnectorRunRow {
  connector_name?: string;
}

export interface ConnectorRunListResponse {
  runs: ApiConnectorRun[];
  total: number;
}

// === Customer Row & API Types ===
export interface CustomerRow {
  id: string;
  tenant_id: string;
  customer_number: string;
  name: string;
  email: string | null;
  coa_delivery_method: COADeliveryMethod;
  coa_requirements: string | null; // JSON
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ApiCustomer extends CustomerRow {
  tenant_name?: string;
  order_count?: number;
}

export interface CustomerListResponse {
  customers: ApiCustomer[];
  total: number;
}

export interface CustomerGetResponse {
  customer: ApiCustomer;
}

// === Order Row & API Types ===
export interface OrderRow {
  id: string;
  tenant_id: string;
  connector_id: string | null;
  connector_run_id: string | null;
  order_number: string;
  po_number: string | null;
  customer_id: string | null;
  customer_number: string | null;
  customer_name: string | null;
  status: OrderStatus;
  source_data: string | null; // JSON — raw untouched source row
  /** Canonical-core fields mapped from source. JSON string keyed by CoreFieldKey. */
  primary_metadata: string | null;
  /** User-defined extended fields. JSON string keyed by FieldMappingExtended.key. */
  extended_metadata: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiOrder extends OrderRow {
  customer_name_resolved?: string;
  item_count?: number;
  matched_count?: number;
  connector_name?: string;
  tenant_name?: string;
}

export interface OrderListResponse {
  orders: ApiOrder[];
  total: number;
  limit: number;
  offset: number;
}

export interface OrderGetResponse {
  order: ApiOrder;
  items: ApiOrderItem[];
}

// === Order Item Row & API Types ===
export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  lot_matched: number;
  coa_document_id: string | null;
  match_confidence: number | null;
  created_at: string;
}

export interface ApiOrderItem extends OrderItemRow {
  product_name_resolved?: string;
  coa_document_title?: string;
}

// === Unified Activity Feed ===
//
// The `/api/activity` endpoint returns a discriminated union of events
// drawn from four underlying tables (connector_runs, processing_queue,
// orders, audit_log). See functions/lib/activityMerge.ts for the mappers
// and functions/api/activity/index.ts for the handler.

export type ActivityEventType =
  | 'connector_run'
  | 'document_ingest'
  | 'order_created'
  | 'audit';

export type ActivitySourceFilter =
  | 'email'
  | 'api'
  | 'import'
  | 'file_watch'
  | 'all';

export type ActivityStatusFilter =
  | 'success'
  | 'error'
  | 'partial'
  | 'running'
  | 'queued'
  | 'all';

export interface ActivityConnectorRunEvent {
  type: 'connector_run';
  id: string;
  timestamp: string;
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

export interface ActivityDocumentIngestEvent {
  type: 'document_ingest';
  id: string;
  timestamp: string;
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

export interface ActivityOrderCreatedEvent {
  type: 'order_created';
  id: string;
  timestamp: string;
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

export interface ActivityAuditEvent {
  type: 'audit';
  id: string;
  timestamp: string;
  action: string;
  user_id: string | null;
  user_name: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
  tenant_id: string | null;
}

export type ActivityEvent =
  | ActivityConnectorRunEvent
  | ActivityDocumentIngestEvent
  | ActivityOrderCreatedEvent
  | ActivityAuditEvent;

export interface ActivityFilters {
  from?: string;
  to?: string;
  connector_id?: string;
  source?: ActivitySourceFilter;
  status?: ActivityStatusFilter;
  event_type?: ActivityEventType | 'all';
  limit?: number;
  offset?: number;
  tenant_id?: string;
}

export interface ActivityListResponse {
  events: ActivityEvent[];
  total_count: number;
  limit: number;
  offset: number;
  filters_applied: {
    from: string;
    to: string;
    connector_id: string | null;
    source: ActivitySourceFilter;
    status: ActivityStatusFilter;
    event_type: ActivityEventType | 'all';
    tenant_id: string;
  };
}

export interface ActivityEventDetailResponse {
  event: Record<string, unknown>;
}

// === Extraction A/B Evaluations (Tinder-style text-vs-VLM comparison) ===

export type ExtractionEvalWinner = 'a' | 'b' | 'tie';
export type ExtractionEvalSide = 'text' | 'vlm';

/**
 * One row per (queue_item, evaluator). The `a_side` column stores which real
 * extraction method was presented to the reviewer as "Method A" — the UI
 * randomizes it per doc so the reviewer is blind to text-vs-VLM identity,
 * and we unblind at report time using this mapping.
 */
export interface ExtractionEvaluation {
  id: string;
  queue_item_id: string;
  evaluator_user_id: string;
  winner: ExtractionEvalWinner;
  a_side: ExtractionEvalSide;
  comment: string | null;
  evaluated_at: number;
}

export interface EvalNextResponse {
  /** null when nothing left to evaluate (the UI shows the completion screen). */
  item: ProcessingQueueItem | null;
  /** Which real method is presented as "Method A" for this doc. Client echoes this back on POST. */
  a_side: ExtractionEvalSide | null;
  /** Docs still unevaluated (including the current one). 0 means done. */
  remaining: number;
  /** Total eligible docs (both extractions present). */
  total: number;
}

export interface EvalSubmitRequest {
  winner: ExtractionEvalWinner;
  a_side: ExtractionEvalSide;
  comment?: string;
}

export interface EvalSubmitResponse {
  evaluation: ExtractionEvaluation;
  remaining: number;
  total: number;
}

export interface EvalReportTotals {
  evaluated: number;
  text_wins: number;
  vlm_wins: number;
  ties: number;
  remaining: number;
  total: number;
}

export interface EvalReportBreakdownRow {
  /** Display key: supplier name or document-type name. Empty string means "unknown". */
  key: string;
  text_wins: number;
  vlm_wins: number;
  ties: number;
}

export interface EvalReportCommentRow {
  queue_item_id: string;
  file_name: string;
  winner: ExtractionEvalWinner;
  /** Which side actually won (text or vlm), unblinded. null for ties. */
  winning_side: ExtractionEvalSide | null;
  comment: string;
  evaluated_at: number;
  evaluator_name: string | null;
}

export interface EvalReportEvaluationRow {
  queue_item_id: string;
  file_name: string;
  supplier: string | null;
  document_type_name: string | null;
  winner: ExtractionEvalWinner;
  a_side: ExtractionEvalSide;
  winning_side: ExtractionEvalSide | null;
  comment: string | null;
  evaluated_at: number;
  evaluator_name: string | null;
}

export interface EvalReportResponse {
  totals: EvalReportTotals;
  by_supplier: EvalReportBreakdownRow[];
  by_doctype: EvalReportBreakdownRow[];
  comments: EvalReportCommentRow[];
  evaluations: EvalReportEvaluationRow[];
}

// === Auth Token Storage Key (single constant) ===
export const AUTH_TOKEN_KEY = 'auth_token';
export const AUTH_USER_KEY = 'auth_user';
