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
  DocumentLinkedLot,
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
  ApiRequirement,
  ApiSpecTest,
  ApiSpecLimit,
  SpecCriticality,
  ApiSpecCheck,
  ApiClaimType,
  ClaimSubjectGrain,
  DocumentFacetLinkInput,
  RequirementListResponse,
  RequirementGetResponse,
  NoteEntityType,
  NoteListResponse,
  NoteGetResponse,
  EntityNote,
  ClaimTypeListResponse,
  ClaimTypeGetResponse,
  ClaimRuleListResponse,
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
  LotScheme,
  ProductMapGetResponse,
  ProductMapPutResponse,
  OrderProductListResponse,
  ExtractionTemplate,
  TemplateFieldMapping,
  SupplierExtractionInstructionsGetResponse,
  SupplierExtractionInstructionsPutResponse,
  SupplierExtractionInstructionsListResponse,
  DocumentTypeExtractionInstructionsGetResponse,
  DocumentTypeExtractionInstructionsListResponse,
  DocumentTypeExtractionInstructionsPutResponse,
  TeachExample,
  TeachSessionCreateResponse,
  TeachMessageResponse,
  TeachSynthesizeResponse,
  TeachSessionDetailResponse,
  TeachConfirmResponse,
  TeachSessionListResponse,
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
  ExpirationListResponse,
  ExpirationNotifyResponse,
  OwnerRoute,
  OwnerRouteListResponse,
  TenantSetupResponse,
  TenantSetupRunResponse,
  TenantSetupStatus,
  StarterPackCatalogResponse,
  ApplyStarterPackResponse,
  ApplyRequirementPacketResponse,
  DocumentTypeRequirementsResponse,
  ReplaceDocumentTypeRequirementsRequest,
  ReplaceDocumentTypeRequirementsResponse,
  ApiSupplierRequirement,
  SupplierRequirementTier,
  LotMatchListResponse,
  CoaRecordsPayload,
  CoaRecordDecision,
  RejectionReason,
} from './types';
import type { ParsedCustomer, ParsedOrder, ParsedShipment } from '../../shared/connectorOutput';
import type { TypeRenewalPolicy, RenewalDecisionPayload } from '../../shared/types';
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

  // Registry JSON-array columns (migrations 0076/0077) arrive as JSON strings.
  const parseArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v as string[];
    if (typeof v === 'string' && v.trim()) {
      try {
        const p = JSON.parse(v);
        return Array.isArray(p) ? p : [];
      } catch { return []; }
    }
    return [];
  };

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
    aliases: parseArr(doc.aliases),
    criteria: parseArr(doc.criteria),
    appliesTo: parseArr(doc.applies_to),
    owner: doc.owner ?? null,
    renewalType: doc.renewal_type ?? null,
    renewalIntervalMonths: doc.renewal_interval_months ?? null,
    renewalDueDate: doc.renewal_due_date ?? null,
    categories: doc.categories ?? [],
    // Registry facets (migration 0080). GET/PUT /api/documents/:id join the
    // vocabulary in, so these arrive render-ready; older responses that predate
    // cfb1b5e carry neither key, hence the [] fallbacks.
    requirements: doc.requirements ?? [],
    claims: doc.claims ?? [],
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

// ---------------------------------------------------------------------------
// The request composer (migration 0090). Kept as its own import statement so
// the composer's shapes can be read as a set; everything else it needs is in
// the block above.
// ---------------------------------------------------------------------------
import type {
  AmendDocumentRequestRequest,
  CreateDocumentRequestRequest,
  CreateRequestTemplateRequest,
  DocumentRequestListResponse,
  DocumentRequestLineCounts,
  DocumentRequestResponse,
  DocumentRequestStatus,
  InstantiateRequestTemplateRequest,
  IssueDocumentRequestRequest,
  ReissueDocumentRequestRequest,
  RequestLineInput,
  RequestLineRow,
  RequestLineWithClosure,
  RequestLinkView,
  RequestTemplateListResponse,
  RequestTemplateResponse,
  SupplierRequestView,
  UpdateRequestLineRequest,
} from '../../shared/types';
import type { SupplierGapListResponse } from '../../shared/requirementGap';

