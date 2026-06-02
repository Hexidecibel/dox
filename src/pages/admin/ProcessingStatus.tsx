/**
 * Processing Status — super_admin health page for the doc processing
 * pipeline. Refreshes every 30s so a tab left open during an outage
 * stays current. Built after the 2026-05-09 outage so the user (and
 * Buddy) can see at a glance which subsystem is broken without having
 * to ssh anywhere.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  Chip,
  Button,
  Alert,
  Skeleton,
  Stack,
  Divider,
  IconButton,
  Collapse,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import { api } from '../../lib/api';
import {
  Refresh as RefreshIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  CheckCircle as OkIcon,
  Warning as WarnIcon,
  Error as ErrIcon,
} from '@mui/icons-material';
import { AUTH_TOKEN_KEY } from '../../lib/types';
import { formatDateTime } from '../../utils/format';
import type { ProcessingStatusResponse } from '../../../shared/types';

const REFRESH_MS = 30_000;
// Faster cadence used only while the pipeline is actively churning (items
// queued / processing, or stale claims present). Drops back to the 30s
// baseline once everything settles so we don't poll a quiet pipeline hard.
const ACTIVE_REFRESH_MS = 5_000;

type Severity = 'ok' | 'warn' | 'error';

const sevColor: Record<Severity, 'success' | 'warning' | 'error'> = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
};

function SeverityIcon({ sev }: { sev: Severity }) {
  if (sev === 'ok') return <OkIcon color="success" fontSize="small" />;
  if (sev === 'warn') return <WarnIcon color="warning" fontSize="small" />;
  return <ErrIcon color="error" fontSize="small" />;
}

function fmtMin(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / (60 * 24))} d`;
}

function StatusCard({
  title,
  severity,
  children,
}: {
  title: string;
  severity: Severity;
  children: React.ReactNode;
}) {
  return (
    <Paper sx={{ p: 2, borderLeft: 4, borderColor: `${sevColor[severity]}.main` }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <SeverityIcon sev={severity} />
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
      </Stack>
      {children}
    </Paper>
  );
}

function QueueCard({ data }: { data: ProcessingStatusResponse['queue'] }) {
  const oldest = data.oldestQueued;
  // Backlog severity: queued > 100 = error, queued > 25 OR oldest > 30min = warn.
  let sev: Severity = 'ok';
  if (data.counts.queued > 100) sev = 'error';
  else if (data.counts.queued > 25 || (oldest && oldest.ageMinutes > 30)) sev = 'warn';

  return (
    <StatusCard title="Queue" severity={sev}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <Chip
          size="small"
          label={`Queued: ${data.counts.queued}`}
          color={data.counts.queued > 25 ? 'warning' : 'default'}
        />
        <Chip
          size="small"
          label={`Processing: ${data.counts.processing}`}
          color={data.counts.processing > 0 ? 'info' : 'default'}
        />
        <Chip size="small" label={`Ready: ${data.counts.ready}`} color="success" variant="outlined" />
        <Chip
          size="small"
          label={`Error: ${data.counts.error}`}
          color={data.counts.error > 0 ? 'error' : 'default'}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block">
        Total rows: {data.totalRows}
      </Typography>
      {oldest ? (
        <Typography variant="body2" sx={{ mt: 1 }}>
          Oldest queued: <strong>{fmtMin(oldest.ageMinutes)}</strong> ago
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            ({oldest.id.slice(0, 8)}…)
          </Typography>
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ mt: 1 }} color="text.secondary">
          No queued items.
        </Typography>
      )}
    </StatusCard>
  );
}

function WorkerCard({ data }: { data: ProcessingStatusResponse['worker'] }) {
  // Worker is healthy if a job completed in the last 10 min. >30min is red.
  // No data ever (lastJobCompletedAt null) is warn — could just be a fresh
  // env or the worker has never run; not necessarily broken.
  let sev: Severity = 'warn';
  if (data.healthy) sev = 'ok';
  else if (data.minutesSinceLastJob !== null && data.minutesSinceLastJob > 30) sev = 'error';

  return (
    <StatusCard title="Worker" severity={sev}>
      {data.lastJobCompletedAt ? (
        <>
          <Typography variant="body2">
            Last job completed: <strong>{fmtMin(data.minutesSinceLastJob)}</strong> ago
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            {formatDateTime(data.lastJobCompletedAt)}
          </Typography>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No `ready` rows yet — worker has never reported a completed job.
        </Typography>
      )}
    </StatusCard>
  );
}

function QwenCard({ data }: { data: ProcessingStatusResponse['qwen'] }) {
  // Reachable + fast = green. Reachable but slow (>2s) = yellow.
  // Unreachable = red.
  let sev: Severity = 'ok';
  if (!data.reachable) sev = 'error';
  else if (data.responseTimeMs !== null && data.responseTimeMs > 2000) sev = 'warn';

  return (
    <StatusCard title="Qwen GPU host" severity={sev}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Chip
          size="small"
          color={data.reachable ? 'success' : 'error'}
          label={data.reachable ? 'Reachable' : 'Unreachable'}
        />
        {data.responseTimeMs !== null && (
          <Typography variant="caption" color="text.secondary">
            {data.responseTimeMs} ms
          </Typography>
        )}
      </Stack>
      {data.error && (
        <Alert severity="error" sx={{ mb: 1, py: 0 }}>
          {data.error}
        </Alert>
      )}
      {data.advertisedModels && data.advertisedModels.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" display="block">
            Advertised models:
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
            {data.advertisedModels.map((m) => (
              <Chip key={m} size="small" label={m} variant="outlined" />
            ))}
          </Stack>
        </Box>
      )}
      {data.loadedModels !== null && (
        <Box>
          <Typography variant="caption" color="text.secondary" display="block">
            Loaded in VRAM:
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
            {data.loadedModels.length === 0 ? (
              <Typography variant="caption" color="warning.main">
                None (router idle — first request will trigger a swap-in)
              </Typography>
            ) : (
              data.loadedModels.map((m) => (
                <Chip key={m} size="small" label={m} color="success" />
              ))
            )}
          </Stack>
        </Box>
      )}
    </StatusCard>
  );
}

function StaleCard({ data }: { data: ProcessingStatusResponse['stale'] }) {
  const sev: Severity = data.orphanedClaims > 0 ? 'error' : 'ok';
  return (
    <StatusCard title="Stale claims" severity={sev}>
      {data.orphanedClaims === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No orphaned `processing` rows.
        </Typography>
      ) : (
        <>
          <Typography variant="body2">
            <strong>{data.orphanedClaims}</strong> row
            {data.orphanedClaims === 1 ? '' : 's'} stuck in `processing` for &gt; 15 min.
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            Oldest: {fmtMin(data.oldestOrphanAgeMinutes)} ago. Likely orphaned worker
            claims — there is no reaper, so these will not move on their own.
          </Typography>
        </>
      )}
    </StatusCard>
  );
}

function ErrorsCard({
  data,
  onRefresh,
}: {
  data: ProcessingStatusResponse['errors'];
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rowLoading, setRowLoading] = useState<Record<string, boolean>>({});
  const [bulkLoading, setBulkLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalRecent = data.recent.length;
  const sev: Severity = totalRecent === 0 ? 'ok' : totalRecent > 5 ? 'error' : 'warn';
  const patternEntries = Object.entries(data.byPattern).sort((a, b) => b[1] - a[1]);

  const reprocessOne = async (id: string) => {
    setRowLoading((m) => ({ ...m, [id]: true }));
    setError(null);
    try {
      await api.queue.reprocess(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reprocess failed');
    } finally {
      setRowLoading((m) => ({ ...m, [id]: false }));
    }
  };

  // Bulk: chunk into batches of 5 in parallel so we don't hammer the API
  // when an outage produced a wall of identical errors. Each row's loading
  // state still flips so the user sees forward progress.
  const reprocessAll = async () => {
    setBulkLoading(true);
    setError(null);
    try {
      const ids = data.recent.map((r) => r.id);
      const CHUNK = 5;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        setRowLoading((m) => {
          const next = { ...m };
          for (const id of slice) next[id] = true;
          return next;
        });
        const results = await Promise.allSettled(slice.map((id) => api.queue.reprocess(id)));
        setRowLoading((m) => {
          const next = { ...m };
          for (const id of slice) next[id] = false;
          return next;
        });
        const firstReject = results.find((r) => r.status === 'rejected');
        if (firstReject && firstReject.status === 'rejected') {
          const reason = firstReject.reason;
          setError(reason instanceof Error ? reason.message : 'One or more reprocess calls failed');
        }
      }
    } finally {
      setBulkLoading(false);
      setConfirmOpen(false);
      onRefresh();
    }
  };

  return (
    <StatusCard title="Recent errors" severity={sev}>
      {totalRecent === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No errored rows.
        </Typography>
      ) : (
        <>
          {patternEntries.length > 0 && (
            <Box sx={{ mb: 1.5 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                By pattern (recent 200):
              </Typography>
              <Stack spacing={0.5}>
                {patternEntries.slice(0, 8).map(([pattern, count]) => (
                  <Box
                    key={pattern}
                    sx={{
                      display: 'flex',
                      gap: 1,
                      alignItems: 'center',
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                    }}
                  >
                    <Chip size="small" label={count} color="error" sx={{ minWidth: 36 }} />
                    <Tooltip title={pattern}>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: 'monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {pattern}
                      </Typography>
                    </Tooltip>
                  </Box>
                ))}
              </Stack>
            </Box>
          )}
          <Divider sx={{ my: 1 }} />
          {error && (
            <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button
              size="small"
              onClick={() => setOpen((v) => !v)}
              startIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            >
              {open ? 'Hide' : `Show top ${totalRecent}`} recent rows
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="warning"
              startIcon={bulkLoading ? <CircularProgress size={14} /> : <RefreshIcon />}
              disabled={bulkLoading || totalRecent === 0}
              onClick={() => setConfirmOpen(true)}
            >
              Reprocess all visible ({totalRecent})
            </Button>
          </Stack>
          <Collapse in={open} timeout="auto">
            <Table size="small" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: '0.75rem' }}>ID</TableCell>
                  <TableCell sx={{ fontSize: '0.75rem' }}>Error</TableCell>
                  <TableCell sx={{ fontSize: '0.75rem' }}>When</TableCell>
                  <TableCell sx={{ fontSize: '0.75rem' }} align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}>
                      {r.id.slice(0, 8)}…
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.75rem', maxWidth: 480 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: 'monospace',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: 'block',
                        }}
                        title={r.errorMessage ?? ''}
                      >
                        {r.errorMessage ?? '(no message)'}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                      {formatDateTime(r.createdAt)}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={
                          rowLoading[r.id]
                            ? <CircularProgress size={12} />
                            : <RefreshIcon fontSize="small" />
                        }
                        disabled={!!rowLoading[r.id] || bulkLoading}
                        onClick={async () => {
                          await reprocessOne(r.id);
                          onRefresh();
                        }}
                      >
                        Reprocess
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Collapse>
        </>
      )}
      <Dialog open={confirmOpen} onClose={() => !bulkLoading && setConfirmOpen(false)}>
        <DialogTitle>Reprocess errored items?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will reset {totalRecent} errored row{totalRecent === 1 ? '' : 's'}{' '}
            to <code>queued</code> with <code>attempts=0</code>, bypassing the
            worker retry cap. Useful after a transient outage (Qwen 502s, etc.)
            but make sure the underlying issue is resolved or the rows will
            error again.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={bulkLoading}>
            Cancel
          </Button>
          <Button
            onClick={reprocessAll}
            color="warning"
            variant="contained"
            disabled={bulkLoading}
            startIcon={bulkLoading ? <CircularProgress size={14} /> : undefined}
          >
            {bulkLoading ? 'Reprocessing…' : `Reprocess ${totalRecent}`}
          </Button>
        </DialogActions>
      </Dialog>
    </StatusCard>
  );
}

function LoadingSkeleton() {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} variant="rectangular" height={140} />
      ))}
    </Box>
  );
}

export function ProcessingStatus() {
  const [data, setData] = useState<ProcessingStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Track the last successful poll wall-clock so the "checked Xs ago"
  // line ticks even between polls. Driven by an interval below.
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const res = await fetch('/api/admin/processing-status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as ProcessingStatusResponse;
      if (mountedRef.current) {
        setData(json);
        setNow(Date.now());
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load status');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial fetch + 30s auto-refresh. Background refreshes do not flip
  // the loading skeleton so the page stays visible.
  useEffect(() => {
    mountedRef.current = true;
    load(false);
    const interval = setInterval(() => load(true), REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [load]);

  // "In-flight" = the pipeline is doing (or owes) work: items queued or
  // processing, or stale claims that need attention. While true we poll fast;
  // when everything settles this flips false and the fast poll tears down.
  const isActive = data
    ? data.queue.counts.queued > 0 ||
      data.queue.counts.processing > 0 ||
      data.stale.orphanedClaims > 0
    : false;

  // Fast auto-refresh while the pipeline is active. Reuses the existing load()
  // callback (stable) — no duplicate fetch logic. Cleared on unmount and
  // whenever isActive flips false, so a settled pipeline falls back to the
  // 30s baseline above.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => load(true), ACTIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [isActive, load]);

  // Tick the "Xs ago" label every 5s so it drifts smoothly.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  const checkedAgoSec = data
    ? Math.max(0, Math.round((now - new Date(data.checkedAt).getTime()) / 1000))
    : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" gutterBottom>
            Processing Status
          </Typography>
          <Typography variant="body2" color="text.secondary">
            System health for the document processing pipeline. Auto-refreshes every 30s.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {isActive && (
            <Chip
              size="small"
              variant="outlined"
              color="info"
              icon={<CircularProgress size={12} thickness={6} />}
              label="Auto-refreshing"
            />
          )}
          {data && (
            <Typography variant="caption" color="text.secondary">
              Checked {checkedAgoSec}s ago
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => load(true)}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Stack>
      </Box>

      {error && (
        <Alert severity="error" action={
          <IconButton size="small" onClick={() => load(false)}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        }>
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <LoadingSkeleton />
      ) : data ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <QueueCard data={data.queue} />
          <WorkerCard data={data.worker} />
          <QwenCard data={data.qwen} />
          <StaleCard data={data.stale} />
          <Box sx={{ gridColumn: { xs: '1', md: '1 / -1' } }}>
            <ErrorsCard data={data.errors} onRefresh={() => load(true)} />
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
