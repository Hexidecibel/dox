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
  // Phase 3: per-field pre-fill hints derived from past reviewer picks.
  // JSON-stringified Record<field_key, LearnedFieldHint>; null when no signal.
  learned_field_hints: string | null;
  // Phase 3: per-field heuristic uncertainty score in [0, 1]. JSON-stringified
  // Record<field_key, number>; null when uncertainty was not computed.
  uncertainty: string | null;
  // Joined fields from list/get queries
  document_type_name?: string;
  document_type_slug?: string;
  tenant_name?: string;
  tenant_slug?: string;
  created_by_name?: string;
  reviewed_by_name?: string;
}

/**
 * Phase 3: per-field pre-fill hint derived from accumulated reviewer picks for
 * a given (supplier, doctype) pair. Worker writes only entries with
 * confidence >= 0.8; the UI uses these to pre-populate edited fields and
 * render the "from N past reviews" badge.
 */
export interface LearnedFieldHint {
  preferred_source: 'text' | 'vlm';
  suggested_value: string | null;
  confidence: number;
  pick_count: number;
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

// =====================================================================
// === Records Module ===================================================
// =====================================================================
//
// Smartsheet-class collaborative surface. A `records_sheet` owns
// `records_columns` (typed schema) and `records_rows` (the records
// themselves). Cells live in `records_rows.data` as a JSON object keyed
// by column.key. Entity-typed columns (supplier_ref, product_ref,
// document_ref, record_ref, contact) are mirrored into
// `records_row_refs` so reverse lookups don't have to scan JSON.
//
// Schema source: migrations/0040_records_core.sql.

// --- Enums (must match CHECK constraints in 0040) ---

export type RecordColumnType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'duration'
  | 'checkbox'
  | 'dropdown_single'
  | 'dropdown_multi'
  | 'contact'
  | 'email'
  | 'url'
  | 'phone'
  | 'attachment'
  | 'formula'
  | 'rollup'
  | 'supplier_ref'
  | 'product_ref'
  | 'document_ref'
  | 'record_ref'
  | 'customer_ref';

export type RecordRefType =
  | 'supplier'
  | 'product'
  | 'document'
  | 'record'
  | 'contact'
  | 'customer';

export type RecordViewType =
  | 'grid'
  | 'kanban'
  | 'timeline'
  | 'gallery'
  | 'calendar';

// --- JSON-payload shapes ---

/**
 * Cell value bag stored in records_rows.data. Keys are column.key (the
 * immutable slug), values are whatever the column type permits. The
 * value space is intentionally open — the API layer enforces shape per
 * column type.
 */
export type RecordRowData = Record<string, unknown>;

/**
 * Column-type-specific config stored in records_columns.config (JSON).
 * Variants are loose by design: the schema doesn't pin shape, and new
 * column types accrete config keys over time. The discriminant is the
 * owning column's `type`, not a field on the config itself.
 */
export interface RecordColumnConfigBase {
  [key: string]: unknown;
}

export interface RecordColumnDropdownOption {
  value: string;
  label?: string;
  color?: string;
}

export interface RecordColumnDropdownConfig extends RecordColumnConfigBase {
  options?: RecordColumnDropdownOption[];
  allow_custom?: boolean;
}

export interface RecordColumnNumberConfig extends RecordColumnConfigBase {
  precision?: number;
  format?: 'plain' | 'currency' | 'percent';
  currency_code?: string;
}

export interface RecordColumnDateConfig extends RecordColumnConfigBase {
  format?: string;
  include_time?: boolean;
}

export interface RecordColumnRefConfig extends RecordColumnConfigBase {
  /** For record_ref columns: which sheet the reference points at. */
  target_sheet_id?: string;
  /** For multi-value ref columns. */
  multiple?: boolean;
}

export interface RecordColumnFormulaConfig extends RecordColumnConfigBase {
  expression?: string;
  result_type?: RecordColumnType;
}

export interface RecordColumnRollupConfig extends RecordColumnConfigBase {
  source_column_key?: string;
  target_sheet_id?: string;
  aggregation?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first' | 'last';
}

export type RecordColumnConfig =
  | RecordColumnDropdownConfig
  | RecordColumnNumberConfig
  | RecordColumnDateConfig
  | RecordColumnRefConfig
  | RecordColumnFormulaConfig
  | RecordColumnRollupConfig
  | RecordColumnConfigBase;

// --- View config (records_views.config, JSON) ---

export type RecordViewFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'in';

export interface RecordViewFilter {
  column_key: string;
  operator: RecordViewFilterOperator;
  value?: unknown;
}

export interface RecordViewSort {
  column_key: string;
  direction: 'asc' | 'desc';
}

export interface RecordViewConfigBase {
  filters?: RecordViewFilter[];
  sorts?: RecordViewSort[];
  group_by?: string;
  visible_columns?: string[];
  column_widths?: Record<string, number>;
}

export interface RecordGridViewConfig extends RecordViewConfigBase {
  view_type?: 'grid';
  row_height?: 'short' | 'medium' | 'tall';
  frozen_columns?: number;
}

export interface RecordKanbanViewConfig extends RecordViewConfigBase {
  view_type?: 'kanban';
  /** dropdown_single column whose options become board columns. */
  status_column_key?: string;
  card_columns?: string[];
}

export interface RecordTimelineViewConfig extends RecordViewConfigBase {
  view_type?: 'timeline';
  start_column_key?: string;
  end_column_key?: string;
  /** Bucket size when rendering the timeline. */
  scale?: 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface RecordGalleryViewConfig extends RecordViewConfigBase {
  view_type?: 'gallery';
  cover_column_key?: string;
  card_columns?: string[];
}

export interface RecordCalendarViewConfig extends RecordViewConfigBase {
  view_type?: 'calendar';
  date_column_key?: string;
  end_date_column_key?: string;
}

export type RecordViewConfig =
  | RecordGridViewConfig
  | RecordKanbanViewConfig
  | RecordTimelineViewConfig
  | RecordGalleryViewConfig
  | RecordCalendarViewConfig;

// --- D1 row types (raw shape coming back from the database) ---

export interface RecordSheetRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  template_key: string | null;
  archived: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordColumnRow {
  id: string;
  sheet_id: string;
  tenant_id: string;
  key: string;
  label: string;
  type: RecordColumnType;
  config: string | null; // JSON<RecordColumnConfig>
  required: number;
  is_title: number;
  display_order: number;
  width: number | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface RecordRowRow {
  id: string;
  sheet_id: string;
  tenant_id: string;
  display_title: string | null;
  data: string | null; // JSON<RecordRowData>
  position: number;
  parent_row_id: string | null;
  archived: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordRowRefRow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  row_id: string;
  column_key: string;
  ref_type: RecordRefType;
  ref_id: string;
  created_at: string;
}

export interface RecordRowAttachmentRow {
  id: string;
  tenant_id: string;
  /** NULL while the attachment is in the pending-upload state (pre-submit). */
  row_id: string | null;
  column_key: string | null;
  r2_key: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  checksum: string | null;
  uploaded_by: string | null;
  created_at: string;
  /** Set on creation by the public-form upload endpoint; cleared on link to a row. */
  pending_token: string | null;
  /** ISO timestamp; cleared with pending_token. NULL once linked. */
  pending_expires_at: string | null;
  /** Set on creation when the upload originated from a public form. */
  form_id: string | null;
}

export interface RecordViewRow {
  id: string;
  sheet_id: string;
  tenant_id: string;
  name: string;
  view_type: RecordViewType;
  config: string | null; // JSON<RecordViewConfig>
  is_default: number;
  shared: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordCommentRow {
  id: string;
  tenant_id: string;
  row_id: string;
  parent_comment_id: string | null;
  author_id: string;
  body: string;
  mentions: string | null; // JSON<string[]> of user_ids
  created_at: string;
  edited_at: string | null;
}

export interface RecordActivityRow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  row_id: string;
  actor_id: string | null;
  kind: string;
  details: string | null; // JSON; shape varies by kind
  created_at: string;
}

// --- API response shapes (joins surface as optional fields) ---

export interface ApiRecordSheet extends RecordSheetRow {
  creator_name?: string;
  column_count?: number;
  row_count?: number;
}

export interface ApiRecordColumn extends RecordColumnRow {}

export interface ApiRecordRow extends RecordRowRow {
  creator_name?: string;
  updater_name?: string;
  comment_count?: number;
  attachment_count?: number;
}

export interface ApiRecordRowRef extends RecordRowRefRow {
  ref_label?: string;
}

export interface ApiRecordRowAttachment extends RecordRowAttachmentRow {
  uploader_name?: string;
}

export interface ApiRecordView extends RecordViewRow {
  creator_name?: string;
}

export interface ApiRecordComment extends RecordCommentRow {
  author_name?: string;
  author_email?: string;
}

export interface ApiRecordActivity extends RecordActivityRow {
  actor_name?: string;
}

// --- List response wrappers ---

export interface RecordSheetListResponse {
  sheets: ApiRecordSheet[];
  total: number;
}

export interface RecordSheetGetResponse {
  sheet: ApiRecordSheet;
  columns: ApiRecordColumn[];
  views: ApiRecordView[];
}

export interface RecordColumnListResponse {
  columns: ApiRecordColumn[];
}

export interface RecordRowListResponse {
  rows: ApiRecordRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordRowGetResponse {
  row: ApiRecordRow;
  refs: ApiRecordRowRef[];
  attachments: ApiRecordRowAttachment[];
}

export interface RecordViewListResponse {
  views: ApiRecordView[];
}

export interface RecordCommentListResponse {
  comments: ApiRecordComment[];
  total: number;
}

export interface RecordActivityListResponse {
  activity: ApiRecordActivity[];
  total: number;
  limit: number;
  offset: number;
}

// --- Single-resource responses ---

export interface RecordSheetCreateResponse { sheet: ApiRecordSheet; }
export interface RecordSheetUpdateResponse { sheet: ApiRecordSheet; }
export interface RecordColumnCreateResponse { column: ApiRecordColumn; }
export interface RecordColumnUpdateResponse { column: ApiRecordColumn; }
export interface RecordRowCreateResponse { row: ApiRecordRow; }
export interface RecordRowUpdateResponse { row: ApiRecordRow; }
export interface RecordViewCreateResponse { view: ApiRecordView; }
export interface RecordViewUpdateResponse { view: ApiRecordView; }
export interface RecordCommentCreateResponse { comment: ApiRecordComment; }

// --- Request shapes ---

export interface CreateSheetRequest {
  name: string;
  slug?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  template_key?: string | null;
}

export interface UpdateSheetRequest {
  name?: string;
  slug?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  archived?: boolean;
}

export interface CreateColumnRequest {
  key?: string;
  label: string;
  type: RecordColumnType;
  config?: RecordColumnConfig | null;
  required?: boolean;
  is_title?: boolean;
  display_order?: number;
  width?: number | null;
}

export interface UpdateColumnRequest {
  key?: string;
  label?: string;
  type?: RecordColumnType;
  config?: RecordColumnConfig | null;
  required?: boolean;
  is_title?: boolean;
  display_order?: number;
  width?: number | null;
  archived?: boolean;
}

export interface ReorderColumnsRequest {
  /** Ordered list of column ids; index becomes new display_order. */
  column_ids: string[];
}

export interface CreateRowRequest {
  data?: RecordRowData;
  display_title?: string | null;
  parent_row_id?: string | null;
  /** Fractional index. If omitted, server appends to the end. */
  position?: number;
}

export interface UpdateRowRequest {
  data?: RecordRowData;
  display_title?: string | null;
  parent_row_id?: string | null;
  position?: number;
  archived?: boolean;
}

/**
 * Patch a single cell. The server merges into records_rows.data and
 * keeps records_row_refs in sync for entity-typed columns.
 */
export interface UpdateCellRequest {
  column_key: string;
  value: unknown;
}

export interface CreateViewRequest {
  name: string;
  view_type: RecordViewType;
  config?: RecordViewConfig | null;
  is_default?: boolean;
  shared?: boolean;
}

export interface UpdateViewRequest {
  name?: string;
  view_type?: RecordViewType;
  config?: RecordViewConfig | null;
  is_default?: boolean;
  shared?: boolean;
}

export interface CreateCommentRequest {
  body: string;
  parent_comment_id?: string | null;
  mentions?: string[];
}

// --- Records Forms (Phase 2 Slice 1) ---
//
// Forms are derived 1:1 from a sheet's columns. There is no separate
// form designer — adding/removing/renaming a column flows straight to
// the form. `field_config` selects which columns appear and lets the
// builder override label/help text and reorder fields independently of
// the column display_order on the sheet.

export type RecordFormStatus = 'draft' | 'live' | 'archived';

/** One field in a form, mapped 1:1 to a column on the sheet. */
export interface RecordFormFieldConfig {
  /** records_columns.id this field renders. */
  column_id: string;
  /** Required at submit time even if the column itself isn't required. */
  required?: boolean;
  /** Override the column.label for this form context. */
  label_override?: string | null;
  /** Optional helper text rendered below the input. */
  help_text?: string | null;
  /** 0-based render order. Independent of column.display_order on the grid. */
  position: number;
}

/** Presentation knobs for the public form. */
export interface RecordFormSettings {
  /** Shown after a successful submit. Optional. */
  thank_you_message?: string | null;
  /** If set, public form redirects here after success. */
  redirect_url?: string | null;
  /** Hex color (e.g. "#1A365D") used for buttons + accents. */
  accent_color?: string | null;
  /** R2/public URL for an optional logo at the top of the form. */
  logo_url?: string | null;
  /** When true, the public renderer surfaces an attachment step. Default false. */
  allow_attachments?: boolean;
  /** Cap on uploads per submission. Default 5. */
  max_attachments?: number;
  /** Per-file size cap in megabytes. Default 10. */
  max_file_size_mb?: number;
  /**
   * MIME-type allowlist. Entries may be exact (`image/png`) or wildcards
   * (`image/*`). Default `["image/*","application/pdf"]`. The upload
   * endpoint enforces this server-side; the renderer mirrors it for UX.
   */
  allowed_mime_types?: string[];
}

/**
 * Defaults applied when settings.allow_attachments is true but a per-key
 * value is missing. Centralized so the upload endpoint, renderer, and
 * builder agree without copy/paste drift.
 */
export const FORM_ATTACHMENT_DEFAULTS = {
  max_attachments: 5,
  max_file_size_mb: 10,
  allowed_mime_types: ['image/*', 'application/pdf'] as readonly string[],
} as const;

export interface RecordFormRow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  name: string;
  description: string | null;
  public_slug: string | null;
  is_public: number;
  status: RecordFormStatus;
  field_config: string | null; // JSON<RecordFormFieldConfig[]>
  settings: string | null; // JSON<RecordFormSettings>
  archived: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordFormSubmissionRow {
  id: string;
  tenant_id: string;
  form_id: string;
  sheet_id: string;
  row_id: string;
  submitter_metadata: string | null; // JSON
  turnstile_verified: number;
  created_at: string;
}

/** API-shape (joins surface as optional fields). */
export interface RecordForm extends RecordFormRow {
  creator_name?: string;
  submission_count?: number;
}

export interface RecordFormSubmitterMetadata {
  ip?: string | null;
  user_agent?: string | null;
  email?: string | null;
}

export interface RecordFormSubmission extends RecordFormSubmissionRow {
  /** Resolved row title for the admin submission list. */
  row_display_title?: string | null;
}

// --- Admin request/response shapes ---

export interface RecordFormListResponse {
  forms: RecordForm[];
  total: number;
}

export interface RecordFormGetResponse {
  form: RecordForm;
}

export interface RecordFormCreateResponse {
  form: RecordForm;
}

export interface RecordFormUpdateResponse {
  form: RecordForm;
}

export interface RecordFormSubmissionListResponse {
  submissions: RecordFormSubmission[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateFormRequest {
  name: string;
  description?: string | null;
  is_public?: boolean;
  status?: RecordFormStatus;
  field_config?: RecordFormFieldConfig[];
  settings?: RecordFormSettings;
}

export interface UpdateFormRequest {
  name?: string;
  description?: string | null;
  is_public?: boolean;
  status?: RecordFormStatus;
  field_config?: RecordFormFieldConfig[];
  settings?: RecordFormSettings;
  /** Regenerate the public_slug. */
  rotate_slug?: boolean;
}

// --- Public endpoint shapes (NO auth) ---
//
// PublicFormView is a sanitized projection: only visible columns are
// included, only the fields needed to render and validate. We never
// expose tenant_id, hidden columns, or sheet metadata that wasn't
// explicitly opted into the form.

/** Column definition shipped to the public form renderer. */
export interface PublicFormFieldDef {
  /** Stable column key — used as the data payload key on submit. */
  key: string;
  /** Column type — drives the input renderer + server validation. */
  type: RecordColumnType;
  /** Display label (label_override > column.label). */
  label: string;
  help_text?: string | null;
  required: boolean;
  /** Type-specific config (dropdown options, etc). */
  config?: RecordColumnConfig | null;
  position: number;
}

/**
 * Tenant-scoped entity option safe to expose on a public form.
 *
 * Intentionally minimal — id, display name, and a single optional
 * disambiguator (e.g. customer_number, sku). NEVER include PII like
 * email, phone, or address; this rides on an unauthenticated route.
 */
export interface PublicEntityOption {
  id: string;
  name: string;
  /** Optional disambiguator shown as a subtle subtitle in the picker. */
  secondary?: string;
}

/**
 * Pre-fetched entity options for any entity-ref columns visible on the
 * form. Keyed by entity-ref kind so the renderer can match a column's
 * type to its dropdown options without an extra network roundtrip.
 *
 * Only `customer`, `supplier`, and `product` are populated. Other ref
 * types (`record_ref`, `document_ref`, `contact`) are intentionally
 * excluded — their listings have different security profiles and are
 * not safe to enumerate publicly.
 */
export interface PublicFormEntityOptions {
  customer?: PublicEntityOption[];
  supplier?: PublicEntityOption[];
  product?: PublicEntityOption[];
}

/**
 * Attachment policy attached to PublicFormView. Present whenever the
 * builder enabled `allow_attachments`; absent otherwise. The upload
 * endpoint re-enforces every constraint server-side — this projection
 * is purely for UX (disabling the picker, showing limits, etc).
 */
export interface PublicFormAttachmentPolicy {
  enabled: true;
  max_attachments: number;
  max_file_size_mb: number;
  /** Wildcards allowed (e.g. `image/*`). */
  allowed_mime_types: string[];
}

export interface PublicFormView {
  /** Form display metadata. */
  form: {
    name: string;
    description: string | null;
    accent_color: string | null;
    logo_url: string | null;
  };
  fields: PublicFormFieldDef[];
  /** Cloudflare Turnstile site key. Public — safe to ship to the browser. */
  turnstile_site_key: string;
  /**
   * Tenant-scoped entity dropdown options for any visible
   * customer_ref / supplier_ref / product_ref columns. Absent (or empty
   * sub-keys) when the form has no such columns. Capped at 500 entries
   * per kind — see [slug].ts for the search/pagination TODO.
   */
  entity_options?: PublicFormEntityOptions;
  /**
   * Present when the form opted into file/photo uploads. Renderer adds
   * an attachment step; absence means the step is skipped entirely.
   */
  attachments?: PublicFormAttachmentPolicy;
}

/**
 * Server's response to a successful public file upload. Browser holds
 * `attachment_id` + `pending_token` in form state and sends the ids in
 * the eventual submit body.
 */
export interface PublicAttachmentUpload {
  attachment_id: string;
  pending_token: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** ISO; pending row is GC'd by a background sweeper after this. */
  expires_at: string;
}

export interface PublicFormSubmitRequest {
  /** Cell values keyed by column.key. */
  data: RecordRowData;
  /** Cloudflare Turnstile token, captured client-side. */
  turnstile_token: string;
  /** Optional submitter email — captured for audit, not auth. */
  submitter_email?: string | null;
  /**
   * Pending attachment ids issued by /api/forms/public/:slug/upload.
   * Empty / omitted when the form has no attachments.
   */
  attachment_ids?: string[];
}

export interface PublicFormSubmitResponse {
  success: boolean;
  thank_you_message?: string | null;
  redirect_url?: string | null;
}

// === Update Requests ===
//
// Phase 2 Slice 2 of the Records module. Targeted, single-recipient
// "fill these specific fields on this specific row" flow. A user opens
// a row drawer, picks fields + recipient + optional message + optional
// due date, the server mints an unguessable token, an email is sent,
// the recipient lands on /u/<token>, fills only the requested fields
// (server-enforced), and the row is updated. The original sender sees
// a "filled out N fields" entry in the row's activity feed.
//
// Schema source: migrations/0044_records_update_requests.sql.

export type UpdateRequestStatus =
  | 'pending'
  | 'responded'
  | 'expired'
  | 'cancelled';

/** Mirror of the records_update_requests row. */
export interface RecordUpdateRequestRow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  row_id: string;
  token: string;
  recipient_email: string;
  recipient_user_id: string | null;
  /** JSON array of column_keys (NOT column ids) the recipient must fill. */
  fields_requested: string;
  message: string | null;
  due_date: string | null;
  status: UpdateRequestStatus;
  responded_at: string | null;
  expires_at: string | null;
  created_at: string;
  created_by_user_id: string;
}

/**
 * API-shape (joins surface as optional fields). The token is omitted
 * from the admin list response — admins see who/what/when, but the
 * actual gate value never leaves the create POST response so it can't
 * be replayed by a stale GET.
 */
export interface RecordUpdateRequest extends Omit<RecordUpdateRequestRow, 'token'> {
  /** Resolved column_keys parsed from fields_requested for convenience. */
  fields_requested_keys: string[];
  /** Sender display name from a LEFT JOIN on users. */
  creator_name?: string | null;
  /** Title of the row, denormalized for the drawer "pending requests" list. */
  row_display_title?: string | null;
}

/**
 * Response from POST /api/records/.../update-requests. The token IS
 * included here because the caller needs the public link to copy/share
 * if email delivery fails. After this single response, the token is
 * never returned again to authenticated admins.
 */
export interface RecordUpdateRequestCreateResponse {
  request: RecordUpdateRequest;
  /** Full magic link the recipient will use. */
  public_url: string;
  /** Whether the recipient email actually went out (false if RESEND_API_KEY unset). */
  email_sent: boolean;
}

export interface RecordUpdateRequestListResponse {
  requests: RecordUpdateRequest[];
  total: number;
}

/** Body for POST /api/records/sheets/:sheetId/rows/:rowId/update-requests. */
export interface CreateUpdateRequestRequest {
  recipient_email: string;
  /** Optional — set when the recipient is a known user (autocomplete pick). */
  recipient_user_id?: string | null;
  /** Column keys the recipient must fill. Must be 1+ valid keys on this sheet. */
  fields_requested: string[];
  message?: string | null;
  /** Optional ISO date the requester wants the response by. */
  due_date?: string | null;
  /**
   * Optional override (ISO). Defaults to ~30 days when omitted; pass
   * null to disable expiry entirely (e.g. "fill this whenever").
   */
  expires_at?: string | null;
}

// --- Public endpoint shapes (NO auth — token is the gate) ---

/**
 * Sanitized projection shipped to the recipient form at /u/:token.
 *
 * Includes only the columns the requester picked, and the row's CURRENT
 * values for those columns so the recipient sees what they're updating.
 * Never leaks other columns, full sheet metadata, or anything outside
 * the scope of the fields_requested set.
 */
export interface PublicUpdateRequestView {
  /** Row + sheet identity (recipient-friendly only). */
  request: {
    sheet_name: string;
    row_title: string | null;
    sender_name: string;
    sender_email: string;
    message: string | null;
    due_date: string | null;
    /** When this request stops accepting submissions. NULL = no expiry. */
    expires_at: string | null;
  };
  /**
   * Field defs for ONLY the requested columns. Same shape the public
   * form renderer already understands so we can reuse PublicFormRenderer.
   */
  fields: PublicFormFieldDef[];
  /**
   * Current row values, keyed by column.key. Pre-fills the form so the
   * recipient sees "current: X" and can change it. Only includes keys
   * present in `fields` — values for non-requested columns are never
   * included in this projection.
   */
  current_values: RecordRowData;
}

/** Body for POST /api/update-requests/public/:token (recipient submit). */
export interface PublicUpdateRequestSubmitRequest {
  /** Cell values keyed by column.key. Only requested keys are honored. */
  data: RecordRowData;
}

export interface PublicUpdateRequestSubmitResponse {
  success: boolean;
  /** Number of cells the server actually updated (echoes for the UI). */
  fields_updated: number;
}

// === View runtime types (Kanban / Calendar / Timeline / Gallery) ===
//
// Phase 2 Slice 3a/3b: client-side view shapes used by the SheetDetail
// view switcher and the alternate-layout lenses. These are NOT persisted
// yet — `records_views` rows still drive the saved-view list. The active
// view is derived from the URL query (`?view=...&group=...&date=...`)
// so links are shareable and mechanical to test in Playwright.

export type AnyRecordViewType = 'grid' | 'kanban' | 'calendar' | 'timeline' | 'gallery';

/**
 * A view that is implemented in the current build. Slice 3b adds
 * 'timeline' and 'gallery' so all five view buttons in the switcher are
 * live. The set is intentionally a subset of AnyRecordViewType so the
 * compile-time check below catches drift if a placeholder type is added
 * but never wired up.
 */
export type ImplementedRecordViewType =
  | 'grid'
  | 'kanban'
  | 'calendar'
  | 'timeline'
  | 'gallery';

/** Compile-time check that the implemented set is a subset. */
const _viewSubsetCheck: ImplementedRecordViewType extends AnyRecordViewType ? true : false = true;
void _viewSubsetCheck;

/**
 * Timeline view runtime config (URL-driven, not persisted).
 *
 *   - dateColumnKey: which date/datetime column positions chips on the axis
 *   - groupColumnKey: optional swimlane grouping (any non-date column)
 *   - scale: zoom level — controls how many days fit in a visible width
 *
 * Multi-day spans (start_date_column_key + end_date_column_key) are
 * intentionally deferred to a future slice — see TimelineView.tsx header.
 */
export type TimelineScale = 'day' | 'week' | 'month' | 'quarter';

export interface TimelineConfig {
  dateColumnKey: string | null;
  groupColumnKey: string | null;
  scale: TimelineScale;
}

/**
 * Gallery view runtime config (URL-driven, not persisted).
 *
 *   - sortColumnKey: which column to order cards by (null = updated_at desc)
 *   - sortDir: 'asc' | 'desc'
 *   - photosOnly: hide records that have no image attachment
 */
export interface GalleryConfig {
  sortColumnKey: string | null;
  sortDir: 'asc' | 'desc';
  photosOnly: boolean;
}

// === Workflows ===
//
// Phase 3 Slice 3 of the Records module. Linear, step-based workflows
// per sheet. A workflow is a definition; a run is an instance executing
// against a specific row. Step types in v1:
//
//   1. approval         -- in-app or magic-link approve/reject
//   2. update_request   -- reuses the existing update-request infra
//   3. set_cell         -- writes a value to a cell, no human in the loop
//
// Push-to-other-sheet is intentionally deferred (Phase 3b).
//
// Schema source: migrations/0045_records_workflows.sql.

export type WorkflowStepType = 'approval' | 'update_request' | 'set_cell';

export type WorkflowTriggerType = 'manual' | 'on_row_create';

export type WorkflowStatus = 'draft' | 'active' | 'archived';

export type WorkflowRunStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export type WorkflowStepRunStatus =
  | 'pending'
  | 'awaiting_response'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'skipped';

/** Per-step config shapes. Discriminated by RecordWorkflowStep.type. */
export interface ApprovalStepConfig {
  /** Email of an external approver. Mutually exclusive with assignee_user_id at runtime. */
  assignee_email?: string | null;
  /** User id of an internal approver (resolves to in-app inbox). */
  assignee_user_id?: string | null;
  message?: string | null;
  /** Hours-from-step-start until the magic link / inbox item expires. Optional. */
  due_days?: number | null;
}

export interface UpdateRequestStepConfig {
  recipient_email: string;
  fields_requested: string[];
  message?: string | null;
  due_days?: number | null;
}

export interface SetCellStepConfig {
  column_key: string;
  value: unknown;
}

export type WorkflowStepConfig =
  | ApprovalStepConfig
  | UpdateRequestStepConfig
  | SetCellStepConfig;

/** A single step in records_workflows.steps (JSON array element). */
export interface RecordWorkflowStep {
  /** Stable id across edits — generated client-side on add. */
  id: string;
  type: WorkflowStepType;
  /** User-facing label, e.g. "Manager approval". */
  name: string;
  config: WorkflowStepConfig;
  /**
   * Next step.id to execute on approve / completion. Sentinel 'complete'
   * marks the run finished. Defaults to "next step in array, or complete".
   */
  on_approve_next?: string | null;
  /**
   * Next step.id to execute on reject. Sentinel 'rejected' fails the run.
   * Defaults to 'rejected' for approval steps.
   */
  on_reject_next?: string | null;
}

/** Mirror of the records_workflows row, parsed for API consumers. */
export interface RecordWorkflow {
  id: string;
  tenant_id: string;
  sheet_id: string;
  name: string;
  description: string | null;
  trigger_type: WorkflowTriggerType;
  trigger_config: unknown | null;
  steps: RecordWorkflowStep[];
  status: WorkflowStatus;
  archived: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string;
  /** LEFT JOIN convenience field. */
  creator_name?: string | null;
}

/** Mirror of the records_workflow_runs row + step_runs hydrated. */
export interface RecordWorkflowRun {
  id: string;
  tenant_id: string;
  workflow_id: string;
  sheet_id: string;
  row_id: string;
  status: WorkflowRunStatus;
  current_step_id: string | null;
  triggered_by_user_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** Hydrated children — populated on GET /workflow-runs/:runId. */
  step_runs?: RecordWorkflowStepRun[];
  /** Workflow snapshot — convenience for the visualization. */
  workflow_name?: string | null;
  workflow_steps?: RecordWorkflowStep[];
  /** Triggered-by user display name (LEFT JOIN). */
  triggered_by_name?: string | null;
}

/** Mirror of the records_workflow_step_runs row. */
export interface RecordWorkflowStepRun {
  id: string;
  run_id: string;
  step_id: string;
  step_index: number;
  step_type: WorkflowStepType;
  status: WorkflowStepRunStatus;
  assignee_email: string | null;
  assignee_user_id: string | null;
  /** Token is omitted when projecting to admin views. */
  approver_token?: string | null;
  token_expires_at: string | null;
  response_value: unknown | null;
  response_comment: string | null;
  responded_at: string | null;
  responded_by_email_or_user_id: string | null;
  update_request_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** LEFT JOIN convenience: assignee user display name when applicable. */
  assignee_user_name?: string | null;
}

// --- Request shapes (admin) ---

export interface CreateWorkflowRequest {
  name: string;
  description?: string | null;
  trigger_type?: WorkflowTriggerType;
  trigger_config?: unknown | null;
  steps?: RecordWorkflowStep[];
  status?: WorkflowStatus;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string | null;
  trigger_type?: WorkflowTriggerType;
  trigger_config?: unknown | null;
  steps?: RecordWorkflowStep[];
  status?: WorkflowStatus;
}

export interface RecordWorkflowListResponse {
  workflows: RecordWorkflow[];
  total: number;
}

export interface RecordWorkflowGetResponse {
  workflow: RecordWorkflow;
}

export interface RecordWorkflowCreateResponse {
  workflow: RecordWorkflow;
}

export interface RecordWorkflowUpdateResponse {
  workflow: RecordWorkflow;
}

/** Body for POST /api/records/sheets/:sheetId/rows/:rowId/workflow-runs */
export interface StartWorkflowRunRequest {
  workflow_id: string;
}

export interface RecordWorkflowRunListResponse {
  runs: RecordWorkflowRun[];
  total: number;
}

export interface RecordWorkflowRunGetResponse {
  run: RecordWorkflowRun;
}

/** GET /api/records/workflow-approvals/inbox response. */
export interface WorkflowApprovalInboxItem {
  step_run_id: string;
  run_id: string;
  workflow_id: string;
  workflow_name: string;
  step_name: string;
  sheet_id: string;
  sheet_name: string;
  row_id: string;
  row_title: string | null;
  message: string | null;
  due_at: string | null;
  started_at: string | null;
  /** Sender display info. */
  triggered_by_name: string | null;
}

export interface WorkflowApprovalInboxResponse {
  items: WorkflowApprovalInboxItem[];
  total: number;
}

// --- Public approval endpoint (NO auth -- token is the gate) ---

/**
 * Sanitized projection shipped to the approver at /a/:token. Includes
 * minimal row context so the approver can make an informed decision
 * without exposing the rest of the sheet.
 */
export interface PublicApprovalView {
  step: {
    name: string;
    message: string | null;
    workflow_name: string;
    sender_name: string;
    sender_email: string;
    /** ISO timestamp at which this token will stop accepting submissions. */
    expires_at: string | null;
  };
  row: {
    sheet_name: string;
    title: string | null;
    /** Visible columns + their current values, surfaced read-only. */
    fields: Array<{
      key: string;
      label: string;
      type: RecordColumnType;
      value: unknown;
    }>;
  };
}

export interface PublicApprovalSubmitRequest {
  decision: 'approve' | 'reject';
  comment?: string | null;
}

export interface PublicApprovalSubmitResponse {
  success: true;
  decision: 'approve' | 'reject';
}

// === Auth Token Storage Key (single constant) ===
export const AUTH_TOKEN_KEY = 'auth_token';
export const AUTH_USER_KEY = 'auth_user';
