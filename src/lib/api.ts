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

  return {
    ...doc,
    tags,
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
    list: async (params?: { category?: string; status?: string; page?: number; limit?: number; tenantId?: string }): Promise<{ documents: Document[]; total: number }> => {
      const query = new URLSearchParams();
      if (params?.category) query.set('category', params.category);
      if (params?.status) query.set('status', params.status);
      if (params?.page) query.set('offset', String((params.page - 1) * (params.limit || 50)));
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.tenantId) query.set('tenantId', params.tenantId);
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
    update: async (id: string, data: Partial<{ title: string; description: string; category: string; tags: string[]; status: string }>): Promise<Document> => {
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
};
