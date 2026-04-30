/**
 * ConnectorDetail page — "see everything + edit inline" rework.
 *
 * The previous incarnation split config and runs into tabs and forced the
 * user to either (a) edit raw JSON via the "Edit" toggle or (b) round-trip
 * back through the multi-step wizard just to change a single subject
 * pattern. This rewrite surfaces the full connector config as a set of
 * cards with in-place editing, using PUT /api/connectors/:id as a PATCH
 * (the backend already treats omitted fields as "leave alone").
 *
 * Saves are fired on blur / toggle change and reflected optimistically —
 * failures roll the state back and show an Alert. A snackbar confirms
 * successful saves.
 *
 * The wizard is still reachable (for full re-discovery with a new sample
 * file) via the "Remap" and "Re-test" buttons on the Sample card.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { formatDate } from '../../utils/format';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormHelperText,
  Pagination,
  Paper,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Science as TestIcon,
  FileUpload as UploadIcon,
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  ContentCopy as CopyIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
  Autorenew as RotateIcon,
  Key as KeyIcon,
  Link as LinkIcon,
  OpenInNew as OpenInNewIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { Tenant } from '../../lib/types';
import {
  defaultFieldMappings,
  normalizeFieldMappings,
  DOX_FIELD_LABELS,
  type ConnectorFieldMappings,
  type CoreFieldKey,
} from '../../components/connectors/doxFields';
import { FieldMappingEditor } from '../../components/connectors/FieldMappingEditor';
import { ACCEPTED_CONNECTOR_FILE_EXTENSIONS } from '../../../shared/connectorFileTypes';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface Connector {
  id: string;
  name: string;
  /** Phase B0.5 — globally-unique URL-safe handle. Used everywhere
   * vendors see the connector (API endpoint, email address, S3 bucket,
   * public link). NULL only on legacy rows that pre-date the backfill. */
  slug: string | null;
  config: Record<string, unknown>;
  field_mappings: ConnectorFieldMappings;
  schedule: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
  sample_r2_key: string | null;
  /** Phase B2 — per-connector HTTP POST drop bearer token. NULL on
   * legacy connectors created before the auto-generate flow shipped;
   * those need a rotation to bootstrap. */
  api_token: string | null;
  /** Phase B3 — per-connector S3 drop bucket. NULL until the owner
   * provisions it via the "Set up S3 drop" affordance. Auto-set on
   * fresh connector create when the env has the CF API token. */
  r2_bucket_name: string | null;
  /** Phase B3 — vendor-facing R2 access key id. Plaintext at rest is
   * fine — paired with a per-bucket-scoped secret that's rotatable. */
  r2_access_key_id: string | null;
  /** Phase B3 — server-side flag indicating the encrypted secret
   * exists in the DB. The plaintext secret is NOT recoverable from
   * the row; we only show it ONCE on provision/rotate. */
  has_r2_secret: boolean;
  /** Phase B3 — R2 S3-compatible endpoint URL. Comes from the GET
   * response when the env has CLOUDFLARE_ACCOUNT_ID configured.
   * Blank in local dev / dev shells without that secret. */
  r2_endpoint: string | null;
  /** Phase B4 — per-connector public drop link token. NULL means no
   * link is active; vendors hitting `/drop/<slug>/<token>` get the
   * "not active" page until the owner generates one here. */
  public_link_token: string | null;
  /** Phase B4 — unix-seconds expiry for the public link. NULL means
   * no expiry (link is active until the token is revoked or rotated). */
  public_link_expires_at: number | null;
}

interface ConnectorRun {
  id: string;
  connector_id: string;
  status: 'success' | 'error' | 'partial' | 'running';
  started_at: string;
  completed_at: string | null;
  records_found: number;
  records_created: number;
  records_errored: number;
  error_message: string | null;
  /** Phase B5: which intake door this run came in through. NULL on
   *  pre-0049 historical rows. */
  source: string | null;
  /** Phase B5: when set, this run is a retry of an earlier failed run.
   *  Surfaces a "retry of …" pill in the runs table. */
  retry_of_run_id: string | null;
}

/** Phase B5 — observability snapshot from GET /api/connectors/:id/health. */
interface ConnectorHealth {
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
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function runStatusColor(status: ConnectorRun['status']): 'success' | 'error' | 'warning' | 'info' {
  switch (status) {
    case 'success': return 'success';
    case 'error': return 'error';
    case 'partial': return 'warning';
    case 'running': return 'info';
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fallthrough */ }
  }
  return {};
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x): x is string => typeof x === 'string');
}

function normalizeConnector(raw: unknown): Connector {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    slug: (r.slug as string | null) ?? null,
    config: asRecord(r.config),
    field_mappings: normalizeFieldMappings(r.field_mappings),
    schedule: (r.schedule as string | null) ?? null,
    active: !!r.active,
    last_run_at: (r.last_run_at as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
    tenant_id: String(r.tenant_id ?? ''),
    sample_r2_key: (r.sample_r2_key as string | null) ?? null,
    api_token: (r.api_token as string | null) ?? null,
    r2_bucket_name: (r.r2_bucket_name as string | null) ?? null,
    r2_access_key_id: (r.r2_access_key_id as string | null) ?? null,
    has_r2_secret: !!r.has_r2_secret,
    r2_endpoint: (r.r2_endpoint as string | null) ?? null,
    public_link_token: (r.public_link_token as string | null) ?? null,
    public_link_expires_at:
      typeof r.public_link_expires_at === 'number'
        ? r.public_link_expires_at
        : null,
  };
}

const RUNS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Location state shape used by the wizard to flag a freshly-created
 * connector. Phase B0 universal model: connectors no longer carry a
 * per-row type, so the toast message is generic — partners are pointed
 * at the universal manual upload zone above and the receive address
 * card; they can pick whichever intake path matches their setup.
 */
interface ConnectorDetailLocationState {
  justCreated?: boolean;
}

