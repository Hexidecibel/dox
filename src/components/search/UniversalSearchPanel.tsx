import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { SearchBar } from './SearchBar';
import { ResultCardDocument } from './ResultCardDocument';
import { ResultCardOrder } from './ResultCardOrder';
import { ResultCardCustomer } from './ResultCardCustomer';
import { ResultCardBundle } from './ResultCardBundle';
import { useSearchParamsState } from '../../hooks/useSearchParamsState';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { api } from '../../lib/api';
import type {
  SearchState,
  UniversalSearchResponse,
  UniversalSearchType,
} from '../../../shared/types';

/**
 * Universal cross-entity search panel — drives `/api/search`.
 *
 * Top-level tabs: All | Documents | Orders | Customers | Bundles. The
 * "All" tab shows top-N per type with "see all" affordances; clicking
 * a per-type "see all" flips to that tab.
 *
 * State: same `SearchState` carrier as DocumentSearchPanel, but only
 * `q` and `type` matter here. Per-type filters from the universal URL
 * spec (e.g. customer, status) flow through but the universal endpoint
 * itself doesn't currently consume them — that's a Phase 6+ extension.
 */
const TAB_ORDER: UniversalSearchType[] = ['all', 'documents', 'orders', 'customers', 'bundles'];
const TAB_LABEL: Record<UniversalSearchType, string> = {
  all: 'All',
  documents: 'Documents',
  orders: 'Orders',
  customers: 'Customers',
  bundles: 'Bundles',
};

const EMPTY_RESPONSE: UniversalSearchResponse = {
  documents: { total: 0, results: [] },
  suppliers: { total: 0, results: [] },
  products: { total: 0, results: [] },
  doc_types: { total: 0, results: [] },
  orders: { total: 0, results: [] },
  customers: { total: 0, results: [] },
  bundles: { total: 0, results: [] },
};

export interface UniversalSearchPanelProps {
  syncToUrl?: boolean;
  tenantId?: string;
}

export function UniversalSearchPanel({
  syncToUrl = true,
  tenantId,
}: UniversalSearchPanelProps) {
  const urlBound = useSearchParamsState();
  const [localState, setLocalState] = useState<SearchState>({ q: '', type: 'all' });

  const state: SearchState = syncToUrl ? urlBound.state : localState;
  const tab: UniversalSearchType = state.type ?? 'documents';

  const setStatePatch = useCallback(
    (patch: Partial<SearchState>) => {
      if (syncToUrl) urlBound.setState(patch);
      else setLocalState((prev) => ({ ...prev, ...patch }));
    },
    [syncToUrl, urlBound],
  );

  const debouncedQ = useDebouncedValue(state.q, 300);
  const recent = useRecentSearches();

  const [data, setData] = useState<UniversalSearchResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = debouncedQ.trim();
    if (!trimmed) {
      setData(EMPTY_RESPONSE);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api.search
      .universal({ q: trimmed, tenant_id: tenantId })
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Search failed');
        setData(EMPTY_RESPONSE);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, tenantId]);

  const handleSubmit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) recent.push(trimmed);
    setStatePatch({ q: trimmed });
  };

  const totals: Record<UniversalSearchType, number> = {
    all:
      data.documents.total +
      data.orders.total +
      data.customers.total +
      data.bundles.total,
    documents: data.documents.total,
    orders: data.orders.total,
    customers: data.customers.total,
    bundles: data.bundles.total,
  };

  return (
    <Box>
      <SearchBar
        value={state.q}
        onChange={(q) => setStatePatch({ q })}
        onSubmit={handleSubmit}
        recent={recent.recent}
        onRecentPick={(q) => setStatePatch({ q })}
        onRecentRemove={recent.remove}
        onRecentClear={recent.clear}
        placeholder="Search documents, orders, customers, bundles…"
      />
      <Tabs
        value={tab}
        onChange={(_, next: UniversalSearchType) => setStatePatch({ type: next })}
        sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {TAB_ORDER.map((t) => (
          <Tab
            key={t}
            value={t}
            label={
              <Badge
                badgeContent={totals[t]}
                color="primary"
                max={999}
                showZero={false}
                sx={{ '& .MuiBadge-badge': { right: -16, top: 4 } }}
              >
                {TAB_LABEL[t]}
              </Badge>
            }
            sx={{ textTransform: 'none', minHeight: 40, mr: 2 }}
          />
        ))}
      </Tabs>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!loading && state.q.trim() === '' && (
        <Typography variant="body2" color="text.secondary">
          Type to search across documents, orders, customers, and bundles.
        </Typography>
      )}

      {!loading && state.q.trim() !== '' && tab === 'all' && (
        <Stack spacing={3}>
          {data.documents.total > 0 && (
            <Section
              title="Documents"
              total={data.documents.total}
              onSeeAll={() => setStatePatch({ type: 'documents' })}
            >
              {data.documents.results.slice(0, 5).map((d) => (
                <ResultCardDocument key={d.id} doc={d} />
              ))}
            </Section>
          )}
          {data.orders.total > 0 && (
            <Section
              title="Orders"
              total={data.orders.total}
              onSeeAll={() => setStatePatch({ type: 'orders' })}
            >
              {data.orders.results.slice(0, 5).map((o) => (
                <ResultCardOrder key={o.id} order={o} />
              ))}
            </Section>
          )}
          {data.customers.total > 0 && (
            <Section
              title="Customers"
              total={data.customers.total}
              onSeeAll={() => setStatePatch({ type: 'customers' })}
            >
              {data.customers.results.slice(0, 5).map((c) => (
                <ResultCardCustomer key={c.id} customer={c} />
              ))}
            </Section>
          )}
          {data.bundles.total > 0 && (
            <Section
              title="Bundles"
              total={data.bundles.total}
              onSeeAll={() => setStatePatch({ type: 'bundles' })}
            >
              {data.bundles.results.slice(0, 5).map((b) => (
                <ResultCardBundle key={b.id} bundle={b} />
              ))}
            </Section>
          )}
          {totals.all === 0 && (
            <Typography variant="body2" color="text.secondary">
              No results across any entity type.
            </Typography>
          )}
        </Stack>
      )}

      {!loading && tab === 'documents' &&
        data.documents.results.map((d) => <ResultCardDocument key={d.id} doc={d} />)}
      {!loading && tab === 'orders' &&
        data.orders.results.map((o) => <ResultCardOrder key={o.id} order={o} />)}
      {!loading && tab === 'customers' &&
        data.customers.results.map((c) => <ResultCardCustomer key={c.id} customer={c} />)}
      {!loading && tab === 'bundles' &&
        data.bundles.results.map((b) => <ResultCardBundle key={b.id} bundle={b} />)}
    </Box>
  );
}

interface SectionProps {
  title: string;
  total: number;
  onSeeAll: () => void;
  children: React.ReactNode;
}

function Section({ title, total, onSeeAll, children }: SectionProps) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1, flex: 1 }}>
          {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
        </Typography>
        {total > 5 && (
          <Box
            component="button"
            onClick={onSeeAll}
            sx={{
              border: 0,
              bgcolor: 'transparent',
              cursor: 'pointer',
              color: 'primary.main',
              fontSize: '0.8125rem',
              p: 0,
            }}
          >
            See all →
          </Box>
        )}
      </Box>
      {children}
    </Box>
  );
}
