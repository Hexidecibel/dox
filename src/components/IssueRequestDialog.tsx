/**
 * IssueRequestDialog — the last screen before an ask leaves the building.
 *
 * Issuing is one act by one person and it happens once: `issueRequest` refuses
 * a second issue (there is a UNIQUE on request_routing.request_id) and refuses
 * an empty packet. After it, the request is immutable — changing it means an
 * amendment, which is versioned. So this dialog restates both facts rather than
 * being a confirm button with a spinner.
 *
 * `recipient` and `internal_notes` are ROUTING, which is internal by
 * construction: `buildSupplierRequestView` builds the supplier's payload from a
 * named allow-list that includes neither. The helper text says so, because a
 * person typing a note into a form that is about to be sent somewhere deserves
 * to know which side of the line it lands on.
 *
 * There is deliberately NO client-side "preview what they will see" here. The
 * only honest preview is the server's own projection, and it exists only for a
 * request that is currently issued — so the detail page offers it after the
 * fact instead of this dialog re-deriving an allow-list that could drift.
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
  Typography,
} from '@mui/material';
import type { DocumentRequestDetail, IssueDocumentRequestRequest, RequestIssueChannel } from '../lib/types';

export interface IssueRequestDialogProps {
  open: boolean;
  request: DocumentRequestDetail;
  onClose: () => void;
  onSubmit: (body: IssueDocumentRequestRequest) => Promise<void>;
}

export function IssueRequestDialog({
  open,
  request,
  onClose,
  onSubmit,
}: IssueRequestDialogProps) {
  const [channel, setChannel] = useState<RequestIssueChannel>('portal');
  const [recipient, setRecipient] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setChannel('portal');
    setRecipient('');
    setInternalNotes('');
    setError('');
  }, [open]);

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        channel,
        recipient: recipient.trim() || null,
        internal_notes: internalNotes.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue this request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Issue this request</DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Once issued, it is not editable</AlertTitle>
          {request.supplier_name ?? 'The supplier'} will be asked for{' '}
          {request.counts.total} thing{request.counts.total === 1 ? '' : 's'} (
          {request.counts.required} required, {request.counts.recommended} recommended).
          After this, changing the ask means amending it, which sends a new version and
          keeps this one on the record.
          {request.counts.free_text > 0 && (
            <Typography variant="body2" sx={{ mt: 1, fontWeight: 600 }}>
              {request.counts.free_text} line
              {request.counts.free_text === 1 ? ' is' : 's are'} free text — nothing that
              arrives can close {request.counts.free_text === 1 ? 'it' : 'them'}, and{' '}
              {request.counts.free_text === 1 ? 'it' : 'they'} will never be counted as
              missing.
            </Typography>
          )}
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Stack spacing={2}>
          <TextField
            select
            label="How it goes out"
            fullWidth
            value={channel}
            onChange={(e) => setChannel(e.target.value as RequestIssueChannel)}
            helperText="Recorded on the issue, so there is one answer to “how did we send it?”"
          >
            <MenuItem value="portal">Portal</MenuItem>
            <MenuItem value="email">Email</MenuItem>
            <MenuItem value="manual">Manually, by us</MenuItem>
          </TextField>
          <TextField
            label="Recipient"
            fullWidth
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="qa@supplier.example"
            helperText="Who it went to, for our record. Internal."
          />
          <TextField
            label="Internal note"
            fullWidth
            multiline
            minRows={2}
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            helperText="Ours only — the supplier never sees this, the assigned buyer, or any of our line statuses."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={saving || request.counts.total === 0}
        >
          {saving ? 'Issuing…' : 'Issue'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
