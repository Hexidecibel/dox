/**
 * ReissueRequestDialog — start a FRESH ask modelled on an existing one.
 *
 * The counterpart to AmendRequestDialog, and deliberately not the same control
 * with a flag. What `reissueRequest` actually does, and what this dialog has to
 * make legible before someone clicks it:
 *
 *   * a NEW ask on its OWN root at version 1. The source request is not
 *     touched, not superseded, not re-opened.
 *   * line progress RESETS. Last year's certificate is not this year's, so
 *     every line starts at not started even where the source was accepted.
 *   * it lands as a DRAFT. A renewal is still an ask a person should look at
 *     before it goes out, and there is exactly one issue path.
 *   * it may point at a DIFFERENT supplier — that is how "the packet we send
 *     every approved vendor" gets reused without saving a template.
 *
 * If the intent is to correct the ask the supplier is already holding, that is
 * an amendment and this dialog says so rather than quietly doing the other
 * thing.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material';
import type { DocumentRequestDetail, ReissueDocumentRequestRequest } from '../lib/types';

export interface ReissueRequestDialogProps {
  open: boolean;
  request: DocumentRequestDetail;
  suppliers: { id: string; name: string }[];
  assignees: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (body: ReissueDocumentRequestRequest) => Promise<void>;
}

export function ReissueRequestDialog({
  open,
  request,
  suppliers,
  assignees,
  onClose,
  onSubmit,
}: ReissueRequestDialogProps) {
  const [supplierId, setSupplierId] = useState(request.supplier_id);
  const [title, setTitle] = useState(request.title);
  const [intro, setIntro] = useState(request.intro ?? '');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState(request.assigned_to ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setSupplierId(request.supplier_id);
    setTitle(request.title);
    setIntro(request.intro ?? '');
    // Deliberately blank: a renewal's deadline is this year's, and inheriting
    // the old one would put a date in the past on a brand-new ask.
    setDueDate('');
    setAssignedTo(request.assigned_to ?? '');
    setError('');
  }, [open, request]);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        supplier_id: supplierId,
        title: title.trim(),
        intro: intro.trim() || null,
        due_date: dueDate || null,
        assigned_to: assignedTo || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to re-issue this request');
    } finally {
      setSaving(false);
    }
  };

  const movedSupplier = supplierId !== request.supplier_id;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Re-issue as a new request</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>This is a new ask, not a correction</AlertTitle>
          “{request.title}” stays exactly as it is. You get a fresh request asking for the
          same {request.counts.total} thing{request.counts.total === 1 ? '' : 's'}, starting
          from nothing received — last year’s certificate is not this year’s. It is saved as
          a <strong>draft</strong>, so you can adjust it before it goes out. To change the
          packet the supplier is already holding, cancel and use{' '}
          <strong>Amend</strong> instead.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Stack spacing={2}>
          <TextField
            select
            label="Supplier"
            fullWidth
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            helperText={
              movedSupplier
                ? 'Sending the same packet to a different supplier. Their own outstanding items are not taken into account here — compose from scratch if you want that.'
                : 'Defaults to the same supplier, which is what a renewal is.'
            }
          >
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
          <TextField
            label="Introduction"
            fullWidth
            multiline
            minRows={2}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Deadline"
              type="date"
              fullWidth
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              helperText="Blank on purpose — set this year’s."
            />
            <TextField
              select
              label="Buyer chasing this"
              fullWidth
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
            >
              <MenuItem value="">Nobody yet</MenuItem>
              {assignees.map((u) => (
                <MenuItem key={u.id} value={u.id}>
                  {u.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create draft'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
