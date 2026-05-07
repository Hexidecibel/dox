import { useCallback, useEffect, useState } from 'react';

/**
 * localStorage-backed list of recent free-text queries.
 *
 * - Cap: 20 entries. Oldest fall off when capacity is exceeded.
 * - Dedup-on-insert: pushing a query that already exists moves it to the
 *   front instead of duplicating it.
 * - Cross-tab sync: listens to the `storage` event so two open tabs stay
 *   in sync without a page refresh.
 *
 * Cross-device sync is intentionally NOT v1 — the plan calls this
 * out as nice-to-have only.
 */
const STORAGE_KEY = 'dox.search.recent';
const MAX = 20;

function readStorage(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function writeStorage(list: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Quota exceeded / private mode — silent failure is fine.
  }
}

export interface UseRecentSearchesResult {
  recent: string[];
  push: (query: string) => void;
  remove: (query: string) => void;
  clear: () => void;
}

export function useRecentSearches(): UseRecentSearchesResult {
  const [recent, setRecent] = useState<string[]>(() => readStorage());

  // Cross-tab sync. The `storage` event only fires in *other* tabs, not
  // the originating one — so we only need to mirror inbound changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRecent(readStorage());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const push = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecent((prev) => {
      const filtered = prev.filter((q) => q !== trimmed);
      const next = [trimmed, ...filtered].slice(0, MAX);
      writeStorage(next);
      return next;
    });
  }, []);

  const remove = useCallback((query: string) => {
    setRecent((prev) => {
      const next = prev.filter((q) => q !== query);
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecent([]);
    writeStorage([]);
  }, []);

  return { recent, push, remove, clear };
}
