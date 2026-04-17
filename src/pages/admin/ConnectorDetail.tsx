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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../../utils/format';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
  ExpandMore as ExpandMoreIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { Tenant } from '../../lib/types';
import {
  defaultFieldMappings,
  normalizeFieldMappings,
  type ConnectorFieldMappings,
} from '../../components/connectors/doxFields';
import { FieldMappingEditor } from '../../components/connectors/FieldMappingEditor';

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

export function ConnectorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [connector, setConnector] = useState<Connector | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveSnack, setSaveSnack] = useState('');

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

  const handleTest = async () => {
    if (!id) return;
    setTesting(true);
    setError('');
    try {
      const result = (await api.connectors.test(id)) as {
        success: boolean;
        message: string;
        warnings?: string[];
      };
      const warnings = result.warnings ?? [];
      if (warnings.length > 0) {
        setSaveSnack(`${result.message}: ${warnings[0]}`);
      } else {
        setSaveSnack(result.message || 'Connection test successful');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleRun = async () => {
    if (!id) return;
    setRunning(true);
    setError('');
    try {
      await api.connectors.run(id);
      setSaveSnack('Manual run started');
      loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start manual run');
    } finally {
      setRunning(false);
    }
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
  const hasStoredSample = !!connector.sample_r2_key;

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
            <Tooltip title={isEmail ? 'Email connectors cannot be run manually' : 'Trigger a run now'}>
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<RunIcon />}
                  onClick={handleRun}
                  disabled={running || isEmail}
                >
                  {running ? 'Running…' : 'Run'}
                </Button>
              </span>
            </Tooltip>
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
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
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
                        <Chip label={run.status} size="small" color={runStatusColor(run.status)} />
                      </TableCell>
                      <TableCell>{formatDate(run.started_at)}</TableCell>
                      <TableCell>{run.completed_at ? formatDate(run.completed_at) : '-'}</TableCell>
                      <TableCell align="right">{run.records_found}</TableCell>
                      <TableCell align="right">{run.records_created}</TableCell>
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
        autoHideDuration={3500}
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

  const receiveAddress = tenantSlug ? `${tenantSlug}@supdox.com` : null;
  const hasNoFilter = subjectPatterns.length === 0 && !senderFilterLocal.trim();

  const copyToClipboard = (text: string) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch { /* no-op */ }
  };

  const curlExample = useMemo(() => {
    return [
      `curl -X POST https://dox.supdox.com/api/webhooks/connector-email-ingest \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "X-API-Key: $EMAIL_INGEST_API_KEY" \\`,
      `  -d '{`,
      `    "connector_id": "${connector.id}",`,
      `    "tenant_id": "${connector.tenant_id}",`,
      `    "subject": "Test order email",`,
      `    "sender": "sender@example.com",`,
      `    "body": "plain text body",`,
      `    "attachments": []`,
      `  }'`,
    ].join('\n');
  }, [connector.id, connector.tenant_id]);

  return (
    <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Receive info
      </Typography>

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
          Emails sent to this address with subject matching the patterns below route to this connector.
          If no patterns are set, this connector matches any email for its tenant.
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

      <Accordion variant="outlined" disableGutters sx={{ mt: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">How to send a test email via webhook</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Send email-shaped payloads directly to the webhook endpoint (bypasses SMTP). The
            <code> X-API-Key</code> value is the <code>EMAIL_INGEST_API_KEY</code> secret from your deployment
            environment.
          </Typography>
          <Box
            component="pre"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              bgcolor: 'grey.50',
              p: 1.5,
              borderRadius: 1,
              m: 0,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {curlExample}
          </Box>
          <Button
            size="small"
            startIcon={<CopyIcon />}
            onClick={() => copyToClipboard(curlExample)}
            sx={{ mt: 1 }}
          >
            Copy curl
          </Button>
        </AccordionDetails>
      </Accordion>
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
