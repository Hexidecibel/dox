/**
 * The approval and the facility of ONE item from ONE supplier (migration 0135),
 * as the two controls every screen that shows a pair uses: the Approved items
 * page and Supplier > Products.
 *
 * Approval is NOT "currently supplied" -- that is a different chip on a
 * different column -- and it decides nothing else in the portal. What the chip
 * has to get right is WHO said so: a pair that was on file when approvals were
 * introduced reads "Approved" with a tooltip saying nobody decided it, never
 * as somebody's sign-off.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Edit as EditIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import { ITEM_APPROVAL_LABELS, describeApprovalSource } from '../../shared/itemApproval';
import type { ItemApprovalSource, ItemApprovalStatus, SupplierFacility } from '../../shared/types';

const CHIP_COLOR: Record<ItemApprovalStatus, 'success' | 'warning' | 'error'> = {
  approved: 'success',
  pending: 'warning',
  not_approved: 'error',
};

export function ItemApprovalChip({
  status,
  source,
  note,
  onClick,
}: {
  status: ItemApprovalStatus;
  source: ItemApprovalSource | null;
  note?: string | null;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const title = [describeApprovalSource(source), note].filter(Boolean).join(' — ');
  return (
    <Tooltip title={title}>
      <Chip
        size="small"
        color={CHIP_COLOR[status]}
        variant={source === 'person' ? 'filled' : 'outlined'}
        label={ITEM_APPROVAL_LABELS[status]}
        onClick={onClick}
        data-testid="item-approval-chip"
      />
    </Tooltip>
  );
}

interface ApprovalProps {
  supplierId: string;
  productId: string;
  productName: string;
  /** NULL = nothing recorded for this supplier's link yet; shown as pending. */
  status: ItemApprovalStatus | null | undefined;
  source: ItemApprovalSource | null | undefined;
  note?: string | null;
  canEdit: boolean;
  onChanged: () => void;
}

/** The chip, and for an admin the three decisions behind it. */
export function ItemApprovalControl({
  supplierId,
  productId,
  productName,
  status,
  source,
  note,
  canEdit,
  onChanged,
}: ApprovalProps) {
  const current: ItemApprovalStatus = status ?? 'pending';
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const decide = async (next: ItemApprovalStatus, withNote?: string) => {
    setSaving(true);
    setError('');
    try {
      await api.supplierProducts.update(supplierId, productId, {
        approval_status: next,
        ...(withNote !== undefined ? { approval_note: withNote } : {}),
      });
      setNoteOpen(false);
      setAnchor(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the approval');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <ItemApprovalChip
        status={current}
        source={source ?? null}
        note={note}
        onClick={
          canEdit
            ? (e) => {
                e.stopPropagation();
                setAnchor(e.currentTarget);
              }
            : undefined
        }
      />
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} onClick={(e) => e.stopPropagation()}>
        <MenuItem disabled={saving} onClick={() => void decide('approved')}>
          Approve
        </MenuItem>
        <MenuItem
          disabled={saving}
          onClick={() => {
            setAnchor(null);
            setNoteText('');
            setError('');
            setNoteOpen(true);
          }}
        >
          Mark not approved…
        </MenuItem>
        <MenuItem disabled={saving} onClick={() => void decide('pending')}>
          Set back to pending
        </MenuItem>
        {error && !noteOpen && (
          <MenuItem disabled sx={{ whiteSpace: 'normal', maxWidth: 280, opacity: '1 !important' }}>
            <Typography variant="caption" color="error">{error}</Typography>
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={noteOpen}
        onClose={() => !saving && setNoteOpen(false)}
        onClick={(e) => e.stopPropagation()}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Mark {productName} not approved</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <Typography variant="body2" color="text.secondary">
              This records that the item is not approved from this supplier. It does not change whether
              the item is currently supplied, and nothing in the portal is blocked by it.
            </Typography>
            <TextField
              label="Why"
              required
              autoFocus
              multiline
              minRows={2}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              inputProps={{ 'data-testid': 'item-approval-note' }}
              helperText="Kept with the decision and shown wherever the item is listed."
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNoteOpen(false)} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            disabled={saving || !noteText.trim()}
            onClick={() => void decide('not_approved', noteText.trim())}
          >
            {saving ? 'Saving…' : 'Mark not approved'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

interface FacilityProps {
  supplierId: string;
  productId: string;
  productName: string;
  facilityId: string | null | undefined;
  facilityName: string | null | undefined;
  canEdit: boolean;
  onChanged: () => void;
}

/**
 * Which facility the item comes from. "No facility recorded" is a complete
 * answer: the item simply counts toward the whole supplier. The supplier's
 * facilities are read when the picker opens, not for every row of a list.
 */
export function ItemFacilityControl({
  supplierId,
  productId,
  productName,
  facilityId,
  facilityName,
  canEdit,
  onChanged,
}: FacilityProps) {
  const [open, setOpen] = useState(false);
  const [facilities, setFacilities] = useState<SupplierFacility[] | null>(null);
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFacilities(null);
    setError('');
    setChoice(facilityId ?? '');
    api.suppliers.facilities
      .list(supplierId)
      .then((res) => {
        if (live) setFacilities(res.facilities);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load facilities');
      });
    return () => {
      live = false;
    };
  }, [open, supplierId, facilityId]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.supplierProducts.update(supplierId, productId, { facility_id: choice || null });
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the facility');
    } finally {
      setSaving(false);
    }
  };

  // A retired facility is offered only to the item that already names it.
  const options = (facilities ?? []).filter((f) => f.active || f.id === facilityId);

  return (
    <>
      <Stack direction="row" alignItems="center" spacing={0.5} onClick={(e) => e.stopPropagation()}>
        <Typography variant="body2" color={facilityName ? 'text.primary' : 'text.secondary'}>
          {facilityName || 'No facility recorded'}
        </Typography>
        {canEdit && (
          <IconButton size="small" aria-label={`Set facility for ${productName}`} onClick={() => setOpen(true)}>
            <EditIcon fontSize="inherit" />
          </IconButton>
        )}
      </Stack>
      <Dialog open={open} onClose={() => !saving && setOpen(false)} onClick={(e) => e.stopPropagation()} fullWidth maxWidth="xs">
        <DialogTitle>Facility for {productName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            {facilities === null && !error ? (
              <CircularProgress size={22} />
            ) : (
              <>
                <FormControl size="small" fullWidth>
                  <InputLabel id="item-facility-label">Facility</InputLabel>
                  <Select
                    labelId="item-facility-label"
                    label="Facility"
                    value={choice}
                    onChange={(e) => setChoice(String(e.target.value))}
                  >
                    <MenuItem value="">No facility recorded</MenuItem>
                    {options.map((f) => (
                      <MenuItem key={f.id} value={f.id}>
                        {f.name}
                        {f.plant_code ? ` (${f.plant_code})` : ''}
                        {f.active ? '' : ' — no longer in use'}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {options.length === 0 && (
                  <Typography variant="body2" color="text.secondary">
                    This supplier has no facilities yet. Add one on the supplier's Facilities tab.
                  </Typography>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => void save()} disabled={saving || facilities === null}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
