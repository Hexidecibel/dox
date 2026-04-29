/**
 * Records module API client. Thin wrapper over fetch that mirrors the
 * REST endpoints under /api/records. The same auth-token / error handling
 * conventions as `src/lib/api.ts` are used so callers don't have to think
 * about it. We deliberately don't share the `fetchApi` helper from api.ts
 * (yet) to keep the Records surface decoupled while it's iterating fast.
 */
import { AUTH_TOKEN_KEY } from './types';
import type {
  ApiRecordSheet,
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordRowAttachment,
  ApiRecordView,
  CreateSheetRequest,
  UpdateSheetRequest,
  CreateColumnRequest,
  UpdateColumnRequest,
  CreateRowRequest,
  UpdateRowRequest,
  RecordRowData,
  RecordSheetListResponse,
  RecordSheetGetResponse,
  RecordSheetCreateResponse,
  RecordSheetUpdateResponse,
  RecordColumnListResponse,
  RecordColumnCreateResponse,
  RecordColumnUpdateResponse,
  RecordRowListResponse,
  RecordRowGetResponse,
  RecordRowCreateResponse,
  RecordRowUpdateResponse,
  RecordViewListResponse,
  RecordActivityListResponse,
  CreateFormRequest,
  UpdateFormRequest,
  RecordFormListResponse,
  RecordFormGetResponse,
  RecordFormCreateResponse,
  RecordFormUpdateResponse,
  RecordFormSubmissionListResponse,
  PublicAttachmentUpload,
  PublicFormView,
  PublicFormSubmitRequest,
  PublicFormSubmitResponse,
  CreateUpdateRequestRequest,
  RecordUpdateRequestCreateResponse,
  RecordUpdateRequestListResponse,
  PublicUpdateRequestView,
  PublicUpdateRequestSubmitRequest,
  PublicUpdateRequestSubmitResponse,
} from '../../shared/types';

const API_BASE = '/api';

