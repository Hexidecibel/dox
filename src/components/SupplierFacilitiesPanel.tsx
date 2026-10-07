/**
 * Supplier > Facilities (migration 0135, decision C-002): the named places
 * this supplier's items come from.
 *
 * A facility is added HERE, by a person. Nothing in the portal creates one
 * from a certificate, and an item with no facility is not incomplete -- it
 * counts toward the whole supplier. The plant code is the identifier a
 * certificate prints; it is recorded for the reader and matched against
 * nothing. There is no "line".
 */

import { useCallback, useEffect, useState } from 'react';
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
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { SupplierFacilitiesResponse, SupplierFacility } from '../../shared/types';

interface Props {
  supplierId: string;
  supplierName: string;
  canEdit: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  plantCode: string;
  notes: string;
  active: boolean;
}

const EMPTY: Draft = { id: null, name: '', plantCode: '', notes: '', active: true };

export default function SupplierFacilitiesPanel({ supplierId, supplierName, canEdit }: Props) {
  const [data, setData] = useState<SupplierFacilitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.suppliers.facilities.list(supplierId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load facilities');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (f: SupplierFacility) => {
    setDialogError('');
    setDraft({ id: f.id, name: f.name, plantCode: f.plant_code ?? '', notes: f.notes ?? '', active: f.active });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setDialogError('');
    try {
      const body = {
        name: draft.name.trim(),
        plant_code: draft.plantCode.trim() || null,
        notes: draft.notes.trim() || null,
        ...(draft.id ? { active: draft.active } : {}),
      };
      const next = draft.id
        ? await api.suppliers.facilities.update(supplierId, draft.id, body)
        : await api.suppliers.facilities.create(supplierId, body);
      setData(next);
      setDraft(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Failed to save facility');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: SupplierFacility) => {
    const warning =
      f.item_count > 0
        ? `Remove ${f.name}? ${f.item_count} item${f.item_count === 1 ? '' : 's'} will go back to "no facility recorded". The items themselves are not removed.`
        : `Remove ${f.name}?`;
    if (!window.confirm(warning)) return;
    setNotice('');
    try {
      const next = await api.suppliers.facilities.remove(supplierId, f.id);
      setData(next);
      if (next.cleared_items > 0) {
        setNotice(
          `${f.name} removed. ${next.cleared_items} item${next.cleared_items === 1 ? ' now has' : 's now have'} no facility recorded.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove facility');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  const facilities = data?.facilities ?? [];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">Facilities</Typography>
          <Typography variant="body2" color="text.secondary">
            The plants or sites {supplierName} ships from. Add one here, then name it on an item under
            Products. An item with no facility counts toward the whole supplier. Nothing is read off a
            certificate to fill this in.
          </Typography>
        </Box>
        {canEdit && (
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => {
              setDialogError('');
              setDraft({ ...EMPTY });
            }}
          >
            Add facility
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="info" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert>}

      {facilities.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="no-facilities">
          No facilities recorded. Every item counts toward the whole supplier.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Plant code</TableCell>
                <TableCell>Items</TableCell>
                <TableCell>Notes</TableCell>
                {canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {facilities.map((f) => (
                <TableRow key={f.id} hover sx={f.active ? undefined : { opacity: 0.55 }}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{f.name}</span>
                      {!f.active && <Chip size="small" variant="outlined" label="No longer in use" />}
                    </Stack>
                  </TableCell>
                  <TableCell>{f.plant_code || '—'}</TableCell>
                  <TableCell>{f.item_count}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>{f.notes || '—'}</TableCell>
                  {canEdit && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <IconButton size="small" aria-label={`Edit ${f.name}`} onClick={() => openEdit(f)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={!!draft} onClose={() => !saving && setDraft(null)} fullWidth maxWidth="sm">
        <DialogTitle>{draft?.id ? 'Edit facility' : 'Add facility'}</DialogTitle>
        {draft && (
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {dialogError && <Alert severity="error">{dialogError}</Alert>}
              <TextField
                label="Name"
                required
                autoFocus={!draft.id}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                helperText="What you call the site: a town, a plant name."
                fullWidth
                size="small"
              />
              <TextField
                label="Plant code"
                value={draft.plantCode}
                onChange={(e) => setDraft({ ...draft, plantCode: e.target.value })}
                helperText="Optional. The code the supplier's certificates print for this site."
                fullWidth
                size="small"
              />
              <TextField
                label="Notes"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                multiline
                minRows={2}
                fullWidth
                size="small"
              />
              {draft.id && (
                <FormControlLabel
                  control={
                    <Checkbox checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                  }
                  label="In use — items can be assigned to it"
                />
              )}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || !draft?.name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
