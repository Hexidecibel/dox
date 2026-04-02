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

export interface DocumentTypeRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string | null;
  naming_format: string | null;
  extraction_fields: string | null;
  auto_ingest_threshold: number | null;
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
  lot_number: string | null;
  po_number: string | null;
  code_date: string | null;
  expiration_date: string | null;
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
  lot_number: string | null;
  po_number: string | null;
  code_date: string | null;
  expiration_date: string | null;
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
  lotNumber: string | null;
  poNumber: string | null;
  codeDate: string | null;
  expirationDate: string | null;
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

export interface ExpirationItem {
  link_id: string;
  document_id: string;
  document_title: string;
  document_type_name: string | null;
  product_id: string;
  product_name: string;
  product_slug: string;
  tenant_id: string;
  tenant_name: string;
  expires_at: string;
  days_remaining: number;
  status: 'expired' | 'critical' | 'warning' | 'ok';
  notes: string | null;
}

export interface ExpirationSummary {
  expired: number;
  critical: number;
  warning: number;
  ok: number;
  total: number;
}

export interface ExpirationListResponse {
  expirations: ExpirationItem[];
  summary: ExpirationSummary;
}

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
    naming_format: string | null;
    extraction_fields: ExtractionField[];
    auto_ingest_threshold: number | null;
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
  created_by: string | null;
  created_at: string;
}

export interface ProcessingQueueItem {
  id: string;
  tenant_id: string;
  document_type_id: string;
  file_r2_key: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  extracted_text: string | null;
  ai_fields: string | null;
  ai_confidence: string | null;
  confidence_score: number | null;
  product_names: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
}

// === Natural Language Search ===

export interface ParsedQuery {
  keywords: string[];
  document_type_slug: string | null;
  product_name: string | null;
  date_from: string | null;
  date_to: string | null;
  lot_number: string | null;
  po_number: string | null;
}

export interface NaturalSearchResponse {
  parsed_query: ParsedQuery;
  results: ApiDocument[];
  total: number;
}

// === Auth Token Storage Key (single constant) ===
export const AUTH_TOKEN_KEY = 'auth_token';
export const AUTH_USER_KEY = 'auth_user';