async function fetchRecords<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };
  if (!(options?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (!res.ok) {
    if (res.status === 401) {
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
      message = (await res.text()) || res.statusText;
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface CellPatchResponse {
  cell: {
    row_id: string;
    column_key: string;
    value: unknown;
  };
  seq: number | null;
}

export const recordsApi = {
  sheets: {
    /** GET /api/records/sheets */
    list(params?: { archived?: boolean; tenant_id?: string; limit?: number; offset?: number }): Promise<RecordSheetListResponse> {
      const query = new URLSearchParams();
      if (params?.archived) query.set('archived', '1');
      if (params?.tenant_id) query.set('tenant_id', params.tenant_id);
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchRecords<RecordSheetListResponse>(`/records/sheets${qs ? `?${qs}` : ''}`);
    },

    /** GET /api/records/sheets/:id — sheet + columns + views in one round trip. */
    get(id: string): Promise<RecordSheetGetResponse> {
      return fetchRecords<RecordSheetGetResponse>(`/records/sheets/${id}`);
    },

    /** POST /api/records/sheets */
    create(data: CreateSheetRequest & { tenant_id?: string }): Promise<RecordSheetCreateResponse> {
      return fetchRecords<RecordSheetCreateResponse>('/records/sheets', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** PUT /api/records/sheets/:id — also used for archive (archived: true). */
    update(id: string, data: UpdateSheetRequest): Promise<RecordSheetUpdateResponse> {
      return fetchRecords<RecordSheetUpdateResponse>(`/records/sheets/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** DELETE /api/records/sheets/:id — soft-archive. */
    archive(id: string): Promise<{ success: true }> {
      return fetchRecords<{ success: true }>(`/records/sheets/${id}`, { method: 'DELETE' });
    },
  },

  columns: {
    /** GET /api/records/sheets/:sheetId/columns */
    list(sheetId: string, params?: { archived?: boolean }): Promise<RecordColumnListResponse> {
      const qs = params?.archived ? '?archived=1' : '';
      return fetchRecords<RecordColumnListResponse>(`/records/sheets/${sheetId}/columns${qs}`);
    },

    /** POST /api/records/sheets/:sheetId/columns */
    create(sheetId: string, data: CreateColumnRequest): Promise<RecordColumnCreateResponse> {
      return fetchRecords<RecordColumnCreateResponse>(`/records/sheets/${sheetId}/columns`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** PUT /api/records/sheets/:sheetId/columns/:columnId */
    update(sheetId: string, columnId: string, data: UpdateColumnRequest): Promise<RecordColumnUpdateResponse> {
      return fetchRecords<RecordColumnUpdateResponse>(`/records/sheets/${sheetId}/columns/${columnId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** DELETE /api/records/sheets/:sheetId/columns/:columnId */
    archive(sheetId: string, columnId: string): Promise<{ success: true }> {
      return fetchRecords<{ success: true }>(`/records/sheets/${sheetId}/columns/${columnId}`, {
        method: 'DELETE',
      });
    },
  },

  rows: {
    /** GET /api/records/sheets/:sheetId/rows */
    list(sheetId: string, params?: { limit?: number; offset?: number; parent_row_id?: string; archived?: boolean }): Promise<RecordRowListResponse> {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      if (params?.parent_row_id) query.set('parent_row_id', params.parent_row_id);
      if (params?.archived) query.set('archived', '1');
      const qs = query.toString();
      return fetchRecords<RecordRowListResponse>(`/records/sheets/${sheetId}/rows${qs ? `?${qs}` : ''}`);
    },

    /** GET /api/records/sheets/:sheetId/rows/:rowId */
    get(sheetId: string, rowId: string): Promise<RecordRowGetResponse> {
      return fetchRecords<RecordRowGetResponse>(`/records/sheets/${sheetId}/rows/${rowId}`);
    },

    /** POST /api/records/sheets/:sheetId/rows */
    create(sheetId: string, data: CreateRowRequest = {}): Promise<RecordRowCreateResponse> {
      return fetchRecords<RecordRowCreateResponse>(`/records/sheets/${sheetId}/rows`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** PUT /api/records/sheets/:sheetId/rows/:rowId — full replace. */
    update(sheetId: string, rowId: string, data: UpdateRowRequest): Promise<RecordRowUpdateResponse> {
      return fetchRecords<RecordRowUpdateResponse>(`/records/sheets/${sheetId}/rows/${rowId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** DELETE /api/records/sheets/:sheetId/rows/:rowId — soft-archive. */
    archive(sheetId: string, rowId: string): Promise<{ success: true }> {
      return fetchRecords<{ success: true }>(`/records/sheets/${sheetId}/rows/${rowId}`, { method: 'DELETE' });
    },

    /**
     * PATCH /api/records/sheets/:sheetId/rows/:rowId/cell — single-cell
     * write that broadcasts to the SheetSession DO on success.
     */
    patchCell(
      sheetId: string,
      rowId: string,
      columnKey: string,
      value: unknown,
      clientSeq?: number,
    ): Promise<CellPatchResponse> {
      return fetchRecords<CellPatchResponse>(`/records/sheets/${sheetId}/rows/${rowId}/cell`, {
        method: 'PATCH',
        body: JSON.stringify({ column_key: columnKey, value, clientSeq }),
      });
    },

    /** GET /api/records/sheets/:sheetId/rows/:rowId/activity */
    activity(sheetId: string, rowId: string, params?: { limit?: number; offset?: number }): Promise<RecordActivityListResponse> {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchRecords<RecordActivityListResponse>(`/records/sheets/${sheetId}/rows/${rowId}/activity${qs ? `?${qs}` : ''}`);
    },

    /** GET /api/records/sheets/:sheetId/rows/:rowId/attachments — drawer attachments. */
    attachments(sheetId: string, rowId: string): Promise<{ attachments: ApiRecordRowAttachment[] }> {
      return fetchRecords<{ attachments: ApiRecordRowAttachment[] }>(
        `/records/sheets/${sheetId}/rows/${rowId}/attachments`,
      );
    },
  },

  attachments: {
    /** Authenticated download URL for an attachment (used as <img src> / <a href>). */
    downloadUrl(attachmentId: string, opts?: { preview?: boolean }): string {
      const qs = opts?.preview ? '?preview=true' : '';
      return `${API_BASE}/records/attachments/${encodeURIComponent(attachmentId)}/download${qs}`;
    },
  },

  views: {
    /** GET /api/records/sheets/:sheetId/views */
    list(sheetId: string): Promise<RecordViewListResponse> {
      return fetchRecords<RecordViewListResponse>(`/records/sheets/${sheetId}/views`);
    },
  },

  updateRequests: {
    /** GET /api/records/sheets/:sheetId/rows/:rowId/update-requests */
    list(sheetId: string, rowId: string): Promise<RecordUpdateRequestListResponse> {
      return fetchRecords<RecordUpdateRequestListResponse>(
        `/records/sheets/${sheetId}/rows/${rowId}/update-requests`,
      );
    },
    /** POST /api/records/sheets/:sheetId/rows/:rowId/update-requests */
    create(
      sheetId: string,
      rowId: string,
      data: CreateUpdateRequestRequest,
    ): Promise<RecordUpdateRequestCreateResponse> {
      return fetchRecords<RecordUpdateRequestCreateResponse>(
        `/records/sheets/${sheetId}/rows/${rowId}/update-requests`,
        { method: 'POST', body: JSON.stringify(data) },
      );
    },
    /** DELETE /api/records/sheets/:sheetId/rows/:rowId/update-requests/:requestId */
    cancel(sheetId: string, rowId: string, requestId: string): Promise<{ success: true }> {
      return fetchRecords<{ success: true }>(
        `/records/sheets/${sheetId}/rows/${rowId}/update-requests/${requestId}`,
        { method: 'DELETE' },
      );
    },
  },

  forms: {
    /** GET /api/records/sheets/:sheetId/forms */
    list(sheetId: string, params?: { archived?: boolean }): Promise<RecordFormListResponse> {
      const qs = params?.archived ? '?archived=1' : '';
      return fetchRecords<RecordFormListResponse>(`/records/sheets/${sheetId}/forms${qs}`);
    },

    /** GET /api/records/sheets/:sheetId/forms/:formId */
    get(sheetId: string, formId: string): Promise<RecordFormGetResponse> {
      return fetchRecords<RecordFormGetResponse>(`/records/sheets/${sheetId}/forms/${formId}`);
    },

    /** POST /api/records/sheets/:sheetId/forms */
    create(sheetId: string, data: CreateFormRequest): Promise<RecordFormCreateResponse> {
      return fetchRecords<RecordFormCreateResponse>(`/records/sheets/${sheetId}/forms`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** PUT /api/records/sheets/:sheetId/forms/:formId */
    update(sheetId: string, formId: string, data: UpdateFormRequest): Promise<RecordFormUpdateResponse> {
      return fetchRecords<RecordFormUpdateResponse>(`/records/sheets/${sheetId}/forms/${formId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** DELETE /api/records/sheets/:sheetId/forms/:formId */
    archive(sheetId: string, formId: string): Promise<{ success: true }> {
      return fetchRecords<{ success: true }>(`/records/sheets/${sheetId}/forms/${formId}`, {
        method: 'DELETE',
      });
    },

    /** GET /api/records/sheets/:sheetId/forms/:formId/submissions */
    submissions(
      sheetId: string,
      formId: string,
      params?: { limit?: number; offset?: number },
    ): Promise<RecordFormSubmissionListResponse> {
      const query = new URLSearchParams();
      if (params?.limit != null) query.set('limit', String(params.limit));
      if (params?.offset != null) query.set('offset', String(params.offset));
      const qs = query.toString();
      return fetchRecords<RecordFormSubmissionListResponse>(
        `/records/sheets/${sheetId}/forms/${formId}/submissions${qs ? `?${qs}` : ''}`,
      );
    },
  },
};

/**
 * Public form client — no auth header, never redirects on 401, never
 * touches localStorage. Used by the /f/<slug> renderer which is reached
 * by anonymous external users.
 */
export const publicFormsApi = {
  /** GET /api/forms/public/:slug — sanitized PublicFormView. */
  async get(slug: string): Promise<PublicFormView> {
    const res = await fetch(`/api/forms/public/${encodeURIComponent(slug)}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const code = res.status === 404 ? 'not_found' : 'fetch_failed';
      throw Object.assign(new Error('Form unavailable'), { code });
    }
    return res.json();
  },

  /** POST /api/forms/public/:slug/submit. */
  async submit(slug: string, payload: PublicFormSubmitRequest): Promise<PublicFormSubmitResponse> {
    const res = await fetch(`/api/forms/public/${encodeURIComponent(slug)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        // ignore parse errors
      }
      throw new Error(message);
    }
    return res.json();
  },

  /**
   * POST /api/forms/public/:slug/upload — single-file streaming upload.
   *
   * Uses XHR (not fetch) so we get progress events; fetch's
   * ReadableStream upload progress isn't supported in any major browser
   * yet. The returned PublicAttachmentUpload contains the attachment_id
   * the renderer holds in form state until submit.
   */
  uploadAttachment(
    slug: string,
    file: File,
    opts?: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal },
  ): Promise<PublicAttachmentUpload> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/forms/public/${encodeURIComponent(slug)}/upload`);
      if (xhr.upload && opts?.onProgress) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        });
      }
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as PublicAttachmentUpload);
          } catch {
            reject(new Error('Invalid upload response'));
          }
        } else {
          let message = xhr.statusText || 'Upload failed';
          try {
            const body = JSON.parse(xhr.responseText);
            if (body?.error) message = body.error;
          } catch {
            // ignore
          }
          reject(new Error(message));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed')));
      xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      if (opts?.signal) {
        if (opts.signal.aborted) {
          xhr.abort();
          return;
        }
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  },

  /** DELETE /api/forms/public/:slug/attachment/:attachmentId — cancel a pending upload. */
  async cancelAttachment(
    slug: string,
    attachmentId: string,
    pendingToken: string,
  ): Promise<void> {
    const res = await fetch(
      `/api/forms/public/${encodeURIComponent(slug)}/attachment/${encodeURIComponent(attachmentId)}?pending_token=${encodeURIComponent(pendingToken)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
  },
};

/**
 * Public update-request client — recipient form at /u/<token>. Same
 * "no auth, no localStorage" rules as publicFormsApi. The token in the
 * URL is the gate; tokens are 32 random bytes encoded as base64url.
 */
export const publicUpdateRequestsApi = {
  /** GET /api/update-requests/public/:token */
  async get(token: string): Promise<PublicUpdateRequestView> {
    const res = await fetch(`/api/update-requests/public/${encodeURIComponent(token)}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const code = res.status === 404 ? 'not_found' : 'fetch_failed';
      throw Object.assign(new Error('Request unavailable'), { code });
    }
    return res.json();
  },

  /** POST /api/update-requests/public/:token */
  async submit(
    token: string,
    payload: PublicUpdateRequestSubmitRequest,
  ): Promise<PublicUpdateRequestSubmitResponse> {
    const res = await fetch(`/api/update-requests/public/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        // ignore parse errors
      }
      throw new Error(message);
    }
    return res.json();
  },
};

export type {
  ApiRecordSheet,
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordView,
  RecordRowData,
};
