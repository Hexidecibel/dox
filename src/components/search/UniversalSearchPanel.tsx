import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { SearchBar } from './SearchBar';
import { ResultCardDocument } from './ResultCardDocument';
import { ResultCardOrder } from './ResultCardOrder';
import { ResultCardCustomer } from './ResultCardCustomer';
import { ResultCardBundle } from './ResultCardBundle';
import { CoverageResults, UnreviewedCandidatesSection } from './CoverageResults';
import { SelectableResult } from './SelectableResult';
import type { SearchSelection } from './SelectableResult';
import { ExportSelectionBar } from './ExportSelectionBar';
import { SendExportDialog } from './SendExportDialog';
import { useSearchParamsState } from '../../hooks/useSearchParamsState';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { api } from '../../lib/api';
import type {
  NaturalSearchResponse,
  SearchState,
  UniversalSearchDocument,
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
  /**
   * Turn on selection + the export bar. OFF by default, and passed in rather
   * than read from a context here, so this panel keeps rendering standalone
   * (its own tests, any future embed) and so the `library` module gate is
   * decided once, by the page that owns the surface.
   */
  enableExport?: boolean;
  /** Who the export email says it is from, and where replies go. */
  exportSender?: { name: string; email: string };
}

export function UniversalSearchPanel({
  syncToUrl = true,
  tenantId,
  enableExport = false,
  exportSender,
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

  // "Lot / sublot" (AJ A3): a lot given as two inputs, matched part against
  // part. An advanced input beside the one box, which stays the main path.
  const [lotOpen, setLotOpen] = useState(false);
  const [lotBase, setLotBase] = useState('');
  const [lotSub, setLotSub] = useState('');
  const debouncedLot = useDebouncedValue(lotOpen ? lotBase.trim() : '', 300);
  const debouncedSub = useDebouncedValue(lotOpen ? lotSub.trim() : '', 300);
  const recent = useRecentSearches();

  const [data, setData] = useState<UniversalSearchResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI mode: the question is parsed by the model on Enter (not per
  // keystroke — it is a model call) and answered with coverage.
  const [aiMode, setAiMode] = useState(false);
  const [aiData, setAiData] = useState<NaturalSearchResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const runAi = useCallback(
    (q: string) => {
      setAiLoading(true);
      setAiError(null);
      api.search
        .natural(q, tenantId)
        .then((res) => setAiData(res))
        .catch((e: unknown) => {
          setAiData(null);
          setAiError(e instanceof Error ? e.message : 'AI search failed');
        })
        .finally(() => setAiLoading(false));
    },
    [tenantId],
  );

  useEffect(() => {
    let cancelled = false;
    const trimmed = debouncedQ.trim();
    if (aiMode) return;
    if (!trimmed && !debouncedLot) {
      setData(EMPTY_RESPONSE);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api.search
      .universal({ q: trimmed, tenant_id: tenantId, lot: debouncedLot || undefined, sublot: debouncedSub || undefined })
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
  }, [debouncedQ, debouncedLot, debouncedSub, tenantId, aiMode]);

  const handleSubmit = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) recent.push(trimmed);
    setStatePatch({ q: trimmed });
    if (aiMode && trimmed) runAi(trimmed);
  };

  // ── Export selection ─────────────────────────────────────────────────────
  // The whole selected DOCUMENT is held, not just its id: the send dialog and
  // the bar have to name what is being sent, and a selection deliberately
  // SURVIVES the next search — the normal shape of this job is "find the COA
  // for lot A, then the spec sheet, then send both".
  const [selectedDocs, setSelectedDocs] = useState<UniversalSearchDocument[]>([]);
  const [includedAnyway, setIncludedAnyway] = useState<Set<string>>(new Set());
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);

  const selectedIds = new Set(selectedDocs.map((d) => d.id));

  const toggleDoc = useCallback((doc: UniversalSearchDocument) => {
    setSelectedDocs((prev) =>
      prev.some((d) => d.id === doc.id) ? prev.filter((d) => d.id !== doc.id) : [...prev, doc],
    );
  }, []);

  const selectMany = useCallback((docs: UniversalSearchDocument[]) => {
    setSelectedDocs((prev) => {
      const have = new Set(prev.map((d) => d.id));
      return [...prev, ...docs.filter((d) => !have.has(d.id))];
    });
  }, []);

  const includeAnyway = useCallback((doc: UniversalSearchDocument) => {
    setIncludedAnyway((prev) => new Set(prev).add(doc.id));
    setSelectedDocs((prev) => (prev.some((d) => d.id === doc.id) ? prev : [...prev, doc]));
  }, []);

  const selection: SearchSelection | undefined = enableExport
    ? {
        selectedIds,
        includedAnyway,
        onToggle: toggleDoc,
        onIncludeAnyway: includeAnyway,
        onSelectMany: selectMany,
      }
    : undefined;

  const runDownload = useCallback(() => {
    setExportBusy(true);
    setExportError(null);
    setExportNotice(null);
    api.documentExports
      .downloadZip(selectedDocs.map((d) => d.id), tenantId)
      .then((res) => setExportNotice(`${res.count} document${res.count === 1 ? '' : 's'} downloaded.`))
      .catch((e: unknown) => setExportError(e instanceof Error ? e.message : 'Export failed'))
      .finally(() => setExportBusy(false));
  }, [selectedDocs, tenantId]);

  const runSend = useCallback(
    (input: { recipients: string; onBehalfOf: string; message: string }) => {
      setExportBusy(true);
      setExportError(null);
      setExportNotice(null);
      api.documentExports
        .send({
          document_ids: selectedDocs.map((d) => d.id),
          recipients: input.recipients
            .split(/[,;\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          on_behalf_of: input.onBehalfOf.trim() || undefined,
          message: input.message.trim() || undefined,
          tenant_id: tenantId,
        })
        .then((res) => {
          setSendOpen(false);
          setSelectedDocs([]);
          setIncludedAnyway(new Set());
          setExportNotice(
            `Sent ${res.document_count} document${res.document_count === 1 ? '' : 's'} to ${res.recipients.join(', ')}.`,
          );
        })
        .catch((e: unknown) => setExportError(e instanceof Error ? e.message : 'Send failed'))
        .finally(() => setExportBusy(false));
    },
    [selectedDocs, tenantId],
  );

  const constrained = data.coverage === 'covered' || data.coverage === 'likely' || data.coverage === 'none' || data.coverage === 'ambiguous';
  const hasQuery = state.q.trim() !== '' || (lotOpen && lotBase.trim() !== '');
  const coverageProps = {
    selection,
    documents: data.documents.results,
    coverage: data.coverage,
    constraints: data.constraints,
    dropped_constraints: data.dropped_constraints,
    coverage_summary: data.coverage_summary,
    unreviewed_candidates: data.unreviewed_candidates,
    coverage_scan_truncated: data.coverage_scan_truncated,
  };
  const unreviewed = data.unreviewed_candidates ?? [];

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
        aiMode={aiMode}
        onAiToggle={(next) => {
          setAiMode(next);
          setAiData(null);
          setAiError(null);
        }}
        placeholder={
          aiMode
            ? 'Ask a question, then press Enter — e.g. Darigold butter produced 7/31/26'
            : 'Search documents, orders, customers, bundles…'
        }
      />
      {!aiMode && (
        <Box sx={{ mt: 1 }} data-testid="lot-sublot-search">
          <Button
            size="small"
            variant={lotOpen ? 'outlined' : 'text'}
            onClick={() => setLotOpen((v) => !v)}
            sx={{ textTransform: 'none' }}
            aria-expanded={lotOpen}
          >
            Lot / sublot
          </Button>
          {lotOpen && (
            <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
              <TextField
                size="small"
                label="Lot"
                placeholder="10426203"
                value={lotBase}
                onChange={(e) => setLotBase(e.target.value)}
                inputProps={{ 'data-testid': 'lot-base-input' }}
                sx={{ flex: '1 1 180px', maxWidth: 260 }}
              />
              <TextField
                size="small"
                label="Sublot"
                placeholder="03"
                value={lotSub}
                onChange={(e) => setLotSub(e.target.value)}
                inputProps={{ 'data-testid': 'lot-sub-input' }}
                sx={{ flex: '0 1 110px' }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center', flex: '1 1 220px' }}>
                Base lot and sublot as the certificate prints them — matched separately, never by gluing them together.
              </Typography>
            </Stack>
          )}
        </Box>
      )}
      {aiMode && (
        <Box sx={{ mt: 1 }} data-testid="ai-search">
          {aiError && <Alert severity="error" sx={{ mb: 2 }}>{aiError}</Alert>}
          {aiLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          {!aiLoading && !aiData && !aiError && (
            <Typography variant="body2" color="text.secondary">
              AI search reads your question, then checks each document against what you asked for. Press Enter to search.
            </Typography>
          )}
          {!aiLoading && aiData && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Understood as: {aiData.parsed_query.intent_summary}
              </Typography>
              <CoverageResults
                selection={selection}
                documents={aiData.results as unknown as UniversalSearchDocument[]}
                coverage={aiData.coverage}
                constraints={aiData.constraints}
                dropped_constraints={aiData.dropped_constraints}
                coverage_summary={aiData.coverage_summary}
                unreviewed_candidates={aiData.unreviewed_candidates}
                coverage_scan_truncated={aiData.coverage_scan_truncated}
              />
            </>
          )}
        </Box>
      )}
      {!aiMode && (<>
      <Tabs
        value={tab}
        onChange={(_, next: UniversalSearchType) => setStatePatch({ type: next })}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {TAB_ORDER.map((t) => (
          <Tab
            key={t}
            value={t}
            label={
              <Box
                component="span"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
              >
                {TAB_LABEL[t]}
                {totals[t] > 0 && (
                  <Box
                    component="span"
                    sx={{
                      bgcolor: 'primary.main',
                      color: 'primary.contrastText',
                      borderRadius: 999,
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      lineHeight: 1,
                      px: 0.75,
                      py: 0.25,
                      minWidth: 18,
                      textAlign: 'center',
                    }}
                  >
                    {totals[t] > 999 ? '999+' : totals[t]}
                  </Box>
                )}
              </Box>
            }
            sx={{ textTransform: 'none', minHeight: 40, minWidth: 'auto', px: 2 }}
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

      {!loading && !hasQuery && (
        <Typography variant="body2" color="text.secondary">
          Type to search across documents, orders, customers, and bundles.
        </Typography>
      )}

      {!loading && hasQuery && tab === 'all' && (
        <Stack spacing={3}>
          {constrained && (
            <Section title="Documents" total={data.documents.total} onSeeAll={() => setStatePatch({ type: 'documents' })}>
              <CoverageResults {...coverageProps} />
            </Section>
          )}
          {!constrained && data.documents.total > 0 && (
            <Section
              title="Documents"
              total={data.documents.total}
              onSeeAll={() => setStatePatch({ type: 'documents' })}
            >
              {data.documents.results.slice(0, 5).map((d) => (
                <SelectableResult key={d.id} doc={d} selection={selection} mode="plain">
                  <ResultCardDocument doc={d} />
                </SelectableResult>
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
          {!constrained && <UnreviewedCandidatesSection items={unreviewed} />}
          {!constrained && totals.all === 0 && unreviewed.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No results across any entity type.
            </Typography>
          )}
        </Stack>
      )}

      {!loading && tab === 'documents' && constrained && <CoverageResults {...coverageProps} />}
      {!loading && tab === 'documents' && !constrained &&
        data.documents.results.map((d) => (
          <SelectableResult key={d.id} doc={d} selection={selection} mode="plain">
            <ResultCardDocument doc={d} />
          </SelectableResult>
        ))}
      {!loading && tab === 'documents' && !constrained && (
        <Box sx={{ mt: 2 }}>
          <UnreviewedCandidatesSection items={unreviewed} />
        </Box>
      )}
      {!loading && tab === 'orders' &&
        data.orders.results.map((o) => <ResultCardOrder key={o.id} order={o} />)}
      {!loading && tab === 'customers' &&
        data.customers.results.map((c) => <ResultCardCustomer key={c.id} customer={c} />)}
      {!loading && tab === 'bundles' &&
        data.bundles.results.map((b) => <ResultCardBundle key={b.id} bundle={b} />)}
      </>)}

      {enableExport && (
        <>
          <ExportSelectionBar
            count={selectedDocs.length}
            busy={exportBusy}
            error={exportError}
            notice={exportNotice}
            onDownload={runDownload}
            onSend={() => {
              setExportError(null);
              setSendOpen(true);
            }}
            onClear={() => {
              setSelectedDocs([]);
              setIncludedAnyway(new Set());
              setExportError(null);
              setExportNotice(null);
            }}
            onDismissMessage={() => {
              setExportError(null);
              setExportNotice(null);
            }}
          />
          <SendExportDialog
            open={sendOpen}
            documents={selectedDocs}
            senderName={exportSender?.name ?? 'You'}
            senderEmail={exportSender?.email ?? 'your address'}
            busy={exportBusy}
            error={sendOpen ? exportError : null}
            onClose={() => setSendOpen(false)}
            onSend={runSend}
          />
        </>
      )}
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
