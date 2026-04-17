/**
 * Activity — unified feed page.
 *
 * Single place to see every ingest event in the system:
 *   - Connector runs (success/error/partial)
 *   - Document ingests (processing_queue rows, emails -> queue)
 *   - Orders created (from connector runs or manual entry)
 *   - Audit log entries
 *
 * Features:
 *   - Date range presets + custom start/end
 *   - Event type, connector, source, status filters
 *   - Expandable rows with the full details JSON for each event
 *   - Cross-navigation links to the detail pages for connectors, orders,
 *     documents and users
 *   - Load-more pagination (backend enforces max 200 per page)
 *
 * Backed by GET /api/activity and GET /api/activity/event.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams, Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControl,
  Grid,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  History as HistoryIcon,
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
  Refresh as RefreshIcon,
  OpenInNew as OpenInNewIcon,
  Hub as ConnectorIcon,
  Description as DocumentIcon,
  ShoppingCart as OrderIcon,
  Article as AuditIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import type {
  ActivityEvent,
  ActivityListResponse,
  ActivitySourceFilter,
  ActivityStatusFilter,
  ActivityEventType,
} from '../lib/types';
import { formatDateTime } from '../utils/format';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type DatePreset = '1h' | '24h' | '7d' | '30d' | 'custom';

const PRESET_LABELS: Record<DatePreset, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom range',
};

function presetToRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  let ms = 0;
  switch (preset) {
    case '1h': ms = 3600 * 1000; break;
    case '24h': ms = 24 * 3600 * 1000; break;
    case '7d': ms = 7 * 24 * 3600 * 1000; break;
    case '30d': ms = 30 * 24 * 3600 * 1000; break;
    case 'custom': ms = 24 * 3600 * 1000; break;
  }
  return { from: new Date(now.getTime() - ms).toISOString(), to };
}

/** Format an ISO timestamp as a relative "5m ago" style string. */
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(/[Zz]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (isNaN(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return formatDateTime(iso);
}

function typeChip(type: ActivityEventType) {
  const meta: Record<ActivityEventType, { label: string; color: 'info' | 'secondary' | 'success' | 'default'; icon: JSX.Element }> = {
    connector_run: { label: 'Connector Run', color: 'info', icon: <ConnectorIcon fontSize="inherit" /> },
    document_ingest: { label: 'Document', color: 'secondary', icon: <DocumentIcon fontSize="inherit" /> },
    order_created: { label: 'Order', color: 'success', icon: <OrderIcon fontSize="inherit" /> },
    audit: { label: 'Audit', color: 'default', icon: <AuditIcon fontSize="inherit" /> },
  };
  const m = meta[type];
  return <Chip size="small" variant="outlined" color={m.color} icon={m.icon} label={m.label} />;
}

function statusChip(event: ActivityEvent) {
  if (event.type === 'connector_run') {
    const map: Record<string, { color: 'success' | 'error' | 'warning' | 'info' | 'default' }> = {
      success: { color: 'success' },
      error: { color: 'error' },
      partial: { color: 'warning' },
      running: { color: 'info' },
    };
    const c = map[event.status] || { color: 'default' as const };
    return <Chip label={event.status} size="small" color={c.color} />;
  }
  if (event.type === 'document_ingest') {
    const p = event.processing_status;
    const map: Record<string, { color: 'default' | 'info' | 'success' | 'error' | 'warning' }> = {
      queued: { color: 'default' },
      processing: { color: 'info' },
      ready: { color: 'success' },
      error: { color: 'error' },
    };
    const c = map[p] || { color: 'default' as const };
    return <Chip label={p} size="small" color={c.color} variant="outlined" />;
  }
  if (event.type === 'order_created') {
    return <Chip label={event.status} size="small" variant="outlined" />;
  }
  return <Chip label="event" size="small" variant="outlined" />;
}

function summaryLine(event: ActivityEvent): string {
  switch (event.type) {
    case 'connector_run': {
      const name = event.connector_name || 'Connector';
      if (event.status === 'error') return `${name} failed (${event.error_message || 'unknown error'})`;
      const bits: string[] = [];
      if (event.records_created) bits.push(`${event.records_created} created`);
      if (event.records_updated) bits.push(`${event.records_updated} updated`);
      if (event.records_errored) bits.push(`${event.records_errored} errored`);
      if (bits.length === 0) bits.push(`${event.records_found} found`);
      return `${name} — ${bits.join(', ')}`;
    }
    case 'document_ingest': {
      const origin = event.sender_email ? `from ${event.sender_email}` : event.source ? `via ${event.source}` : '';
      return `${event.file_name}${origin ? ` ${origin}` : ''}`;
    }
    case 'order_created': {
      const who = event.customer_name || event.customer_number || 'customer';
      const via = event.connector_name ? ` via ${event.connector_name}` : '';
      return `${event.order_number} — ${who}${via}`;
    }
    case 'audit': {
      const who = event.user_name || 'someone';
      const what = event.resource_type ? ` ${event.resource_type}` : '';
      return `${who} ${event.action}${what}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Expanded row — fetches detail on demand
// ---------------------------------------------------------------------------

function ExpandedRow({ event, onNavigate }: { event: ActivityEvent; onNavigate: (path: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.activity
      .getEvent(event.type, event.id)
      .then((res) => { if (!cancelled) setDetail(res.event as Record<string, unknown>); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [event.id, event.type]);

  return (
    <Box sx={{ py: 2, px: 3, bgcolor: 'background.default' }}>
      {loading && <CircularProgress size={20} />}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {!loading && detail && (
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {event.type === 'connector_run' && (
              <>
                <Button
                  size="small"
                  startIcon={<OpenInNewIcon />}
                  onClick={() => onNavigate(`/admin/connectors/${event.connector_id}`)}
                >
                  View connector
                </Button>
                {Array.isArray((detail as any).orders) && (detail as any).orders.length > 0 && (
                  <Chip
                    label={`${(detail as any).orders.length} orders from this run`}
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                )}
              </>
            )}
            {event.type === 'document_ingest' && (
              <Button
                size="small"
                startIcon={<OpenInNewIcon />}
                onClick={() => onNavigate(`/review/${event.id}`)}
              >
                Open in review queue
              </Button>
            )}
            {event.type === 'order_created' && (
              <>
                <Button
                  size="small"
                  startIcon={<OpenInNewIcon />}
                  onClick={() => onNavigate(`/orders/${event.id}`)}
                >
                  View order
                </Button>
                {event.connector_id && (
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => onNavigate(`/admin/connectors/${event.connector_id}`)}
                  >
                    View connector
                  </Button>
                )}
              </>
            )}
          </Box>

          {event.type === 'connector_run' && Array.isArray((detail as any).orders) && (detail as any).orders.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>Orders created in this run</Typography>
              <Stack spacing={0.5}>
                {((detail as any).orders as Array<{ id: string; order_number: string; customer_name: string | null }>)
                  .slice(0, 50)
                  .map((o) => (
                    <Link
                      key={o.id}
                      component={RouterLink}
                      to={`/orders/${o.id}`}
                      underline="hover"
                      sx={{ fontSize: '0.875rem' }}
                    >
                      {o.order_number}{o.customer_name ? ` — ${o.customer_name}` : ''}
                    </Link>
                  ))}
              </Stack>
            </Box>
          )}

          <Box>
            <Typography variant="subtitle2" gutterBottom>Full payload</Typography>
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paper' }}>
              <pre
                style={{
                  margin: 0,
                  fontSize: '0.75rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 320,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(detail, null, 2)}
              </pre>
            </Paper>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ActivityRow({ event, onNavigate }: { event: ActivityEvent; onNavigate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow hover sx={{ '& > td': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          <IconButton size="small" onClick={() => setOpen(!open)}>
            {open ? <CollapseIcon /> : <ExpandIcon />}
          </IconButton>
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          <Tooltip title={formatDateTime(event.timestamp)}>
            <Typography variant="body2" color="text.secondary">{formatRelative(event.timestamp)}</Typography>
          </Tooltip>
        </TableCell>
        <TableCell>{typeChip(event.type)}</TableCell>
        <TableCell sx={{ minWidth: 260 }}>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {summaryLine(event)}
          </Typography>
          {event.type === 'connector_run' && event.error_message && (
            <Typography variant="caption" color="error" sx={{ display: 'block' }}>
              {event.error_message}
            </Typography>
          )}
        </TableCell>
        <TableCell>{statusChip(event)}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={5} sx={{ p: 0, borderBottom: open ? undefined : 'none' }}>
          <Collapse in={open} unmountOnExit>
            {open && <ExpandedRow event={event} onNavigate={onNavigate} />}
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface ConnectorOption {
  id: string;
  name: string;
}

export function Activity() {
  const navigate = useNavigate();
  const { isSuperAdmin } = useAuth();
  const [searchParams] = useSearchParams();

  // ---- filters ----
  const [preset, setPreset] = useState<DatePreset>('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [connectorId, setConnectorId] = useState<string>(searchParams.get('connector_id') || '');
  const [eventType, setEventType] = useState<ActivityEventType | 'all'>('all');
  const [source, setSource] = useState<ActivitySourceFilter>('all');
  const [status, setStatus] = useState<ActivityStatusFilter>('all');
  const [crossTenant, setCrossTenant] = useState(false);

  // ---- data ----
  const [connectors, setConnectors] = useState<ConnectorOption[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 50;

  // ---- load connector list once ----
  useEffect(() => {
    let cancelled = false;
    api.connectors
      .list({ limit: 200 } as any)
      .then((res: any) => {
        if (cancelled) return;
        setConnectors(
          (res?.connectors || []).map((c: any) => ({ id: c.id, name: c.name })),
        );
      })
      .catch(() => { /* best effort */ });
    return () => { cancelled = true; };
  }, []);

  // ---- resolved range ----
  const { from, to } = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) {
      return { from: new Date(customFrom).toISOString(), to: new Date(customTo).toISOString() };
    }
    return presetToRange(preset);
  }, [preset, customFrom, customTo]);

  // ---- fetch ----
  const fetchEvents = useCallback(async (nextOffset: number, append: boolean) => {
    setLoading(true);
    setError('');
    try {
      const res: ActivityListResponse = await api.activity.list({
        from,
        to,
        connector_id: connectorId || undefined,
        event_type: eventType,
        source,
        status,
        limit: PAGE_SIZE,
        offset: nextOffset,
        tenant_id: isSuperAdmin && crossTenant ? 'all' : undefined,
      });
      setTotal(res.total_count);
      setEvents((prev) => (append ? [...prev, ...res.events] : res.events));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [from, to, connectorId, eventType, source, status, isSuperAdmin, crossTenant]);

  // ---- reload whenever a filter changes ----
  useEffect(() => {
    setOffset(0);
    fetchEvents(0, false);
  }, [fetchEvents]);

  const handleLoadMore = () => {
    const next = offset + PAGE_SIZE;
    setOffset(next);
    fetchEvents(next, true);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
  };

  const eventTypes: Array<{ value: ActivityEventType | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'connector_run', label: 'Connector Runs' },
    { value: 'document_ingest', label: 'Ingests' },
    { value: 'order_created', label: 'Orders' },
    { value: 'audit', label: 'Audit' },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <HistoryIcon color="primary" />
        <Typography variant="h4" fontWeight={700}>Activity</Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Ingest events, connector runs, and order creation — one timeline for the whole pipeline.
      </Typography>

      {/* Filter bar */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6} lg={4}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Time range
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={preset}
              onChange={(_, v) => { if (v) setPreset(v); }}
              fullWidth
            >
              {(['1h', '24h', '7d', '30d', 'custom'] as DatePreset[]).map((p) => (
                <ToggleButton key={p} value={p}>{PRESET_LABELS[p]}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            {preset === 'custom' && (
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <TextField
                  size="small"
                  type="datetime-local"
                  label="From"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
                <TextField
                  size="small"
                  type="datetime-local"
                  label="To"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  fullWidth
                />
              </Box>
            )}
          </Grid>

          <Grid item xs={12} md={6} lg={8}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Event type
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={eventType}
              onChange={(_, v) => { if (v) setEventType(v); }}
              fullWidth
            >
              {eventTypes.map((t) => (
                <ToggleButton key={t.value} value={t.value}>{t.label}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Grid>

          <Grid item xs={12} md={4}>
            <FormControl size="small" fullWidth>
              <InputLabel>Connector</InputLabel>
              <Select
                label="Connector"
                value={connectorId}
                onChange={(e) => setConnectorId(e.target.value)}
              >
                <MenuItem value="">All connectors</MenuItem>
                {connectors.map((c) => (
                  <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={4}>
            <FormControl size="small" fullWidth>
              <InputLabel>Source</InputLabel>
              <Select
                label="Source"
                value={source}
                onChange={(e) => setSource(e.target.value as ActivitySourceFilter)}
              >
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="email">Email</MenuItem>
                <MenuItem value="api">API</MenuItem>
                <MenuItem value="import">Import</MenuItem>
                <MenuItem value="file_watch">File watch</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={4}>
            <FormControl size="small" fullWidth>
              <InputLabel>Status</InputLabel>
              <Select
                label="Status"
                value={status}
                onChange={(e) => setStatus(e.target.value as ActivityStatusFilter)}
              >
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="success">Success</MenuItem>
                <MenuItem value="error">Error</MenuItem>
                <MenuItem value="partial">Partial</MenuItem>
                <MenuItem value="running">Running</MenuItem>
                <MenuItem value="queued">Queued</MenuItem>
              </Select>
            </FormControl>
          </Grid>

          {isSuperAdmin && (
            <Grid item xs={12}>
              <Button
                size="small"
                variant={crossTenant ? 'contained' : 'outlined'}
                onClick={() => setCrossTenant((v) => !v)}
              >
                {crossTenant ? 'Viewing all tenants' : 'Only my tenant'}
              </Button>
            </Grid>
          )}
        </Grid>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* Results */}
      <Paper variant="outlined">
        <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {loading && events.length === 0
              ? 'Loading…'
              : `${events.length} of ${total} events`}
          </Typography>
          <IconButton size="small" onClick={() => { setOffset(0); fetchEvents(0, false); }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Box>
        <Divider />
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>When</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Summary</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography color="text.secondary">
                      No activity in this window.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                events.map((ev) => (
                  <ActivityRow key={`${ev.type}:${ev.id}`} event={ev} onNavigate={handleNavigate} />
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
        {events.length < total && (
          <Box sx={{ p: 2, display: 'flex', justifyContent: 'center' }}>
            <Button disabled={loading} onClick={handleLoadMore}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
