import type {
  AuthPayload,
  Document,
  DocumentVersion,
  User,
  Tenant,
  LoginResponse,
  RegisterResponse,
  DocumentListResponse,
  DocumentGetResponse,
  DocumentCreateResponse,
  DocumentUpdateResponse,
  DocumentVersionsResponse,
  DocumentUploadResponse,
  SearchResponse,
  AuditListResponse,
  ResetPasswordResponse,
  IngestResponse,
  LookupResponse,
  ApiKey,
  CreateApiKeyResponse,
  ApiProduct,
  ApiDocumentType,
  ProductListResponse,
  ProductGetResponse,
  DocumentTypeListResponse,
  DocumentTypeGetResponse,
  DocumentProductListResponse,
  ApiDocumentProduct,
  ApiBundle,
  ApiBundleItem,
  BundleListResponse,
  BundleGetResponse,
  ProcessingQueueItem,
  QueuedResponse,
  NaturalSearchResponse,
  ApiSupplier,
  SupplierListResponse,
  SupplierLookupOrCreateResponse,
  SupplierDuplicatesResponse,
  SupplierMergeResponse,
  ExtractionTemplate,
  TemplateFieldMapping,
  SupplierExtractionInstructionsGetResponse,
  SupplierExtractionInstructionsPutResponse,
  SupplierExtractionInstructionsListResponse,
  TeachExample,
  TeachSessionCreateResponse,
  TeachMessageResponse,
  TeachSynthesizeResponse,
  TeachSessionDetailResponse,
  TeachConfirmResponse,
  ActivityFilters,
  ActivityListResponse,
  ActivityEventType,
  ActivityEventDetailResponse,
  CreateSavedSearchRequest,
  UpdateSavedSearchRequest,
  SavedSearchListResponse,
  SavedSearchResponse,
  UniversalSearchParams,
  UniversalSearchResponse,
  LotListResponse,
  LotDetail,
  CoaFulfillmentResponse,
  LotMatchListResponse,
} from './types';
import type { ParsedCustomer, ParsedOrder, ParsedShipment } from '../../shared/connectorOutput';
import { AUTH_TOKEN_KEY } from './types';

const API_BASE = '/api';

/**
 * Parse an API document (tags is a JSON string from D1) into a frontend Document.
 */
function parseDocument(doc: any): Document {
  let tags: string[] = [];
  if (typeof doc.tags === 'string') {
    try {
      const parsed = JSON.parse(doc.tags || '[]');
      tags = Array.isArray(parsed) ? parsed : [];
    } catch {
      tags = [];
    }
  } else if (Array.isArray(doc.tags)) {
    tags = doc.tags;
  }

  // Parse primary_metadata and extended_metadata from JSON strings
  let primaryMetadata: Record<string, string | null> | null = null;
  if (doc.primary_metadata) {
    try {
      primaryMetadata = typeof doc.primary_metadata === 'string'
        ? JSON.parse(doc.primary_metadata)
        : doc.primary_metadata;
    } catch { primaryMetadata = null; }
  }

  let extendedMetadata: Record<string, string | null> | null = null;
  if (doc.extended_metadata) {
    try {
      extendedMetadata = typeof doc.extended_metadata === 'string'
        ? JSON.parse(doc.extended_metadata)
        : doc.extended_metadata;
    } catch { extendedMetadata = null; }
  }

  return {
    ...doc,
    tags,
    documentTypeId: doc.document_type_id ?? null,
    documentTypeName: doc.document_type_name,
    documentTypeSlug: doc.document_type_slug,
    supplierId: doc.supplier_id ?? null,
    supplierName: doc.supplier_name,
    primaryMetadata,
    extendedMetadata,
  };
}

