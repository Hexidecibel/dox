export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JWT_SECRET: string;
  RESEND_API_KEY?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'org_admin' | 'user' | 'reader';
  tenant_id: string | null;
  active: number;
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

export interface Document {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string; // JSON array
  current_version: number;
  status: 'active' | 'archived' | 'deleted';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentVersion {
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

export interface AuditEntry {
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

export interface AuthenticatedRequest {
  user: User;
}

export interface CFContext {
  env: Env;
  user?: User;
  request: Request;
}
