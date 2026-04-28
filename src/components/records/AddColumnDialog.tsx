/**
 * AddColumnDialog — minimal column creator. Phase 1 surface:
 *   - Label (required)
 *   - Type (required, picked from a curated subset of column types)
 *   - For dropdown_single: comma- or newline-separated options
 *
 * Width / required / is_title are not surfaced here — they're admin
 * niceties that the spec deferred. The backend defaults handle them.
 */

import { useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import type { CreateColumnRequest, RecordColumnType } from '../../../shared/types';

interface AddColumnDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: CreateColumnRequest) => Promise<void>;
}

const COLUMN_TYPE_CHOICES: { value: RecordColumnType; label: string; hint: string }[] = [
  { value: 'text',            label: 'Text',           hint: 'Short single-line text' },
  { value: 'long_text',       label: 'Long text',      hint: 'Multi-line description' },
  { value: 'number',          label: 'Number',         hint: 'Numeric, locale-formatted' },
  { value: 'date',            label: 'Date',           hint: 'Calendar picker' },
  { value: 'checkbox',        label: 'Checkbox',       hint: 'Yes / no' },
  { value: 'dropdown_single', label: 'Dropdown',       hint: 'Pick one of a fixed list' },
  { value: 'supplier_ref',    label: 'Supplier',       hint: 'Link to a supplier record' },
  { value: 'product_ref',     label: 'Product',        hint: 'Link to a product record' },
];

export function AddColumnDialog({ open, onClose, onCreate }: AddColumnDialogProps) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<RecordColumnType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setLabel('');
    setType('text');
    setOptionsText('');
    setError('');
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const handleSubmit = async () => {
    if (!label.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const data: CreateColumnRequest = {
        label: label.trim(),
        type,
      };
      if (type === 'dropdown_single' && optionsText.trim()) {
        const opts = optionsText
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((value) => ({ value, label: value }));
        data.config = { options: opts };
      }
      await onCreate(data);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add column');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Add column
        <IconButton size="small" onClick={handleClose} disabled={submitting}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Column name"
            placeholder="e.g. Status, Owner, Due date"
            fullWidth
            autoFocus
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && label.trim() && !submitting) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Type
            </Typography>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value as RecordColumnType)}
              fullWidth
              disabled={submitting}
            >
              {COLUMN_TYPE_CHOICES.map((c) => (
                <MenuItem key={c.value} value={c.value}>
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{c.label}</Typography>
                    <Typography variant="caption" color="text.secondary">{c.hint}</Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </Box>
          {type === 'dropdown_single' && (
            <TextField
              label="Options"
              helperText="One per line, or comma-separated"
              fullWidth
              multiline
              rows={4}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              disabled={submitting}
            />
          )}
          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!label.trim() || submitting}>
          {submitting ? 'Adding…' : 'Add column'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
