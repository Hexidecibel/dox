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

// === Auth Token Storage Key (single constant) ===
export const AUTH_TOKEN_KEY = 'auth_token';
export const AUTH_USER_KEY = 'auth_user';
