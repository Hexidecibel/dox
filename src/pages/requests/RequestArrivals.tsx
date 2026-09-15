/**
 * Arrivals — what suppliers have sent back, waiting on someone here.
 *
 * The inbox for the supplier portal. Every card is a file a supplier sent
 * through their request link with at least one requirement still waiting on a
 * person. Oldest first: the file that has waited longest is the one the
 * supplier is most likely to phone about.
 *
 * TWO STEPS, ON PURPOSE. A file is approved in the Review Queue (is what we
 * read from it right?) and then decided here (does it satisfy what we asked
 * for?). The card links straight to the Review Queue item when the first step
 * is outstanding. Reading is open to every tenant user; deciding is not offered
 * to a reader, matching the API.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSupplier, RequestArrival } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { ArrivalCard } from '../../components/ArrivalCard';
import { DecideArrivalDialog, type DecidableLine } from '../../components/DecideArrivalDialog';

/** The tab label, with the inbox size when there is one. Shared by the three tab bars. */
export function arrivalsTabLabel(pending: number | null): string {
  return pending ? `Arrivals (${pending})` : 'Arrivals';
}

/** The inbox size for a tab badge. Null until known, and on any failure. */
export function usePendingArrivals(tenantId: string | undefined, enabled = true): number | null {
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.requestUploads
      .list({ pending: true, tenant_id: tenantId, limit: 1 })
      .then((res) => {
        if (!cancelled) setPending(res.pending_total);
      })
      .catch(() => {
        // A badge is a convenience; the tab still works without a number.
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, enabled]);
  return pending;
}

export function RequestArrivals() {
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const canCompose = user?.role === 'super_admin' || user?.role === 'org_admin';
  const canWorkLines = canCompose || user?.role === 'user';

  const [arrivals, setArrivals] = useState<RequestArrival[]>([]);
  const [pendingTotal, setPendingTotal] = useState<number | null>(null);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [deciding, setDeciding] = useState<RequestArrival | null>(null);
  const [decidingLines, setDecidingLines] = useState<DecidableLine[] | undefined>(undefined);

  const load = useCallback(async () => {
    if (isSuperAdmin && !tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.requestUploads.list({
        pending: true,
        tenant_id: tenantId,
        supplier_id: supplierId || undefined,
        limit: 200,
      });
      setArrivals(res.arrivals);
      setPendingTotal(res.pending_total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load what suppliers sent');
    } finally {
      setLoading(false);
    }
  }, [tenantId, supplierId, isSuperAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.suppliers
      .list({ tenant_id: tenantId, limit: 500 })
      .then((res) => setSuppliers(res.suppliers))
      .catch(() => {
        // The supplier filter is optional; the inbox reads fine without it.
      });
  }, [tenantId]);

  const openDecide = async (a: RequestArrival) => {
    setDeciding(a);
    setDecidingLines(undefined);
    try {
      const res = await api.documentRequests.get(a.current_request_id);
      setDecidingLines(res.request.lines.map((l) => ({ id: l.id, name: l.name, status: l.status })));
    } catch {
      // Without the request's lines the dialog still decides the claimed ones.
    }
  };

  const openFile = async (a: RequestArrival) => {
    try {
      await api.requestUploads.openFile(a.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the file');
    }
  };

  const enqueue = async (a: RequestArrival) => {
    setBusy(true);
    try {
      await api.requestUploads.enqueue(a.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not put the file in the Review Queue');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" fontWeight={700} sx={{ flexGrow: 1 }}>
          Requests
        </Typography>
        {canCompose && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/requests/new')}>
            Compose a request
          </Button>
        )}
      </Box>

      <Tabs value={2} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Requests" onClick={() => navigate('/requests')} />
        <Tab label="Templates" onClick={() => navigate('/requests/templates')} />
        <Tab label={arrivalsTabLabel(pendingTotal)} />
      </Tabs>

      <HelpWell id="requests.arrivals" title="What suppliers sent back">
        Each card is a file a supplier sent through their request link, with the requirements they
        said it covers. Two steps turn it into a closed requirement: first approve it in the{' '}
        <strong>Review Queue</strong> (is what we read from it right?), then decide here whether it
        satisfies what you asked for. Nothing a supplier uploads counts as accepted until someone
        here says so. If it is the wrong document, send it back with a reason — the supplier reads
        that reason on their link.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isSuperAdmin && !tenantId ? (
        <Alert severity="info">Pick a tenant to see what its suppliers sent.</Alert>
      ) : (
        <>
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
              <Box sx={{ flexGrow: 1 }} />
              <Typography variant="body2" color="text.secondary">
                {arrivals.length} waiting{supplierId ? ' from this supplier' : ''}
              </Typography>
            </Stack>
          </Paper>

          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress />
            </Box>
          ) : arrivals.length === 0 ? (
            <EmptyState
              title={supplierId ? 'Nothing waiting from this supplier' : 'Nothing waiting on you'}
              description="When a supplier sends a file through their request link, it shows up here until someone decides which requirements it satisfies."
              actionLabel={supplierId ? 'Show every supplier' : undefined}
              onAction={supplierId ? () => setSupplierId('') : undefined}
            />
          ) : (
            <Stack spacing={2}>
              {arrivals.map((a) => (
                <ArrivalCard
                  key={a.id}
                  arrival={a}
                  showRequest
                  canDecide={canWorkLines}
                  canEnqueue={canCompose}
                  busy={busy}
                  onOpenFile={openFile}
                  onDecide={openDecide}
                  onEnqueue={enqueue}
                  onOpenQueueItem={(queueId) => navigate(`/review?item=${queueId}`)}
                  onOpenRequest={(x) => navigate(`/requests/${x.current_request_id}`)}
                  onOpenDocument={(docId) => navigate(`/documents/${docId}`)}
                />
              ))}
            </Stack>
          )}
        </>
      )}

      {deciding && (
        <DecideArrivalDialog
          open
          arrival={deciding}
          lines={decidingLines}
          onClose={() => setDeciding(null)}
          onOpenQueueItem={(queueId) => navigate(`/review?item=${queueId}`)}
          onSubmit={async (body) => {
            await api.requestUploads.decide(deciding.id, body);
            setDeciding(null);
            await load();
          }}
        />
      )}
    </Box>
  );
}
