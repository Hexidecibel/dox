import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalAuth } from '../../contexts/AuthContext';
import {
  Alert,
  Box,
  Button,
  Drawer,
  Pagination,
  Popover,
  Snackbar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import BookmarkBorderRoundedIcon from '@mui/icons-material/BookmarkBorderRounded';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Omnibox } from './Omnibox';
import { ClauseEditor } from './ClauseEditor';
import { AnswerCard, Kbd, splitScope } from './AnswerCard';
import { JumpRow } from './JumpRow';
import { PreviewPane } from './PreviewPane';
import { CoverageResults } from './CoverageResults';
import { FacetSidebar } from './FacetSidebar';
import { SortMenu } from './SortMenu';
import { SavedSearchesDialog } from './SavedSearchesDialog';
import { FilterBuilder } from './FilterBuilder';
import { AdvancedFacetRail } from './AdvancedFacetRail';
import { AdvancedResults } from './AdvancedResults';
import { ExportSelectionBar } from './ExportSelectionBar';
import { SendExportDialog } from './SendExportDialog';
import type { SearchSelection } from './SelectableResult';
import { useSearchQueryState } from '../../hooks/useSearchQueryState';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRecentSearches } from '../../hooks/useRecentSearches';
import { useSavedSearches } from '../../hooks/useSavedSearches';
import { useSearchRun } from '../../hooks/useSearchRun';
import { useSearchExamples } from '../../hooks/useSearchExamples';
import { api } from '../../lib/api';
import { isTypingTarget, modKeyLabel } from '../../lib/platform';
import {
  clauseAsText,
  commitInterpretation,
  encodeClause,
  EMPTY_QUERY,
  queryKey,
  questionText,
  replaceClause,
  savedPayloadToQuery,
  withAiReading,
  withClause,
  withoutClause,
  type Clause,
  type SearchQuery,
} from '../../../shared/searchQuery';
import { detectOptimistic } from '../../../shared/searchInterpret';
import type { FacetField } from '../../../shared/searchFields';

/** Easy mode's side rail shows these five; Advanced asks for every facet. */
const EASY_FACETS = ['supplier', 'document_type', 'product', 'status', 'uploaded'] as const;
import type { FacetCount, SearchDroppedConstraint, SearchSort, UniversalSearchDocument } from '../../../shared/types';
import { chipParts } from '../../lib/searchChips';

/**
 * THE search surface (search redesign Phase 2) — one workspace behind both
 * /search and /documents, on the one query model.
 *
 *   omnibox    one wide input; what it reads appears as live chips at once
 *              (the browser's reading, confirmed by the server's tenant-aware
 *              one in the same request); Enter keeps them; every chip opens
 *              the clause editor; a rejected reading becomes the person's own
 *              words and is never re-read.
 *   answer     the AnswerCard leads — Covered / Likely · confirm / Nothing
 *              covers / Could mean N products — before any result.
 *   bands      Covering (checkbox) → Likely · confirm (Include anyway) →
 *              Nearby, does not cover (collapsed) → Still in Review Queue:
 *              exactly the 0115 gates, unchanged.
 *   ✦ Ask AI   explicit, never automatic; its reading comes back as chips
 *              marked as the AI's, each with its reason.
 *   preview    the certificate beside the results, the answering lot row named.
 *   keyboard   / focus · ↑↓ or j k move · Space select · ↵ open · E ZIP · S send
 *              · ⌘/Ctrl+Enter Ask AI · ⌘/Ctrl+K anywhere (Layout's palette).
 *
 * `surface="documents"` lists everything when nothing is asked and opens with
 * the facet rail; `surface="search"` starts from a quiet, empty answer.
 */
const PAGE_SIZE = 25;
/** Keystrokes inside this window are one search. */
const DEBOUNCE_MS = 250;

export interface SearchWorkspaceProps {
  surface?: 'search' | 'documents';
  syncToUrl?: boolean;
  tenantId?: string;
  /** Selection + ZIP / Send (0115). Off by default; the page decides (library module). */
  enableExport?: boolean;
  exportSender?: { name: string; email: string };
  /**
   * One more thing to do with the selection, beside ZIP / Send -- "Add to
   * order" on Documents, "Add to this order" in the order's own picker. It
   * turns selection on by itself, so a surface that only picks need not offer
   * export at all. The Include-anyway gate is untouched: a likely or nearby
   * result still has to be included on purpose before it can be acted on.
   */
  selectionAction?: SearchSelectionAction;
  /**
   * The page-wide shortcuts (/ focus, A mode, arrows, Space, Enter, E, S).
   * On by default. Off when the workspace sits inside a dialog, where a
   * document-level key handler would act on the page behind it and Enter would
   * navigate away from the thing being built.
   */
  globalShortcuts?: boolean;
}

