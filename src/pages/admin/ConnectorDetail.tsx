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
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Pagination,
  Paper,
  Select,
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
  PlayArrow as RunIcon,
  Science as TestIcon,
  FileUpload as UploadIcon,
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  ContentCopy as CopyIcon,
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

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

const SYSTEM_TYPES = ['erp', 'wms', 'other'] as const;
type SystemType = typeof SYSTEM_TYPES[number];

interface Connector {
  id: string;
  name: string;
  connector_type: 'email' | 'api_poll' | 'webhook' | 'file_watch';
  system_type: SystemType;
  config: Record<string, unknown>;
  field_mappings: ConnectorFieldMappings;
  schedule: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
  sample_r2_key: string | null;
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
    connector_type: (r.connector_type as Connector['connector_type']) || 'email',
    system_type: (r.system_type as SystemType) || 'other',
    config: asRecord(r.config),
    field_mappings: normalizeFieldMappings(r.field_mappings),
    schedule: (r.schedule as string | null) ?? null,
    active: !!r.active,
    last_run_at: (r.last_run_at as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
    tenant_id: String(r.tenant_id ?? ''),
    sample_r2_key: (r.sample_r2_key as string | null) ?? null,
  };
}

const RUNS_PER_PAGE = 20;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Location state shape used by the wizard to flag a freshly-created
 * connector. When present, the detail page renders a one-time success
 * toast pointing the partner at the right intake path (drop zone for
 * file_watch, receive address for email). See `ConnectorWizard.handleSave`.
 */
interface ConnectorDetailLocationState {
  justCreated?: boolean;
  connectorType?: Connector['connector_type'] | null;
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

  useEffect(() => { loadConnector(); }, [loadConnector]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

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
    // either populated or known-null (fetch failed). No additional wait
    // needed; if tenant is null for an email connector we fall back to
    // a generic message.
    const isEmail = connector.connector_type === 'email';
    const tenantSlug = tenant?.slug ?? null;

    let message: string;
    if (connector.connector_type === 'file_watch') {
      message =
        'Connector created. Drop a file into the upload zone above to test, or share the address with your vendor.';
    } else if (isEmail) {
      // Mirror ReceiveInfoCard's domain logic so the hint and the card
      // below stay consistent.
      const isStaging =
        typeof window !== 'undefined' &&
        !!window.location?.host &&
        (window.location.host.toLowerCase().includes('staging') ||
          window.location.host.toLowerCase().endsWith('.pages.dev'));
      const emailDomain = isStaging ? 'supdox-staging.com' : 'supdox.com';
      const address = tenantSlug ? `${tenantSlug}@${emailDomain}` : null;
      message = address
        ? `Connector created. Send emails with attachments to ${address} to test.`
        : 'Connector created. See the receive address card below to start sending email.';
    } else {
      message = 'Connector created.';
    }

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
  const isEmail = connector.connector_type === 'email';
  const isFileWatch = connector.connector_type === 'file_watch';
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
                label={connector.connector_type.replace('_', ' ')}
                size="small"
                color="primary"
                variant="outlined"
              />
              <Chip
                label={connector.system_type.toUpperCase()}
                size="small"
                color={connector.system_type === 'erp' ? 'info' : connector.system_type === 'wms' ? 'success' : 'default'}
                variant="outlined"
              />
              <Chip
                label={connector.active ? 'Active' : 'Inactive'}
                size="small"
                color={connector.active ? 'success' : 'default'}
              />
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
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <InputLabel>System</InputLabel>
              <Select
                value={connector.system_type}
                label="System"
                onChange={(e) => {
                  const next = e.target.value as SystemType;
                  patchConnector({ system_type: next }, { system_type: next });
                }}
              >
                {SYSTEM_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t.toUpperCase()}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
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
              File-watch connectors trigger runs from the drop zone below
              (the backend requires a multipart `file` payload — an empty
              POST always 400s). Email connectors run from inbound webhooks.
              The header Run button is therefore only meaningful for
              api_poll / webhook types, which the backend currently 501s
              anyway, but we leave it visible so its eventual implementation
              has an entry point.
            */}
            {!isEmail && !isFileWatch && (
              <Tooltip title="Trigger a run now">
                <span>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<RunIcon />}
                    onClick={() => setError('Manual runs for this connector type are not yet implemented')}
                    disabled={running}
                  >
                    {running ? 'Running…' : 'Run'}
                  </Button>
                </span>
              </Tooltip>
            )}
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
      {/* Manual upload drop zone (file_watch only) — surfaced at the   */}
      {/* top because dropping a file is the primary action on this     */}
      {/* page for file_watch connectors.                               */}
      {/* ------------------------------------------------------------ */}
      {isFileWatch && (
        <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
            Manual upload
          </Typography>
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
      )}

      {/* ------------------------------------------------------------ */}
      {/* Remote drop (R2 prefix) card — file_watch only. Paired with   */}
      {/* the manual upload zone above as the "ways to send files"      */}
      {/* group.                                                        */}
      {/* ------------------------------------------------------------ */}
      {isFileWatch && (
        <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
          <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
            Remote drop
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
            For unattended ingestion. A scheduled poller checks the prefix
            below every 5 minutes and runs this connector against any new
            files it finds.
          </Typography>

          {r2Prefix ? (
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
          ) : (
            <Alert severity="info" variant="outlined">
              Configure an R2 prefix in connection config below to enable
              scheduled ingestion.
            </Alert>
          )}
        </Paper>
      )}

      {/* ------------------------------------------------------------ */}
      {/* 2. Receive Info card (email only)                             */}
      {/* ------------------------------------------------------------ */}
      {isEmail && (
        <ReceiveInfoCard
          connector={connector}
          tenantSlug={tenant?.slug ?? null}
          onConfigChange={updateConfigKey}
        />
      )}

      {/* ------------------------------------------------------------ */}
      {/* 3. Connection Config card (non-email)                         */}
      {/* ------------------------------------------------------------ */}
      {!isEmail && (
        <ConnectionConfigCard connector={connector} onConfigChange={updateConfigKey} />
      )}

      {/* ------------------------------------------------------------ */}
      {/* 4. Field Mappings card                                        */}
      {/* ------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6" fontWeight={600}>
              Field mappings
            </Typography>
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
        <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
          Stored sample
        </Typography>
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
          <Typography color="text.secondary">No runs yet</Typography>
        ) : (
          <>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Completed</TableCell>
                    <TableCell align="right">Found</TableCell>
                    <TableCell align="right">Created</TableCell>
                    <TableCell align="right">Errors</TableCell>
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
  const emailDomain = isStaging ? 'supdox-staging.com' : 'supdox.com';
  const receiveAddress = tenantSlug ? `${tenantSlug}@${emailDomain}` : null;
  const hasNoFilter = subjectPatterns.length === 0 && !senderFilterLocal.trim();

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch { /* no-op */ }
  };

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Receive info
      </Typography>

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
// Connection Config card (non-email connectors)
// ---------------------------------------------------------------------------

