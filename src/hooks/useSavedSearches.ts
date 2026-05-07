import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type {
  SavedSearch,
  CreateSavedSearchRequest,
  UpdateSavedSearchRequest,
} from '../../shared/types';

/**
 * Server-backed saved-search list with optimistic CRUD.
 *
 * Loads the calling user's named bookmarks once on mount; mutations go
 * straight to `/api/search/saved/*` via `api.search.saved` and the
 * local list mirrors the server response on success.
 *
 * The hook deliberately stays close to the API shape — no client-side
 * sort, no derived "today / older" buckets, no group-by-name. The
 * popover/drawer component does its own presentation.
 */
export interface UseSavedSearchesResult {
  saved: SavedSearch[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (data: CreateSavedSearchRequest) => Promise<SavedSearch>;
  update: (id: string, data: UpdateSavedSearchRequest) => Promise<SavedSearch>;
  remove: (id: string) => Promise<void>;
}

export function useSavedSearches(): UseSavedSearchesResult {
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.search.saved.list();
      setSaved(res.saved_searches);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load saved searches');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (data: CreateSavedSearchRequest) => {
    const res = await api.search.saved.create(data);
    // Server is the source of truth (UNIQUE(user_id, name) enforced
    // there); just merge the new row in. Most-recent first matches what
    // the popover wants to render.
    setSaved((prev) => [res.saved_search, ...prev]);
    return res.saved_search;
  }, []);

  const update = useCallback(async (id: string, data: UpdateSavedSearchRequest) => {
    const res = await api.search.saved.update(id, data);
    setSaved((prev) => prev.map((s) => (s.id === id ? res.saved_search : s)));
    return res.saved_search;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.search.saved.delete(id);
    setSaved((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { saved, loading, error, refresh, create, update, remove };
}