export function ConnectorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [connector, setConnector] = useState<Connector | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSnack, setSaveSnack] = useState('');
  // Tracks whether the wizard's "just created" hint has already been
  // surfaced for this navigation, so we don't re-trigger the toast on
  // every state change once the connector / tenant load resolves.
  const justCreatedHintShownRef = useRef(false);

  // Inline edit state — name is the only field with a "click to edit" cycle.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // Runs
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(false);
  // Phase B5: in-flight retry indicator keyed by the failed run id.
  // Multiple retries can run in parallel without state contention.
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  // Phase B5: observability snapshot (24h dispatched, success rate,
  // last error, per-source pills). Refreshed alongside the runs list
  // so a freshly-dispatched run reflects in the card without a hard
  // page reload.
  const [health, setHealth] = useState<ConnectorHealth | null>(null);

  // Action state
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // file_watch drop-zone state — separate from `running` so we can drive the
  // visual hover state independently. The hidden file-input ref lets a click
  // on the zone open the native file picker without rendering a separate
  // button.
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runsRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------------

  const loadConnector = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = (await api.connectors.get(id)) as { connector: unknown };
      const c = normalizeConnector(result.connector);
      setConnector(c);
      setNameDraft(c.name);
      // Fetch tenant for the "receive address" display. Non-fatal if it fails.
      if (c.tenant_id) {
        try {
          const t = await api.tenants.get(c.tenant_id);
          setTenant(t);
        } catch {
          setTenant(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connector');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadRuns = useCallback(async () => {
    if (!id) return;
    setRunsLoading(true);
    try {
      const result = (await api.connectors.runs(id, {
        limit: RUNS_PER_PAGE,
        offset: (runsPage - 1) * RUNS_PER_PAGE,
      })) as { runs: ConnectorRun[]; total: number };
      setRuns(result.runs);
      setRunsTotal(result.total);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [id, runsPage]);

  // Phase B5 — pull the health snapshot. Best-effort: a 4xx/5xx leaves
  // `health` null and the card silently hides rather than blocking the
  // page render. Refreshes on the same trigger as the runs list so a
  // dispatched-then-completed run is reflected without manual reload.
  const loadHealth = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.connectors.health(id);
      setHealth(result);
    } catch {
      setHealth(null);
    }
  }, [id]);

  useEffect(() => { loadConnector(); }, [loadConnector]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  // ---------------------------------------------------------------------
  // Wizard end-state hint (Phase A2.3) — fires once per navigation when
  // the wizard hands off a freshly-created connector via location state.
  // Email connectors get the receive address inlined; file_watch points
  // at the drop zone above. Edits don't carry the flag, so this is silent
  // for the inline-edit / remap flows.
  //
  // Waits for the connector AND (for email) the tenant to finish loading
  // so the toast can show the actual `slug@domain` address. The `ref`
  // guard prevents re-firing if either record refreshes after the first
  // successful render.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (justCreatedHintShownRef.current) return;
    if (loading || !connector) return;
    const state = (location.state || null) as ConnectorDetailLocationState | null;
    if (!state?.justCreated) return;

    // `loadConnector` resolves both the connector AND tenant fetches
    // before flipping `loading` to false, so by this point `tenant` is
    // either populated or known-null (fetch failed). Phase B0 universal
    // model: every connector exposes every intake door, so the toast
    // points the partner at the manual upload zone (the most direct
    // path) and the receive-address card below.
    const tenantSlug = tenant?.slug ?? null;
    const isStaging =
      typeof window !== 'undefined' &&
      !!window.location?.host &&
      (window.location.host.toLowerCase().includes('staging') ||
        window.location.host.toLowerCase().endsWith('.pages.dev'));
    const emailDomain = isStaging ? 'supdox-staging.com' : 'supdox.com';
    const address = tenantSlug ? `${tenantSlug}@${emailDomain}` : null;
    const message = address
      ? `Connector created. Drop a file in the upload zone above to test, or send email to ${address}.`
      : 'Connector created. Drop a file in the upload zone above, or use the receive address card below.';

    setSaveSnack(message);
    justCreatedHintShownRef.current = true;
    // Clear the marker so a manual refresh of the detail page doesn't
    // re-trigger the hint. `replace: true` swaps the current history
    // entry rather than pushing a new one.
    navigate(location.pathname, { replace: true, state: null });
  }, [loading, connector, tenant, location.state, location.pathname, navigate]);

  // ---------------------------------------------------------------------
  // Patch helper — optimistic update with rollback on error.
  // ---------------------------------------------------------------------

  const patchConnector = useCallback(
    async (partial: Record<string, unknown>, optimistic?: Partial<Connector>) => {
      if (!id || !connector) return;
      const prev = connector;
      if (optimistic) {
        setConnector({ ...prev, ...optimistic });
      }
      try {
        const result = (await api.connectors.patch(id, partial)) as { connector: unknown };
        setConnector(normalizeConnector(result.connector));
        setSaveSnack('Changes saved');
      } catch (err) {
        setConnector(prev);
        setError(err instanceof Error ? err.message : 'Failed to save changes');
      }
    },
    [id, connector],
  );

  // ---------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------

  const [probeResult, setProbeResult] = useState<{
    ok: boolean;
    message: string;
    details: Record<string, unknown>;
  } | null>(null);

  const handleTest = async () => {
    if (!id) return;
    setTesting(true);
    setError('');
    try {
      const result = (await api.connectors.test(id)) as {
        success: boolean;
        message: string;
        warnings?: string[];
        probe?: {
          probe: string;
          ok: boolean;
          message: string;
          details: Record<string, unknown>;
        };
      };
      if (result.probe) {
        setProbeResult({
          ok: result.probe.ok,
          message: result.probe.message,
          details: result.probe.details,
        });
      } else {
        // Legacy shape — fall back to top-level message.
        setProbeResult({
          ok: result.success,
          message: result.message,
          details: {},
        });
      }
      setSaveSnack(result.message || 'Connection test complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
      setProbeResult(null);
    } finally {
      setTesting(false);
    }
  };

  // Accepted-extension list lives in shared/connectorFileTypes.ts so this
  // drop zone and the server-side classifier in
  // functions/api/connectors/[id]/run.ts cannot drift apart.
  const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — safety cap; the backend
                                            // enforces tighter per-kind limits.

  const validateRunFile = useCallback((file: File): string | null => {
    const name = file.name.toLowerCase();
    if (!ACCEPTED_CONNECTOR_FILE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      return `Unsupported file type. Accepted: ${ACCEPTED_CONNECTOR_FILE_EXTENSIONS.join(', ')}`;
    }
    if (file.size > MAX_FILE_BYTES) {
      return `File too large (${Math.round(file.size / 1024 / 1024)}MB). Limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB.`;
    }
    return null;
  }, []);

  const handleRunFile = useCallback(async (file: File) => {
    if (!id) return;
    const validationError = validateRunFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setRunning(true);
    setError('');
    try {
      await api.connectors.run(id, file);
      setSaveSnack('Manual run started');
      await loadRuns();
      // Bring the runs panel into view so the new row is visible without a
      // manual scroll. `behavior: 'smooth'` is fine here — the table is
      // already populated by the awaited loadRuns() above.
      requestAnimationFrame(() => {
        runsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start manual run');
    } finally {
      setRunning(false);
    }
  }, [id, loadRuns, validateRunFile]);

  const handleDropZoneClick = () => {
    if (running) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleRunFile(file);
    // Reset so picking the same filename twice still fires onChange.
    e.target.value = '';
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (running) return;
    setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (running) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleRunFile(file);
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api.connectors.delete(id);
      navigate('/admin/connectors');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connector');
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  /**
   * Phase B5 — retry a failed run. The backend refetches the original
   * file and dispatches a new run linked via `retry_of_run_id`. We
   * surface the standard 422 ("source no longer retrievable") and 400
   * ("not in error state") errors as inline alerts; success refreshes
   * the runs panel so the new row appears at the top.
   */
  const handleRetryRun = useCallback(
    async (runId: string) => {
      if (!id) return;
      setRetryingRunId(runId);
      setError('');
      try {
        const result = await api.connectors.retryRun(id, runId);
        setSaveSnack(`Retry dispatched (run ${result.run_id.slice(0, 8)}…)`);
        await Promise.all([loadRuns(), loadHealth()]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to retry run';
        setError(msg);
      } finally {
        setRetryingRunId(null);
      }
    },
    [id, loadRuns, loadHealth],
  );

  const commitName = () => {
    if (!connector) return;
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === connector.name) {
      setNameDraft(connector.name);
      return;
    }
    patchConnector({ name: trimmed }, { name: trimmed });
  };

  const updateConfigKey = (key: string, value: unknown) => {
    if (!connector) return;
    const nextConfig = { ...connector.config, [key]: value };
    patchConnector({ config: nextConfig }, { config: nextConfig });
  };

  const commitFieldMappings = (next: ConnectorFieldMappings) => {
    if (!connector) return;
    patchConnector({ field_mappings: next }, { field_mappings: next });
  };

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!connector) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">Connector not found</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/admin/connectors')} sx={{ mt: 2 }}>
          Back to Connectors
        </Button>
      </Box>
    );
  }

  const runsTotalPages = Math.max(1, Math.ceil(runsTotal / RUNS_PER_PAGE));
  const hasStoredSample = !!connector.sample_r2_key;
  const r2Prefix =
    typeof connector.config.r2_prefix === 'string' ? connector.config.r2_prefix.trim() : '';

  // Field-mapping summary for the drop zone — show how many enabled core
  // fields exist so the user knows what columns the file should contain.
  // Core fields don't carry their own label on the mapping value; labels come
  // from the canonical CORE_FIELD_DEFINITIONS catalog (re-exported as
  // DOX_FIELD_LABELS).
  const enabledCoreFieldLabels: string[] = (() => {
    const core = connector.field_mappings?.core;
    if (!core) return [];
    const out: string[] = [];
    for (const key of Object.keys(core) as CoreFieldKey[]) {
      if (core[key]?.enabled) {
        out.push(DOX_FIELD_LABELS[key] ?? key);
      }
    }
    return out;
  })();
  const extendedCount = connector.field_mappings?.extended?.length ?? 0;
  const totalEnabledMappings = enabledCoreFieldLabels.length + extendedCount;

  return (
    <Box>
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/connectors')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Connectors
      </Button>

      <HelpWell id="connectors.detail" title={helpContent.connectors.detail.headline}>
        {helpContent.connectors.detail.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* ------------------------------------------------------------ */}
      {/* 1. Header card                                                */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', md: 'flex-start' }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {editingName ? (
              <TextField
                size="small"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') {
                    setNameDraft(connector.name);
                    setEditingName(false);
                  }
                }}
                autoFocus
                sx={{ mb: 1, minWidth: 320 }}
              />
            ) : (
              <Box
                sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, cursor: 'pointer' }}
                onClick={() => setEditingName(true)}
                role="button"
                aria-label="Edit connector name"
              >
                <Typography variant="h4" fontWeight={700}>
                  {connector.name}
                </Typography>
                <EditIcon fontSize="small" color="action" />
              </Box>
            )}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
              <Chip
                label={connector.active ? 'Active' : 'Inactive'}
                size="small"
                color={connector.active ? 'success' : 'default'}
              />
              {/* Phase B0.5 slug pill — vendor-facing handle. The
                  InfoTooltip explains *what* the slug is for; the title
                  attr remains for admins who want a quick hover-copy
                  confirmation. */}
              {connector.slug && (
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                  <Chip
                    label={connector.slug}
                    size="small"
                    variant="outlined"
                    title={`URL slug: ${connector.slug}`}
                    sx={{ fontFamily: 'monospace' }}
                  />
                  <InfoTooltip text={helpContent.connectors.detail.slugTooltip} />
                </Box>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Last run: {formatRelativeTime(connector.last_run_at)}
              {tenant && <> &middot; Tenant: {tenant.name}</>}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="caption" color="text.secondary">
                {connector.active ? 'Active' : 'Inactive'}
              </Typography>
              <Switch
                checked={connector.active}
                onChange={(e) =>
                  patchConnector({ active: e.target.checked }, { active: e.target.checked })
                }
                size="small"
              />
            </Stack>
            <Button
              variant="outlined"
              size="small"
              startIcon={<TestIcon />}
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test'}
            </Button>
            {/*
              Phase B0 universal model: manual runs go through the drop
              zone below (multipart upload). Email runs go through the
              inbound email webhook. The header Run button is no longer
              needed — every door has its own card with the right CTA.
            */}
            <Button
              variant="outlined"
              size="small"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {/* ------------------------------------------------------------ */}
      {/* Phase B5 — Health card. Sits below the header so the very     */}
      {/* first thing an admin sees on a connector page is "is it       */}
      {/* dispatching, and is it succeeding?". Hidden on first load     */}
      {/* until the snapshot resolves so the layout doesn't pop.        */}
      {/* ------------------------------------------------------------ */}
      {health && (
        <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', md: 'center' }}
            justifyContent="space-between"
          >
            <Box>
              <Typography variant="overline" color="text.secondary">
                Health (last {health.window_hours}h)
              </Typography>
              {health.last_24h.dispatched === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No activity in the last {health.window_hours} hours.
                </Typography>
              ) : (
                <Stack direction="row" spacing={2} alignItems="baseline" flexWrap="wrap" useFlexGap>
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                    <Typography variant="h6" fontWeight={600}>
                      {health.last_24h.dispatched} dispatched
                    </Typography>
                    <InfoTooltip text={helpContent.connectors.detail.healthCard.dispatched24h} />
                  </Box>
                  {health.last_24h.success_rate !== null && (
                    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                      <Typography
                        variant="body2"
                        color={
                          health.last_24h.success_rate >= 90
                            ? 'success.main'
                            : health.last_24h.success_rate >= 70
                              ? 'warning.main'
                              : 'error.main'
                        }
                        fontWeight={600}
                      >
                        {health.last_24h.success_rate}% success
                      </Typography>
                      <InfoTooltip text={helpContent.connectors.detail.healthCard.successRate} />
                    </Box>
                  )}
                  {health.last_24h.error > 0 && (
                    <Typography variant="body2" color="error">
                      {health.last_24h.error} error{health.last_24h.error === 1 ? '' : 's'}
                    </Typography>
                  )}
                  {health.last_24h.partial > 0 && (
                    <Typography variant="body2" color="warning.main">
                      {health.last_24h.partial} partial
                    </Typography>
                  )}
                </Stack>
              )}
            </Box>
            {/* Per-source pills — only show non-zero buckets so the row
                doesn't degenerate into noise on quiet connectors. */}
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
              {Object.entries(health.by_source)
                .filter(([, count]) => count > 0)
                .map(([source, count]) => (
                  <Chip
                    key={source}
                    label={`${source}: ${count}`}
                    size="small"
                    variant="outlined"
                    sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
                  />
                ))}
              {Object.values(health.by_source).some((c) => c > 0) && (
                <InfoTooltip text={helpContent.connectors.detail.healthCard.perSourceBreakdown} />
              )}
            </Stack>
          </Stack>
          {health.last_error && (
            <Alert
              severity="error"
              variant="outlined"
              sx={{ mt: 2 }}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    runsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  View
                </Button>
              }
            >
              <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                <Typography variant="caption" color="text.secondary">
                  Last error · {formatRelativeTime(health.last_error.started_at)}
                </Typography>
                <InfoTooltip text={helpContent.connectors.detail.healthCard.lastError} />
              </Box>
              <Typography
                variant="body2"
                sx={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {health.last_error.error_message || '(no message)'}
              </Typography>
            </Alert>
          )}
        </Paper>
      )}

      {/* Live probe result — surfaces after the user clicks Test */}
      {probeResult && (
        <Alert
          severity={probeResult.ok ? 'success' : 'warning'}
          sx={{ mb: 3 }}
          onClose={() => setProbeResult(null)}
        >
          <Typography variant="body2" fontWeight={600}>
            {probeResult.message}
          </Typography>
          <ProbeDetails details={probeResult.details} />
        </Alert>
      )}

      {/* ------------------------------------------------------------ */}
      {/* Manual upload drop zone — Phase B0 universal-doors model.    */}
      {/* Every connector has this door; surface it first because       */}
      {/* dropping a file is the most direct way to test a connector.  */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Typography variant="h6" fontWeight={600}>
            Manual upload
          </Typography>
          <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.manual} />
        </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
            Drop a file to run this connector against it now. Uses the field
            mappings configured below; results appear in the runs panel below.
          </Typography>

          <Box
            sx={{
              mb: 2,
              p: 1.5,
              bgcolor: 'grey.50',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
            }}
          >
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              {totalEnabledMappings} field mapping{totalEnabledMappings === 1 ? '' : 's'} configured
            </Typography>
            {enabledCoreFieldLabels.length > 0 ? (
              <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                Expected fields:{' '}
                {enabledCoreFieldLabels.slice(0, 6).join(', ')}
                {enabledCoreFieldLabels.length > 6 && ` +${enabledCoreFieldLabels.length - 6} more`}
                {extendedCount > 0 && ` (+${extendedCount} extended)`}
              </Typography>
            ) : (
              <Typography variant="caption" display="block" sx={{ mt: 0.5 }} color="warning.main">
                No core fields enabled — configure mappings before uploading.
              </Typography>
            )}
          </Box>

          <Box
            onClick={handleDropZoneClick}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            aria-label="Drop a file to run the connector"
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !running) {
                e.preventDefault();
                handleDropZoneClick();
              }
            }}
            sx={{
              p: 4,
              border: '2px dashed',
              borderColor: dragActive ? 'primary.main' : 'divider',
              borderRadius: 2,
              textAlign: 'center',
              cursor: running ? 'not-allowed' : 'pointer',
              bgcolor: dragActive ? 'primary.50' : running ? 'grey.100' : 'background.paper',
              opacity: running ? 0.7 : 1,
              transition: 'background-color 120ms, border-color 120ms',
              '&:hover': running ? undefined : { borderColor: 'primary.main', bgcolor: 'primary.50' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            <UploadIcon
              fontSize="large"
              color={dragActive ? 'primary' : 'action'}
              sx={{ mb: 1 }}
            />
            <Typography variant="body1" fontWeight={500}>
              {running
                ? 'Running…'
                : dragActive
                  ? 'Drop to upload'
                  : 'Drop a CSV, TSV, XLSX, or PDF here, or click to pick a file'}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              Accepted: {ACCEPTED_CONNECTOR_FILE_EXTENSIONS.join(', ')} · max 50 MB
            </Typography>
            {running && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                <CircularProgress size={20} />
              </Box>
            )}
          </Box>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_CONNECTOR_FILE_EXTENSIONS.join(',')}
          onChange={handleFileInputChange}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
      </Paper>

      {/* ------------------------------------------------------------ */}
      {/* API drop card — Phase B2 HTTP POST intake door. Surfaces the */}
      {/* per-connector bearer token + a copy-pasteable curl example.  */}
      {/* ------------------------------------------------------------ */}
      <ApiDropCard
        connector={connector}
        onTokenRotated={(newToken) => {
          setConnector({ ...connector, api_token: newToken });
          setSaveSnack('API token rotated. Old token has stopped working.');
        }}
        onError={(msg) => setError(msg)}
      />

      {/* ------------------------------------------------------------ */}
      {/* S3 drop card — Phase B3 auto-provisioned per-connector       */}
      {/* bucket. Vendors point any S3-compatible tool (aws cli, rclone,*/}
      {/* boto3) at the bucket using the access key + secret. Lazy      */}
      {/* bring-up affordance for connectors without a bucket yet.      */}
      {/* ------------------------------------------------------------ */}
      <S3DropCard
        connector={connector}
        onProvisioned={(creds) => {
          setConnector({
            ...connector,
            r2_bucket_name: creds.bucket_name,
            r2_access_key_id: creds.access_key_id,
            has_r2_secret: true,
            r2_endpoint: creds.endpoint,
          });
          setSaveSnack(
            'S3 drop provisioned. Copy the secret access key now — it is shown only once.',
          );
        }}
        onRotated={(creds) => {
          setConnector({
            ...connector,
            r2_access_key_id: creds.access_key_id,
            has_r2_secret: true,
            r2_endpoint: creds.endpoint,
          });
          setSaveSnack(
            'R2 token rotated. Copy the new secret now — the old token has stopped working.',
          );
        }}
        onError={(msg) => setError(msg)}
      />

      {/* ------------------------------------------------------------ */}
      {/* Public drop link card — Phase B4 tenant-shareable URL. The   */}
      {/* owner generates a link, hands it to a vendor (email, Slack,  */}
      {/* embedded portal — wherever), and the vendor uploads via a    */}
      {/* browser form at /drop/<slug>/<token> with no login.          */}
      {/* ------------------------------------------------------------ */}
      <PublicLinkCard
        connector={connector}
        onGenerated={(payload) => {
          setConnector({
            ...connector,
            public_link_token: payload.public_link_token,
            public_link_expires_at: payload.public_link_expires_at,
          });
          setSaveSnack(
            payload.rotated
              ? 'Public link rotated. Old URL has stopped working.'
              : 'Public link generated. Copy the URL now — it is also visible on the page until you navigate away.',
          );
        }}
        onRevoked={() => {
          setConnector({
            ...connector,
            public_link_token: null,
            public_link_expires_at: null,
          });
          setSaveSnack('Public link revoked. Vendors hitting the URL now see "not active".');
        }}
        onError={(msg) => setError(msg)}
      />

      {/* ------------------------------------------------------------ */}
      {/* Remote drop (R2 prefix) card — Phase B0 universal-doors. Any  */}
      {/* connector can opt into the scheduled R2 poller by setting an */}
      {/* r2_prefix below.                                              */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography variant="h6" fontWeight={600}>
              Remote drop
            </Typography>
            <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.remote} />
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
            For unattended ingestion. A scheduled poller checks the prefix
            below every 5 minutes and runs this connector against any new
            files it finds.
          </Typography>

        <Stack spacing={2}>
          <ConfigTextField
            label="R2 prefix"
            configKey="r2_prefix"
            connector={connector}
            onConfigChange={updateConfigKey}
            helperText="Watches new objects landing under this R2 prefix. Leave blank to disable."
          />
          {r2Prefix && (
            <Box>
              <Typography variant="caption" color="text.secondary" fontWeight={600}>
                Watching prefix
              </Typography>
              <Box
                sx={{
                  mt: 0.5,
                  p: 1.5,
                  bgcolor: 'grey.50',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  wordBreak: 'break-all',
                }}
              >
                r2://doc-upload-files/{r2Prefix}
              </Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                Upload files into this prefix — they'll be ingested within
                5 minutes. Each filename is processed once; re-uploading a
                file with the same key has no effect.
              </Typography>
            </Box>
          )}
        </Stack>
      </Paper>

      {/* ------------------------------------------------------------ */}
      {/* Receive Info card — Phase B0 universal model: email scoping   */}
      {/* renders for every connector. Any connector can opt into the   */}
      {/* email door by setting subject patterns or a sender filter.   */}
      {/* ------------------------------------------------------------ */}
      <ReceiveInfoCard
        connector={connector}
        tenantSlug={tenant?.slug ?? null}
        onConfigChange={updateConfigKey}
      />

      {/* ------------------------------------------------------------ */}
      {/* 4. Field Mappings card                                        */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="h6" fontWeight={600}>
                Field mappings
              </Typography>
              <InfoTooltip text={helpContent.connectors.detail.fieldMappingsTooltip} />
            </Box>
            <Typography variant="caption" color="text.secondary">
              Which source columns map onto canonical dox fields. Changes auto-save on blur.
            </Typography>
          </Box>
          <Button
            size="small"
            startIcon={<EditIcon />}
            onClick={() =>
              navigate(`/admin/connectors/${id}/edit`, {
                state: { startAtStep: 2, remapMode: true },
              })
            }
          >
            Edit in wizard
          </Button>
        </Box>
        <FieldMappingEditor
          mappings={connector.field_mappings || defaultFieldMappings()}
          onCommit={commitFieldMappings}
        />
      </Paper>

      {/* ------------------------------------------------------------ */}
      {/* 5. Sample + Actions card                                      */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
          <Typography variant="h6" fontWeight={600}>
            Stored sample
          </Typography>
          <InfoTooltip text={helpContent.connectors.detail.sampleTooltip} />
        </Box>
        {hasStoredSample ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, wordBreak: 'break-all' }}>
              {connector.sample_r2_key}
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant="outlined"
                size="small"
                startIcon={<RefreshIcon />}
                onClick={() =>
                  navigate(`/admin/connectors/${id}/edit`, {
                    state: { startAtStep: 3, remapMode: true },
                  })
                }
              >
                Re-test with stored sample
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={<UploadIcon />}
                onClick={() =>
                  navigate(`/admin/connectors/${id}/edit`, {
                    state: { startAtStep: 1, remapMode: true },
                  })
                }
              >
                Remap with new sample
              </Button>
            </Stack>
          </>
        ) : (
          <>
            <Alert severity="info" sx={{ mb: 2 }}>
              No sample file stored yet. Upload one to enable the "Re-test" preview and seed
              field-mapping suggestions from real data.
            </Alert>
            <Button
              variant="contained"
              size="small"
              startIcon={<UploadIcon />}
              onClick={() =>
                navigate(`/admin/connectors/${id}/edit`, {
                  state: { startAtStep: 1, remapMode: true },
                })
              }
            >
              Upload sample
            </Button>
          </>
        )}
      </Paper>

      {/* ------------------------------------------------------------ */}
      {/* 6. Runs card                                                  */}
      {/* ------------------------------------------------------------ */}
      <Paper ref={runsRef} variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
          Recent runs {runsTotal > 0 && <Typography component="span" variant="body2" color="text.secondary">({runsTotal})</Typography>}
        </Typography>
        {runsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : runs.length === 0 ? (
          <EmptyState
            title={helpContent.connectors.detail.runsEmptyTitle}
            description={helpContent.connectors.detail.runsEmptyDescription}
          />
        ) : (
          <>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        Status
                        <InfoTooltip text={helpContent.connectors.detail.runColumnTooltips.status} />
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        Source
                        <InfoTooltip text={helpContent.connectors.detail.runColumnTooltips.source} />
                      </Box>
                    </TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Completed</TableCell>
                    <TableCell align="right">
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        Found
                        <InfoTooltip text={helpContent.connectors.detail.runColumnTooltips.found} />
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        Created
                        <InfoTooltip text={helpContent.connectors.detail.runColumnTooltips.created} />
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        Errors
                        <InfoTooltip text={helpContent.connectors.detail.runColumnTooltips.errors} />
                      </Box>
                    </TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id} hover>
                      <TableCell>
                        <Stack spacing={0.25}>
                          <Chip
                            label={run.status}
                            size="small"
                            color={runStatusColor(run.status)}
                            sx={{ alignSelf: 'flex-start' }}
                          />
                          {run.error_message && (run.status === 'error' || run.status === 'partial') && (
                            // Truncated error preview — full text lives in the tooltip so partners
                            // don't have to crack open DevTools to see why a run failed.
                            <Tooltip title={run.error_message} arrow placement="top">
                              <Typography
                                variant="caption"
                                color="error"
                                sx={{
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  maxWidth: 280,
                                  cursor: 'help',
                                }}
                              >
                                {run.error_message}
                              </Typography>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction="column" spacing={0.25} alignItems="flex-start">
                          {run.source ? (
                            <Chip
                              label={run.source}
                              size="small"
                              variant="outlined"
                              sx={{ fontFamily: 'monospace', fontSize: '0.65rem', height: 20 }}
                            />
                          ) : (
                            <Typography variant="caption" color="text.secondary">-</Typography>
                          )}
                          {run.retry_of_run_id && (
                            <Tooltip title={`Retry of run ${run.retry_of_run_id}`} arrow>
                              <Chip
                                label="retry"
                                size="small"
                                color="info"
                                variant="outlined"
                                sx={{ fontSize: '0.65rem', height: 18 }}
                              />
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>{formatDate(run.started_at)}</TableCell>
                      <TableCell>{run.completed_at ? formatDate(run.completed_at) : '-'}</TableCell>
                      <TableCell align="right">{run.records_found}</TableCell>
                      <TableCell align="right">
                        {run.records_created > 0 ? (
                          // The /orders endpoint accepts ?connector_id=...; we use that as the
                          // smallest viable filter. Per-run filtering would require a
                          // connector_run_id query param on the orders page (not added in this
                          // slice — flagged for future work).
                          <Tooltip title={`View orders from ${connector.name}`} arrow>
                            <Button
                              size="small"
                              variant="text"
                              onClick={() =>
                                navigate(`/orders?connector_id=${encodeURIComponent(connector.id)}`)
                              }
                              sx={{ minWidth: 0, p: 0.25, textTransform: 'none' }}
                            >
                              {run.records_created} →
                            </Button>
                          </Tooltip>
                        ) : (
                          run.records_created
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color={run.records_errored > 0 ? 'error' : 'text.primary'}>
                          {run.records_errored}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {run.status === 'error' ? (
                          <Tooltip
                            title="Refetch the original file and re-dispatch the run"
                            arrow
                          >
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={<RefreshIcon fontSize="small" />}
                                onClick={() => handleRetryRun(run.id)}
                                disabled={retryingRunId === run.id}
                                sx={{ minWidth: 0, py: 0.25, px: 1, fontSize: '0.7rem' }}
                              >
                                {retryingRunId === run.id ? '…' : 'Retry'}
                              </Button>
                            </span>
                          </Tooltip>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {runsTotalPages > 1 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                <Pagination
                  count={runsTotalPages}
                  page={runsPage}
                  onChange={(_, p) => setRunsPage(p)}
                  color="primary"
                  size="small"
                />
              </Box>
            )}
          </>
        )}
      </Paper>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onClose={() => !deleting && setDeleteOpen(false)}>
        <DialogTitle>Delete connector?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This deactivates the connector. Existing runs and ingested orders are preserved.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!saveSnack}
        // Slightly longer than the previous 3500ms — the wizard
        // end-state hint (Phase A2.3) includes a full email address
        // partners need to read; routine "Changes saved" toasts can
        // afford to linger a moment longer too.
        autoHideDuration={6000}
        onClose={() => setSaveSnack('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={saveSnack}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Receive Info card (email connectors only)
// ---------------------------------------------------------------------------

function ReceiveInfoCard({
  connector,
  tenantSlug,
  onConfigChange,
}: {
  connector: Connector;
  tenantSlug: string | null;
  onConfigChange: (key: string, value: unknown) => void;
}) {
  const subjectPatterns = useMemo(
    () => asStringArray(connector.config.subject_patterns),
    [connector.config.subject_patterns],
  );
  const senderFilterInitial = useMemo(
    () => (typeof connector.config.sender_filter === 'string' ? connector.config.sender_filter : ''),
    [connector.config.sender_filter],
  );
  const [senderFilterLocal, setSenderFilterLocal] = useState(senderFilterInitial);
  useEffect(() => { setSenderFilterLocal(senderFilterInitial); }, [senderFilterInitial]);

  // Chip input state — a simple controlled TextField + Enter-to-commit keeps
  // the commit path bulletproof (MUI's Autocomplete freeSolo flow dropped
  // values on certain keystroke sequences during live testing).
  const [subjectInput, setSubjectInput] = useState('');

  const commitPatterns = useCallback(
    (nextList: string[]) => {
      const cleaned = nextList.map((s) => s.trim()).filter((s) => s.length > 0);
      // Dedupe while preserving order.
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const s of cleaned) {
        if (!seen.has(s)) {
          seen.add(s);
          deduped.push(s);
        }
      }
      onConfigChange('subject_patterns', deduped);
    },
    [onConfigChange],
  );

  const addPatternsFromInput = useCallback(
    (raw: string) => {
      // Split on comma/semicolon/newline so pasting a CSV list works too.
      const parts = raw
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) return;
      commitPatterns([...subjectPatterns, ...parts]);
      setSubjectInput('');
    },
    [commitPatterns, subjectPatterns],
  );

  const handlePatternKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
      if (subjectInput.trim().length > 0) {
        e.preventDefault();
        addPatternsFromInput(subjectInput);
      }
    }
  };

  const handlePatternBlur = () => {
    if (subjectInput.trim().length > 0) {
      addPatternsFromInput(subjectInput);
    }
  };

  const handleDeletePattern = (pattern: string) => {
    commitPatterns(subjectPatterns.filter((p) => p !== pattern));
  };

  // Local draft for the "test a subject" preview field.
  const [testSubject, setTestSubject] = useState('');
  const testResult = useMemo(() => {
    if (!testSubject.trim()) return null;
    if (subjectPatterns.length === 0) {
      return { matched: true, reason: 'No patterns set — matches ALL emails' };
    }
    for (const p of subjectPatterns) {
      try {
        if (new RegExp(p, 'i').test(testSubject)) {
          return { matched: true, reason: `Matched pattern: ${p}` };
        }
      } catch {
        /* skip invalid */
      }
    }
    return { matched: false, reason: 'No pattern matches this subject' };
  }, [testSubject, subjectPatterns]);

  // Detect staging by hostname. Mirrors the server-side `isStagingHost`
  // helper in `functions/api/connectors/[id]/test.ts` so the in-page
  // notice and the test/probe message stay consistent.
  const isStaging = useMemo(() => {
    if (typeof window === 'undefined' || !window.location?.host) return false;
    const host = window.location.host.toLowerCase();
    return host.includes('staging') || host.endsWith('.pages.dev');
  }, []);

  // Email domain is environment-specific. Staging is a placeholder until
  // DNS / Email Routing is wired (see `email-worker/wrangler.staging.toml`),
  // so we still render an address for completeness — the staging Alert
  // below tells the user it's not actually receiving mail yet.
  //
  // Phase B0.5: the local-part is the CONNECTOR slug, not the tenant
  // slug. Per-connector addressing means each connector gets its own
  // mailbox and the routing layer doesn't need a separate
  // tenant->connector lookup at the email-worker. Legacy connectors
  // without a slug fall back to the tenant slug for graceful
  // degradation until the backfill picks them up.
  const emailDomain = isStaging ? 'supdox-staging.com' : 'supdox.com';
  const receiveLocal = connector.slug || tenantSlug;
  const receiveAddress = receiveLocal ? `${receiveLocal}@${emailDomain}` : null;
  const hasNoFilter = subjectPatterns.length === 0 && !senderFilterLocal.trim();

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch { /* no-op */ }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2 }}>
        <Typography variant="h6" fontWeight={600}>
          Receive info
        </Typography>
        <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.email} />
      </Box>

      {isStaging && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Email ingestion isn't wired up on staging — emails sent to a staging
          connector address won't be received. Test the email path on prod or
          use the manual upload zone above.
        </Alert>
      )}

      {hasNoFilter && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Email connectors need at least one subject pattern or a sender filter —
          otherwise they'll match every inbound email for your tenant. Add one
          below to keep this connector working.
        </Alert>
      )}

      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Receive address
        </Typography>
        {receiveAddress ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField size="small" value={receiveAddress} fullWidth InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }} />
            <Tooltip title="Copy">
              <Button size="small" onClick={() => copyToClipboard(receiveAddress)}>
                <CopyIcon fontSize="small" />
              </Button>
            </Tooltip>
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            (Tenant slug unavailable — cannot derive receive address)
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          Send emails with attachments (PDF, CSV, XLSX) to this address. The connector
          will process the attachments and create orders/customers. Plain-text emails
          without attachments are ignored. Subject patterns below further scope which
          emails match this connector — if no patterns are set, this connector matches
          any email for its tenant.
        </Typography>
      </Box>

      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Subject patterns
        </Typography>
        <TextField
          size="small"
          fullWidth
          value={subjectInput}
          onChange={(e) => setSubjectInput(e.target.value)}
          onKeyDown={handlePatternKeyDown}
          onBlur={handlePatternBlur}
          placeholder={
            subjectPatterns.length === 0
              ? 'e.g. Daily COA Report  (required)'
              : 'Type a pattern and press Enter'
          }
          error={hasNoFilter}
          inputProps={{ 'aria-label': 'Add subject pattern' }}
        />
        {subjectPatterns.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
            {subjectPatterns.map((p) => (
              <Chip
                key={p}
                label={p}
                size="small"
                onDelete={() => handleDeletePattern(p)}
              />
            ))}
          </Box>
        )}
        <FormHelperText sx={{ mt: 0.5 }} error={hasNoFilter}>
          Each chip is a <strong>regex</strong> matched (case-insensitive) against the email
          Subject. Type literal text like{' '}
          <Box component="code" sx={{ fontFamily: 'monospace' }}>Daily COA Report</Box>{' '}
          for a substring match, or use regex wildcards like{' '}
          <Box component="code" sx={{ fontFamily: 'monospace' }}>Order.*Report</Box>. Press
          Enter, comma, or semicolon to add a pattern. At least one pattern
          (or a sender filter below) is required.
        </FormHelperText>
        {subjectPatterns.length > 0 && (
          <Box sx={{ mt: 1.5 }}>
            <TextField
              size="small"
              fullWidth
              label="Test a subject"
              placeholder="Paste a sample subject to see if it matches"
              value={testSubject}
              onChange={(e) => setTestSubject(e.target.value)}
            />
            {testResult && (
              <Box
                sx={{
                  mt: 0.5,
                  px: 1,
                  py: 0.5,
                  borderRadius: 1,
                  bgcolor: testResult.matched ? 'success.50' : 'error.50',
                  border: '1px solid',
                  borderColor: testResult.matched ? 'success.main' : 'error.main',
                }}
              >
                <Typography
                  variant="caption"
                  sx={{ color: testResult.matched ? 'success.dark' : 'error.dark' }}
                >
                  {testResult.matched ? 'Match — ' : 'No match — '}
                  {testResult.reason}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Box>

      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Sender filter
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. @supplier.com or vendor@example.com"
          value={senderFilterLocal}
          onChange={(e) => setSenderFilterLocal(e.target.value)}
          onBlur={() => {
            const trimmed = senderFilterLocal.trim();
            if (trimmed !== senderFilterInitial.trim()) {
              onConfigChange('sender_filter', trimmed || undefined);
            }
          }}
          error={hasNoFilter}
          helperText={
            hasNoFilter
              ? 'Set this OR add a subject pattern above to scope the connector.'
              : 'Optional. Matches senders containing this substring.'
          }
        />
      </Box>

      {/*
        Note: an earlier version of this card had an Accordion with a sample
        `curl` POST against /api/webhooks/connector-email-ingest using the
        EMAIL_INGEST_API_KEY service secret. That was misleading partner-facing
        UI — the secret is owned by the email-worker for machine-to-machine
        calls and partners can't (and shouldn't) have it. The webhook path
        still exists for internal testing; reach for it from a dev shell with
        the secret pulled from 1Password rather than asking the user to
        construct the call from a UI hint.
      */}
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// ApiDropCard — Phase B2 HTTP POST drop door surface.
// ---------------------------------------------------------------------------

/**
 * Renders the per-connector HTTP POST drop endpoint card. The card has
 * three layers, top to bottom:
 *
 *   1. Endpoint URL — `<origin>/api/connectors/<id>/drop` with copy.
 *   2. Bearer token — `connectors.api_token`, masked by default with a
 *      show/hide toggle + copy. Rotate button cuts a new token via
 *      `POST /api/connectors/:id/api-token/rotate`. Legacy connectors
 *      with NULL `api_token` see a single "Generate token" button that
 *      reuses the same rotate endpoint to bootstrap.
 *   3. Vendor instructions — a copy-pasteable curl example with the
 *      real endpoint baked in. We deliberately use a placeholder when
 *      the token is hidden so vendors don't accidentally paste a fully-
 *      assembled curl into an unredacted bug report or screenshot — the
 *      partner has to explicitly reveal the token first.
 *
 * Hard cutover semantics on rotate are surfaced inline: a confirm
 * dialog warns "old token will stop working immediately."
 */
function ApiDropCard({
  connector,
  onTokenRotated,
  onError,
}: {
  connector: Connector;
  onTokenRotated: (newToken: string) => void;
  onError: (message: string) => void;
}) {
  const [showToken, setShowToken] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);

  const endpoint = useMemo(() => {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    // Phase B0.5: prefer the slug-based URL when available — that's
    // the address vendors should bookmark. Fall back to the random-hex
    // id only on legacy rows that pre-date the slug backfill.
    const handle = connector.slug || connector.id;
    return `${origin}/api/connectors/${handle}/drop`;
  }, [connector.id, connector.slug]);

  const hasToken = !!connector.api_token;
  const tokenDisplay = useMemo(() => {
    if (!hasToken) return '';
    if (showToken) return connector.api_token!;
    // Mask all but the last 4 chars so the partner can verify the
    // suffix matches whatever they handed to a vendor without
    // re-revealing the secret.
    const t = connector.api_token!;
    return `${'•'.repeat(Math.max(0, t.length - 4))}${t.slice(-4)}`;
  }, [hasToken, showToken, connector.api_token]);

  const curlExample = useMemo(() => {
    const tokenStr = hasToken && showToken
      ? connector.api_token!
      : '<token>';
    return [
      'curl -X POST \\',
      `  -H "Authorization: Bearer ${tokenStr}" \\`,
      '  -F "file=@/path/to/your/file.csv" \\',
      `  ${endpoint}`,
    ].join('\n');
  }, [endpoint, hasToken, showToken, connector.api_token]);

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch { /* no-op */ }
  };

  const performRotate = async (isBootstrap: boolean) => {
    setRotating(true);
    try {
      const result = await api.connectors.rotateApiToken(connector.id);
      onTokenRotated(result.api_token);
      // After bootstrapping a brand-new token, reveal it automatically
      // so the partner can copy it immediately without an extra click.
      // Rotation (replacing an existing token) reveals it too, since
      // the old one has just stopped working and the new one needs to
      // be handed to whoever held the old one.
      if (isBootstrap) {
        setShowToken(true);
      } else {
        setShowToken(true);
      }
      setConfirmRotateOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to rotate API token');
    } finally {
      setRotating(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <KeyIcon fontSize="small" color="action" />
        <Typography variant="h6" fontWeight={600}>
          API drop
        </Typography>
        <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.api} />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
        Programmatic intake door. Vendors POST a multipart file body with
        their bearer token; the connector's field mappings parse it and
        records land alongside manual / email runs.
      </Typography>

      {/* Endpoint */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Endpoint
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            fullWidth
            value={endpoint}
            InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
            inputProps={{ 'aria-label': 'Connector drop endpoint URL' }}
          />
          <Tooltip title="Copy endpoint URL">
            <Button size="small" onClick={() => copyToClipboard(endpoint)}>
              <CopyIcon fontSize="small" />
            </Button>
          </Tooltip>
        </Stack>
      </Box>

      {/* Bearer token */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Bearer token
        </Typography>
        {hasToken ? (
          <>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={tokenDisplay}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'Connector API bearer token' }}
              />
              <Tooltip title={showToken ? 'Hide token' : 'Show token'}>
                <Button
                  size="small"
                  onClick={() => setShowToken((s) => !s)}
                  aria-label={showToken ? 'Hide bearer token' : 'Show bearer token'}
                >
                  {showToken ? <HideIcon fontSize="small" /> : <ShowIcon fontSize="small" />}
                </Button>
              </Tooltip>
              <Tooltip title="Copy token">
                <span>
                  <Button
                    size="small"
                    onClick={() => connector.api_token && copyToClipboard(connector.api_token)}
                    disabled={!connector.api_token}
                  >
                    <CopyIcon fontSize="small" />
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title="Rotate token (old token stops working immediately)">
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  startIcon={<RotateIcon fontSize="small" />}
                  onClick={() => setConfirmRotateOpen(true)}
                  disabled={rotating}
                >
                  Rotate
                </Button>
              </Tooltip>
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              Treat this token like a password. Vendors with this token can submit
              files into this connector — rotate immediately if exposed.
            </Typography>
          </>
        ) : (
          <Stack direction="row" spacing={1} alignItems="center">
            <Alert severity="info" sx={{ flex: 1 }}>
              No token yet — generate one to enable the API drop door.
            </Alert>
            <Button
              variant="contained"
              size="small"
              startIcon={<KeyIcon fontSize="small" />}
              onClick={() => performRotate(true)}
              disabled={rotating}
            >
              {rotating ? 'Generating…' : 'Generate token'}
            </Button>
          </Stack>
        )}
      </Box>

      {/* Vendor instructions */}
      {hasToken && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Vendor instructions
          </Typography>
          <Box
            sx={{
              position: 'relative',
              p: 1.5,
              pr: 5,
              bgcolor: 'grey.900',
              color: 'grey.50',
              borderRadius: 1,
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              whiteSpace: 'pre',
              overflowX: 'auto',
            }}
          >
            <Tooltip title="Copy curl command">
              <Button
                size="small"
                onClick={() => copyToClipboard(curlExample)}
                sx={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  minWidth: 0,
                  color: 'grey.50',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.1)' },
                }}
              >
                <CopyIcon fontSize="small" />
              </Button>
            </Tooltip>
            {curlExample}
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            Accepts the same file types as the upload zone above (CSV, TSV,
            XLSX, PDF). Returns JSON with <Box component="code" sx={{ fontFamily: 'monospace' }}>run_id</Box> + <Box component="code" sx={{ fontFamily: 'monospace' }}>file_key</Box> on success;
            results land in the runs panel below.
          </Typography>
        </Box>
      )}

      {/* Rotate confirmation */}
      <Dialog
        open={confirmRotateOpen}
        onClose={() => !rotating && setConfirmRotateOpen(false)}
      >
        <DialogTitle>Rotate API token?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anyone using the current token will be locked out immediately. Make
            sure you have a way to deliver the new token to the vendor before
            you rotate.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRotateOpen(false)} disabled={rotating}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => performRotate(false)}
            disabled={rotating}
          >
            {rotating ? 'Rotating…' : 'Rotate now'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// S3DropCard — Phase B3 per-connector S3 drop bucket surface.
// ---------------------------------------------------------------------------

/**
 * Renders the per-connector S3 drop card. Two states:
 *
 *   1. Not provisioned (`r2_bucket_name === null`): single
 *      "Set up S3 drop" button + brief explanation. Click hits
 *      `POST /api/connectors/:id/r2/provision` and transitions the
 *      card to the populated state with the plaintext secret visible.
 *
 *   2. Provisioned: shows endpoint, bucket, access key id, masked
 *      secret with "rotate to view" link, and a copy-pasteable
 *      `aws s3 cp` example. The secret is only visible immediately
 *      after provision/rotate — once the user navigates away or
 *      re-loads the page we can't recover it (we don't keep a
 *      decryptable copy of the plaintext).
 *
 * Rotation hard-cuts: a confirm dialog warns "old token will stop
 * working immediately" before issuing the rotate.
 */
function S3DropCard({
  connector,
  onProvisioned,
  onRotated,
  onError,
}: {
  connector: Connector;
  onProvisioned: (creds: {
    bucket_name: string;
    access_key_id: string;
    secret_access_key: string;
    endpoint: string;
  }) => void;
  onRotated: (creds: {
    bucket_name: string;
    access_key_id: string;
    secret_access_key: string;
    endpoint: string;
  }) => void;
  onError: (message: string) => void;
}) {
  const [provisioning, setProvisioning] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  // Only populated immediately after a successful provision/rotate.
  // Cleared on next page navigation; we deliberately do NOT cache it
  // in localStorage because it's a vendor-facing secret.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const isProvisioned = !!connector.r2_bucket_name;
  // Endpoint is always derivable on the server; in local dev / unit
  // tests where the GET response doesn't include it we fall back to
  // a placeholder so the UI doesn't render "null" verbatim.
  const endpoint = connector.r2_endpoint || '<endpoint-from-server>';

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* no-op */
    }
  };

  const performProvision = async () => {
    setProvisioning(true);
    try {
      const creds = await api.connectors.provisionR2(connector.id);
      setRevealedSecret(creds.secret_access_key);
      setShowSecret(true);
      onProvisioned(creds);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to provision S3 drop');
    } finally {
      setProvisioning(false);
    }
  };

  const performRotate = async () => {
    setRotating(true);
    try {
      const creds = await api.connectors.rotateR2(connector.id);
      setRevealedSecret(creds.secret_access_key);
      setShowSecret(true);
      setConfirmRotateOpen(false);
      onRotated(creds);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to rotate R2 token');
    } finally {
      setRotating(false);
    }
  };

  const secretDisplay = (() => {
    if (!isProvisioned) return '';
    if (revealedSecret && showSecret) return revealedSecret;
    if (revealedSecret && !showSecret) {
      return `${'•'.repeat(Math.max(0, revealedSecret.length - 4))}${revealedSecret.slice(-4)}`;
    }
    // No revealed secret — DB has it encrypted but we don't keep a
    // decryptable copy. User has to rotate to see a fresh value.
    return '(rotate to view)';
  })();

  // aws-cli example using real values when we have them and clear
  // placeholders when we don't.
  const awsCliExample = (() => {
    if (!isProvisioned) return '';
    const bucket = connector.r2_bucket_name!;
    const keyId = connector.r2_access_key_id ?? '<access-key-id>';
    const secret = revealedSecret && showSecret ? revealedSecret : '<secret-access-key>';
    return [
      '# Configure once (writes to ~/.aws/credentials):',
      `aws configure set aws_access_key_id ${keyId} --profile dox-${connector.slug ?? connector.id}`,
      `aws configure set aws_secret_access_key ${secret} --profile dox-${connector.slug ?? connector.id}`,
      '',
      '# Then upload files:',
      'aws s3 cp /path/to/file.csv \\',
      `  s3://${bucket}/ \\`,
      `  --endpoint-url ${endpoint} \\`,
      `  --profile dox-${connector.slug ?? connector.id}`,
    ].join('\n');
  })();

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <UploadIcon fontSize="small" color="action" />
        <Typography variant="h6" fontWeight={600}>
          S3 drop
        </Typography>
        <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.s3} />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
        Vendor-facing S3 drop bucket. Anyone with the access key + secret
        below can upload via aws-cli, rclone, boto3, or any other
        S3-compatible tool. New files are ingested within 5 minutes.
      </Typography>

      {!isProvisioned ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <Alert severity="info" sx={{ flex: 1 }}>
            No bucket yet — provision one to enable the S3 drop door.
            Provisioning creates a dedicated bucket and a vendor-scoped
            R2 access token.
          </Alert>
          <Button
            variant="contained"
            size="small"
            startIcon={<KeyIcon fontSize="small" />}
            onClick={performProvision}
            disabled={provisioning}
          >
            {provisioning ? 'Provisioning…' : 'Set up S3 drop'}
          </Button>
        </Stack>
      ) : (
        <>
          {/* Endpoint */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Endpoint
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={endpoint}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'R2 S3-compatible endpoint URL' }}
              />
              <Tooltip title="Copy endpoint URL">
                <Button size="small" onClick={() => copyToClipboard(endpoint)}>
                  <CopyIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>
          </Box>

          {/* Bucket */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Bucket
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={connector.r2_bucket_name ?? ''}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'R2 bucket name' }}
              />
              <Tooltip title="Copy bucket name">
                <Button
                  size="small"
                  onClick={() =>
                    connector.r2_bucket_name && copyToClipboard(connector.r2_bucket_name)
                  }
                >
                  <CopyIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>
          </Box>

          {/* Access key id */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Access key ID
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={connector.r2_access_key_id ?? ''}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'R2 access key ID' }}
              />
              <Tooltip title="Copy access key ID">
                <Button
                  size="small"
                  onClick={() =>
                    connector.r2_access_key_id &&
                    copyToClipboard(connector.r2_access_key_id)
                  }
                >
                  <CopyIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>
          </Box>

          {/* Secret */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Secret access key
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={secretDisplay}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'R2 secret access key' }}
              />
              {revealedSecret && (
                <Tooltip title={showSecret ? 'Hide secret' : 'Show secret'}>
                  <Button
                    size="small"
                    onClick={() => setShowSecret((s) => !s)}
                    aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                  >
                    {showSecret ? <HideIcon fontSize="small" /> : <ShowIcon fontSize="small" />}
                  </Button>
                </Tooltip>
              )}
              {revealedSecret && (
                <Tooltip title="Copy secret">
                  <Button size="small" onClick={() => copyToClipboard(revealedSecret)}>
                    <CopyIcon fontSize="small" />
                  </Button>
                </Tooltip>
              )}
              <Tooltip title="Rotate token (old credentials stop working immediately)">
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  startIcon={<RotateIcon fontSize="small" />}
                  onClick={() => setConfirmRotateOpen(true)}
                  disabled={rotating}
                >
                  Rotate
                </Button>
              </Tooltip>
            </Stack>
            {!revealedSecret && (
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                The secret is only visible immediately after provisioning or
                rotation. We do not keep a recoverable copy — rotate to issue
                a fresh secret.
              </Typography>
            )}
            {revealedSecret && (
              <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
                Copy this secret now. It will not be visible again after you
                leave this page.
              </Typography>
            )}
          </Box>

          {/* Vendor instructions */}
          <Box>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Vendor instructions
            </Typography>
            <Box
              sx={{
                position: 'relative',
                p: 1.5,
                pr: 5,
                bgcolor: 'grey.900',
                color: 'grey.50',
                borderRadius: 1,
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                whiteSpace: 'pre',
                overflowX: 'auto',
              }}
            >
              <Tooltip title="Copy aws-cli example">
                <Button
                  size="small"
                  onClick={() => copyToClipboard(awsCliExample)}
                  sx={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    minWidth: 0,
                    color: 'grey.50',
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.1)' },
                  }}
                >
                  <CopyIcon fontSize="small" />
                </Button>
              </Tooltip>
              {awsCliExample}
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              Works with any S3-compatible client (aws-cli, rclone, boto3,
              etc.). Files dropped into this bucket are ingested by the
              5-minute poller and surface in the runs panel below.
            </Typography>
          </Box>
        </>
      )}

      {/* Rotate confirmation */}
      <Dialog
        open={confirmRotateOpen}
        onClose={() => !rotating && setConfirmRotateOpen(false)}
      >
        <DialogTitle>Rotate R2 token?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Anyone using the current access key + secret will be locked out
            immediately. The bucket itself is preserved — only the credentials
            change. Make sure you have a way to deliver the new secret to the
            vendor before you rotate.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRotateOpen(false)} disabled={rotating}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={performRotate}
            disabled={rotating}
          >
            {rotating ? 'Rotating…' : 'Rotate now'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// PublicLinkCard — Phase B4 tenant-shareable upload form URL.
// ---------------------------------------------------------------------------

/**
 * Renders the per-connector public drop-link card. Three states:
 *
 *   1. Not generated (`public_link_token === null`): single
 *      "Generate link" button + brief explanation. Click hits
 *      `POST /api/connectors/:id/public-link/generate` with the
 *      30-day default expiry and transitions the card to the
 *      populated state with the URL revealed.
 *
 *   2. Active: shows the full URL (read-only, copy + open-in-new),
 *      expiry status (human-readable), and three action buttons —
 *      Rotate, Revoke, and a toggle for setting / removing expiry
 *      via re-generation. Rotation hard-cuts the previous link with
 *      a confirm dialog. Revoke also confirms.
 *
 * The link is plaintext at rest on the server, so we display it
 * verbatim — there's no "show / hide" toggle. This is by design: the
 * URL IS the credential and the owner needs to be able to copy it
 * any time without having to rotate.
 */
function PublicLinkCard({
  connector,
  onGenerated,
  onRevoked,
  onError,
}: {
  connector: Connector;
  onGenerated: (payload: {
    public_link_token: string;
    public_link_expires_at: number | null;
    rotated: boolean;
  }) => void;
  onRevoked: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const isActive = !!connector.public_link_token;
  const handle = connector.slug || connector.id;

  const url = useMemo(() => {
    if (!isActive) return '';
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '';
    return `${origin}/drop/${handle}/${connector.public_link_token}`;
  }, [isActive, handle, connector.public_link_token]);

  const expiryDescription = useMemo(() => {
    if (!isActive) return '';
    if (connector.public_link_expires_at === null) return 'No expiry';
    const expiresAt = new Date(connector.public_link_expires_at * 1000);
    const now = Date.now();
    const diffMs = expiresAt.getTime() - now;
    if (diffMs <= 0) return `Expired ${expiresAt.toLocaleDateString()}`;
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days === 0) {
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      return `Expires in ${hours}h (${expiresAt.toLocaleString()})`;
    }
    return `Expires in ${days} day${days === 1 ? '' : 's'} (${expiresAt.toLocaleDateString()})`;
  }, [isActive, connector.public_link_expires_at]);

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* no-op */
    }
  };

  // Single workhorse for generate / rotate / change-expiry. The
  // server-side endpoint is idempotent — passing `expires_in_days`
  // re-issues a new token regardless of whether one existed.
  const performGenerate = async (
    expiresInDays: number | null,
    rotating: boolean,
  ) => {
    setBusy(true);
    try {
      const result = await api.connectors.generatePublicLink(connector.id, {
        expires_in_days: expiresInDays,
      });
      onGenerated({
        public_link_token: result.public_link_token,
        public_link_expires_at: result.public_link_expires_at,
        rotated: rotating,
      });
      setConfirmRotateOpen(false);
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Failed to generate public link',
      );
    } finally {
      setBusy(false);
    }
  };

  const performRevoke = async () => {
    setBusy(true);
    try {
      await api.connectors.revokePublicLink(connector.id);
      onRevoked();
      setConfirmRevokeOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to revoke public link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <LinkIcon fontSize="small" color="action" />
        <Typography variant="h6" fontWeight={600}>
          Public drop link
        </Typography>
        <InfoTooltip text={helpContent.connectors.detail.intakeDoorTooltips.public} />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
        Tenant-shareable URL. Anyone with the link can upload a file via a
        web form — no login required. The link itself is the auth, so treat
        it like a password and rotate or revoke if it leaks.
      </Typography>

      {!isActive ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <Alert severity="info" sx={{ flex: 1 }}>
            No link yet — generate one to enable the public drop door.
            Default expiry is 30 days.
          </Alert>
          <Button
            variant="contained"
            size="small"
            startIcon={<LinkIcon fontSize="small" />}
            onClick={() => performGenerate(30, false)}
            disabled={busy}
          >
            {busy ? 'Generating…' : 'Generate link'}
          </Button>
        </Stack>
      ) : (
        <>
          {/* URL */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              URL
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small"
                fullWidth
                value={url}
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                inputProps={{ 'aria-label': 'Public drop link URL' }}
              />
              <Tooltip title="Copy URL">
                <Button size="small" onClick={() => copyToClipboard(url)}>
                  <CopyIcon fontSize="small" />
                </Button>
              </Tooltip>
              <Tooltip title="Open in new tab">
                <Button
                  size="small"
                  component="a"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open public drop link in new tab"
                >
                  <OpenInNewIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Stack>
          </Box>

          {/* Expiry status + controls */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Expiry
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                {expiryDescription}
              </Typography>
              {connector.public_link_expires_at !== null ? (
                <Tooltip title="Re-issue the link with no expiry. Old link stops working.">
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => performGenerate(null, true)}
                    disabled={busy}
                  >
                    Remove expiry
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip title="Re-issue the link with a 30-day expiry. Old link stops working.">
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => performGenerate(30, true)}
                    disabled={busy}
                  >
                    Set 30-day expiry
                  </Button>
                </Tooltip>
              )}
            </Stack>
          </Box>

          {/* Rotate / Revoke */}
          <Stack direction="row" spacing={1}>
            <Tooltip title="Rotate token (old URL stops working immediately)">
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<RotateIcon fontSize="small" />}
                onClick={() => setConfirmRotateOpen(true)}
                disabled={busy}
              >
                Rotate link
              </Button>
            </Tooltip>
            <Tooltip title="Revoke link (no token until you generate a new one)">
              <Button
                size="small"
                variant="outlined"
                color="error"
                startIcon={<DeleteIcon fontSize="small" />}
                onClick={() => setConfirmRevokeOpen(true)}
                disabled={busy}
              >
                Revoke link
              </Button>
            </Tooltip>
          </Stack>

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
            Submissions land in the runs panel below tagged
            {' '}<Box component="code" sx={{ fontFamily: 'monospace' }}>source=public_link</Box>.
          </Typography>
        </>
      )}

      {/* Rotate confirmation */}
      <Dialog
        open={confirmRotateOpen}
        onClose={() => !busy && setConfirmRotateOpen(false)}
      >
        <DialogTitle>Rotate public link?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The current URL will stop working immediately. Make sure you have
            a way to deliver the new URL to whoever was using the old one
            before you rotate.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRotateOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() =>
              performGenerate(
                connector.public_link_expires_at === null ? null : 30,
                true,
              )
            }
            disabled={busy}
          >
            {busy ? 'Rotating…' : 'Rotate now'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog
        open={confirmRevokeOpen}
        onClose={() => !busy && setConfirmRevokeOpen(false)}
      >
        <DialogTitle>Revoke public link?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The URL will stop working immediately. Anyone who tries to upload
            via the link will see a "not active" message. You can generate a
            new link any time.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRevokeOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={performRevoke}
            disabled={busy}
          >
            {busy ? 'Revoking…' : 'Revoke now'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// ConfigTextField — small inline-edit text field for connector config keys.
// ---------------------------------------------------------------------------

function ConfigTextField({
  label,
  configKey,
  connector,
  onConfigChange,
  helperText,
}: {
  label: string;
  configKey: string;
  connector: Connector;
  onConfigChange: (key: string, value: unknown) => void;
  helperText?: string;
}) {
  const initial = typeof connector.config[configKey] === 'string' ? (connector.config[configKey] as string) : '';
  const [local, setLocal] = useState(initial);
  useEffect(() => { setLocal(initial); }, [initial]);
  return (
    <TextField
      size="small"
      label={label}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== initial) {
          onConfigChange(configKey, local || undefined);
        }
      }}
      fullWidth
      helperText={helperText}
    />
  );
}

// ---------------------------------------------------------------------------
// ProbeDetails — renders the per-type probe payload from POST /:id/test.
// ---------------------------------------------------------------------------

function ProbeDetails({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <Box component="dl" sx={{ mt: 1, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: '0.85rem' }}>
      {entries.map(([key, value]) => (
        <Box key={key} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="caption" fontWeight={600} sx={{ color: 'text.secondary' }}>
            {key.replace(/_/g, ' ')}
          </Typography>
          <Typography component="dd" variant="caption" sx={{ m: 0, fontFamily: typeof value === 'string' && value.length > 40 ? 'monospace' : undefined, wordBreak: 'break-all' }}>
            {formatProbeValue(value)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function formatProbeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    return value.join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
