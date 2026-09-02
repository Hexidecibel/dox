/**
 * Requests — every ask this tenant has out with a supplier.
 *
 * The list is the working surface, so it answers the chaser's questions in the
 * order they get asked: who, what, by when, and how much of it has landed. The
 * per-line progress bar is `counts.by_status` and nothing else — there is no
 * derived "percent complete", because a packet where four of five lines are
 * accepted and the fifth needs attention is not 80% fine.
 *
 * SUPERSEDED VERSIONS ARE OFF BY DEFAULT and the toggle says why. A list that
 * mixed a live version with the one it replaced would double-count what is
 * outstanding, which is the one wrong answer this screen must not give. The
 * amendment trail belongs on the detail view, where it can be read as a trail.
 *
 * Reading is open to any authenticated user of the tenant — an outstanding
 * request list is evidence, not configuration — so the compose button is the
 * only role-gated thing here, matching the API's own split.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type {
  ApiSupplier,
  DocumentRequestListItem,
  DocumentRequestStatus,
} from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';

const STATUS_COLOR: Record<
  DocumentRequestStatus,
  'default' | 'primary' | 'success' | 'warning'
> = {
  draft: 'default',
  issued: 'primary',
  closed: 'success',
  cancelled: 'warning',
};

/** The five line states, as a bar. Colour carries the meaning, not a number. */
export function LineProgress({ item }: { item: DocumentRequestListItem }) {
  const { by_status: s, total } = item.counts;
  if (total === 0) return <Typography variant="caption" color="text.secondary">No lines</Typography>;
  const segments: { key: string; n: number; color: string; label: string }[] = [
    { key: 'accepted', n: s.accepted, color: 'success.main', label: 'accepted' },
    { key: 'under_review', n: s.under_review, color: 'info.main', label: 'under review' },
    { key: 'received', n: s.received, color: 'primary.light', label: 'received' },
    { key: 'needs_attention', n: s.needs_attention, color: 'error.main', label: 'needs attention' },
    { key: 'not_started', n: s.not_started, color: 'grey.300', label: 'not started' },
  ];
  const title = segments
    .filter((seg) => seg.n > 0)
    .map((seg) => `${seg.n} ${seg.label}`)
    .join(', ');
  return (
    <Tooltip title={title}>
      <Box>
        <Box sx={{ display: 'flex', height: 6, borderRadius: 1, overflow: 'hidden', mb: 0.5 }}>
          {segments.map((seg) =>
            seg.n === 0 ? null : (
              <Box key={seg.key} sx={{ flex: seg.n, bgcolor: seg.color }} />
            ),
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {s.accepted} of {total} accepted
          {s.needs_attention > 0 && (
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>
              {' '}
              · {s.needs_attention} needs attention
            </Box>
          )}
        </Typography>
      </Box>
    </Tooltip>
  );
}

/** Overdue is a fact about an issued ask, not a draft nobody has sent. */
function DueCell({ item }: { item: DocumentRequestListItem }) {
  if (!item.due_date) {
    return (
      <Typography variant="body2" color="text.secondary">
        No deadline
      </Typography>
    );
  }
  const overdue =
    item.status === 'issued' && item.due_date < new Date().toISOString().slice(0, 10);
  return (
    <Typography variant="body2" color={overdue ? 'error.main' : 'text.primary'} fontWeight={overdue ? 700 : 400}>
      {item.due_date}
      {overdue && ' — overdue'}
    </Typography>
  );
}

export function Requests() {
  const [requests, setRequests] = useState<DocumentRequestListItem[]>([]);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState<DocumentRequestStatus | ''>('');
  const [mineOnly, setMineOnly] = useState(false);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;
  const canCompose = user?.role === 'super_admin' || user?.role === 'org_admin';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, supplierList] = await Promise.all([
        api.documentRequests.list({
          tenant_id: tenantId,
          supplier_id: supplierId || undefined,
          status: status || undefined,
          assigned_to: mineOnly && user ? user.id : undefined,
          include_superseded: includeSuperseded,
          limit: 200,
        }),
        api.suppliers.list({ tenant_id: tenantId, limit: 500 }),
      ]);
      setRequests(list.requests);
      setSuppliers(supplierList.suppliers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [tenantId, supplierId, status, mineOnly, includeSuperseded, user]);

  useEffect(() => {
    load();
  }, [load]);

  const openCount = useMemo(
    () => requests.filter((r) => r.status === 'issued').length,
    [requests],
  );

  const filtered = supplierId || status || mineOnly;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" fontWeight={700} sx={{ flexGrow: 1 }}>
          Requests
        </Typography>
        {canCompose && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate('/requests/new')}
          >
            Compose a request
          </Button>
        )}
      </Box>

      <Tabs value={0} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Requests" />
        <Tab label="Templates" onClick={() => navigate('/requests/templates')} />
      </Tabs>

      <HelpWell id="requests.list" title="Asking a supplier for documents">
        A request is what you send a supplier when something is missing. Each line points at
        an item on your own checklist, so when the document arrives the portal already knows
        what it was for — it can be closed, chased when it expires, and counted while it is
        outstanding. Issued requests are never edited: correcting one is an{' '}
        <strong>amendment</strong>, which keeps the version the supplier is holding.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center">
          <TextField
            select
            size="small"
            label="Supplier"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="">All suppliers</MenuItem>
            {suppliers.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as DocumentRequestStatus | '')}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">Any status</MenuItem>
            <MenuItem value="draft">Draft</MenuItem>
            <MenuItem value="issued">Issued</MenuItem>
            <MenuItem value="closed">Closed</MenuItem>
            <MenuItem value="cancelled">Cancelled</MenuItem>
          </TextField>
          <FormControlLabel
            control={
              <Switch checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            }
            label="Assigned to me"
          />
          <Tooltip title="Amended-away versions are hidden by default: showing both would count the same outstanding ask twice.">
            <FormControlLabel
              control={
                <Switch
                  checked={includeSuperseded}
                  onChange={(e) => setIncludeSuperseded(e.target.checked)}
                />
              }
              label="Include superseded versions"
            />
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="body2" color="text.secondary">
            {requests.length} shown · {openCount} issued
          </Typography>
        </Stack>
      </Paper>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : requests.length === 0 ? (
        filtered ? (
          <EmptyState
            title="Nothing matches those filters"
            description="No request matches this supplier, status or assignee. Clear the filters to see everything that is out."
            actionLabel="Clear filters"
            onAction={() => {
              setSupplierId('');
              setStatus('');
              setMineOnly(false);
            }}
          />
        ) : (
          <EmptyState
            title="No requests yet"
            description={
              canCompose
                ? 'Compose one to ask a supplier for what they owe. Start from a supplier and the portal offers the items already outstanding for them, so you are not re-picking a checklist you already configured.'
                : 'Nobody has sent a supplier a document request yet. An org admin composes and issues these.'
            }
            actionLabel={canCompose ? 'Compose a request' : undefined}
            onAction={canCompose ? () => navigate('/requests/new') : undefined}
          />
        )
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Request</TableCell>
                <TableCell>Supplier</TableCell>
                <TableCell>Status</TableCell>
                <TableCell sx={{ minWidth: 180 }}>Lines</TableCell>
                <TableCell>Deadline</TableCell>
                <TableCell>Chased by</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {requests.map((r) => (
                <TableRow
                  key={r.id}
                  hover
                  sx={{ cursor: 'pointer', opacity: r.superseded_at ? 0.6 : 1 }}
                  onClick={() => navigate(`/requests/${r.id}`)}
                >
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {r.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {r.version > 1 ? `Version ${r.version}` : 'Version 1'}
                      {r.superseded_at && ' · superseded'}
                      {r.origin !== 'manual' && ` · from ${r.origin}`}
                      {r.counts.free_text > 0 && (
                        <Box component="span" sx={{ color: 'warning.main' }}>
                          {' '}
                          · {r.counts.free_text} free text
                        </Box>
                      )}
                    </Typography>
                  </TableCell>
                  <TableCell>{r.supplier_name ?? '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={r.status} color={STATUS_COLOR[r.status]} />
                  </TableCell>
                  <TableCell>
                    <LineProgress item={r} />
                  </TableCell>
                  <TableCell>
                    <DueCell item={r} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color={r.assigned_to_name ? 'text.primary' : 'text.secondary'}>
                      {r.assigned_to_name ?? 'Nobody'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {loading && <LinearProgress />}
        </TableContainer>
      )}
    </Box>
  );
}
