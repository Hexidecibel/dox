/**
 * RequirementsWorklist — supplier requirements that need a person.
 *
 * Two kinds of row land here, and they read differently on purpose:
 *
 *   Unconfirmed   written by the initial bulk seed, before anybody recorded
 *                 why (0102 `source IS NULL`). Every supplier got the same
 *                 set, so each row is a guess until somebody says otherwise.
 *   Not on the verified list
 *                 derived from an earlier supplier list import that the latest
 *                 import no longer supports (0112 `review_flag`). Still counted
 *                 in gap reports — it is never deleted automatically.
 *
 * Actions: Confirm (a person says it stands), Remove (audited, the same hard
 * detach as the editor), or Replace with a packet (apply a packet to the
 * selected suppliers and remove their unconfirmed rows it does not name).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import type { ApiSupplierRequirement } from '../lib/types';
import ApplyPacketDialog from './ApplyPacketDialog';

type ReviewFilter = 'any' | 'unconfirmed' | 'flagged';

export interface RequirementsWorklistProps {
  tenantId?: string;
  /** Fired after any write, so the host can refresh its counts. */
  onChanged?: () => void;
}

export function worklistReason(row: Pick<ApiSupplierRequirement, 'source' | 'review_flag'>): string {
  if (row.review_flag === 'not_on_verified_list') return 'No longer on the verified supplier list — review';
  if (row.source === null || row.source === undefined) return 'Set by the initial bulk seed — not confirmed';
  return 'Needs review';
}

export default function RequirementsWorklist({ tenantId, onChanged }: RequirementsWorklistProps) {
  const [filter, setFilter] = useState<ReviewFilter>('any');
  const [rows, setRows] = useState<ApiSupplierRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [packetOpen, setPacketOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await api.supplierRequirements.listAll({ tenant_id: tenantId, review: filter }));
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the worklist');
    } finally {
      setLoading(false);
    }
  }, [tenantId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: ApiSupplierRequirement[] }>();
    for (const r of rows) {
      const g = map.get(r.supplier_id) ?? { name: r.supplier_name || r.supplier_id, rows: [] };
      g.rows.push(r);
      map.set(r.supplier_id, g);
    }
    return [...map.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows]);

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedSuppliers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of selectedRows) m.set(r.supplier_id, r.supplier_name || r.supplier_id);
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [selectedRows]);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const act = async (action: 'confirm' | 'remove') => {
    setBusy(true);
    setError('');
    try {
      const res = await api.supplierRequirements.review({ action, ids: [...selected], tenant_id: tenantId });
      setNotice(action === 'confirm' ? `Confirmed ${res.applied} requirement${res.applied === 1 ? '' : 's'}.` : `Removed ${res.applied} requirement${res.applied === 1 ? '' : 's'}.`);
      setConfirmRemove(false);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
          <ToggleButton value="any">All needing review</ToggleButton>
          <ToggleButton value="unconfirmed">Unconfirmed (bulk seed)</ToggleButton>
          <ToggleButton value="flagged">Not on verified list</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {selected.size} selected
        </Typography>
        <Button size="small" variant="outlined" disabled={selected.size === 0 || busy} onClick={() => void act('confirm')}>
          Confirm
        </Button>
        <Button size="small" variant="outlined" color="warning" disabled={selected.size === 0 || busy} onClick={() => setConfirmRemove(true)}>
          Remove
        </Button>
        <Button size="small" variant="outlined" disabled={selectedSuppliers.length === 0 || busy} onClick={() => setPacketOpen(true)}>
          Replace with a packet
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : rows.length === 0 ? (
        <Alert severity="info">Nothing needs review. Every supplier requirement was set by a person, a packet, or the verified supplier list.</Alert>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {rows.length} requirement{rows.length === 1 ? '' : 's'} across {groups.length} supplier{groups.length === 1 ? '' : 's'}. These still count in gap
            reports until they are removed.
          </Typography>
          {groups.map(([supplierId, g]) => {
            const ids = g.rows.map((r) => r.id);
            const all = ids.every((id) => selected.has(id));
            const some = ids.some((id) => selected.has(id));
            return (
              <Paper key={supplierId} variant="outlined" sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Checkbox
                    size="small"
                    checked={all}
                    indeterminate={some && !all}
                    onChange={(e) => toggle(ids, e.target.checked)}
                    inputProps={{ 'aria-label': `Select all for ${g.name}` }}
                  />
                  <Typography variant="subtitle2">{g.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {g.rows.length} to review
                  </Typography>
                </Box>
                {g.rows.map((r) => (
                  <Box key={r.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 3, flexWrap: 'wrap' }}>
                    <Checkbox
                      size="small"
                      checked={selected.has(r.id)}
                      onChange={(e) => toggle([r.id], e.target.checked)}
                      inputProps={{ 'aria-label': `Select ${r.requirement_name} for ${g.name}` }}
                    />
                    <Typography variant="body2" sx={{ minWidth: 220 }}>
                      {r.requirement_name || r.requirement_slug}
                    </Typography>
                    <Chip size="small" variant="outlined" label={r.tier} />
                    <Chip
                      size="small"
                      color={r.review_flag ? 'warning' : 'default'}
                      variant="outlined"
                      label={worklistReason(r)}
                    />
                  </Box>
                ))}
              </Paper>
            );
          })}
        </Box>
      )}

      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)}>
        <DialogTitle>Remove {selected.size} requirement{selected.size === 1 ? '' : 's'}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            These suppliers will stop owing the selected items, and they will no longer appear as gaps. Each removal is
            recorded in the audit log with the row as it was.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
          <Button color="warning" variant="contained" disabled={busy} onClick={() => void act('remove')}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>

      <ApplyPacketDialog
        open={packetOpen}
        onClose={() => setPacketOpen(false)}
        suppliers={selectedSuppliers}
        tenantId={tenantId}
        defaultReplaceUnconfirmed
        onApplied={() => {
          setNotice('Packet applied.');
          void load();
          onChanged?.();
        }}
      />
    </Box>
  );
}
