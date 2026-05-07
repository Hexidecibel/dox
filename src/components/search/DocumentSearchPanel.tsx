import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Stack } from '@mui/material';
import { SearchBar } from './SearchBar';
import { FacetSidebar } from './FacetSidebar';
import { ActiveFilterChips } from './ActiveFilterChips';
import { SortMenu } from './SortMenu';
import { ResultsList } from './ResultsList';
import { ResultCardDocument } from './ResultCardDocument';
import { SavedSearchesDialog } from './SavedSearchesDialog';
import { useSearchParamsState } from '../../hooks/useSearchParamsState';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { useSavedSearches } from '../../hooks/useSavedSearches';
import { api } from '../../lib/api';
import type {
  FacetCount,
  FacetKind,
  SearchSort,
  SearchState,
  UniversalSearchDocument,
} from '../../../shared/types';

/**
 * Documents-only search panel — composed from the atoms in 5b and the
 * hooks in 5a.
 *
 * `syncToUrl` (default true): two-way bind state to react-router. The
 * Documents page uses this so deep links share their filters. Embedded
 * uses (e.g. a picker dialog) can pass `syncToUrl={false}` and manage
 * state locally.
 */
const PAGE_SIZE = 20;

const SUPPLIER_FACET_KEY = 'supplier';
const DOC_TYPE_FACET_KEY = 'doc_type';

export interface DocumentSearchPanelProps {
  syncToUrl?: boolean;
  /** Optional tenant override for super_admin context. */
  tenantId?: string;
  /**
   * Optional override for clicking a result row. Defaults to navigating
   * to /documents/:id via React Router.
   */
  onOpen?: (doc: UniversalSearchDocument) => void;
}

interface SearchSnapshot {
  documents: UniversalSearchDocument[];
  total: number;
  facets: Partial<Record<FacetKind, FacetCount[]>>;
}

const EMPTY_SNAPSHOT: SearchSnapshot = { documents: [], total: 0, facets: {} };

function dateBucketRange(bucket: NonNullable<SearchState['date']>): { from?: string; to?: string } {
  if (bucket === 'any') return {};
  const now = new Date();
  const days =
    bucket === 'last_7d'
      ? 7
      : bucket === 'last_30d'
        ? 30
        : bucket === 'last_90d'
          ? 90
          : 365;
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  return { from: from.toISOString() };
}