/**
 * Core fetch helper. Reads the auth token, sets headers, handles errors.
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };

  // Don't set Content-Type for FormData -- browser sets it with boundary
  if (!(options?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    // Auto-redirect to login on 401 (expired/invalid token), but not for login attempts
    if (res.status === 401 && !path.includes('/auth/login')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.href = '/login';
      throw new Error('Session expired');
    }

    let message: string;
    try {
      const body = await res.json();
      message = body.error || body.message || res.statusText;
    } catch {
      message = await res.text() || res.statusText;
    }
    throw new Error(message);
  }

  // Handle empty responses (204 No Content)
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// R1.3 — staged-extraction review surface types.
//
// Exposed at module scope so callers (e.g. the ConnectorRunReview page)
// can import them without a re-declaration. Shapes mirror
// `functions/api/sources/[id]/runs/[runId]/staged.ts` and
// `functions/api/orders/[id]/approve-staged.ts`.
// ---------------------------------------------------------------------------
export interface StagedOrderItem {
  id: string;
  product_name: string | null;
  product_code: string | null;
  quantity: number | null;
  lot_number: string | null;
  confidence: number | null;
  staged_at: string | null;
}

export interface StagedOrder {
  id: string;
  order_number: string;
  customer_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  confidence: number | null;
  staged_at: string;
  primary_metadata: Record<string, unknown> | null;
  extended_metadata: Record<string, unknown> | null;
  items: StagedOrderItem[];
}

export interface StagedRunResponse {
  run: {
    id: string;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    records_found: number;
    records_created: number;
    records_staged: number;
  };
  orders: StagedOrder[];
}

export interface ApproveStagedItemEdit {
  id?: string;
  product_name?: string | null;
  product_code?: string | null;
  quantity?: number | null;
  lot_number?: string | null;
  _delete?: boolean;
}

export interface ApproveStagedBody {
  order_number?: string;
  po_number?: string;
  customer_number?: string;
  customer_name?: string;
  primary_metadata?: Record<string, unknown>;
  extended_metadata?: Record<string, unknown>;
  items?: ApproveStagedItemEdit[];
}

export const api = {
  auth: {
    /**
     * POST /api/auth/login
     * Returns: { token, user: { id, email, name, role, tenant_id, force_password_change } }
     */
    login: async (email: string, password: string): Promise<AuthPayload> => {
      const data = await fetchApi<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      return {
        token: data.token,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          role: data.user.role,
          tenant_id: data.user.tenant_id,
          active: 1, // If they can log in, they're active
          last_login_at: null, // Not returned by login endpoint
          created_at: '', // Not returned by login endpoint
          force_password_change: data.user.force_password_change,
        },
      };
    },

    /**
     * POST /api/auth/logout
     * Returns: { success: true }
     */
    logout: () =>
      fetchApi<{ success: boolean }>('/auth/logout', { method: 'POST' }),

    /**
     * PUT /api/auth/password
     * Returns: { success: true }
     */
    changePassword: (currentPassword: string, newPassword: string) =>
      fetchApi<{ success: boolean }>('/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),

    /**
     * POST /api/auth/forgot-password
     * Returns: { message: '...' }
     */
    forgotPassword: (email: string) =>
      fetchApi<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),

    /**
     * POST /api/auth/reset-password
     * Returns: { success: true, message: '...' }
     */
    resetPassword: (token: string, newPassword: string) =>
      fetchApi<{ success: boolean; message: string }>('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      }),
  },

  documents: {
    /**
     * GET /api/documents
     * Returns: { documents: ApiDocument[], total, limit, offset }
     * documents have tags as JSON string -- we parse them.
     */
    list: async (params?: { category?: string; status?: string; page?: number; limit?: number; tenantId?: string; supplier_id?: string }): Promise<{ documents: Document[]; total: number }> => {
      const query = new URLSearchParams();
      if (params?.category) query.set('category', params.category);
      if (params?.status) query.set('status', params.status);
      if (params?.page) query.set('offset', String((params.page - 1) * (params.limit || 50)));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.tenantId) query.set('tenant_id', params.tenantId);
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      const qs = query.toString();
      const data = await fetchApi<DocumentListResponse>(`/documents${qs ? `?${qs}` : ''}`);
      return {
        documents: (data.documents || []).map(parseDocument),
        total: data.total || 0,
      };
    },

    /**
     * GET /api/documents/:id
     * Returns: { document: ApiDocument, currentVersion: ApiDocumentVersion | null }
     * We parse the document and return it.
     */
    get: async (id: string): Promise<Document> => {
      const data = await fetchApi<DocumentGetResponse>(`/documents/${id}`);
      return parseDocument(data.document);
    },

    /**
     * GET /api/documents/:id -- full response with version info
     */
    getWithVersion: async (id: string): Promise<{ document: Document; currentVersion: DocumentVersion | null }> => {
      const data = await fetchApi<DocumentGetResponse>(`/documents/${id}`);
      return {
        document: parseDocument(data.document),
        currentVersion: data.currentVersion || null,
      };
    },

    /**
     * POST /api/documents
     * Returns: { document: ApiDocument }
     * The created document has tags as JSON string.
     */
    create: async (data: { title: string; description?: string; category?: string; tags?: string[]; tenantId?: string }): Promise<Document> => {
      const response = await fetchApi<DocumentCreateResponse>('/documents', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return parseDocument(response.document);
    },

    /**
     * PUT /api/documents/:id
     * Returns: { document: ApiDocument }
     * The updated document has tags as JSON string.
     */
    update: async (id: string, data: Partial<{ title: string; description: string; category: string; tags: string[]; status: string; document_type_id: string | null; supplier_id: string | null; supplier_name: string; primary_metadata: Record<string, string | null> | null; extended_metadata: Record<string, string | null> | null }>): Promise<Document> => {
      const response = await fetchApi<DocumentUpdateResponse>(`/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      return parseDocument(response.document);
    },

    /**
     * DELETE /api/documents/:id
     * Returns: { success: true }
     */
    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/documents/${id}`, { method: 'DELETE' }),

    /**
     * POST /api/documents/:id/upload
     * Returns: { version: ApiDocumentVersion }
     * Note: backend reads formData.get('changeNotes') -- NOT 'change_notes'.
     */
    upload: async (id: string, file: File, changeNotes?: string): Promise<DocumentVersion> => {
      const form = new FormData();
      form.append('file', file);
      if (changeNotes) form.append('changeNotes', changeNotes);
      const response = await fetchApi<DocumentUploadResponse>(`/documents/${id}/upload`, {
        method: 'POST',
        body: form,
      });
      return response.version;
    },

    /**
     * Download a document version (opens in a new tab).
     */
    download: (id: string, version?: number) => {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const params = new URLSearchParams();
      if (version) params.set('version', String(version));
      if (token) params.set('token', token);
      const qs = params.toString();
      window.open(`${API_BASE}/documents/${id}/download${qs ? `?${qs}` : ''}`, '_blank');
    },

    /**
     * GET /api/documents/:id/versions
     * Returns: { versions: ApiDocumentVersion[], document_id, current_version }
     * We unwrap to just the versions array.
     */
    versions: async (id: string): Promise<DocumentVersion[]> => {
      const data = await fetchApi<DocumentVersionsResponse>(`/documents/${id}/versions`);
      return data.versions || [];
    },

    /**
     * POST /api/documents/ingest
     * Upsert a document by external_ref. Creates or adds a new version.
     */
    ingest: async (data: {
      file: File;
      externalRef: string;
      tenantId: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      changeNotes?: string;
      sourceMetadata?: Record<string, any>;
    }): Promise<IngestResponse> => {
      const form = new FormData();
      form.append('file', data.file);
      form.append('external_ref', data.externalRef);
      form.append('tenant_id', data.tenantId);
      if (data.title) form.append('title', data.title);
      if (data.description) form.append('description', data.description);
      if (data.category) form.append('category', data.category);
      if (data.tags) form.append('tags', JSON.stringify(data.tags));
      if (data.changeNotes) form.append('changeNotes', data.changeNotes);
      if (data.sourceMetadata) form.append('source_metadata', JSON.stringify(data.sourceMetadata));
      return fetchApi<IngestResponse>('/documents/ingest', {
        method: 'POST',
        body: form,
      });
    },

    /**
     * GET /api/documents/lookup
     * Look up a document by external_ref within a tenant.
     */
    lookup: (externalRef: string, tenantId: string) =>
      fetchApi<LookupResponse>(`/documents/lookup?external_ref=${encodeURIComponent(externalRef)}&tenant_id=${encodeURIComponent(tenantId)}`),

    /**
     * GET /api/documents/search
     * Returns: { documents: ApiDocument[], total, limit, offset }
     * Documents have tags as JSON string -- we parse them.
     */
    search: async (query: string, filters?: { category?: string; dateFrom?: string; dateTo?: string }): Promise<{ documents: Document[]; total: number }> => {
      const params = new URLSearchParams({ q: query });
      if (filters?.category) params.set('category', filters.category);
      if (filters?.dateFrom) params.set('date_from', filters.dateFrom);
      if (filters?.dateTo) params.set('date_to', filters.dateTo);
      const data = await fetchApi<SearchResponse>(`/documents/search?${params.toString()}`);
      return {
        documents: (data.documents || []).map(parseDocument),
        total: data.total || 0,
      };
    },

    /**
     * GET /api/documents/search — Phase 4 surface (FTS5).
     *
     * Distinct from `search()` because the panel needs facets, sort,
     * supplier_id / document_type_id, and the loose snippet projection
     * the FTS endpoint returns. Returns the raw server payload — the
     * panel handles `parseDocument` itself for the rows it actually
     * intends to render.
     */
    searchV2: async (params: {
      q: string;
      tenant_id?: string;
      supplier_id?: string;
      document_type_id?: string;
      category?: string;
      date_from?: string;
      date_to?: string;
      sort?: 'relevance' | 'newest' | 'oldest' | 'name';
      limit?: number;
      offset?: number;
      facets?: boolean;
    }): Promise<{
      documents: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      facets?: Partial<Record<'supplier' | 'doc_type' | 'product' | 'date_bucket' | 'status', Array<{ value: string; label: string; count: number }>>>;
    }> => {
      const qs = new URLSearchParams();
      qs.set('q', params.q);
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      if (params.supplier_id) qs.set('supplier_id', params.supplier_id);
      if (params.document_type_id) qs.set('document_type_id', params.document_type_id);
      if (params.category) qs.set('category', params.category);
      if (params.date_from) qs.set('date_from', params.date_from);
      if (params.date_to) qs.set('date_to', params.date_to);
      if (params.sort && params.sort !== 'relevance') qs.set('sort', params.sort);
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      if (params.facets) qs.set('facets', '1');
      return fetchApi(`/documents/search?${qs.toString()}`);
    },
  },

  users: {
    /**
     * GET /api/users
     * Returns: User[] (flat array, NOT wrapped)
     */
    list: () => fetchApi<User[]>('/users'),

    /**
     * GET /api/users/:id
     * Returns: User (flat object, NOT wrapped)
     */
    get: (id: string) => fetchApi<User>(`/users/${id}`),

    /**
     * POST /api/auth/register (user creation goes through register endpoint)
     * Returns: { user: { id, email, name, role, tenant_id }, emailSent }
     * We unwrap to return just the user.
     */
    create: async (data: { email: string; name: string; password: string; role: string; tenant_id?: string }): Promise<User> => {
      const response = await fetchApi<RegisterResponse>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: data.email,
          name: data.name,
          password: data.password,
          role: data.role,
          tenantId: data.tenant_id,
        }),
      });
      return {
        ...response.user,
        role: response.user.role as User['role'],
        active: 1,
        last_login_at: null,
        created_at: '',
      };
    },

    /**
     * PUT /api/users/:id
     * Returns: User (flat object after update)
     */
    update: (id: string, data: Partial<{ name: string; email: string; role: string; tenant_id: string; active: number }>) =>
      fetchApi<User>(`/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * GET /api/users/me
     * Returns: { ...user fields, tenant_name } (flat, with tenant_name added)
     */
    me: () => fetchApi<User>('/users/me'),

    /**
     * POST /api/users/:id/reset-password
     * Returns: { temporaryPassword, emailSent }
     */
    resetPassword: (id: string) =>
      fetchApi<ResetPasswordResponse>(`/users/${id}/reset-password`, { method: 'POST' }),
  },

  tenants: {
    /**
     * GET /api/tenants
     * Returns: Tenant[] (flat array, NOT wrapped)
     */
    list: () => fetchApi<Tenant[]>('/tenants'),

    /**
     * GET /api/tenants/:id
     * Returns: Tenant (flat object)
     */
    get: (id: string) => fetchApi<Tenant>(`/tenants/${id}`),

    /**
     * POST /api/tenants
     * Returns: Tenant (flat object, the created tenant)
     */
    create: (data: { name: string; slug: string; description?: string }) =>
      fetchApi<Tenant>('/tenants', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/tenants/:id
     * Returns: Tenant (flat object after update)
     */
    update: (
      id: string,
      data: Partial<{
        name: string;
        slug: string;
        description: string;
        active: number;
        // Doc-R1: numeric 0–1 enables LLM-confidence-driven auto-approve for
        // this tenant; null disables. super_admin only on the backend.
        auto_approve_threshold: number | null;
      }>
    ) =>
      fetchApi<Tenant>(`/tenants/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  audit: {
    /**
     * GET /api/audit
     * Returns: { entries: AuditEntry[], total, limit, offset }
     */
    list: (params?: Record<string, string>) => {
      const query = new URLSearchParams(params || {});
      const qs = query.toString();
      return fetchApi<AuditListResponse>(`/audit${qs ? `?${qs}` : ''}`);
    },
  },

  ingestHistory: {
    /**
     * GET /api/audit (filtered to ingest actions)
     * Returns: { entries: AuditEntry[], total, limit, offset }
     */
    list: (params?: Record<string, string>) => {
      const query = new URLSearchParams({
        action: 'document.ingested,document.ingest_failed',
        ...params,
      });
      return fetchApi<AuditListResponse>(`/audit?${query.toString()}`);
    },
  },

  apiKeys: {
    list: () => fetchApi<ApiKey[]>('/api-keys'),
    create: (data: { name: string; tenantId?: string; permissions?: string[]; expiresAt?: string }) =>
      fetchApi<CreateApiKeyResponse>('/api-keys', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    revoke: (id: string) =>
      fetchApi<{ success: boolean }>(`/api-keys/${id}`, { method: 'DELETE' }),
  },

  products: {
    /**
     * GET /api/products
     * Returns: { products: ApiProduct[], total, limit, offset }
     */
    list: (params?: { search?: string; active?: number; limit?: number; offset?: number; tenant_id?: string; supplier_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set('search', params.search);
      if (params?.active !== undefined) query.set('active', String(params.active));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      const qs = query.toString();
      return fetchApi<ProductListResponse>(`/products${qs ? `?${qs}` : ''}`);
    },

    /**
     * GET /api/products/:id
     * Returns: { product: ApiProduct }
     */
    get: (id: string) => fetchApi<ProductGetResponse>(`/products/${id}`),

    /**
     * POST /api/products
     * Returns: { product: ApiProduct }
     */
    create: (data: { name: string; description?: string; tenant_id: string; supplier_id?: string }) =>
      fetchApi<{ product: ApiProduct }>('/products', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/products/:id
     * Returns: { product: ApiProduct }
     */
    update: (id: string, data: { name?: string; description?: string; active?: number; supplier_id?: string | null }) =>
      fetchApi<{ product: ApiProduct }>(`/products/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/products/:id
     * Returns: 204 No Content
     */
    delete: (id: string) =>
      fetchApi<void>(`/products/${id}`, { method: 'DELETE' }),

    /**
     * POST /api/products/lookup-or-create
     * Finds an existing product by name or creates a new one.
     * Returns: { product: ApiProduct, created: boolean }
     */
    lookupOrCreate: (data: { name: string; tenant_id: string }) =>
      fetchApi<{ product: ApiProduct; created: boolean }>('/products/lookup-or-create', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  lots: {
    /**
     * GET /api/lots
     * Returns: { lots: LotListItem[], total }
     */
    list: (params?: { supplier_id?: string; product_id?: string; search?: string; limit?: number; offset?: number; tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      if (params?.product_id) query.set('product_id', params.product_id);
      if (params?.search) query.set('search', params.search);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<LotListResponse>(`/lots${qs ? `?${qs}` : ''}`);
    },

    /**
     * GET /api/lots/:id
     * Returns: { lot, coa_documents, order_lines, suggestions }
     */
    get: (id: string) => fetchApi<LotDetail>(`/lots/${id}`),
  },

  suppliers: {
    /**
     * GET /api/suppliers
     * Returns: { suppliers: ApiSupplier[], total }
     */
    list: (params?: { search?: string; active?: number; limit?: number; offset?: number; tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set('search', params.search);
      if (params?.active !== undefined) query.set('active', String(params.active));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<SupplierListResponse>(`/suppliers${qs ? `?${qs}` : ''}`);
    },

    /**
     * POST /api/suppliers
     * Returns: { supplier: ApiSupplier }
     */
    create: (data: { name: string; tenant_id: string; aliases?: string }) =>
      fetchApi<{ supplier: ApiSupplier }>('/suppliers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * GET /api/suppliers/:id
     * Returns: { supplier: ApiSupplier } (with parsed aliases array and counts)
     */
    get: (id: string) => fetchApi<{ supplier: ApiSupplier }>(`/suppliers/${id}`),

    /**
     * PUT /api/suppliers/:id
     * Returns: { supplier: ApiSupplier }
     */
    update: (id: string, data: { name?: string; aliases?: string[]; active?: boolean }) =>
      fetchApi<{ supplier: ApiSupplier }>(`/suppliers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/suppliers/:id
     * Soft-delete (sets active=0). Returns: { success: true }
     */
    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/suppliers/${id}`, { method: 'DELETE' }),

    /**
     * POST /api/suppliers/lookup-or-create
     * Fuzzy match or create supplier by name.
     * Returns: { supplier: ApiSupplier, created: boolean }
     */
    lookupOrCreate: (data: { name: string; tenant_id: string }) =>
      fetchApi<SupplierLookupOrCreateResponse>('/suppliers/lookup-or-create', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * GET /api/suppliers/duplicates
     * Returns clusters of likely-duplicate suppliers for the merge tool.
     */
    duplicates: () => fetchApi<SupplierDuplicatesResponse>('/suppliers/duplicates'),

    /**
     * POST /api/suppliers/merge
     * Folds loser suppliers into a winner (reassigns documents, products,
     * lots, templates, and instructions, then deletes the losers).
     */
    merge: (winnerId: string, loserIds: string[]) =>
      fetchApi<SupplierMergeResponse>('/suppliers/merge', {
        method: 'POST',
        body: JSON.stringify({ winner_id: winnerId, loser_ids: loserIds }),
      }),
  },

  documentTypes: {
    /**
     * GET /api/document-types
     * Returns: { documentTypes: ApiDocumentType[] }
     */
    list: (params?: { tenant_id?: string; active?: number; supplier_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.active !== undefined) query.set('active', String(params.active));
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      const qs = query.toString();
      return fetchApi<DocumentTypeListResponse>(`/document-types${qs ? `?${qs}` : ''}`);
    },

    /**
     * GET /api/document-types/:id
     * Returns: { documentType: ApiDocumentType }
     */
    get: (id: string) => fetchApi<DocumentTypeGetResponse>(`/document-types/${id}`),

    /**
     * POST /api/document-types
     * Returns: { documentType: ApiDocumentType }
     */
    create: (data: { name: string; description?: string; tenant_id?: string; supplier_id?: string | null; auto_ingest?: number; extract_tables?: number }) =>
      fetchApi<{ documentType: ApiDocumentType }>('/document-types', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/document-types/:id
     * Returns: { documentType: ApiDocumentType }
     */
    update: (id: string, data: { name?: string; description?: string; active?: number; supplier_id?: string | null; auto_ingest?: number; extract_tables?: number }) =>
      fetchApi<{ documentType: ApiDocumentType }>(`/document-types/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/document-types/:id
     * Returns: 204 No Content
     */
    delete: (id: string) =>
      fetchApi<void>(`/document-types/${id}`, { method: 'DELETE' }),
  },

  documentProducts: {
    /**
     * GET /api/documents/:id/products
     * Returns: { products: ApiDocumentProduct[] }
     */
    list: (documentId: string) =>
      fetchApi<DocumentProductListResponse>(`/documents/${documentId}/products`),

    /**
     * POST /api/documents/:id/products
     * Link a product to a document.
     */
    link: (documentId: string, data: { product_id: string; expires_at?: string; notes?: string }) =>
      fetchApi<{ documentProduct: ApiDocumentProduct }>(`/documents/${documentId}/products`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/documents/:id/products/:productId
     * Update a document-product link.
     */
    update: (documentId: string, productId: string, data: { expires_at?: string | null; notes?: string | null }) =>
      fetchApi<{ documentProduct: ApiDocumentProduct }>(`/documents/${documentId}/products/${productId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/documents/:id/products/:productId
     * Remove a document-product link.
     */
    unlink: (documentId: string, productId: string) =>
      fetchApi<{ success: boolean }>(`/documents/${documentId}/products/${productId}`, { method: 'DELETE' }),
  },

  reports: {
    /**
     * POST /api/reports/generate
     * Returns CSV (file download) or JSON { data, total }
     */
    generate: async (params: {
      tenantId?: string;
      category?: string;
      dateFrom?: string;
      dateTo?: string;
      format: 'csv' | 'json';
    }) => {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(`${API_BASE}/reports/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        let message: string;
        try {
          const body = await res.json();
          message = body.error || res.statusText;
        } catch {
          message = await res.text() || res.statusText;
        }
        throw new Error(message);
      }

      if (params.format === 'csv') {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const disposition = res.headers.get('Content-Disposition');
        const match = disposition?.match(/filename="([^"]+)"/);
        a.download = match?.[1] || `report-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        return null;
      }

      return res.json();
    },

    /**
     * GET /api/reports/coa-fulfillment
     * The daily COA-fulfillment view: one row per shipped order line with a
     * server-computed gap flag, plus a coverage summary. Tenant-scoped.
     */
    coaFulfillment: (params?: {
      tenantId?: string;
      from?: string;
      to?: string;
      customerId?: string;
      asOf?: string;
      limit?: number;
      offset?: number;
    }): Promise<CoaFulfillmentResponse> => {
      const query = new URLSearchParams();
      if (params?.tenantId) query.set('tenant_id', params.tenantId);
      if (params?.from) query.set('from', params.from);
      if (params?.to) query.set('to', params.to);
      if (params?.customerId) query.set('customer_id', params.customerId);
      if (params?.asOf) query.set('as_of', params.asOf);
      if (params?.limit !== undefined) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchApi<CoaFulfillmentResponse>(`/reports/coa-fulfillment${qs ? `?${qs}` : ''}`);
    },
  },

  bundles: {
    /**
     * GET /api/bundles
     * Returns: { bundles: ApiBundle[], total, limit, offset }
     */
    list: (params?: { limit?: number; offset?: number; tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<BundleListResponse>(`/bundles${qs ? `?${qs}` : ''}`);
    },

    /**
     * GET /api/bundles/:id
     * Returns: { bundle: ApiBundle, items: ApiBundleItem[] }
     */
    get: (id: string) => fetchApi<BundleGetResponse>(`/bundles/${id}`),

    /**
     * POST /api/bundles
     * Returns: { bundle: ApiBundle }
     */
    create: (data: { name: string; description?: string; product_id?: string; tenant_id?: string }) =>
      fetchApi<{ bundle: ApiBundle }>('/bundles', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/bundles/:id
     * Returns: { bundle: ApiBundle }
     */
    update: (id: string, data: { name?: string; description?: string; product_id?: string | null; status?: string }) =>
      fetchApi<{ bundle: ApiBundle }>(`/bundles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/bundles/:id
     * Returns: { success: true }
     */
    delete: (id: string) =>
      fetchApi<{ success: boolean }>(`/bundles/${id}`, { method: 'DELETE' }),

    /**
     * POST /api/bundles/:id/items
     * Add a document to a bundle.
     */
    addItem: (bundleId: string, data: { document_id: string; version_number?: number; sort_order?: number }) =>
      fetchApi<{ item: ApiBundleItem }>(`/bundles/${bundleId}/items`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/bundles/:id/items/:itemId
     * Remove an item from a bundle.
     */
    removeItem: (bundleId: string, itemId: string) =>
      fetchApi<{ success: boolean }>(`/bundles/${bundleId}/items/${itemId}`, { method: 'DELETE' }),

    /**
     * Returns the download URL for a bundle ZIP.
     */
    downloadUrl: (bundleId: string): string => {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      const qs = params.toString();
      return `${API_BASE}/bundles/${bundleId}/download${qs ? `?${qs}` : ''}`;
    },
  },

  processing: {
    /**
     * POST /api/documents/process
     * Send files for async processing. Returns queue item IDs immediately.
     */
    process: (
      files: File[],
      tenantId: string,
      documentTypeId?: string,
      outputKind?: 'coa' | 'order' | 'shipment',
      sourceId?: string,
    ): Promise<QueuedResponse> => {
      const form = new FormData();
      files.forEach(f => form.append('files', f));
      if (documentTypeId) form.append('document_type_id', documentTypeId);
      form.append('tenant_id', tenantId);
      if (outputKind) form.append('output_kind', outputKind);
      if (sourceId) form.append('source_id', sourceId);
      return fetchApi<QueuedResponse>('/documents/process', {
        method: 'POST',
        body: form,
      });
    },
  },

  assignments: {
    /** List ownership assignments for the tenant, with joined labels. */
    list: (params?: { supplier_id?: string; document_type_id?: string; tenant_id?: string }) =>
      fetchApi<{ assignments: import('../../shared/types').Assignment[] }>(
        `/assignments?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString()}`
      ),
    /** Upsert the owner for a (supplier_id, document_type_id) combo. Both owners null = unassigned. */
    set: (data: { supplier_id: string; document_type_id: string; owner_user_id?: string | null; owner_group_id?: string | null; tenant_id?: string }) =>
      fetchApi<{ assignment: import('../../shared/types').Assignment }>(
        '/assignments',
        { method: 'PUT', body: JSON.stringify(data) }
      ),
    /** Remove an assignment by id (clears the combo's owner). */
    remove: (id: string, tenant_id?: string) =>
      fetchApi<{ success: boolean }>(
        `/assignments/${id}${tenant_id ? `?tenant_id=${encodeURIComponent(tenant_id)}` : ''}`,
        { method: 'DELETE' }
      ),
  },

  queue: {
    list: (params?: { status?: string; processing_status?: string; document_type_id?: string; tenant_id?: string; mine?: boolean | 1; limit?: number; offset?: number }) =>
      fetchApi<{ items: ProcessingQueueItem[]; total: number; limit: number; offset: number }>(
        `/queue?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, k === 'mine' ? (v ? '1' : '0') : String(v)])).toString()}`
      ),
    get: (id: string) => fetchApi<{ item: ProcessingQueueItem }>(`/queue/${id}`),
    approve: (id: string, data: {
      fields?: Record<string, string>;
      product_name?: string;
      shared_fields?: Record<string, string>;
      /**
       * Human-verified supplier. Precedence on the backend:
       * supplier_id > supplier_name > legacy extracted value. Send
       * `supplier_id` when an existing supplier was selected, else
       * `supplier_name` for a newly-confirmed name (backend find-or-creates).
       */
      supplier_id?: string;
      supplier_name?: string;
      products?: Array<{
        product_name: string;
        fields: Record<string, string>;
        tables?: Array<{ name: string; headers: string[]; rows: string[][] }>;
      }>;
      save_template?: {
        field_mappings: TemplateFieldMapping[];
        auto_ingest_enabled?: boolean;
        confidence_threshold?: number;
      };
      /** Which extraction source the user picked when dual-run compare was shown. Defaults to 'text'. */
      selected_source?: 'text' | 'vlm';
      /** Phase 2 capture: per-field source picks derived in the UI. */
      field_picks?: Array<{
        field_key: string;
        text_value: string | null;
        vlm_value: string | null;
        chosen_source: 'text' | 'vlm' | 'edited' | 'dismissed';
        final_value: string | null;
      }>;
      /** Phase 2 capture: explicit field dismissals. */
      dismissals?: Array<{ field_key: string; action: 'dismissed' | 'extended' }>;
      /** Phase 2 capture: table-level edits (column excludes, header renames, etc). */
      table_edits?: Array<{ table_idx: number; operation: string; detail: Record<string, unknown> }>;
      /**
       * Review Queue v2 — human-edited records for order/shipment items.
       * `{ customers, orders }` for an order item, `{ shipments }` for a
       * shipment item. The backend re-runs the kind producer over these on
       * approve. COA items never send this.
       */
      records?: {
        customers?: ParsedCustomer[];
        orders?: ParsedOrder[];
        shipments?: ParsedShipment[];
      };
    }) =>
      fetchApi<{ document?: any; documents?: any[]; summary?: string; item?: any }>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'approved', ...data }) }),
    reject: (id: string) =>
      fetchApi<void>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }),
    postResults: (id: string, data: Record<string, unknown>) =>
      fetchApi<{ success: boolean }>(`/queue/${id}/results`, { method: 'PUT', body: JSON.stringify(data) }),
    reprocess: (id: string) =>
      fetchApi<{ success: boolean }>(`/queue/${id}/reprocess`, { method: 'POST' }),
  },

  /**
   * Review Queue v2 — weak COA→lot match suggestions, produced when a shipment
   * item is accepted. The reviewer confirms/rejects each candidate binding.
   */
  lotMatches: {
    /**
     * GET /api/lot-matches?status=pending&order_number=...
     * Returns: { suggestions: LotMatchSuggestion[] }
     *
     * `order_number` may be repeated to scope to several orders at once
     * (e.g. all the orders a shipment touched).
     */
    list: (params?: { status?: string; order_number?: string | string[] }): Promise<LotMatchListResponse> => {
      const query = new URLSearchParams();
      if (params?.status) query.set('status', params.status);
      if (params?.order_number) {
        const nums = Array.isArray(params.order_number) ? params.order_number : [params.order_number];
        for (const n of nums) if (n) query.append('order_number', n);
      }
      const qs = query.toString();
      return fetchApi<LotMatchListResponse>(`/lot-matches${qs ? `?${qs}` : ''}`);
    },

    /**
     * POST /api/lot-matches/:id  — body: { action: 'accept' | 'reject' }
     * Confirmed against functions/api/lot-matches/[id].ts (accept promotes the
     * COA→order_item link; reject just marks the suggestion rejected).
     */
    resolve: (id: string, action: 'accept' | 'reject') =>
      fetchApi<{ success: boolean; status: 'accepted' | 'rejected' }>(`/lot-matches/${id}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
  },

  extractionExamples: {
    list: (documentTypeId: string, tenantId?: string) =>
      fetchApi<{ examples: any[]; total: number }>(`/extraction-examples?document_type_id=${documentTypeId}${tenantId ? `&tenant_id=${tenantId}` : ''}`),
    create: (data: { document_type_id: string; tenant_id?: string; input_text: string; ai_output: string; corrected_output: string; score?: number; supplier?: string | null }) =>
      fetchApi<{ example: any }>('/extraction-examples', { method: 'POST', body: JSON.stringify(data) }),
  },

  extractionTemplates: {
    list: (params?: { tenant_id?: string; supplier_id?: string; document_type_id?: string }) => {
      const qs = new URLSearchParams();
      if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
      if (params?.supplier_id) qs.set('supplier_id', params.supplier_id);
      if (params?.document_type_id) qs.set('document_type_id', params.document_type_id);
      const query = qs.toString();
      return fetchApi<{ templates: ExtractionTemplate[]; total: number }>(
        `/extraction-templates${query ? `?${query}` : ''}`
      );
    },
    get: (id: string) => fetchApi<{ template: ExtractionTemplate }>(`/extraction-templates/${id}`),
    lookup: (params: { supplier_id: string; document_type_id: string; tenant_id?: string }) => {
      const qs = new URLSearchParams({
        supplier_id: params.supplier_id,
        document_type_id: params.document_type_id,
      });
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      return fetchApi<{ template: ExtractionTemplate }>(`/extraction-templates/lookup?${qs.toString()}`);
    },
    create: (data: {
      tenant_id?: string;
      supplier_id: string;
      document_type_id: string;
      field_mappings: TemplateFieldMapping[];
      auto_ingest_enabled?: boolean;
      confidence_threshold?: number;
    }) => fetchApi<{ template: ExtractionTemplate }>('/extraction-templates', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    update: (id: string, data: {
      field_mappings?: TemplateFieldMapping[];
      auto_ingest_enabled?: boolean;
      confidence_threshold?: number;
    }) => fetchApi<{ template: ExtractionTemplate }>(`/extraction-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
    delete: (id: string) => fetchApi<void>(`/extraction-templates/${id}`, { method: 'DELETE' }),
  },

  /**
   * Per-supplier + document-type natural-language extraction instructions.
   * Reviewer-authored guidance that gets prepended to the Qwen prompt on future
   * extractions of the same (supplier, document_type) pair.
   */
  extractionInstructions: {
    get: (params: { supplier_id: string; document_type_id: string; tenant_id?: string }) => {
      const qs = new URLSearchParams({
        supplier_id: params.supplier_id,
        document_type_id: params.document_type_id,
      });
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      return fetchApi<SupplierExtractionInstructionsGetResponse>(
        `/extraction-instructions?${qs.toString()}`
      );
    },
    put: (data: {
      supplier_id: string;
      document_type_id: string;
      instructions: string;
      /**
       * Optional field_mappings to persist on the (supplier, document_type)
       * extraction profile. Omit to leave existing mappings untouched; pass
       * `null` to clear. The Source wizard's mapping step sends these here so
       * the worker (which reads from the profile, not the connector row)
       * picks them up. Shape is the v2 ConnectorFieldMappings object.
       */
      field_mappings?: unknown | null;
      tenant_id?: string;
    }) =>
      fetchApi<SupplierExtractionInstructionsPutResponse>('/extraction-instructions', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    /**
     * List every (document_type, instructions) pair authored for a supplier.
     * One row per active doctype in the tenant — `instructions` is null where
     * the reviewer hasn't written guidance yet. Used by the SupplierDetail
     * "Extraction Instructions" tab so the page doesn't fan out N GETs.
     */
    listBySupplier: (params: { supplier_id: string; tenant_id?: string }) => {
      const qs = new URLSearchParams({ supplier_id: params.supplier_id });
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      return fetchApi<SupplierExtractionInstructionsListResponse>(
        `/extraction-instructions/by-supplier?${qs.toString()}`,
      );
    },
  },

  /**
   * Per-tenant extraction context. The org-wide prompt layer prepended to every
   * extraction for this tenant (the editable "industry/domain" slot). NULL on
   * the server means fall back to the built-in dairy default; the GET returns
   * that default as `default_template` so the UI can seed the editor without
   * duplicating the text client-side.
   */
  tenantExtractionContext: {
    get: (params?: { tenant_id?: string }) => {
      const qs = new URLSearchParams();
      if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return fetchApi<{
        extraction_context: string | null;
        default_template: string;
        updated_at: string | null;
        updated_by: string | null;
      }>(`/tenant-extraction-context${suffix}`);
    },
    put: (body: { extraction_context: string; tenant_id?: string }) =>
      fetchApi<{
        extraction_context: string;
        updated_at: string;
        updated_by: string;
      }>('/tenant-extraction-context', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  },

  /**
   * Learning Interface (teach-chat). A domain expert teaches the system how to
   * read a supplier's documents through a guided conversation; on confirm the
   * proposal is written to the (supplier, document_type) extraction profile.
   */
  teach: {
    /** POST /api/teach/sessions — start a session, returns the opening AI message. */
    createSession: (data: { supplier_id: string; document_type_id: string; tenant_id?: string }) =>
      fetchApi<TeachSessionCreateResponse>('/teach/sessions', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    /** GET /api/teach/sessions/:id — session + transcript + issues + proposal. */
    getSession: (id: string, tenantId?: string) => {
      const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
      return fetchApi<TeachSessionDetailResponse>(`/teach/sessions/${id}${qs}`);
    },
    /** POST /api/teach/sessions/:id/messages — append an SME answer. */
    postMessage: (id: string, content: string, tenantId?: string) =>
      fetchApi<TeachMessageResponse>(`/teach/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, tenant_id: tenantId }),
      }),
    /** POST /api/teach/sessions/:id/synthesize — draft the proposal. */
    synthesize: (id: string, tenantId?: string) =>
      fetchApi<TeachSynthesizeResponse>(`/teach/sessions/${id}/synthesize`, {
        method: 'POST',
        body: JSON.stringify({ tenant_id: tenantId }),
      }),
    /** POST /api/teach/sessions/:id/confirm — write to the profile (allow edits). */
    confirm: (
      id: string,
      data?: { instructions?: string; examples?: TeachExample[]; tenant_id?: string },
    ) =>
      fetchApi<TeachConfirmResponse>(`/teach/sessions/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify(data ?? {}),
      }),
  },

  naturalSearch: (query: string, tenantId?: string) =>
    fetchApi<NaturalSearchResponse>('/documents/search/natural', {
      method: 'POST',
      body: JSON.stringify({ query, tenant_id: tenantId }),
    }),

  sources: {
    list(params?: { tenant_id?: string; search?: string; active?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.search) query.set('search', params.search);
      if (params?.active) query.set('active', params.active);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/sources?${query}`);
    },
    get(id: string) { return fetchApi(`/sources/${id}`); },
    create(data: {
      name: string;
      /** Phase B0.5 — globally-unique URL-safe handle. Required by the
       * server on create; the wizard always sends one (auto-derived from
       * `name` unless the user has typed a different value). */
      slug?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
      sample_r2_key?: string;
      /** Source routing (migration 0067). All optional. */
      origin_kind?: 'supplier' | 'internal';
      output_kind?: 'coa' | 'order' | 'shipment';
      supplier_id?: string | null;
      document_type_id?: string | null;
    }) {
      return fetchApi('/sources', { method: 'POST', body: JSON.stringify(data) });
    },
    /**
     * Variant of `create` that surfaces the structured 409 slug-taken
     * payload (`{ error: 'slug_taken', suggested: '<base>-2' }`) so the
     * wizard can show an inline conflict + a one-click fix without
     * re-parsing the generic `Error.message` produced by fetchApi.
     *
     * Returns either `{ ok: true, connector }` or `{ ok: false,
     * conflict: { suggested } }`. Other errors propagate as thrown
     * Errors so the caller can surface them as red alerts.
     */
    async createOrConflict(data: {
      name: string;
      slug?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
      sample_r2_key?: string;
      /** Source routing (migration 0067). All optional. */
      origin_kind?: 'supplier' | 'internal';
      output_kind?: 'coa' | 'order' | 'shipment';
      supplier_id?: string | null;
      document_type_id?: string | null;
    }): Promise<
      | { ok: true; connector: { id: string; slug?: string } & Record<string, unknown> }
      | { ok: false; conflict: { suggested: string } }
    > {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const res = await fetch(`${API_BASE}/sources`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({})) as { suggested?: string };
        return { ok: false, conflict: { suggested: body.suggested || '' } };
      }
      if (!res.ok) {
        let message: string;
        try {
          const body = await res.json();
          message = body.error || body.message || res.statusText;
        } catch {
          message = await res.text() || res.statusText;
        }
        throw new Error(message);
      }
      const body = await res.json() as { connector: { id: string } & Record<string, unknown> };
      return { ok: true, connector: body.connector };
    },
    update(id: string, data: Record<string, unknown> & { sample_r2_key?: string }) {
      return fetchApi(`/sources/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    /**
     * Patch a connector with a partial update. Thin alias over `update()` —
     * the backend's PUT handler already treats omitted fields as "leave
     * alone" so PATCH semantics map 1:1 onto PUT. Kept as a named helper so
     * the ConnectorDetail page's inline-edit handlers read naturally.
     */
    patch(id: string, partial: Record<string, unknown> & { sample_r2_key?: string | null }) {
      return fetchApi(`/sources/${id}`, { method: 'PUT', body: JSON.stringify(partial) });
    },
    delete(id: string) { return fetchApi(`/sources/${id}`, { method: 'DELETE' }); },
    test(id: string) { return fetchApi(`/sources/${id}/test`, { method: 'POST' }); },
    /**
     * POST /api/sources/:id/run
     *
     * Triggers a manual connector run. Phase B0 universal-doors model: every
     * connector exposes the manual-upload door, and this endpoint is that
     * door. The backend requires a multipart payload with a `file` field;
     * we wrap it in FormData and let the browser set the multipart boundary
     * (the shared `fetchApi` helper already skips the default JSON
     * Content-Type when the body is a FormData instance).
     */
    run(id: string, file: File) {
      const form = new FormData();
      form.append('file', file);
      return fetchApi(`/sources/${id}/run`, { method: 'POST', body: form });
    },
    listRuns(id: string, params?: { limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/sources/${id}/runs?${query}`);
    },
    /**
     * POST /api/sources/:id/runs/:runId/retry
     *
     * Phase B5 — replay a failed run. The backend refetches the
     * original file from R2 (or the per-connector S3 bucket for
     * `source='s3'` runs) and dispatches a fresh run linked back to
     * the original via `retry_of_run_id`. Surfaces 422 when the source
     * file is no longer retrievable, 400 when the run isn't in the
     * `error` state.
     */
    retryRun(id: string, runId: string) {
      return fetchApi<{
        run_id: string;
        retry_of_run_id: string;
        status: 'success' | 'partial' | 'error';
        orders_created: number;
        customers_created: number;
        errors: string[];
      }>(`/sources/${id}/runs/${runId}/retry`, { method: 'POST' });
    },
    /**
     * GET /api/sources/:id/runs/:runId/staged
     *
     * R1.3 — fetch orders + items routed to staging by a specific run
     * because the LLM's confidence on them fell below the threshold.
     * Returned shape matches `StagedRunResponse` on the server.
     */
    runs: {
      staged(connectorId: string, runId: string) {
        return fetchApi<StagedRunResponse>(
          `/sources/${connectorId}/runs/${runId}/staged`,
        );
      },
    },
    /**
     * GET /api/sources/:id/health
     *
     * Phase B5 — observability snapshot for the connector detail
     * page's Health card: 24h dispatched/success counts, last error
     * (7-day lookback), per-source pills.
     */
    health(id: string) {
      return fetchApi<{
        last_24h: {
          dispatched: number;
          success: number;
          partial: number;
          error: number;
          running: number;
          success_rate: number | null;
        };
        last_error: {
          run_id: string;
          started_at: string;
          error_message: string | null;
        } | null;
        by_source: Record<string, number>;
        window_hours: number;
      }>(`/sources/${id}/health`);
    },
    /**
     * POST /api/sources/discover-schema
     * Multipart upload: drop a sample file and get back detected fields +
     * suggested v2 field_mappings. Used by StepUploadSample in the wizard.
     */
    discoverSchema(formData: FormData) {
      return fetchApi<import('../types/connectorSchema').DiscoverSchemaResponse>(
        '/sources/discover-schema',
        { method: 'POST', body: formData },
      );
    },
    /**
     * POST /api/sources/preview-extraction
     * Pure preview — runs the parser over a stored sample with the given
     * field_mappings and returns extracted rows. Never writes to D1.
     */
    previewExtraction(payload: import('../types/connectorSchema').PreviewExtractionRequest) {
      return fetchApi<import('../types/connectorSchema').PreviewExtractionResponse>(
        '/sources/preview-extraction',
        { method: 'POST', body: JSON.stringify(payload) },
      );
    },
    /**
     * GET /api/sources/:id/sample
     * Rehydrates the stored sample for an existing connector — same shape as
     * discoverSchema(), used by the ConnectorDetail "Re-test" button.
     */
    rehydrateSample(id: string) {
      return fetchApi<import('../types/connectorSchema').DiscoverSchemaResponse>(
        `/sources/${id}/sample`,
      );
    },
    /**
     * POST /api/sources/:id/api-token/rotate
     *
     * Rotate the per-connector bearer token used by the Phase B2 HTTP
     * POST drop endpoint. Returns the new plaintext token in the
     * response body — UI surfaces it once with a copy button + warning
     * that the previous token has stopped working. Hard cutover, no
     * grace period.
     */
    rotateApiToken(id: string) {
      return fetchApi<{ api_token: string; rotated_at: string }>(
        `/sources/${id}/api-token/rotate`,
        { method: 'POST' },
      );
    },
    /**
     * POST /api/sources/:id/r2/provision
     *
     * Phase B3 — lazy bring-up of the per-connector S3 drop bucket.
     * Returns the vendor-facing creds; the secret is plaintext ONCE
     * and must be displayed immediately to the user. Subsequent reads
     * of the connector return the secret as redacted.
     */
    provisionR2(id: string) {
      return fetchApi<{
        bucket_name: string;
        access_key_id: string;
        secret_access_key: string;
        endpoint: string;
        provisioned_at: string;
      }>(`/sources/${id}/r2/provision`, { method: 'POST' });
    },
    /**
     * POST /api/sources/:id/r2/rotate
     *
     * Phase B3 — rotate the vendor R2 token. Revokes the existing CF
     * token and mints a fresh one against the same bucket. The new
     * secret is plaintext ONCE; the old token stops working
     * immediately.
     */
    rotateR2(id: string) {
      return fetchApi<{
        bucket_name: string;
        access_key_id: string;
        secret_access_key: string;
        endpoint: string;
        rotated_at: string;
      }>(`/sources/${id}/r2/rotate`, { method: 'POST' });
    },
    /**
     * POST /api/sources/:id/public-link/generate
     *
     * Phase B4 — generate (or rotate) the public drop link. The
     * endpoint is idempotent on rotation: if the connector already
     * has a `public_link_token`, the previous URL stops working
     * immediately and the response carries `rotated: true`. The
     * caller surfaces the new URL in a one-time copy modal. Pass
     * `expires_in_days: null` for a no-expiry link; default is 30.
     */
    generatePublicLink(
      id: string,
      payload: { expires_in_days?: number | null } = {},
    ) {
      return fetchApi<{
        public_link_token: string;
        public_link_expires_at: number | null;
        url: string;
        generated_at: string;
        rotated: boolean;
      }>(`/sources/${id}/public-link/generate`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    /**
     * DELETE /api/sources/:id/public-link
     *
     * Phase B4 — revoke the public drop link. Idempotent — calling
     * on a connector with no link returns `{ revoked: false }`.
     * After revoke, the public form route returns "not active" and
     * the drop endpoint rejects the old token with 401.
     */
    revokePublicLink(id: string) {
      return fetchApi<{ revoked: boolean }>(
        `/sources/${id}/public-link`,
        { method: 'DELETE' },
      );
    },
  },

  orders: {
    list(params?: { tenant_id?: string; status?: string; customer_id?: string; connector_id?: string; search?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.status) query.set('status', params.status);
      if (params?.customer_id) query.set('customer_id', params.customer_id);
      if (params?.connector_id) query.set('connector_id', params.connector_id);
      if (params?.search) query.set('search', params.search);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/orders?${query}`);
    },
    get(id: string) { return fetchApi(`/orders/${id}`); },
    create(data: { order_number: string; po_number?: string; customer_id?: string; customer_number?: string; customer_name?: string; tenant_id?: string; items?: Array<{ product_name?: string; product_code?: string; quantity?: number; lot_number?: string }> }) {
      return fetchApi('/orders', { method: 'POST', body: JSON.stringify(data) });
    },
    update(id: string, data: Record<string, unknown>) {
      return fetchApi(`/orders/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    delete(id: string) { return fetchApi(`/orders/${id}`, { method: 'DELETE' }); },
    /**
     * POST /api/orders/:id/approve-staged
     *
     * R1.3 — promote a staged order out of staging. Optional body
     * carries field overrides + per-item edits (see ApproveStagedBody).
     * Returns the updated order + items.
     */
    approveStaged(id: string, body?: ApproveStagedBody) {
      return fetchApi<{ order: Record<string, unknown>; items: Record<string, unknown>[] }>(
        `/orders/${id}/approve-staged`,
        { method: 'POST', body: JSON.stringify(body ?? {}) },
      );
    },
    naturalSearch(query: string, tenantId?: string) {
      return fetchApi('/orders/search/natural', {
        method: 'POST',
        body: JSON.stringify({ query, tenant_id: tenantId }),
      });
    },
  },

  customers: {
    list(params?: { tenant_id?: string; search?: string; active?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.search) query.set('search', params.search);
      if (params?.active) query.set('active', params.active);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/customers?${query}`);
    },
    get(id: string) { return fetchApi(`/customers/${id}`); },
    create(data: { customer_number: string; name: string; email?: string; coa_delivery_method?: string; coa_requirements?: Record<string, unknown>; tenant_id?: string }) {
      return fetchApi('/customers', { method: 'POST', body: JSON.stringify(data) });
    },
    update(id: string, data: Record<string, unknown>) {
      return fetchApi(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    delete(id: string) { return fetchApi(`/customers/${id}`, { method: 'DELETE' }); },
    lookup(params: { customer_number: string; tenant_id?: string }) {
      const query = new URLSearchParams({ customer_number: params.customer_number });
      if (params.tenant_id) query.set('tenant_id', params.tenant_id);
      return fetchApi(`/customers/lookup?${query}`);
    },
  },

  activity: {
    /**
     * GET /api/activity
     * Unified ingest+connector+order+audit feed scoped to the user's tenant
     * (or ?tenant_id=all for super_admin cross-tenant view).
     */
    list(filters?: ActivityFilters): Promise<ActivityListResponse> {
      const query = new URLSearchParams();
      if (filters?.from) query.set('from', filters.from);
      if (filters?.to) query.set('to', filters.to);
      if (filters?.connector_id) query.set('connector_id', filters.connector_id);
      if (filters?.source) query.set('source', filters.source);
      if (filters?.status) query.set('status', filters.status);
      if (filters?.event_type) query.set('event_type', filters.event_type);
      if (filters?.limit != null) query.set('limit', String(filters.limit));
      if (filters?.offset != null) query.set('offset', String(filters.offset));
      if (filters?.tenant_id) query.set('tenant_id', filters.tenant_id);
      const qs = query.toString();
      return fetchApi<ActivityListResponse>(`/activity${qs ? `?${qs}` : ''}`);
    },
    /**
     * GET /api/activity/event?type=...&id=...
     * Drilldown into a single event — full row + parsed JSON fields.
     */
    getEvent(type: ActivityEventType, id: string): Promise<ActivityEventDetailResponse> {
      const query = new URLSearchParams({ type, id });
      return fetchApi<ActivityEventDetailResponse>(`/activity/event?${query.toString()}`);
    },
  },

  search: {
    /**
     * GET /api/search — universal grouped search (Phase 4d).
     *
     * Returns top-N results per entity type (documents / suppliers /
     * products / doc_types / orders / customers / bundles). The
     * `documents` block also carries snippets and joined display
     * fields (supplier_name, document_type_name, creator_name).
     *
     * Tenant scoping mirrors the rest of the search surface — non-
     * super_admin callers are pinned to their own tenant; the
     * `tenant_id` param is only honored for super_admin.
     */
    universal: (params: UniversalSearchParams): Promise<UniversalSearchResponse> => {
      const query = new URLSearchParams();
      query.set('q', params.q);
      if (params.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.offset !== undefined) query.set('offset', String(params.offset));
      if (params.limit_per_type !== undefined) query.set('limit_per_type', String(params.limit_per_type));
      return fetchApi<UniversalSearchResponse>(`/search?${query.toString()}`);
    },

    /**
     * Document Search v2 — saved-searches CRUD (Phase 3).
     *
     * Recent searches stay client-side (localStorage). These are the
     * server-backed NAMED bookmarks the user explicitly chooses to keep.
     */
    saved: {
      /**
       * GET /api/search/saved
       * Returns: { saved_searches: SavedSearch[] } — the calling user's
       * saved searches only (per-user surface; super_admin sees only
       * their own).
       */
      list: () => fetchApi<SavedSearchListResponse>('/search/saved'),

      /**
       * POST /api/search/saved
       * Body: { name, query, scope? } — `scope` reserved for v2;
       * server rejects 'shared' for now.
       * Returns: { saved_search: SavedSearch }
       */
      create: (data: CreateSavedSearchRequest) =>
        fetchApi<SavedSearchResponse>('/search/saved', {
          method: 'POST',
          body: JSON.stringify(data),
        }),

      /**
       * GET /api/search/saved/:id — owner only.
       */
      get: (id: string) =>
        fetchApi<SavedSearchResponse>(`/search/saved/${id}`),

      /**
       * PUT /api/search/saved/:id — owner only.
       * Returns: { saved_search: SavedSearch }
       */
      update: (id: string, data: UpdateSavedSearchRequest) =>
        fetchApi<SavedSearchResponse>(`/search/saved/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),

      /**
       * DELETE /api/search/saved/:id — owner only.
       * Returns: { success: true }
       */
      delete: (id: string) =>
        fetchApi<{ success: boolean }>(`/search/saved/${id}`, { method: 'DELETE' }),
    },
  },
};
