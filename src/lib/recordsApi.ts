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
  },

  views: {
    /** GET /api/records/sheets/:sheetId/views */
    list(sheetId: string): Promise<RecordViewListResponse> {
      return fetchRecords<RecordViewListResponse>(`/records/sheets/${sheetId}/views`);
    },
  },
};

export type {
  ApiRecordSheet,
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordView,
  RecordRowData,
};