export interface SearchSelectionAction {
  label: string;
  /**
   * Runs with the selected documents. Resolve with a sentence to show and the
   * selection clears; resolve with null when the person backed out and the
   * selection stays; reject and the error is shown.
   */
  onRun: (docs: UniversalSearchDocument[]) => Promise<string | null>;
  /** Hide ZIP / Send: this surface exists only to pick. */
  only?: boolean;
  testId?: string;
}

/** Shown only when the tenant's own examples are unavailable (empty tenant, no organization chosen). */
const FALLBACK_EXAMPLES = ['lot 10426203-03', 'butter produced Sep 2', 'PO K134273', 'lot 104', 'invoice 261149'];

export function SearchWorkspace({
  surface = 'search',
  syncToUrl = true,
  tenantId,
  enableExport = false,
  exportSender,
  selectionAction,
  globalShortcuts = true,
}: SearchWorkspaceProps) {
  const selectable = enableExport || !!selectionAction;
  const exportOffered = enableExport && !selectionAction?.only;
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up('lg'));
  const navigate = useNavigate();
  const modKey = modKeyLabel();

  // ── the query (the URL is the state) ─────────────────────────────────────
  const urlBound = useSearchQueryState();
  const [localQuery, setLocalQuery] = useState<SearchQuery>(EMPTY_QUERY);
  const query: SearchQuery = syncToUrl ? urlBound.query : localQuery;
  const queryRef = useRef(query);
  queryRef.current = query;
  // The box keeps exactly what is typed (the URL keeps it trimmed, which
  // would eat the space before the next word).
  const [draft, setDraft] = useState(query.text);
  useEffect(() => {
    setDraft((d) => (d.trim() === query.text.trim() ? d : query.text));
  }, [query.text]);
  const setQuery = useCallback(
    (next: SearchQuery, options?: { replace?: boolean }) => {
      queryRef.current = next;
      if (syncToUrl) urlBound.setQuery(next, options);
      else setLocalQuery(next);
    },
    [syncToUrl, urlBound],
  );

  /**
   * Easy ↔ Advanced (search Phase 3). The mode is only a presentation of the
   * same query: going to Advanced keeps what the box reads as rows (a chip is
   * a row), coming back shows the rows as chips. Nothing is re-serialized.
   */
  const setMode = useCallback(
    (mode: 'easy' | 'advanced') => {
      const cur = queryRef.current;
      if ((cur.view.mode === 'advanced') === (mode === 'advanced')) return;
      setQuery({ ...cur, view: { ...cur.view, mode: mode === 'advanced' ? 'advanced' : undefined, ...(mode === 'easy' ? { entity: 'documents' as const } : {}), page: undefined } });
    },
    [setQuery],
  );

  // ── running it ───────────────────────────────────────────────────────────
  const debouncedText = useDebouncedValue(query.text, DEBOUNCE_MS);
  const page = query.view.page ?? 1;
  const sort: SearchSort = query.view.sort ?? 'relevance';
  const advanced = query.view.mode === 'advanced';
  // The columns are presentation: changing them never re-asks the server.
  const sent = useMemo<SearchQuery>(
    // Easy shows documents only: a result mode left in the URL must never
    // quietly drop the clauses it does not apply to.
    () => ({ ...query, text: debouncedText, view: { ...query.view, columns: undefined, ...(advanced ? {} : { entity: 'documents' as const }) } }),
    [query, debouncedText, advanced],
  );
  const asked = sent.text.trim() !== '' || sent.clauses.length > 0;
  // A super_admin belongs to no organization: until one is chosen in the top
  // bar there is nothing to search, and the server's "tenant_id is required"
  // is not something to show a person.
  const auth = useOptionalAuth();
  const needsTenant = auth?.user?.role === 'super_admin' && !tenantId;
  const tried = useSearchExamples(tenantId, !needsTenant, FALLBACK_EXAMPLES);
  const run = useSearchRun({
    query: sent,
    tenantId,
    enabled: !needsTenant && (asked || surface === 'documents'),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    facetFields: advanced ? undefined : EASY_FACETS,
  });
  const data = run.data;
  const empty = !query.text.trim() && query.clauses.length === 0;

  // Notes survive the URL round trip here (the URL keeps raw words, not notes).
  const notes = useRef(new Map<string, string>());
  const [labelsExtra, setLabelsExtra] = useState<Record<string, string>>({});
  const rememberNotes = (cs: Clause[]) => {
    for (const c of cs) if (c.note) notes.current.set(encodeClause(c), c.note);
  };
  const labels = useMemo(() => ({ ...labelsExtra, ...(data?.labels ?? {}) }), [labelsExtra, data?.labels]);
  const constraintFor = useCallback((id: string) => data?.constraints?.find((k) => k.id === id) ?? null, [data?.constraints]);
  const kept = useMemo(
    () => query.clauses.map((c) => (c.note ? c : { ...c, note: notes.current.get(encodeClause(c)) ?? constraintFor(c.id)?.note ?? null })),
    [query.clauses, constraintFor],
  );

  // ── live chips: what the box reads right now ─────────────────────────────
  const boxText = query.text.replace(/\s+/g, ' ').trim();
  const serverRead = !!data && run.answeredText === boxText && boxText !== '';
  const optimistic = useMemo(() => detectOptimistic(boxText), [boxText]);
  const liveDetected: Clause[] = boxText ? (serverRead ? data?.interpreted?.clauses ?? [] : optimistic.clauses) : [];
  const liveResidual = boxText ? (serverRead ? data?.interpreted?.residual ?? boxText : optimistic.residual) : '';
  const live: Clause[] = useMemo(() => {
    const out = [...liveDetected];
    if (liveResidual && liveDetected.length > 0) out.push({ id: 'live-text', field: 'text', op: 'contains', values: [liveResidual], source: 'typed' });
    return out;
  }, [liveDetected, liveResidual]);

  // ── chips: commit, edit, reject ───────────────────────────────────────────
  const recent = useRecentSearches();
  const [editing, setEditing] = useState<string | null>(null);
  const chipEls = useRef(new Map<string, HTMLElement>());
  const registerChip = useCallback((id: string, el: HTMLElement | null) => {
    if (el) chipEls.current.set(id, el);
    else chipEls.current.delete(id);
  }, []);

  /** Enter: keep what the box reads. Returns the new clause ids. */
  const commit = useCallback(
    async (opts: { rejectIndex?: number; dropResidual?: boolean } = {}): Promise<string[]> => {
      const current = queryRef.current;
      const text = current.text.replace(/\s+/g, ' ').trim();
      if (!text) return [];
      recent.push(text);
      let det: { clauses: Clause[]; residual: string };
      if (run.data && run.answeredText === text) {
        det = { clauses: run.data.interpreted?.clauses ?? [], residual: run.data.interpreted?.residual ?? text };
      } else {
        try {
          det = (await api.search.interpret({ text, tenant_id: tenantId })) ?? detectOptimistic(text);
        } catch {
          det = detectOptimistic(text);
        }
      }
      rememberNotes(det.clauses);
      const res = commitInterpretation({ ...queryRef.current, text }, det.clauses, opts.dropResidual ? '' : det.residual, opts.rejectIndex);
      rememberNotes(res.query.clauses);
      setQuery(res.query);
      return res.ids;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run.data, run.answeredText, tenantId, recent, setQuery],
  );

  const openChip = useCallback(
    async (id: string, isLive: boolean) => {
      if (!isLive) {
        setEditing((cur) => (cur === id ? null : id));
        return;
      }
      const idx = live.findIndex((c) => c.id === id);
      const ids = await commit();
      const target = ids[idx === -1 ? ids.length - 1 : Math.min(idx, ids.length - 1)];
      if (target) setEditing(target);
    },
    [commit, live],
  );

  const removeChip = useCallback(
    (id: string, isLive: boolean) => {
      if (isLive) {
        if (id === 'live-text') void commit({ dropResidual: true });
        else void commit({ rejectIndex: liveDetected.findIndex((c) => c.id === id) });
        return;
      }
      setEditing(null);
      setQuery(withoutClause(queryRef.current, id));
    },
    [commit, liveDetected, setQuery],
  );

  const editingClause = editing ? kept.find((c) => c.id === editing) ?? null : null;

  // ── Ask AI ────────────────────────────────────────────────────────────────
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNotice, setAiNotice] = useState<{ summary: string; dropped: SearchDroppedConstraint[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const aiCtrl = useRef<AbortController | null>(null);
  const omniRef = useRef<HTMLInputElement>(null);

  const askAi = useCallback(
    async (forced?: string) => {
      const question = (forced ?? questionText(queryRef.current)).trim();
      if (!question) {
        setToast('Type a question first, then Ask AI.');
        omniRef.current?.focus();
        return;
      }
      aiCtrl.current?.abort();
      const c = new AbortController();
      aiCtrl.current = c;
      setAiBusy(true);
      setAiNotice(null);
      try {
        const res = await api.search.natural(question, tenantId, { clausesOnly: true, signal: c.signal });
        if (c.signal.aborted) return;
        const clauses = res.clauses ?? [];
        rememberNotes(clauses.map((x) => ({ ...x, source: 'ai' as const })));
        recent.push(question);
        const base = forced ? { ...EMPTY_QUERY, view: queryRef.current.view } : queryRef.current;
        setQuery(withAiReading(base, clauses));
        setAiNotice({ summary: res.parsed_query?.intent_summary ?? '', dropped: res.ai_dropped ?? [] });
        setToast(
          clauses.length
            ? `AI read your question as ${clauses.length} filter${clauses.length === 1 ? '' : 's'}. Each is marked ✦ — click one to see why.`
            : 'The AI found nothing in that question it could turn into a filter.',
        );
      } catch (e: unknown) {
        if (!c.signal.aborted) setToast(e instanceof Error ? e.message : 'AI search failed');
      } finally {
        if (aiCtrl.current === c) setAiBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantId, recent, setQuery],
  );

  // The command palette hands a question over as ?ai=1.
  const [params, setParams] = useSearchParams();
  const aiHandled = useRef(false);
  useEffect(() => {
    if (params.get('ai') !== '1') {
      aiHandled.current = false;
      return;
    }
    if (!syncToUrl || aiHandled.current) return;
    aiHandled.current = true;
    const q = params.get('q') ?? '';
    const next = new URLSearchParams(params);
    next.delete('ai');
    next.delete('q');
    setParams(next, { replace: true });
    if (q.trim()) void askAi(q);
  }, [params, setParams, syncToUrl, askAi]);

  // ── facets, sort, pages ───────────────────────────────────────────────────
  const [facetsOpen, setFacetsOpen] = useState(surface === 'documents');
  const facets = (data?.facets ?? {}) as Partial<Record<FacetField, FacetCount[]>>;
  const scopeIds = useMemo(() => new Set(query.clauses.flatMap((c) => (['supplier', 'product', 'document_type'].includes(c.field) ? c.values : []))), [query.clauses]);

  // ── selection + export (0115, unchanged gates) ───────────────────────────
  const [selectedDocs, setSelectedDocs] = useState<UniversalSearchDocument[]>([]);
  const [includedAnyway, setIncludedAnyway] = useState<Set<string>>(new Set());
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const selectedIds = useMemo(() => new Set(selectedDocs.map((d) => d.id)), [selectedDocs]);
  const toggleDoc = useCallback((doc: UniversalSearchDocument) => {
    setSelectedDocs((prev) => (prev.some((d) => d.id === doc.id) ? prev.filter((d) => d.id !== doc.id) : [...prev, doc]));
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
  const selection: SearchSelection | undefined = selectable
    ? { selectedIds, includedAnyway, onToggle: toggleDoc, onIncludeAnyway: includeAnyway, onSelectMany: selectMany }
    : undefined;

  const runDownload = useCallback(() => {
    if (!selectedDocs.length) return;
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
          recipients: input.recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
          on_behalf_of: input.onBehalfOf.trim() || undefined,
          message: input.message.trim() || undefined,
          tenant_id: tenantId,
        })
        .then((res) => {
          setSendOpen(false);
          setSelectedDocs([]);
          setIncludedAnyway(new Set());
          setExportNotice(
            `Sent ${res.document_count} document${res.document_count === 1 ? '' : 's'} to ${res.recipients.join(', ')}. ` +
              'Sent the wrong thing? Documents you sent (under Documents in the menu) can revoke the link.',
          );
        })
        .catch((e: unknown) => setExportError(e instanceof Error ? e.message : 'Send failed'))
        .finally(() => setExportBusy(false));
    },
    [selectedDocs, tenantId],
  );

  const runSelectionAction = useCallback(() => {
    if (!selectionAction || !selectedDocs.length) return;
    setExportBusy(true);
    setExportError(null);
    setExportNotice(null);
    selectionAction
      .onRun(selectedDocs)
      .then((notice) => {
        // null = the person backed out; what they chose is still chosen.
        if (notice === null) return;
        setSelectedDocs([]);
        setIncludedAnyway(new Set());
        setExportNotice(notice);
      })
      .catch((e: unknown) => setExportError(e instanceof Error ? e.message : 'That did not work'))
      .finally(() => setExportBusy(false));
  }, [selectionAction, selectedDocs]);

  // ── saved searches ────────────────────────────────────────────────────────
  const saved = useSavedSearches();
  const [savedOpen, setSavedOpen] = useState(false);

  // ── preview ───────────────────────────────────────────────────────────────
  const docs = useMemo(() => data?.documents ?? [], [data?.documents]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const previewDocRef = useRef<UniversalSearchDocument | null>(null);
  const found = previewId ? docs.find((d) => d.id === previewId) ?? null : null;
  if (found) previewDocRef.current = found;
  const previewDoc = previewId ? found ?? (previewDocRef.current?.id === previewId ? previewDocRef.current : null) : null;

  // On a wide screen the first answer is previewed without being asked.
  useEffect(() => {
    if (!wide || !data) return;
    if (previewId && docs.some((d) => d.id === previewId)) return;
    const first = docs.find((d) => d.match_status === 'covering') ?? docs.find((d) => d.match_status === 'likely_covering') ?? (data.coverage === 'unconstrained' || !data.coverage ? docs[0] : undefined);
    setPreviewId(first?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, data]);

  const preview = useCallback(
    (doc: UniversalSearchDocument, how: 'click' | 'focus' = 'click') => {
      setPreviewId(doc.id);
      // Moving through results with the keyboard never throws a drawer over them.
      if (!wide && how === 'click') setDrawerOpen(true);
    },
    [wide],
  );

  // ── keyboard ──────────────────────────────────────────────────────────────
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!globalShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][data-command-palette]')) return;
      if (e.key === 'Escape') {
        setEditing(null);
        setDrawerOpen(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const rows = Array.from(resultsRef.current?.querySelectorAll<HTMLElement>('[data-nav-row]') ?? []);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (e.key === '/') {
        e.preventDefault();
        omniRef.current?.focus();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setMode(queryRef.current.view.mode === 'advanced' ? 'easy' : 'advanced');
      } else if ((e.key === 'ArrowDown' || e.key === 'j') && rows.length) {
        e.preventDefault();
        rows[Math.min(rows.length - 1, at + 1)].focus();
      } else if ((e.key === 'ArrowUp' || e.key === 'k') && rows.length) {
        e.preventDefault();
        rows[Math.max(0, at - 1)].focus();
      } else if (e.key === ' ' && at >= 0) {
        // Space toggles the row's checkbox — and only a row that HAS one: a
        // likely or nearby result still needs Include anyway first (0115).
        const box = rows[at].querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (box) {
          e.preventDefault();
          box.click();
        }
      } else if (e.key === 'Enter' && at >= 0) {
        e.preventDefault();
        navigate(`/documents/${rows[at].dataset.docId}`);
      } else if (e.key === 'e' && exportOffered && selectedDocs.length) {
        e.preventDefault();
        runDownload();
      } else if (e.key === 's' && exportOffered && selectedDocs.length) {
        e.preventDefault();
        setExportError(null);
        setSendOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [globalShortcuts, exportOffered, selectedDocs.length, runDownload, navigate, setMode]);

  // ── the ambiguous product, if any ────────────────────────────────────────
  const ambiguousClause = kept.find((c) => c.field === 'product' && c.ambiguous && c.values.length > 1) ?? null;
  const identifying = (data?.coverage && data.coverage !== 'unconstrained') || false;
  const productCounts = useMemo(() => Object.fromEntries((facets.product ?? []).map((f) => [f.value, f.count])), [facets.product]);
  const countNoun = identifying ? 'covering or likely' : 'documents';

  const browseWords = useMemo(() => {
    const scope = data?.scope_summary ? data.scope_summary : null;
    const words = questionText(query);
    return [scope, words ? `mentioning “${words}”` : null].filter(Boolean).join(' · ') || null;
  }, [data?.scope_summary, query]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const keysPending = data?.keys_pending ?? 0;

  const results = (
    <Box ref={advanced ? undefined : resultsRef} sx={{ minWidth: 0 }}>
      {keysPending > 0 && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {keysPending} document{keysPending === 1 ? ' is' : 's are'} still being indexed for PO, invoice and date search, so this answer also checked every document in the current filters directly.
        </Alert>
      )}
      {aiNotice && (aiNotice.summary || aiNotice.dropped.length > 0) && (
        <Alert
          severity="info"
          icon={<Box component="span" sx={{ color: '#6c45d4' }}>✦</Box>}
          onClose={() => setAiNotice(null)}
          sx={{ mb: 1.5, bgcolor: 'rgba(108,69,212,.05)', color: 'text.primary', border: '1px solid rgba(108,69,212,.2)' }}
          data-testid="ai-notice"
        >
          {aiNotice.summary && <>AI understood: {aiNotice.summary}. </>}
          {aiNotice.dropped.map((d, i) => (
            <Box key={i} component="span" sx={{ display: 'block' }}>
              Not applied — “{d.label}”: {d.reason}
            </Box>
          ))}
        </Alert>
      )}
      {needsTenant && (asked || surface === 'documents') && (
        <Alert severity="info" sx={{ mb: 1.5 }}>Choose an organization in the top bar to search its documents.</Alert>
      )}
      {run.error && <Alert severity="error" sx={{ mb: 1.5 }}>{run.error}</Alert>}

      <AnswerCard
        coverage={data?.coverage}
        coverage_summary={data?.coverage_summary}
        documents={docs}
        dropped_constraints={data?.dropped_constraints}
        unreviewed_candidates={data?.unreviewed_candidates}
        coverage_scan_truncated={data?.coverage_scan_truncated}
        total={data?.total ?? 0}
        empty={empty && surface === 'search'}
        loading={run.loading && !data}
        browseWords={browseWords}
        paletteKey={`${modKey}K`}
        onPreview={(d) => preview(d, 'click')}
        onSelectCovering={selection ? selectMany : undefined}
        onAskAi={() => void askAi()}
        ambiguous={
          ambiguousClause
            ? {
                phrase: ambiguousClause.raw ?? chipParts(ambiguousClause, labels).value,
                candidates: ambiguousClause.values.map((id) => ({ id, label: labels[id] ?? id, count: productCounts[id] ?? 0 })),
                countNoun,
                onPick: (pid) => setQuery(replaceClause(query, ambiguousClause.id, { ...ambiguousClause, values: [pid], ambiguous: false, note: `You picked ${labels[pid] ?? 'this product'}.` })),
              }
            : null
        }
        empties={
          <Stack spacing={0.75} sx={{ mt: 1.5 }}>
            {recent.recent.length > 0 && (
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }} alignItems="center">
                <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>Recent</Typography>
                {recent.recent.slice(0, 5).map((ex) => (
                  <Button
                    key={ex}
                    size="small"
                    variant="outlined"
                    onClick={() => setQuery({ ...EMPTY_QUERY, view: query.view, text: ex })}
                    sx={{ textTransform: 'none', borderRadius: 999, py: 0.1, borderColor: 'divider', color: 'text.primary' }}
                  >
                    {ex}
                  </Button>
                ))}
              </Stack>
            )}
            {tried.examples.length > 0 && (tried.fromTenant || recent.recent.length === 0) && (
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }} alignItems="center" data-testid="search-examples">
                <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>Try</Typography>
                {tried.examples.map((ex) => (
                  <Tooltip key={ex.text} title={ex.label ?? ''} disableHoverListener={!ex.label}>
                    <Button
                      size="small"
                      variant="outlined"
                      data-teaching={ex.teaching ? 'true' : undefined}
                      onClick={() => setQuery({ ...EMPTY_QUERY, view: query.view, text: ex.text })}
                      sx={{
                        textTransform: 'none', borderRadius: 999, py: 0.1, borderColor: 'divider', color: 'text.primary',
                        ...(ex.teaching ? { borderStyle: 'dashed', color: 'text.secondary' } : {}),
                      }}
                    >
                      {ex.text}{ex.teaching ? ' — nothing on file' : ''}
                    </Button>
                  </Tooltip>
                ))}
              </Stack>
            )}
          </Stack>
        }
      />

      {!empty && <JumpRow words={questionText(query)} tenantId={tenantId} active={scopeIds} onFilter={(field, id, name) => {
        setLabelsExtra((l) => ({ ...l, [id]: name }));
        setQuery(withClause(query, { field, op: 'in', values: [id], source: 'builder' }));
      }} />}

      {data && (!empty || surface === 'documents') && (
        <>
          {!identifying && data.total > 0 && (
            <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
              <SortMenu
                value={sort}
                onChange={(next) => setQuery({ ...query, view: { ...query.view, sort: next === 'relevance' ? undefined : next, page: undefined } })}
              />
            </Stack>
          )}
          <CoverageResults
            bands
            documents={docs}
            coverage={data.coverage}
            constraints={data.constraints}
            dropped_constraints={data.dropped_constraints}
            coverage_summary={data.coverage_summary}
            unreviewed_candidates={data.unreviewed_candidates}
            coverage_scan_truncated={data.coverage_scan_truncated}
            selection={selection}
            onActivate={preview}
            activeId={previewId}
          />
          {!identifying && data.total === 0 && (data.unreviewed_candidates ?? []).length === 0 && (
            <Box sx={{ p: 3, textAlign: 'center', color: 'text.secondary', border: '1px dashed', borderColor: 'divider', borderRadius: 3 }} data-testid="no-results">
              Nothing on file matches every part of this.{' '}
              {questionText(query) ? (
                <Button size="small" onClick={() => void askAi()} sx={{ textTransform: 'none', color: '#6c45d4' }}>
                  ✦ Ask AI to read it as a question
                </Button>
              ) : (
                'Remove a chip to widen it.'
              )}
            </Box>
          )}
          {totalPages > 1 && (
            <Stack alignItems="center" sx={{ mt: 2 }}>
              <Pagination
                count={totalPages}
                page={page}
                onChange={(_, p) => setQuery({ ...query, view: { ...query.view, page: p > 1 ? p : undefined } })}
                size="small"
              />
            </Stack>
          )}
        </>
      )}
    </Box>
  );

  const advancedResults = (
    <Box ref={advanced ? resultsRef : undefined} sx={{ minWidth: 0 }}>
      <FilterBuilder
        query={query}
        labels={labels}
        facets={facets}
        onChange={setQuery}
        notApplied={data?.not_applied ?? []}
        entity={query.view.entity ?? 'documents'}
        tenantId={tenantId}
        onLabel={(id, name) => setLabelsExtra((l) => ({ ...l, [id]: name }))}
      />
      <Box sx={{ mt: 2 }}>
        {run.error && <Alert severity="error" sx={{ mb: 1.5 }}>{run.error}</Alert>}
        {needsTenant && <Alert severity="info" sx={{ mb: 1.5 }}>Choose an organization in the top bar to search its documents.</Alert>}
        {identifying && data && (
          <AnswerCard
            coverage={data.coverage}
            coverage_summary={data.coverage_summary}
            documents={docs}
            dropped_constraints={data.dropped_constraints}
            unreviewed_candidates={data.unreviewed_candidates}
            coverage_scan_truncated={data.coverage_scan_truncated}
            total={data.total}
            empty={false}
            loading={false}
            browseWords={browseWords}
            paletteKey={`${modKey}K`}
            onPreview={(d) => preview(d, 'click')}
            onSelectCovering={selection ? selectMany : undefined}
            onAskAi={() => void askAi()}
          />
        )}
        {data && (
          <AdvancedResults
            data={data}
            query={query}
            onQuery={setQuery}
            selection={selection}
            onActivate={preview}
            activeId={previewId}
          />
        )}
        {data && (query.view.entity ?? 'documents') === 'documents' && totalPages > 1 && (
          <Stack alignItems="center" sx={{ mt: 2 }}>
            <Pagination count={totalPages} page={page} onChange={(_, p) => setQuery({ ...query, view: { ...query.view, page: p > 1 ? p : undefined } })} size="small" />
          </Stack>
        )}
      </Box>
    </Box>
  );

  return (
    <Box data-testid="search-workspace">
      <Omnibox
        ref={omniRef}
        text={draft}
        onTextChange={(t) => {
          setDraft(t);
          setQuery({ ...queryRef.current, text: t, view: { ...queryRef.current.view, page: undefined } }, { replace: true });
        }}
        kept={advanced ? [] : kept}
        live={live}
        livePending={!!boxText && !serverRead}
        labels={labels}
        constraintFor={constraintFor}
        onCommit={() => void commit()}
        onBackspaceEmpty={() => {
          const last = queryRef.current.clauses[queryRef.current.clauses.length - 1];
          if (last) setQuery(withoutClause(queryRef.current, last.id));
        }}
        onOpenChip={(id, isLive) => void openChip(id, isLive)}
        onRemoveChip={removeChip}
        registerChip={registerChip}
        selectedChipId={editing}
        onAskAi={() => void askAi()}
        aiBusy={aiBusy}
        busy={run.loading}
        modKey={modKey}
        placeholder={
          tried.fromTenant
            ? tried.examples.filter((e) => !e.teaching).slice(0, 3).map((e) => e.text).join(' · ') || undefined
            : undefined
        }
      />

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5, mb: 2, flexWrap: 'wrap' }} useFlexGap>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={advanced ? 'advanced' : 'easy'}
          onChange={(_, v: 'easy' | 'advanced' | null) => v && setMode(v)}
          aria-label="Search mode"
          sx={{ '& .MuiToggleButton-root': { textTransform: 'none', py: 0.25, px: 1.25 } }}
        >
          <ToggleButton value="easy" data-testid="mode-easy">Easy</ToggleButton>
          <ToggleButton value="advanced" data-testid="mode-advanced">Advanced</ToggleButton>
        </ToggleButtonGroup>
        {!advanced && (
          <Button
            size="small"
            startIcon={<TuneRoundedIcon />}
            onClick={() => setFacetsOpen((v) => !v)}
            variant={facetsOpen ? 'contained' : 'text'}
            disableElevation
            sx={{ textTransform: 'none', borderRadius: 2 }}
            aria-pressed={facetsOpen}
            data-testid="toggle-filters"
          >
            Filters
          </Button>
        )}
        <Button
          size="small"
          startIcon={<BookmarkBorderRoundedIcon />}
          onClick={() => setSavedOpen(true)}
          sx={{ textTransform: 'none', borderRadius: 2 }}
        >
          Saved searches
        </Button>
        {data?.scope_summary && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }} noWrap>
            Within: {splitScope(`x Searched within: ${data.scope_summary}`).scope}
          </Typography>
        )}
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 2.5,
          alignItems: 'start',
          gridTemplateColumns: advanced
            ? { xs: '1fr', md: '232px minmax(0, 1fr)', lg: '232px minmax(0, 1fr) minmax(320px, 0.7fr)' }
            : {
              xs: '1fr',
              md: facetsOpen ? '240px minmax(0, 1fr)' : 'minmax(0, 1fr)',
              lg: `${facetsOpen ? '240px ' : ''}minmax(0, 1fr) minmax(360px, 0.8fr)`,
            },
        }}
      >
        {advanced ? (
          <AdvancedFacetRail query={query} facets={facets} onChange={setQuery} loading={run.loading} countsAnswers={!!identifying} />
        ) : (
          facetsOpen && <FacetSidebar query={query} facets={facets} onChange={setQuery} loading={run.loading} />
        )}
        {advanced ? advancedResults : results}
        {wide && (
          <Box sx={{ position: 'sticky', top: 16, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', pr: 0.5 }}>
            <PreviewPane doc={previewDoc} />
          </Box>
        )}
      </Box>

      {!wide && (
        <Drawer anchor="right" open={drawerOpen && !!previewDoc} onClose={() => setDrawerOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 560 }, p: 2 } }}>
          <PreviewPane doc={previewDoc} onClose={() => setDrawerOpen(false)} />
        </Drawer>
      )}

      {globalShortcuts && <KeyboardLegend modKey={modKey} exportOn={exportOffered} advanced={advanced} />}

      <Popover
        open={!!editingClause}
        anchorEl={() => (editing ? chipEls.current.get(editing) ?? document.body : document.body)}
        onClose={() => setEditing(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 1, borderRadius: 3, boxShadow: '0 1px 3px rgba(15,26,46,.05), 0 30px 60px -24px rgba(15,26,46,.35)' } } }}
      >
        {editingClause && (
          <ClauseEditor
            clause={editingClause}
            labels={labels}
            constraint={constraintFor(editingClause.id)}
            productCounts={productCounts}
            countNoun={countNoun}
            onChange={(next) => {
              if (next.note) notes.current.set(encodeClause(next), next.note);
              setQuery(replaceClause(queryRef.current, editingClause.id, next));
            }}
            onAsText={() => {
              setQuery(clauseAsText(queryRef.current, editingClause.id, labels));
              setEditing(null);
            }}
            onRemove={() => {
              setQuery(withoutClause(queryRef.current, editingClause.id));
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </Popover>

      <SavedSearchesDialog
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        currentState={{ q: query.text }}
        currentPreview={queryKey(query)}
        saved={saved.saved}
        canShare={auth?.user?.role === 'org_admin' || (auth?.user?.role === 'super_admin' && !!auth?.user?.tenant_id)}
        onSave={async (name: string, shared?: boolean) => {
          // A view keeps its mode, result mode, columns and sort — never the page.
          const view = { ...query.view, page: undefined };
          await saved.create({ name, query: { ...query, view } as unknown as Record<string, unknown>, ...(shared ? { scope: 'shared' as const } : {}) });
        }}
        onLoad={(s: { query: Record<string, unknown> }) => setQuery(savedPayloadToQuery(s.query))}
        onDelete={saved.remove}
      />

      {selectable && (
        <>
          <ExportSelectionBar
            count={selectedDocs.length}
            busy={exportBusy}
            error={exportError}
            notice={exportNotice}
            hideExport={!exportOffered}
            extraAction={
              selectionAction
                ? { label: selectionAction.label, onClick: runSelectionAction, testId: selectionAction.testId, primary: !exportOffered }
                : undefined
            }
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
          {exportOffered && <SendExportDialog
            open={sendOpen}
            documents={selectedDocs}
            senderName={exportSender?.name ?? 'You'}
            senderEmail={exportSender?.email ?? 'your address'}
            busy={exportBusy}
            error={sendOpen ? exportError : null}
            onClose={() => setSendOpen(false)}
            onSend={runSend}
          />}
        </>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={4200}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
}

function KeyboardLegend({ modKey, exportOn, advanced = false }: { modKey: string; exportOn: boolean; advanced?: boolean }) {
  const keys: Array<[string, string]> = [
    ['/', 'focus search'],
    [`${modKey}K`, 'search anywhere'],
    ['A', advanced ? 'Easy mode' : 'Advanced mode'],
    ...(advanced ? ([['X', 'exclude a facet value']] as Array<[string, string]>) : []),
    ['↑ ↓', 'move through results'],
    ['Space', 'select'],
    ['↵', 'open'],
    [`${modKey}↵`, 'Ask AI'],
    ...(exportOn ? ([['E', 'download ZIP'], ['S', 'send']] as Array<[string, string]>) : []),
    ['Esc', 'close'],
  ];
  return (
    <Stack
      direction="row"
      spacing={2}
      useFlexGap
      sx={{ mt: 4, pt: 1.5, borderTop: '1px solid', borderColor: 'divider', flexWrap: 'wrap', display: { xs: 'none', md: 'flex' } }}
      data-testid="keyboard-legend"
    >
      {keys.map(([k, l]) => (
        <Typography key={k} variant="caption" color="text.secondary">
          <Kbd>{k}</Kbd> {l}
        </Typography>
      ))}
    </Stack>
  );
}
