/**
 * Request templates — a composed set, saved so the next one is two clicks.
 *
 * A template is deliberately thin: lines, their wording, their tiers, and at
 * most a number of days. It has no supplier, no status and no version chain,
 * which is exactly why instantiating one produces an ORDINARY DRAFT that then
 * travels the same issue path as everything else. There is no "send template"
 * button here and there must not be one.
 *
 * Templates are created from a request that already exists (Save as template on
 * its page), not authored blank here. That is not a missing feature: a template
 * is a set somebody has actually sent and found worth repeating, and building a
 * second composer that writes template rows directly would be the parallel
 * pipeline the composer module is shaped to prevent.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { arrivalsTabLabel, usePendingArrivals } from './RequestArrivals';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { PlayArrow as UseIcon, Archive as RetireIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSupplier, RequestTemplateDetail, User } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';

export function RequestTemplates() {
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;
  const pendingArrivals = usePendingArrivals(tenantId, !isSuperAdmin || Boolean(tenantId));
  const canCompose = user?.role === 'super_admin' || user?.role === 'org_admin';

  const [templates, setTemplates] = useState<RequestTemplateDetail[]>([]);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [using, setUsing] = useState<RequestTemplateDetail | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, supplierList, userList] = await Promise.all([
        api.requestTemplates.list({ tenant_id: tenantId }),
        api.suppliers.list({ tenant_id: tenantId, active: 1, limit: 500 }),
        api.users.list().catch(() => [] as User[]),
      ]);
      setTemplates(list.templates);
      setSuppliers(supplierList.suppliers);
      setUsers(userList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const openUse = (template: RequestTemplateDetail) => {
    setUsing(template);
    setSupplierId('');
    setTitle(template.name);
    setDueDate('');
    setAssignedTo('');
  };

  const instantiate = async () => {
    if (!using) return;
    if (!supplierId) {
      setError('Pick the supplier this is going to.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.requestTemplates.instantiate(using.id, {
        supplier_id: supplierId,
        title: title.trim() || undefined,
        due_date: dueDate || null,
        assigned_to: assignedTo || null,
      });
      setUsing(null);
      navigate(`/requests/${res.request.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to use this template');
    } finally {
      setBusy(false);
    }
  };

  const retire = async (template: RequestTemplateDetail) => {
    setBusy(true);
    try {
      await api.requestTemplates.retire(template.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retire this template');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 2 }}>
        Requests
      </Typography>

      <Tabs value={1} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Requests" onClick={() => navigate('/requests')} />
        <Tab label="Templates" />
        <Tab label={arrivalsTabLabel(pendingArrivals)} onClick={() => navigate('/requests/arrivals')} />
      </Tabs>

      <HelpWell id="requests.templates" title="Packets you send more than once">
        A template holds the lines and their wording, not a supplier or a deadline — you point
        it at a supplier when you use it, and what comes out is an ordinary draft you can
        adjust before issuing. Editing a template never changes requests you have already
        sent.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description={
            canCompose
              ? 'Templates are made from a request you have already composed: open one and choose “Save as template”. That way a template is always a packet somebody actually sent.'
              : 'Nobody has saved a request packet as a template yet.'
          }
          actionLabel={canCompose ? 'Go to requests' : undefined}
          onAction={canCompose ? () => navigate('/requests') : undefined}
        />
      ) : (
        <Stack spacing={1}>
          {templates.map((t) => {
            const freeText = t.lines.filter((l) => l.line_kind === 'free_text').length;
            const required = t.lines.filter((l) => l.tier === 'required').length;
            return (
              <Paper key={t.id} variant="outlined" sx={{ p: 2 }}>
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <Box sx={{ flexGrow: 1, minWidth: 260 }}>
                    <Typography variant="body1" fontWeight={700}>
                      {t.name}
                    </Typography>
                    {t.description && (
                      <Typography variant="body2" color="text.secondary">
                        {t.description}
                      </Typography>
                    )}
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                      {t.lines.length} line{t.lines.length === 1 ? '' : 's'} · {required} required
                      {freeText > 0 && (
                        <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>
                          {' '}
                          · {freeText} free text
                        </Box>
                      )}
                      {typeof t.default_due_in_days === 'number' &&
                        ` · due ${t.default_due_in_days} days after it is used`}
                    </Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                      {t.lines.map((l) => (
                        <Chip
                          key={l.id}
                          size="small"
                          variant="outlined"
                          color={l.line_kind === 'free_text' ? 'warning' : 'default'}
                          label={l.name}
                        />
                      ))}
                    </Stack>
                  </Box>
                  {canCompose && (
                    <Stack direction="row" spacing={1}>
                      <Button variant="contained" startIcon={<UseIcon />} onClick={() => openUse(t)}>
                        Use
                      </Button>
                      <Button
                        color="inherit"
                        startIcon={<RetireIcon />}
                        disabled={busy}
                        onClick={() => retire(t)}
                      >
                        Retire
                      </Button>
                    </Stack>
                  )}
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      <Dialog open={Boolean(using)} onClose={() => setUsing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Use “{using?.name}”</DialogTitle>
        <DialogContent dividers>
          <Alert severity="info" sx={{ mb: 2 }}>
            This composes a <strong>draft</strong> with the template’s{' '}
            {using?.lines.length ?? 0} line{using?.lines.length === 1 ? '' : 's'}. Nothing goes
            out until you issue it, and you can still edit it first.
          </Alert>
          <Stack spacing={2}>
            <TextField
              select
              required
              label="Supplier"
              fullWidth
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              helperText="A template has no supplier of its own — this is where it gets one."
            >
              <MenuItem value="">Pick a supplier…</MenuItem>
              {suppliers.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Title"
              fullWidth
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Deadline"
                type="date"
                fullWidth
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
                helperText={
                  typeof using?.default_due_in_days === 'number'
                    ? `Blank uses the template's ${using.default_due_in_days} days from today.`
                    : 'Optional.'
                }
              />
              <TextField
                select
                label="Buyer chasing this"
                fullWidth
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                <MenuItem value="">Nobody yet</MenuItem>
                {users.map((u) => (
                  <MenuItem key={u.id} value={u.id}>
                    {u.name}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUsing(null)} color="inherit" disabled={busy}>
            Cancel
          </Button>
          <Button variant="contained" onClick={instantiate} disabled={busy}>
            {busy ? 'Composing…' : 'Create draft'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