function ConnectionConfigCard({
  connector,
  onConfigChange,
}: {
  connector: Connector;
  onConfigChange: (key: string, value: unknown) => void;
}) {
  const type = connector.connector_type;
  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Connection config
      </Typography>
      {type === 'api_poll' && (
        <Stack spacing={2}>
          <ConfigTextField
            label="Endpoint URL"
            configKey="endpoint_url"
            connector={connector}
            onConfigChange={onConfigChange}
            helperText="Full URL the connector polls for new records"
          />
          <ConfigTextField
            label="Auth header"
            configKey="auth_header"
            connector={connector}
            onConfigChange={onConfigChange}
            helperText="e.g. Bearer xxx (stored in config — use credentials for secrets)"
          />
          <ConfigTextField
            label="Schedule (cron)"
            configKey="schedule"
            connector={connector}
            onConfigChange={onConfigChange}
            helperText="Cron expression controlling poll frequency"
          />
        </Stack>
      )}
      {type === 'webhook' && (
        <Stack spacing={2}>
          <ConfigTextField
            label="Signing secret"
            configKey="signing_secret"
            connector={connector}
            onConfigChange={onConfigChange}
            helperText="HMAC secret used to verify inbound payloads"
          />
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Webhook URL
            </Typography>
            <TextField
              size="small"
              fullWidth
              value={`https://dox.supdox.com/api/webhooks/connector/${connector.id}`}
              InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
            />
          </Box>
        </Stack>
      )}
      {type === 'file_watch' && (
        <Stack spacing={2}>
          <ConfigTextField
            label="R2 prefix"
            configKey="r2_prefix"
            connector={connector}
            onConfigChange={onConfigChange}
            helperText="Watches new objects landing under this R2 prefix"
          />
        </Stack>
      )}
    </Paper>
  );
}

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