// ---------------------------------------------------------------------------
// Modules (migration 0099). Its own import block for the same reason as the
// composer's above: these shapes are read as a set, by the nav, the router and
// the Settings screen.
// ---------------------------------------------------------------------------
import type {
  ModuleKey,
  ModuleAccessResponse,
  ModuleListResponse,
  ModuleUpdateResponse,
  ModuleVisibilityResponse,
  ModuleVisibilityUpdateResponse,
  UpdateModuleRequest,
  UpdateModuleVisibilityRequest,
} from '../../shared/types';

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
     * GET /api/documents/:id -- linked lots only (one per sublot under Option B).
     * Returns [] for older responses that don't carry the `lots` envelope.
     */
    lots: async (id: string): Promise<DocumentLinkedLot[]> => {
      const data = await fetchApi<DocumentGetResponse>(`/documents/${id}`);
      return data.lots ?? [];
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
     *
     * `requirements` / `claims` are the registry facet links (migration 0080).
     * OMITTING a key leaves that facet's links alone; sending an array —
     * INCLUDING [] — replaces the whole set, so an editor that clears every
     * box actually clears the rows. This endpoint is the human path: a link
     * with no explicit `status` lands 'confirmed', which is the only status
     * gap detection counts.
     */
    update: async (id: string, data: Partial<{ title: string; description: string; category: string; tags: string[]; status: string; document_type_id: string | null; supplier_id: string | null; supplier_name: string; primary_metadata: Record<string, string | null> | null; extended_metadata: Record<string, string | null> | null; categories: string[]; primary_category_id: string | null; requirements: DocumentFacetLinkInput[]; claims: DocumentFacetLinkInput[]; aliases: string[]; criteria: string[]; applies_to: string[]; owner: string | null; renewal_type: string | null; renewal_interval_months: number | null; renewal_due_date: string | null }>): Promise<Document> => {
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
      /** Optional on the manual registry path — omit to mint `reg-<random>`. */
      externalRef?: string;
      tenantId: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: string[];
      changeNotes?: string;
      sourceMetadata?: Record<string, any>;
      documentTypeId?: string | null;
      supplierId?: string | null;
      productIds?: Array<{ product_id: string; expires_at?: string; notes?: string }>;
      primaryMetadata?: Record<string, string | null>;
      extendedMetadata?: Record<string, string | null>;
      // IDP Document Registry fields (migrations 0076/0077).
      categories?: string[];
      primaryCategoryId?: string | null;
      // Registry facets (migration 0080): what the document SATISFIES and what
      // it TRIGGERS. Ingest is machine-reachable, so a link with no explicit
      // `status` lands 'suggested' — a caller acting for a person (the Add
      // Document form) states 'confirmed' per link.
      requirements?: DocumentFacetLinkInput[];
      claims?: DocumentFacetLinkInput[];
      aliases?: string[];
      criteria?: string[];
      appliesTo?: string[];
      owner?: string | null;
      renewalType?: string | null;
      renewalIntervalMonths?: number | null;
      renewalDueDate?: string | null;
    }): Promise<IngestResponse> => {
      const form = new FormData();
      form.append('file', data.file);
      if (data.externalRef) form.append('external_ref', data.externalRef);
      form.append('tenant_id', data.tenantId);
      if (data.title) form.append('title', data.title);
      if (data.description) form.append('description', data.description);
      if (data.category) form.append('category', data.category);
      if (data.tags) form.append('tags', JSON.stringify(data.tags));
      if (data.changeNotes) form.append('changeNotes', data.changeNotes);
      if (data.sourceMetadata) form.append('source_metadata', JSON.stringify(data.sourceMetadata));
      if (data.documentTypeId) form.append('document_type_id', data.documentTypeId);
      if (data.supplierId) form.append('supplier_id', data.supplierId);
      if (data.productIds && data.productIds.length > 0) form.append('product_ids', JSON.stringify(data.productIds));
      if (data.primaryMetadata) form.append('primary_metadata', JSON.stringify(data.primaryMetadata));
      if (data.extendedMetadata) form.append('extended_metadata', JSON.stringify(data.extendedMetadata));
      if (data.categories) form.append('categories', JSON.stringify(data.categories));
      if (data.primaryCategoryId) form.append('primary_category_id', data.primaryCategoryId);
      if (data.requirements) form.append('requirements', JSON.stringify(data.requirements));
      if (data.claims) form.append('claims', JSON.stringify(data.claims));
      if (data.aliases) form.append('aliases', JSON.stringify(data.aliases));
      if (data.criteria) form.append('criteria', JSON.stringify(data.criteria));
      if (data.appliesTo) form.append('applies_to', JSON.stringify(data.appliesTo));
      if (data.owner) form.append('owner', data.owner);
      if (data.renewalType) form.append('renewal_type', data.renewalType);
      if (data.renewalIntervalMonths != null) form.append('renewal_interval_months', String(data.renewalIntervalMonths));
      if (data.renewalDueDate) form.append('renewal_due_date', data.renewalDueDate);
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

    /**
     * GET /api/audit/export
     * Streams a CSV of every row matching the SAME filters as audit.list
     * (tenant_id, action, userId, resourceType, dateFrom, dateTo) — not just
     * the current page — and triggers a browser download.
     * Returns the matched row count so the caller can tell the user what they
     * got, and whether the server capped it.
     */
    export: async (params?: Record<string, string>): Promise<{ matched: number; truncated: boolean }> => {
      const query = new URLSearchParams(params || {});
      const qs = query.toString();

      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(`${API_BASE}/audit/export${qs ? `?${qs}` : ''}`, { headers });

      if (!res.ok) {
        let message: string;
        try {
          const body = await res.json();
          message = body.error || res.statusText;
        } catch {
          message = (await res.text()) || res.statusText;
        }
        throw new Error(message);
      }

      const matched = Number(res.headers.get('X-Audit-Export-Matched') || '0');
      const truncated = res.headers.get('X-Audit-Export-Truncated') === 'true';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition?.match(/filename="([^"]+)"/);
      a.download = match?.[1] || `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      return { matched, truncated };
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
    list: (params?: { search?: string; active?: number | 'all'; limit?: number; offset?: number; tenant_id?: string; supplier_id?: string }) => {
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
    create: (data: { name: string; description?: string; tenant_id: string; supplier_id?: string; brand_owner?: string | null; producer?: string | null; plant_code?: string | null }) =>
      fetchApi<{ product: ApiProduct }>('/products', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/products/:id
     * Returns: { product: ApiProduct }
     */
    update: (id: string, data: { name?: string; description?: string; active?: number; supplier_id?: string | null; brand_owner?: string | null; producer?: string | null; plant_code?: string | null }) =>
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
    update: (id: string, data: { name?: string; aliases?: string[]; active?: boolean; lot_scheme?: LotScheme }) =>
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

  /**
   * Teachable COA-product -> order-product bridge (supplier_product_map).
   * The primary write path is the COA approve body (`product_maps`); these
   * helpers cover prefill (get) and editing an existing mapping (put).
   */
  productMap: {
    /**
     * GET /api/product-map?supplier_id=&coa_product=
     * Returns: { mapping | null } (prefill for the bridge control).
     */
    get: (params: { supplier_id: string; coa_product: string }) => {
      const query = new URLSearchParams();
      query.set('supplier_id', params.supplier_id);
      query.set('coa_product', params.coa_product);
      return fetchApi<ProductMapGetResponse>(`/product-map?${query.toString()}`);
    },

    /**
     * PUT /api/product-map
     * Upsert a mapping outside of review. Returns: { mapping }.
     */
    put: (data: {
      supplier_id: string;
      coa_product: string;
      order_product_id: string;
      distributor_sku?: string | null;
      coa_product_id?: string | null;
    }) =>
      fetchApi<ProductMapPutResponse>('/product-map', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  orderProducts: {
    /**
     * GET /api/order-products?search=&limit=
     * Distinct products appearing on order_items for the tenant (the
     * distributor catalog) for the bridge picker. Returns { products }.
     */
    list: (params?: { search?: string; limit?: number; tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set('search', params.search);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<OrderProductListResponse>(`/order-products${qs ? `?${qs}` : ''}`);
    },
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
    create: (data: { name: string; description?: string; tenant_id?: string; supplier_id?: string | null; auto_ingest?: number; extract_tables?: number; renewal_interval_months?: number | null; renewal_policy?: TypeRenewalPolicy }) =>
      fetchApi<{ documentType: ApiDocumentType }>('/document-types', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * PUT /api/document-types/:id
     * Returns: { documentType: ApiDocumentType }
     */
    update: (id: string, data: { name?: string; description?: string; active?: number; supplier_id?: string | null; auto_ingest?: number; extract_tables?: number; renewal_interval_months?: number | null; renewal_policy?: TypeRenewalPolicy }) =>
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

  /**
   * The out-of-spec register (migration 0085) — every judged result, what it
   * was judged against, and who accepted it. Read is any tenant user: this is
   * evidence, not configuration.
   */
  specChecks: {
    /** Defaults to unacknowledged failures, newest first. */
    list: (params?: {
      verdict?: 'out_of_spec' | 'not_checked' | 'in_spec' | 'all';
      acknowledged?: '0' | '1';
      document_id?: string;
      supplier_id?: string;
      spec_test_id?: string;
      since?: string;
      tenant_id?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
      }
      const qs = query.toString();
      return fetchApi<{
        specChecks: ApiSpecCheck[];
        total: number;
        limit: number;
        offset: number;
      }>(`/spec-checks${qs ? `?${qs}` : ''}`);
    },

    /**
     * Acknowledge results. Never changes a verdict — a person can say "I have
     * seen this and here is why it is acceptable", nobody can say "it was fine".
     */
    acknowledge: (ids: string[], note?: string) =>
      fetchApi<{ success: boolean; acknowledged: number }>('/spec-checks', {
        method: 'POST',
        body: JSON.stringify({ ids, note }),
      }),
  },

  /**
   * Analytes a tenant holds acceptance limits for, plus the aliases suppliers
   * print for them (migration 0084). The aliases are the load-bearing field:
   * thresholds are one number, but "Coliform" / "Coliforms (MPN)" / "Total
   * Coliform" are the same test and matching is exact, never fuzzy.
   */
  specTests: {
    /** GET /api/spec-tests — Returns: { specTests } with aliases already parsed. */
    list: (params?: { tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<{ specTests: ApiSpecTest[] }>(`/spec-tests${qs ? `?${qs}` : ''}`);
    },

    create: (data: {
      name: string;
      aliases?: string[];
      default_unit?: string | null;
      notes?: string | null;
      tenant_id?: string;
    }) =>
      fetchApi<{ specTest: ApiSpecTest }>('/spec-tests', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    update: (
      id: string,
      data: { name?: string; aliases?: string[]; default_unit?: string | null; notes?: string | null }
    ) =>
      fetchApi<{ specTest: ApiSpecTest }>(`/spec-tests/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /** DELETE cascades to this analyte's limits; the count comes back. */
    remove: (id: string) =>
      fetchApi<{ success: boolean; limits_removed: number }>(`/spec-tests/${id}`, {
        method: 'DELETE',
      }),
  },

  /**
   * Acceptance limits — OUR thresholds, as opposed to the one the supplier
   * prints on the COA. Scope columns are all optional; most specific wins.
   */
  specLimits: {
    list: (params?: { tenant_id?: string; spec_test_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.spec_test_id) query.set('spec_test_id', params.spec_test_id);
      const qs = query.toString();
      return fetchApi<{ specLimits: ApiSpecLimit[] }>(`/spec-limits${qs ? `?${qs}` : ''}`);
    },

    create: (data: {
      spec_test_id: string;
      operator: string;
      value_min?: number | null;
      value_max?: number | null;
      unit?: string | null;
      supplier_id?: string | null;
      document_type_id?: string | null;
      severity?: string;
      /** Ranking only (migration 0095); omitted means the default tier. */
      criticality?: SpecCriticality;
      notes?: string | null;
      tenant_id?: string;
    }) =>
      fetchApi<{ specLimit: ApiSpecLimit }>('/spec-limits', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    update: (
      id: string,
      data: {
        operator?: string;
        value_min?: number | null;
        value_max?: number | null;
        unit?: string | null;
        supplier_id?: string | null;
        document_type_id?: string | null;
        severity?: string;
        criticality?: SpecCriticality;
        notes?: string | null;
        active?: boolean;
      }
    ) =>
      fetchApi<{ specLimit: ApiSpecLimit }>(`/spec-limits/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    remove: (id: string) =>
      fetchApi<{ success: boolean }>(`/spec-limits/${id}`, { method: 'DELETE' }),
  },

  /**
   * Layer-2 vocabulary — the checklist line items a document CLOSES
   * (migration 0080). Per-tenant rows, never code.
   */
  requirements: {
    /** GET /api/requirements — Returns: { requirements, total, limit, offset } */
    list: (params?: {
      tenant_id?: string;
      active?: number;
      checklist?: string;
      limit?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.active !== undefined) query.set('active', String(params.active));
      if (params?.checklist) query.set('checklist', params.checklist);
      if (params?.limit) query.set('limit', String(params.limit));
      const qs = query.toString();
      return fetchApi<RequirementListResponse>(`/requirements${qs ? `?${qs}` : ''}`);
    },

    /** GET /api/requirements/:id */
    get: (id: string) => fetchApi<RequirementGetResponse>(`/requirements/${id}`),

    /** POST /api/requirements */
    create: (data: {
      name: string;
      slug?: string;
      description?: string;
      checklist?: string;
      sort_order?: number;
      tenant_id?: string;
    }) =>
      fetchApi<{ requirement: ApiRequirement }>('/requirements', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /** PUT /api/requirements/:id */
    update: (
      id: string,
      data: {
        name?: string;
        slug?: string;
        description?: string | null;
        checklist?: string | null;
        sort_order?: number;
        active?: number;
      },
    ) =>
      fetchApi<{ requirement: ApiRequirement }>(`/requirements/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /** DELETE /api/requirements/:id — soft-delete (active = 0) */
    delete: (id: string) => fetchApi<{ success: boolean }>(`/requirements/${id}`, { method: 'DELETE' }),
  },

  /**
   * Applicability — WHICH checklist items apply to WHICH supplier
   * (migration 0087). `requirements` is the vocabulary; this says who owes
   * what. Without a row here a line item applies to nobody and can never be
   * reported as a gap, which is why an unconfigured supplier must read as
   * "nothing set up yet" and never as "nothing outstanding".
   */
  supplierRequirements: {
    /**
     * GET /api/supplier-requirements
     * Returns: { supplierRequirements, total, limit, offset }
     *
     * The server caps `limit` at 500, so a tenant-wide read (no supplier_id)
     * has to page. `listAll` below does that for you.
     */
    list: (params?: {
      supplier_id?: string;
      requirement_id?: string;
      tier?: SupplierRequirementTier;
      tenant_id?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      if (params?.requirement_id) query.set('requirement_id', params.requirement_id);
      if (params?.tier) query.set('tier', params.tier);
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchApi<{
        supplierRequirements: ApiSupplierRequirement[];
        total: number;
        limit: number;
        offset: number;
      }>(`/supplier-requirements${qs ? `?${qs}` : ''}`);
    },

    /**
     * Every applicability row in the tenant, paged out in full.
     *
     * The cross-supplier roster needs the WHOLE set to tell a supplier with no
     * checklist from one it just has not loaded yet — a truncated read would
     * report configured suppliers as unconfigured, which is the one wrong
     * answer this surface must not give.
     */
    listAll: async (params?: { tenant_id?: string }): Promise<ApiSupplierRequirement[]> => {
      const page = 500;
      const rows: ApiSupplierRequirement[] = [];
      for (let offset = 0; ; offset += page) {
        const res = await api.supplierRequirements.list({ ...params, limit: page, offset });
        rows.push(...res.supplierRequirements);
        if (rows.length >= res.total || res.supplierRequirements.length === 0) break;
      }
      return rows;
    },

    /**
     * POST /api/supplier-requirements — attach a requirement to a supplier.
     * Idempotent: re-attaching an existing pair updates its tier in place.
     */
    attach: (data: {
      supplier_id: string;
      requirement_id: string;
      tier?: SupplierRequirementTier;
      notes?: string | null;
      tenant_id?: string;
    }) =>
      fetchApi<{ supplierRequirement: ApiSupplierRequirement }>('/supplier-requirements', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /** PUT /api/supplier-requirements/:id — change tier or notes. */
    update: (id: string, data: { tier?: SupplierRequirementTier; notes?: string | null }) =>
      fetchApi<{ supplierRequirement: ApiSupplierRequirement }>(
        `/supplier-requirements/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),

    /** DELETE /api/supplier-requirements/:id — detach. Hard delete, no tombstone. */
    detach: (id: string) =>
      fetchApi<{ success: boolean }>(`/supplier-requirements/${id}`, { method: 'DELETE' }),
  },

  /**
   * Layer-3 vocabulary — the claims a document ASSERTS (migration 0080).
   * A claim opens requirements; what it opens is configured via api.claimRules.
   */
  claimTypes: {
    /** GET /api/claim-types — Returns: { claimTypes, total, limit, offset } */
    list: (params?: { tenant_id?: string; active?: number; limit?: number }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.active !== undefined) query.set('active', String(params.active));
      if (params?.limit) query.set('limit', String(params.limit));
      const qs = query.toString();
      return fetchApi<ClaimTypeListResponse>(`/claim-types${qs ? `?${qs}` : ''}`);
    },

    /** GET /api/claim-types/:id — Returns: { claimType, rules } */
    get: (id: string) => fetchApi<ClaimTypeGetResponse>(`/claim-types/${id}`),

    /** POST /api/claim-types */
    create: (data: {
      name: string;
      slug?: string;
      description?: string;
      subject_grain?: ClaimSubjectGrain;
      sort_order?: number;
      tenant_id?: string;
    }) =>
      fetchApi<{ claimType: ApiClaimType }>('/claim-types', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /** PUT /api/claim-types/:id */
    update: (
      id: string,
      data: {
        name?: string;
        slug?: string;
        description?: string | null;
        subject_grain?: ClaimSubjectGrain;
        sort_order?: number;
        active?: number;
      },
    ) =>
      fetchApi<{ claimType: ApiClaimType }>(`/claim-types/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /** DELETE /api/claim-types/:id — soft-delete (active = 0) */
    delete: (id: string) => fetchApi<{ success: boolean }>(`/claim-types/${id}`, { method: 'DELETE' }),
  },

  /**
   * The claim -> requirement mapping ("conditional triggers"): claiming
   * Organic requires an Organic Certificate. Entered once per claim.
   */
  claimRules: {
    /** GET /api/claim-rules[?claim_type_id=] — Returns: { rules } */
    list: (params?: { claim_type_id?: string; tenant_id?: string }) => {
      const query = new URLSearchParams();
      if (params?.claim_type_id) query.set('claim_type_id', params.claim_type_id);
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      const qs = query.toString();
      return fetchApi<ClaimRuleListResponse>(`/claim-rules${qs ? `?${qs}` : ''}`);
    },

    /**
     * PUT /api/claim-rules — replace the whole requirement set for one claim.
     * An empty array clears the rule. Returns: { rules }.
     */
    save: (data: {
      claim_type_id: string;
      requirements: Array<string | { requirement_id: string; is_required?: number; notes?: string | null }>;
    }) =>
      fetchApi<ClaimRuleListResponse>('/claim-rules', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
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

  expirations: {
    /**
     * GET /api/expirations
     * Renewal dashboard feed: active registry docs with a resolvable
     * next-action date, classified into a renewal_type-aware status.
     */
    list: (params?: {
      tenantId?: string;
      windowDays?: number;
      asOf?: string;
    }): Promise<ExpirationListResponse> => {
      const query = new URLSearchParams();
      if (params?.tenantId) query.set('tenant_id', params.tenantId);
      if (params?.windowDays !== undefined) query.set('window_days', String(params.windowDays));
      if (params?.asOf) query.set('as_of', params.asOf);
      const qs = query.toString();
      return fetchApi<ExpirationListResponse>(`/expirations${qs ? `?${qs}` : ''}`);
    },

    /**
     * POST /api/expirations/notify
     *
     * Sends the renewal digest NOW, grouped by the record's owner: one email
     * per owner label containing only that owner's records, addressed only to
     * the people that label resolves to via /api/owner-routes.
     *
     * It no longer blasts every org_admin plus every super_admin. Records with
     * no resolvable owner come back in `unrouted` and get a separate
     * routing-GAP notice instead of being quietly re-broadcast - check that
     * block, it is the part that says who was NOT told.
     *
     * The manual path ignores the 7-day re-alert cooldown (a human asking now
     * gets everything now) but still stamps it, so this does not double up
     * with the scheduled daily run.
     */
    notify: (params?: {
      tenantId?: string;
      windowDays?: number;
      asOf?: string;
    }): Promise<ExpirationNotifyResponse> => {
      return fetchApi<ExpirationNotifyResponse>(`/expirations/notify`, {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: params?.tenantId,
          window_days: params?.windowDays,
          as_of: params?.asOf,
        }),
      });
    },
  },

  /**
   * Owner routes - map a free-text `documents.owner` label ('QA',
   * 'Insurance', ...) to the people who should receive its renewal alerts.
   * Without a route, records carrying that label are UNROUTED and nobody is
   * alerted about them. See migration 0091.
   */
  ownerRoutes: {
    /** GET /api/owner-routes[?owner=QA] */
    list: (params?: { tenantId?: string; owner?: string }): Promise<OwnerRouteListResponse> => {
      const query = new URLSearchParams();
      if (params?.tenantId) query.set('tenant_id', params.tenantId);
      if (params?.owner) query.set('owner', params.owner);
      const qs = query.toString();
      return fetchApi<OwnerRouteListResponse>(`/owner-routes${qs ? `?${qs}` : ''}`);
    },

    /**
     * POST /api/owner-routes
     * Exactly one of userId / email. A bare email is the supported case for an
     * owner with no portal account (a broker, a site manager).
     */
    create: (params: {
      ownerLabel: string;
      userId?: string;
      email?: string;
      tenantId?: string;
    }): Promise<{ route: OwnerRoute }> => {
      return fetchApi<{ route: OwnerRoute }>(`/owner-routes`, {
        method: 'POST',
        body: JSON.stringify({
          owner_label: params.ownerLabel,
          user_id: params.userId,
          email: params.email,
          tenant_id: params.tenantId,
        }),
      });
    },

    /** DELETE /api/owner-routes/:id */
    remove: (id: string): Promise<{ success: boolean }> =>
      fetchApi<{ success: boolean }>(`/owner-routes/${id}`, { method: 'DELETE' }),
  },

  /**
   * The first-run setup wizard (migration 0101).
   *
   * The run row is a POSITION, not a staging area — every screen writes its
   * real configuration through the endpoint that owns it (the pack through
   * `starterPacks.apply`, the departments through `ownerRoutes.create`), and
   * this only records which screen somebody was on. So a failed autosave costs
   * a re-click and never a setting.
   */
  tenantSetup: {
    /**
     * GET /api/tenant-setup[?tenant_id=]
     *
     * `needed` is true only when the tenant has NO completed run AND zero
     * active documents. `reason` says which of the two disqualified it, so a
     * banner can explain itself instead of silently not rendering.
     */
    get: (params?: { tenantId?: string }): Promise<TenantSetupResponse> => {
      const query = new URLSearchParams();
      if (params?.tenantId) query.set('tenant_id', params.tenantId);
      const qs = query.toString();
      return fetchApi<TenantSetupResponse>(`/tenant-setup${qs ? `?${qs}` : ''}`);
    },

    /**
     * POST /api/tenant-setup — returns the EXISTING draft when there is one, so
     * a second tab resumes rather than forking. `restart` abandons the draft
     * and opens a fresh run; it does not un-seed anything already written.
     */
    start: (params?: {
      tenantId?: string;
      restart?: boolean;
      pack?: string;
    }): Promise<TenantSetupRunResponse> =>
      fetchApi<TenantSetupRunResponse>('/tenant-setup', {
        method: 'POST',
        body: JSON.stringify({
          tenant_id: params?.tenantId,
          restart: params?.restart,
          pack: params?.pack,
        }),
      }),

    /** PATCH /api/tenant-setup/:id — the debounced autosave target. */
    update: (
      id: string,
      data: {
        current_step?: number;
        state?: Record<string, unknown>;
        status?: TenantSetupStatus;
        pack?: string | null;
      },
    ): Promise<TenantSetupRunResponse> =>
      fetchApi<TenantSetupRunResponse>(`/tenant-setup/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  /**
   * Starter packs — the registry vocabulary a fresh tenant begins life with.
   *
   * The catalog carries the packs' own counts and three real example rows each,
   * never a marketing blurb: `functions/api/starter-packs/index.ts` builds every
   * number out of the pack JSON.
   */
  starterPacks: {
    /** GET /api/starter-packs */
    list: (): Promise<StarterPackCatalogResponse> =>
      fetchApi<StarterPackCatalogResponse>('/starter-packs'),

    /**
     * POST /api/starter-packs/apply — the same seeding `bin/create-tenant
     * --pack` performs, from inside the portal. Every write is INSERT OR IGNORE
     * on a deterministic id, so re-running adds what is missing and overwrites
     * nothing.
     */
    apply: (params: {
      pack: string;
      tenantId?: string;
      runId?: string;
    }): Promise<ApplyStarterPackResponse> =>
      fetchApi<ApplyStarterPackResponse>('/starter-packs/apply', {
        method: 'POST',
        body: JSON.stringify({
          pack: params.pack,
          tenant_id: params.tenantId,
          run_id: params.runId,
        }),
      }),

    /**
     * POST /api/starter-packs/apply-packet — ONE packet, ONE named supplier.
     *
     * Note what this signature CANNOT express: there is no "every supplier"
     * form, here or on the server. Bulk-writing the same checklist across every
     * supplier is what made the live tenant's gap report uniform-and-wrong, and
     * the endpoint is shaped so a convenience button cannot be built on it.
     *
     * `supplierName` resolves through the same lookup-or-create the approve path
     * uses, so the supplier a just-read document names attaches to an existing
     * row when the spelling matches one.
     */
    applyPacket: (params: {
      pack: string;
      packet: string;
      supplierId?: string;
      supplierName?: string;
      tenantId?: string;
      runId?: string;
    }): Promise<ApplyRequirementPacketResponse> =>
      fetchApi<ApplyRequirementPacketResponse>('/starter-packs/apply-packet', {
        method: 'POST',
        body: JSON.stringify({
          pack: params.pack,
          packet: params.packet,
          supplier_id: params.supplierId,
          supplier_name: params.supplierName,
          tenant_id: params.tenantId,
          run_id: params.runId,
        }),
      }),
  },

  /**
   * The read side of migration 0100 — which checklist items a document of this
   * TYPE is normally proposed to close.
   *
   * Exists so a screen can state the consequence of an approval BEFORE anybody
   * approves: `functions/lib/requirement-defaults.ts` only writes the links once
   * a `documents` row exists, so anything that needs the number earlier has to
   * read the mapping itself rather than guess at it.
   */
  documentTypeRequirements: {
    /** GET /api/document-type-requirements?document_type_id= */
    list: (params: { documentTypeId: string }): Promise<DocumentTypeRequirementsResponse> =>
      fetchApi<DocumentTypeRequirementsResponse>(
        `/document-type-requirements?document_type_id=${encodeURIComponent(params.documentTypeId)}`,
      ),

    /**
     * PUT /api/document-type-requirements — REPLACE the mapping for one type.
     *
     * `requirementIds` is the whole set: anything not in it is deleted. The
     * signature says `replace` rather than `update` for that reason — a caller
     * that thinks it is patching would quietly unmap everything it did not
     * bother to send.
     *
     * There is no batch form here or on the server, and there must not be one:
     * a call that could map every type at once is the bulk data entry the
     * wizard's teaching screen exists to replace.
     */
    replace: (params: {
      documentTypeId: string;
      requirementIds: string[];
      source?: 'wizard' | 'human';
    }): Promise<ReplaceDocumentTypeRequirementsResponse> =>
      fetchApi<ReplaceDocumentTypeRequirementsResponse>('/document-type-requirements', {
        method: 'PUT',
        body: JSON.stringify({
          document_type_id: params.documentTypeId,
          requirement_ids: params.requirementIds,
          source: params.source,
        } satisfies ReplaceDocumentTypeRequirementsRequest),
      }),
  },

  /**
   * Modules (migration 0099) — which parts of the portal a tenant uses, and
   * which of those each department is expected to work in.
   *
   * Three endpoints, three different questions, deliberately not merged:
   *   - `list`/`update` answer about the ORGANIZATION and are admin-only.
   *   - `visibility` answers about its DEPARTMENTS, also admin-only.
   *   - `access` answers about the CALLER, and is open to every role because
   *     the caller is the nav bar. See functions/api/module-access/index.ts.
   */
  modules: {
    /** GET /api/modules — the full vocabulary, each entry carrying its resolved state. */
    list: (params?: { tenantId?: string }): Promise<ModuleListResponse> => {
      const qs = new URLSearchParams();
      if (params?.tenantId) qs.set('tenant_id', params.tenantId);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return fetchApi<ModuleListResponse>(`/modules${suffix}`);
    },

    /** PUT /api/modules/:key — switch one module on or off for one tenant. */
    update: (key: ModuleKey, body: UpdateModuleRequest): Promise<ModuleUpdateResponse> =>
      fetchApi<ModuleUpdateResponse>(`/modules/${key}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    /** GET /api/module-visibility — the function x module grid, plus the ceiling. */
    visibility: (params?: { tenantId?: string }): Promise<ModuleVisibilityResponse> => {
      const qs = new URLSearchParams();
      if (params?.tenantId) qs.set('tenant_id', params.tenantId);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return fetchApi<ModuleVisibilityResponse>(`/module-visibility${suffix}`);
    },

    /**
     * PUT /api/module-visibility/:ownerKey
     *
     * `{ constrained: false }` deletes every row for the function — absence
     * means unconstrained. `{ constrained: true, modules: [] }` is a 400 by
     * design: "sees nothing" is a deactivated account, not a role. The UI is
     * responsible for never sending it; see `src/pages/admin/Modules.tsx`.
     */
    setVisibility: (
      ownerKey: string,
      body: UpdateModuleVisibilityRequest,
    ): Promise<ModuleVisibilityUpdateResponse> =>
      fetchApi<ModuleVisibilityUpdateResponse>(
        `/module-visibility/${encodeURIComponent(ownerKey)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      ),

    /**
     * GET /api/module-access — what the signed-in user may see.
     *
     * Never cached client-side: a stale answer would keep showing a surface
     * the tenant has since switched off, and the whole point of not putting
     * this in the JWT is that a toggle takes effect on the next page load
     * rather than in 24 hours.
     */
    access: (): Promise<ModuleAccessResponse> => fetchApi<ModuleAccessResponse>('/module-access'),
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
       * approve.
       *
       * For records-shaped COA items (Option B / sublot split) this is the
       * human-edited `CoaRecordsPayload`; the backend auto-dispatches to
       * produceCoaRecords when this parses as one. See CoaRecordsReviewTile.
       */
      records?:
        | {
            customers?: ParsedCustomer[];
            orders?: ParsedOrder[];
            shipments?: ParsedShipment[];
          }
        | CoaRecordsPayload;
      /**
       * COA partial approval (Option B): per-record decision keyed by
       * `record_index` (as a string). An absent index defaults to 'approve'.
       * If ANY record is 'hold', the queue item stays pending; all-approve
       * flips it to approved.
       */
      record_decisions?: Record<string, CoaRecordDecision>;
      /**
       * COA teach-at-review product bridge: per-approved-record COA-product ->
       * order-product mapping, keyed by `record_index` (as a string). The server
       * writes each entry to supplier_product_map AFTER it resolves/creates the
       * supplier_id (the primary write path for the bridge). Only entries for
       * `approve`-decision records are honored.
       */
      product_maps?: Record<string, {
        coa_product: string;
        order_product_id: string;
        distributor_sku?: string | null;
        coa_product_id?: string | null;
      }>;
      /**
       * The renewal date the reviewer confirmed (migration 0097). SEND IT
       * WHENEVER THE RENEWAL FIELD WAS SHOWN, including when it is empty:
       * `{ due_date: null }` is the answer "this document does not renew", and
       * omitting the key entirely means "nobody answered", which the server
       * records as no decision at all rather than as a decision to skip.
       */
      renewal?: RenewalDecisionPayload;
    }) =>
      fetchApi<{ document?: any; documents?: any[]; summary?: string; item?: any }>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'approved', ...data }) }),
    /**
     * Reject a queue item. `reason` is a small closed enum (see
     * REJECTION_REASONS) and should always be supplied — a rejection without a
     * reason is a bare fact that no post-mortem can use. `note` is optional
     * free text. Rejecting no longer deletes the source file from R2.
     */
    reject: (id: string, data?: { rejection_reason?: RejectionReason; rejection_note?: string }) =>
      fetchApi<{ item: { id: string; status: 'rejected'; rejection_reason: RejectionReason | null } }>(
        `/queue/${id}`,
        { method: 'PUT', body: JSON.stringify({ status: 'rejected', ...(data || {}) }) }
      ),
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
   * Per-DOCUMENT-TYPE extraction instructions (migration 0098) — the middle
   * layer of the prompt stack, between the tenant's industry context and the
   * (supplier, document_type) guidance above.
   *
   * Written once per type and applied to every supplier that sends that kind of
   * document, including one nobody has configured yet. The supplier layer
   * REFINES this; it does not replace it.
   */
  documentTypeInstructions: {
    /** One type, with the suppliers that refine it. */
    get: (params: { document_type_id: string; tenant_id?: string }) => {
      const qs = new URLSearchParams({ document_type_id: params.document_type_id });
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      return fetchApi<DocumentTypeExtractionInstructionsGetResponse>(
        `/document-type-instructions?${qs.toString()}`,
      );
    },
    /** Every active type in the tenant, authored or not, in one round trip. */
    list: (params?: { tenant_id?: string }) => {
      const qs = new URLSearchParams();
      if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return fetchApi<DocumentTypeExtractionInstructionsListResponse>(
        `/document-type-instructions${suffix}`,
      );
    },
    put: (data: { document_type_id: string; instructions: string; tenant_id?: string }) =>
      fetchApi<DocumentTypeExtractionInstructionsPutResponse>('/document-type-instructions', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    /** Removes the layer outright. PUTting '' only blanks it. */
    remove: (params: { document_type_id: string; tenant_id?: string }) => {
      const qs = new URLSearchParams({ document_type_id: params.document_type_id });
      if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
      return fetchApi<{ deleted: boolean }>(
        `/document-type-instructions?${qs.toString()}`,
        { method: 'DELETE' },
      );
    },
  },

  /**
   * Per-tenant unit equivalence for spec checking (migration 0093).
   *
   * `volume_mass_equivalent` lets CFU/mL be judged against a CFU/g limit (and
   * MPN/mL against MPN/g) as the same number. OFF by default; it is a QA
   * judgement about the tenant's product range, not a technical toggle, and
   * every verdict it makes reachable says so in its own reason text.
   */
  specUnitPolicy: {
    get: (params?: { tenant_id?: string }) => {
      const qs = new URLSearchParams();
      if (params?.tenant_id) qs.set('tenant_id', params.tenant_id);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return fetchApi<{
        volume_mass_equivalent: boolean;
        updated_at: string | null;
        updated_by: string | null;
      }>(`/spec-unit-policy${suffix}`);
    },
    put: (body: { volume_mass_equivalent: boolean; tenant_id?: string }) =>
      fetchApi<{
        volume_mass_equivalent: boolean;
        updated_at: string | null;
        updated_by: string | null;
      }>('/spec-unit-policy', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
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
    /** GET /api/teach/sessions — past (non-active) sessions for a (supplier, doctype) pair. */
    listSessions: (data: { supplier_id: string; document_type_id: string; tenant_id?: string }) => {
      const params = new URLSearchParams({
        supplier_id: data.supplier_id,
        document_type_id: data.document_type_id,
      });
      if (data.tenant_id) params.set('tenant_id', data.tenant_id);
      return fetchApi<TeachSessionListResponse>(`/teach/sessions?${params.toString()}`);
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

  /**
   * In-system notes on any record (migration 0088). ONE client for every
   * parent type — suppliers and documents today, requirement lines next —
   * because the note itself has no per-parent shape.
   *
   * Deliberately incomplete: there is no `update`. Notes are append-only; a
   * correction is a new note. See migrations/0088_entity_notes.sql.
   */
  notes: {
    /**
     * GET /api/notes?entity_type=&entity_id= — newest first.
     * Both params are required; this reads the thread ON one record.
     * `include_deleted` is honoured for org_admin/super_admin only.
     * Returns: { notes, total, limit, offset }
     */
    list: (params: {
      entity_type: NoteEntityType;
      entity_id: string;
      include_deleted?: boolean;
      tenant_id?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams({
        entity_type: params.entity_type,
        entity_id: params.entity_id,
      });
      if (params.include_deleted) query.set('include_deleted', '1');
      if (params.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.offset) query.set('offset', String(params.offset));
      return fetchApi<NoteListResponse>(`/notes?${query.toString()}`);
    },

    /** GET /api/notes/:id */
    get: (id: string) => fetchApi<NoteGetResponse>(`/notes/${id}`),

    /**
     * POST /api/notes — post a note. Not idempotent: two identical posts are
     * two notes, because two things were said.
     */
    create: (data: {
      entity_type: NoteEntityType;
      entity_id: string;
      body: string;
      tenant_id?: string;
    }) =>
      fetchApi<{ note: EntityNote }>('/notes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/notes/:id — RETRACT, not erase. The row is kept and stamped
     * with who withdrew it; it stops appearing in the default read. Author or
     * admin only.
     */
    retract: (id: string) =>
      fetchApi<{ success: boolean }>(`/notes/${id}`, { method: 'DELETE' }),
  },

  /**
   * The gap report — what a supplier owes and has not sent (migration 0087 +
   * shared/requirementGap.ts).
   *
   * Read-only, and the composer's SEED: composing an ask for a supplier who
   * already has open items should offer those rather than making a QA manager
   * re-pick from the whole checklist. One request, server-computed; there is
   * no client-side join here and there must not be one.
   */
  supplierGaps: {
    /** GET /api/supplier-gaps — one supplier's, or the whole tenant's. */
    list: (params?: {
      supplier_id?: string;
      tenant_id?: string;
      include_recommended?: boolean;
      status?: 'open' | 'satisfied' | 'not_configured';
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.include_recommended) query.set('include_recommended', '1');
      if (params?.status) query.set('status', params.status);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchApi<SupplierGapListResponse>(`/supplier-gaps${qs ? `?${qs}` : ''}`);
    },
  },

  /**
   * The request composer (migration 0090) — how a person ASKS a supplier for
   * the documents the registry says are missing.
   *
   * The transitions are NOT interchangeable and this client does not let them
   * look it:
   *
   *   update   edits a DRAFT in place. Refused after issue (409).
   *   amend    supersedes an ISSUED version with a new one on the same root.
   *            The original survives untouched; a reason is mandatory.
   *   reissue  starts a NEW ask at version 1, keeping only provenance. This is
   *            a renewal, not a correction, and it lands as a draft.
   *
   * `compose` always produces a draft, whatever the origin — issuing is one
   * separate, deliberate act by a human.
   */
  documentRequests: {
    /**
     * GET /api/document-requests
     *
     * Superseded versions are excluded by default: a list that mixed a live
     * version with the one it replaced would double-count what is outstanding.
     */
    list: (params?: {
      supplier_id?: string;
      status?: DocumentRequestStatus;
      assigned_to?: string;
      include_superseded?: boolean;
      tenant_id?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.supplier_id) query.set('supplier_id', params.supplier_id);
      if (params?.status) query.set('status', params.status);
      if (params?.assigned_to) query.set('assigned_to', params.assigned_to);
      if (params?.include_superseded) query.set('include_superseded', '1');
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.offset !== undefined) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchApi<DocumentRequestListResponse>(
        `/document-requests${qs ? `?${qs}` : ''}`,
      );
    },

    /** GET /api/document-requests/:id — request + lines + closure + routing + history. */
    get: (id: string) => fetchApi<DocumentRequestResponse>(`/document-requests/${id}`),

    /** POST /api/document-requests — compose a DRAFT. Never issues. */
    compose: (data: CreateDocumentRequestRequest) =>
      fetchApi<DocumentRequestResponse>('/document-requests', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /** PUT /api/document-requests/:id — header fields of a DRAFT only. */
    update: (
      id: string,
      data: {
        title?: string;
        intro?: string | null;
        due_date?: string | null;
        assigned_to?: string | null;
      },
    ) =>
      fetchApi<DocumentRequestResponse>(`/document-requests/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /**
     * DELETE /api/document-requests/:id — hard-deletes a draft, soft-cancels an
     * issued ask. `deleted` says which happened.
     */
    cancel: (id: string) =>
      fetchApi<{ success: boolean; deleted: boolean }>(`/document-requests/${id}`, {
        method: 'DELETE',
      }),

    /** POST /api/document-requests/:id/issue — the one issue path. */
    issue: (id: string, data: IssueDocumentRequestRequest = {}) =>
      fetchApi<DocumentRequestResponse>(`/document-requests/${id}/issue`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * POST /api/document-requests/:id/amend — a NEW version of the SAME ask.
     * Returns the new version; `supersedes_id` is the one it replaced.
     */
    amend: (id: string, data: AmendDocumentRequestRequest) =>
      fetchApi<DocumentRequestResponse & { supersedes_id: string }>(
        `/document-requests/${id}/amend`,
        { method: 'POST', body: JSON.stringify(data) },
      ),

    /**
     * POST /api/document-requests/:id/reissue — a NEW ask modelled on this one.
     * Lands as a draft at version 1 with line progress reset.
     */
    reissue: (id: string, data: ReissueDocumentRequestRequest = {}) =>
      fetchApi<DocumentRequestResponse & { reissue_of_request_id: string }>(
        `/document-requests/${id}/reissue`,
        { method: 'POST', body: JSON.stringify(data) },
      ),

    /** GET /api/document-requests/:id/lines */
    lines: (id: string) =>
      fetchApi<{ lines: RequestLineWithClosure[]; counts: DocumentRequestLineCounts }>(
        `/document-requests/${id}/lines`,
      ),

    /** POST /api/document-requests/:id/lines — draft only. */
    addLines: (id: string, lines: RequestLineInput[]) =>
      fetchApi<{ lines: RequestLineRow[]; counts: DocumentRequestLineCounts }>(
        `/document-requests/${id}/lines`,
        { method: 'POST', body: JSON.stringify({ lines }) },
      ),

    /**
     * GET /api/document-requests/:id/external — EXACTLY what the supplier sees.
     *
     * The server builds this from an allow-list, so this is the only honest way
     * to preview an ask before it goes out. 409 for anything not currently
     * issued.
     */
    external: (id: string) =>
      fetchApi<{ view: SupplierRequestView }>(`/document-requests/${id}/external`),

    /**
     * GET /api/document-requests/:id/link — the URL to send the supplier.
     *
     * `null` is an ordinary answer, not an error: a draft has no door yet, and
     * a link can expire or be revoked out from under an issued ask.
     */
    link: (id: string) =>
      fetchApi<{ link: RequestLinkView | null }>(`/document-requests/${id}/link`),

    /**
     * POST /api/document-requests/:id/link — ROTATES.
     *
     * The server revokes the live link before minting the replacement, so any
     * URL already in a supplier's inbox is dead the moment this returns. Only
     * call it behind a confirmation that says so.
     */
    rotateLink: (id: string) =>
      fetchApi<{ link: { url: string } }>(`/document-requests/${id}/link`, {
        method: 'POST',
      }),
  },

  /**
   * One line on a request.
   *
   * Two different permissions live behind one endpoint, and the split matters:
   * moving `status` is the assigned buyer working the queue (role `user` and
   * up), while changing WHAT was asked for is composing and is refused once the
   * request is issued — that is an amendment.
   */
  requestLines: {
    /** GET /api/request-lines/:id */
    get: (id: string) => fetchApi<{ line: RequestLineRow }>(`/request-lines/${id}`),

    /** PUT /api/request-lines/:id */
    update: (id: string, data: UpdateRequestLineRequest) =>
      fetchApi<{ line: RequestLineRow }>(`/request-lines/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /** DELETE /api/request-lines/:id — draft only. */
    remove: (id: string) =>
      fetchApi<{ success: boolean }>(`/request-lines/${id}`, { method: 'DELETE' }),
  },

  /**
   * Saved, re-issuable composed sets.
   *
   * A template holds only what a template can mean — lines, wording, tiers. It
   * has no supplier, no status and no version chain, which is why instantiating
   * one produces an ordinary draft that then travels the one issue path.
   */
  requestTemplates: {
    /** GET /api/request-templates */
    list: (params?: { tenant_id?: string; include_inactive?: boolean }) => {
      const query = new URLSearchParams();
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.include_inactive) query.set('include_inactive', '1');
      const qs = query.toString();
      return fetchApi<RequestTemplateListResponse>(
        `/request-templates${qs ? `?${qs}` : ''}`,
      );
    },

    /** GET /api/request-templates/:id */
    get: (id: string) => fetchApi<RequestTemplateResponse>(`/request-templates/${id}`),

    /**
     * POST /api/request-templates — from explicit lines, or by snapshotting an
     * existing request with `from_request_id`.
     */
    create: (data: CreateRequestTemplateRequest) =>
      fetchApi<RequestTemplateResponse>('/request-templates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /** PUT /api/request-templates/:id — `lines` REPLACES the set wholesale. */
    update: (
      id: string,
      data: {
        name?: string;
        description?: string | null;
        default_due_in_days?: number | null;
        active?: number | boolean;
        lines?: RequestLineInput[];
      },
    ) =>
      fetchApi<RequestTemplateResponse>(`/request-templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    /** DELETE /api/request-templates/:id — retires it (active = 0). */
    retire: (id: string) =>
      fetchApi<{ success: boolean }>(`/request-templates/${id}`, { method: 'DELETE' }),

    /** POST /api/request-templates/:id/instantiate — compose a draft from it. */
    instantiate: (id: string, data: InstantiateRequestTemplateRequest) =>
      fetchApi<DocumentRequestResponse>(`/request-templates/${id}/instantiate`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
};