export function DocumentSearchPanel({
  syncToUrl = true,
  tenantId,
  onOpen,
}: DocumentSearchPanelProps) {
  const urlBound = useSearchParamsState();
  const [localState, setLocalState] = useState<SearchState>({ q: '' });

  const state: SearchState = syncToUrl ? urlBound.state : localState;
  const setStatePatch = useCallback(
    (patch: Partial<SearchState>) => {
      if (syncToUrl) urlBound.setState(patch);
      else setLocalState((prev) => ({ ...prev, ...patch }));
    },
    [syncToUrl, urlBound],
  );

  const [snap, setSnap] = useState<SearchSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedQ = useDebouncedValue(state.q, 300);
  const recent = useRecentSearches();
  const saved = useSavedSearches();
  const [savedOpen, setSavedOpen] = useState(false);

  const page = state.page ?? 1;
  const sort: SearchSort = state.sort ?? 'relevance';

  const supplierFilter = state.supplier?.[0];
  const docTypeFilter = state.doc_type?.[0];

  const fetchKey = useMemo(
    () =>
      JSON.stringify({
        q: debouncedQ,
        page,
        sort,
        tenantId,
        supplier: state.supplier,
        doc_type: state.doc_type,
        date: state.date,
      }),
    [debouncedQ, page, sort, tenantId, state.supplier, state.doc_type, state.date],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const range = state.date ? dateBucketRange(state.date) : {};
        const res = await api.documents.searchV2({
          q: debouncedQ,
          tenant_id: tenantId,
          supplier_id: supplierFilter,
          document_type_id: docTypeFilter,
          date_from: range.from,
          date_to: range.to,
          sort,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          facets: true,
        });
        if (cancelled) return;

        // Server returns facets keyed by `date_bucket`; the FacetSidebar
        // expects `date`. Translate here so the FacetKind enum stays
        // canonical.
        const serverFacets = res.facets ?? {};
        const facets: Partial<Record<FacetKind, FacetCount[]>> = {
          [SUPPLIER_FACET_KEY]: serverFacets.supplier ?? [],
          [DOC_TYPE_FACET_KEY]: serverFacets.doc_type ?? [],
          product: serverFacets.product ?? [],
          status: serverFacets.status ?? [],
          date: serverFacets.date_bucket ?? [],
        };

        setSnap({
          documents: res.documents as unknown as UniversalSearchDocument[],
          total: res.total,
          facets,
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Search failed');
        setSnap(EMPTY_SNAPSHOT);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchKey is the canonical input
  }, [fetchKey]);

  const handleSubmit = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (trimmed) recent.push(trimmed);
      setStatePatch({ q: trimmed, page: undefined });
    },
    [recent, setStatePatch],
  );

  const handleSaveCurrent = useCallback(
    async (name: string) => {
      await saved.create({ name, query: state });
    },
    [saved, state],
  );

  const handleLoadSaved = useCallback(
    (s: { query: Record<string, unknown> }) => {
      // Reset to the saved query verbatim. Drop unknown keys defensively.
      const next: SearchState = { q: '' };
      const q = s.query.q;
      if (typeof q === 'string') next.q = q;
      for (const k of ['supplier', 'doc_type', 'product', 'status', 'customer'] as const) {
        const v = s.query[k];
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
          next[k] = v as string[];
        }
      }
      if (typeof s.query.date === 'string') next.date = s.query.date as SearchState['date'];
      if (typeof s.query.sort === 'string') next.sort = s.query.sort as SearchSort;
      if (typeof s.query.page === 'number') next.page = s.query.page;
      if (typeof s.query.type === 'string') next.type = s.query.type as SearchState['type'];

      if (syncToUrl) {
        // Replace, not merge — saved searches are absolute.
        urlBound.setState({
          q: next.q,
          supplier: next.supplier,
          doc_type: next.doc_type,
          product: next.product,
          status: next.status,
          customer: next.customer,
          date: next.date,
          sort: next.sort,
          page: undefined,
          type: next.type,
        });
      } else {
        setLocalState(next);
      }
    },
    [syncToUrl, urlBound],
  );

  return (
    <Box>
      <SearchBar
        value={state.q}
        onChange={(q) => setStatePatch({ q, page: undefined })}
        onSubmit={handleSubmit}
        recent={recent.recent}
        onRecentPick={(q) => {
          setStatePatch({ q, page: undefined });
        }}
        onRecentRemove={recent.remove}
        onRecentClear={recent.clear}
        onSavedClick={() => setSavedOpen(true)}
      />
      <ActiveFilterChips state={state} facets={snap.facets} onChange={setStatePatch} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
        <FacetSidebar
          state={state}
          facets={snap.facets}
          onChange={setStatePatch}
          loading={loading}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ResultsList
            results={snap.documents}
            total={snap.total}
            page={page}
            pageSize={PAGE_SIZE}
            loading={loading}
            error={error}
            onPageChange={(p) => setStatePatch({ page: p > 1 ? p : undefined })}
            header={
              <SortMenu
                value={sort}
                onChange={(next) => setStatePatch({ sort: next, page: undefined })}
              />
            }
            renderItem={(doc) => (
              <ResultCardDocument
                key={String(doc.id)}
                doc={doc}
                onOpen={onOpen}
              />
            )}
          />
        </Box>
      </Stack>
      <SavedSearchesDialog
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        currentState={state}
        saved={saved.saved}
        onSave={handleSaveCurrent}
        onLoad={handleLoadSaved}
        onDelete={saved.remove}
      />
    </Box>
  );
}
