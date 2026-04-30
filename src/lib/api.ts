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
  ExtractionTemplate,
  TemplateFieldMapping,
  SupplierExtractionInstructionsGetResponse,
  SupplierExtractionInstructionsPutResponse,
  ActivityFilters,
  ActivityListResponse,
  ActivityEventType,
  ActivityEventDetailResponse,
  EvalNextResponse,
  EvalSubmitRequest,
  EvalSubmitResponse,
  EvalReportResponse,
} from './types';
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
    update: async (id: string, data: Partial<{ title: string; description: string; category: string; tags: string[]; status: string; document_type_id: string | null; supplier_id: string | null; primary_metadata: Record<string, string | null> | null; extended_metadata: Record<string, string | null> | null }>): Promise<Document> => {
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
    update: (id: string, data: Partial<{ name: string; slug: string; description: string; active: number }>) =>
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
  },

  documentTypes: {
    /**
     * GET /api/document-types
     * Returns: { documentTypes: ApiDocumentType[] }
     */
    list: (params?: { tenant_id?: string; active?: number }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.active !== undefined) query.set('active', String(params.active));
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
    create: (data: { name: string; description?: string; tenant_id?: string; auto_ingest?: number; extract_tables?: number }) =>
      fetchApi<{ documentType: ApiDocumentType }>('/document-types', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/document-types/:id
     * Returns: { documentType: ApiDocumentType }
     */
    update: (id: string, data: { name?: string; description?: string; active?: number; auto_ingest?: number; extract_tables?: number }) =>
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
    process: (files: File[], tenantId: string, documentTypeId?: string): Promise<QueuedResponse> => {
      const form = new FormData();
      files.forEach(f => form.append('files', f));
      if (documentTypeId) form.append('document_type_id', documentTypeId);
      form.append('tenant_id', tenantId);
      return fetchApi<QueuedResponse>('/documents/process', {
        method: 'POST',
        body: form,
      });
    },
  },

  queue: {
    list: (params?: { status?: string; processing_status?: string; document_type_id?: string; tenant_id?: string; limit?: number; offset?: number }) =>
      fetchApi<{ items: ProcessingQueueItem[]; total: number; limit: number; offset: number }>(
        `/queue?${new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString()}`
      ),
    get: (id: string) => fetchApi<{ item: ProcessingQueueItem }>(`/queue/${id}`),
    approve: (id: string, data: {
      fields?: Record<string, string>;
      product_name?: string;
      shared_fields?: Record<string, string>;
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
    }) =>
      fetchApi<{ document?: any; documents?: any[] }>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'approved', ...data }) }),
    reject: (id: string) =>
      fetchApi<void>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }),
    postResults: (id: string, data: Record<string, unknown>) =>
      fetchApi<{ success: boolean }>(`/queue/${id}/results`, { method: 'PUT', body: JSON.stringify(data) }),
  },

  /**
   * A/B evaluation flow for text vs VLM extraction. Blind-labeled as
   * "Method A" / "Method B" in the UI — the backend keeps the text/vlm
   * mapping so the aggregate report can unblind it.
   */
  eval: {
    next: () => fetchApi<EvalNextResponse>('/eval/next'),
    submit: (queueItemId: string, data: EvalSubmitRequest) =>
      fetchApi<EvalSubmitResponse>(`/eval/${queueItemId}`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: () => fetchApi<EvalReportResponse>('/eval/report'),
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
      tenant_id?: string;
    }) =>
      fetchApi<SupplierExtractionInstructionsPutResponse>('/extraction-instructions', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  naturalSearch: (query: string, tenantId?: string) =>
    fetchApi<NaturalSearchResponse>('/documents/search/natural', {
      method: 'POST',
      body: JSON.stringify({ query, tenant_id: tenantId }),
    }),

  connectors: {
    list(params?: { tenant_id?: string; system_type?: string; search?: string; active?: string; limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.system_type) query.set('system_type', params.system_type);
      if (params?.search) query.set('search', params.search);
      if (params?.active) query.set('active', params.active);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/connectors?${query}`);
    },
    get(id: string) { return fetchApi(`/connectors/${id}`); },
    create(data: {
      name: string;
      /** Phase B0.5 — globally-unique URL-safe handle. Required by the
       * server on create; the wizard always sends one (auto-derived from
       * `name` unless the user has typed a different value). */
      slug?: string;
      system_type?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
      sample_r2_key?: string;
    }) {
      return fetchApi('/connectors', { method: 'POST', body: JSON.stringify(data) });
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
      system_type?: string;
      config?: Record<string, unknown>;
      field_mappings?: unknown;
      credentials?: Record<string, unknown>;
      schedule?: string;
      tenant_id?: string;
      sample_r2_key?: string;
    }): Promise<
      | { ok: true; connector: { id: string; slug?: string } & Record<string, unknown> }
      | { ok: false; conflict: { suggested: string } }
    > {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const res = await fetch(`${API_BASE}/connectors`, {
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
      return fetchApi(`/connectors/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    /**
     * Patch a connector with a partial update. Thin alias over `update()` —
     * the backend's PUT handler already treats omitted fields as "leave
     * alone" so PATCH semantics map 1:1 onto PUT. Kept as a named helper so
     * the ConnectorDetail page's inline-edit handlers read naturally.
     */
    patch(id: string, partial: Record<string, unknown> & { sample_r2_key?: string | null }) {
      return fetchApi(`/connectors/${id}`, { method: 'PUT', body: JSON.stringify(partial) });
    },
    delete(id: string) { return fetchApi(`/connectors/${id}`, { method: 'DELETE' }); },
    test(id: string) { return fetchApi(`/connectors/${id}/test`, { method: 'POST' }); },
    /**
     * POST /api/connectors/:id/run
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
      return fetchApi(`/connectors/${id}/run`, { method: 'POST', body: form });
    },
    runs(id: string, params?: { limit?: number; offset?: number }) {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset) query.set('offset', String(params.offset));
      return fetchApi(`/connectors/${id}/runs?${query}`);
    },
    /**
     * POST /api/connectors/discover-schema
     * Multipart upload: drop a sample file and get back detected fields +
     * suggested v2 field_mappings. Used by StepUploadSample in the wizard.
     */
    discoverSchema(formData: FormData) {
      return fetchApi<import('../types/connectorSchema').DiscoverSchemaResponse>(
        '/connectors/discover-schema',
        { method: 'POST', body: formData },
      );
    },
    /**
     * POST /api/connectors/preview-extraction
     * Pure preview — runs the parser over a stored sample with the given
     * field_mappings and returns extracted rows. Never writes to D1.
     */
    previewExtraction(payload: import('../types/connectorSchema').PreviewExtractionRequest) {
      return fetchApi<import('../types/connectorSchema').PreviewExtractionResponse>(
        '/connectors/preview-extraction',
        { method: 'POST', body: JSON.stringify(payload) },
      );
    },
    /**
     * GET /api/connectors/:id/sample
     * Rehydrates the stored sample for an existing connector — same shape as
     * discoverSchema(), used by the ConnectorDetail "Re-test" button.
     */
    rehydrateSample(id: string) {
      return fetchApi<import('../types/connectorSchema').DiscoverSchemaResponse>(
        `/connectors/${id}/sample`,
      );
    },
    /**
     * POST /api/connectors/:id/api-token/rotate
     *
     * Rotate the per-connector bearer token used by the Phase B2 HTTP
     * POST drop endpoint. Returns the new plaintext token in the
     * response body — UI surfaces it once with a copy button + warning
     * that the previous token has stopped working. Hard cutover, no
     * grace period.
     */
    rotateApiToken(id: string) {
      return fetchApi<{ api_token: string; rotated_at: string }>(
        `/connectors/${id}/api-token/rotate`,
        { method: 'POST' },
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
};
