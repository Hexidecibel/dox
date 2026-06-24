import { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Radio,
  RadioGroup,
  FormControlLabel,
  Autocomplete,
  TextField,
  Chip,
  CircularProgress,
  Alert,
  Snackbar,
  IconButton,
} from '@mui/material';
import {
  Close as CloseIcon,
  MergeType as MergeIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiSupplier } from '../lib/types';

interface SupplierManualMergeDialogProps {
  open: boolean;
  onClose: () => void;
  /** Tenant to scope the supplier search to (super_admin selection / own tenant). */
  tenantId?: string;
  /** Whether the current user may perform merges (org_admin / super_admin). */
  canMerge: boolean;
  /** Called after a successful merge so the parent can refresh its list + duplicates panel. */
  onMerged?: () => void;
}

/** doc_count is not on the ApiSupplier type but the list endpoint may return it. */
function docCountOf(s: ApiSupplier): number {
  const n = (s as ApiSupplier & { doc_count?: number }).doc_count;
  return typeof n === 'number' ? n : 0;
}

/** Default the survivor to the member with the most documents, else the first. */
function pickDefaultWinner(members: ApiSupplier[]): string {
  if (members.length === 0) return '';
  return members.reduce((best, m) => (docCountOf(m) > docCountOf(best) ? m : best), members[0]).id;
}

export function SupplierManualMergeDialog({
  open,
  onClose,
  tenantId,
  canMerge,
  onMerged,
}: SupplierManualMergeDialogProps) {
  const [searchInput, setSearchInput] = useState('');
  const [options, setOptions] = useState<ApiSupplier[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ApiSupplier[]>([]);
  const [winnerId, setWinnerId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [snackbar, setSnackbar] = useState('');

  // Reset everything when the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setSearchInput('');
      setOptions([]);
      setSelected([]);
      setWinnerId('');
      setMerging(false);
      setMergeError('');
    }
  }, [open]);

  // Debounced supplier search.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.suppliers.list({
          search: searchInput || undefined,
          tenant_id: tenantId,
          limit: 20,
        });
        if (!cancelled) setOptions(result.suppliers || []);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchInput, tenantId, open]);

  // Keep the survivor valid: default it, and reset if it's removed from the selection.
  useEffect(() => {
    setWinnerId((prev) => {
      if (prev && selected.some((s) => s.id === prev)) return prev;
      return pickDefaultWinner(selected);
    });
  }, [selected]);

  const winner = useMemo(() => selected.find((s) => s.id === winnerId) ?? null, [selected, winnerId]);
  const losers = useMemo(() => selected.filter((s) => s.id !== winnerId), [selected, winnerId]);

  const handleClose = () => {
    if (merging) return;
    onClose();
  };

  const handleMerge = async () => {
    if (!winnerId || losers.length === 0) return;
    const loserIds = losers.map((s) => s.id);

    setMerging(true);
    setMergeError('');
    try {
      const result = await api.suppliers.merge(winnerId, loserIds);
      const totalReassigned = Object.values(result.reassigned || {}).reduce(
        (sum, n) => sum + (n || 0),
        0
      );
      const winnerName = winner?.name ?? 'supplier';
      setSnackbar(
        `Merged ${loserIds.length} supplier${loserIds.length === 1 ? '' : 's'} into "${winnerName}". ` +
          `Reassigned ${totalReassigned} document${totalReassigned === 1 ? '' : 's'}.`
      );
      onMerged?.();
      onClose();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Failed to merge suppliers');
    } finally {
      setMerging(false);
    }
  };

  if (!canMerge) return null;

  return (
    <>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Merge suppliers
          <IconButton onClick={handleClose} size="small" disabled={merging}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {mergeError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setMergeError('')}>
              {mergeError}
            </Alert>
          )}
          <DialogContentText sx={{ mb: 2 }}>
            Search and pick two or more suppliers to merge — even if their names are dissimilar.
          </DialogContentText>

          <Autocomplete
            multiple
            options={options}
            value={selected}
            onChange={(_, value) => setSelected(value)}
            inputValue={searchInput}
            onInputChange={(_, value) => setSearchInput(value)}
            getOptionLabel={(opt) => opt.name}
            isOptionEqualToValue={(opt, val) => opt.id === val.id}
            filterOptions={(opts) => opts}
            loading={searching}
            disabled={merging}
            renderTags={(value, getTagProps) =>
              value.map((opt, index) => (
                <Chip
                  {...getTagProps({ index })}
                  key={opt.id}
                  label={opt.name}
                  size="small"
                />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Suppliers to merge"
                placeholder="Type to search…"
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {searching ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
            sx={{ mb: 2 }}
          />

          {selected.length >= 2 && (
            <>
              <DialogContentText sx={{ mb: 1 }}>
                Pick the supplier to keep (the survivor). The others will be merged into it.
              </DialogContentText>
              <RadioGroup value={winnerId} onChange={(e) => setWinnerId(e.target.value)}>
                {selected.map((s) => (
                  <FormControlLabel
                    key={s.id}
                    value={s.id}
                    disabled={merging}
                    control={<Radio />}
                    label={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography variant="body2" fontWeight={500}>
                          {s.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace' }}
                        >
                          {s.slug || '—'}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </RadioGroup>
            </>
          )}

          {winner && losers.length > 0 && (
            <Alert severity="warning" sx={{ mt: 2 }} icon={false}>
              <Typography variant="body2">
                Keep <strong>{winner.name}</strong>. Merge{' '}
                <strong>{losers.map((l) => l.name).join(', ')}</strong> into it. This reassigns all
                their documents, products, lots, templates, and instructions to{' '}
                <strong>{winner.name}</strong>, then deletes them.{' '}
                <strong>This cannot be undone.</strong>
              </Typography>
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleClose} disabled={merging}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={handleMerge}
            disabled={merging || !winnerId || losers.length === 0}
            startIcon={merging ? <CircularProgress size={16} color="inherit" /> : <MergeIcon />}
          >
            {merging ? 'Merging…' : 'Merge suppliers'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snackbar}
        autoHideDuration={6000}
        onClose={() => setSnackbar('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setSnackbar('')}>
          {snackbar}
        </Alert>
      </Snackbar>
    </>
  );
}
