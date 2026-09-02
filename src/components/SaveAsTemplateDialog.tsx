/**
 * SaveAsTemplateDialog — keep a composed set so the next one is a two-click job.
 *
 * A template is a SNAPSHOT, not a link: `POST /api/request-templates` with
 * `from_request_id` copies the lines as they stand, and editing the template
 * later does not reach back into the requests it produced (nor the reverse).
 * That is the honest behaviour to describe, because the alternative assumption
 * — "I fixed the template, so the outstanding asks are fixed too" — is the one
 * that would bite.
 *
 * `default_due_in_days` is the only piece of scheduling a template can hold: it
 * has no supplier and no calendar, so a fixed date would be wrong the day after
 * it was saved. Instantiating adds the days to today.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';

export interface SaveAsTemplateDialogProps {
  open: boolean;
  /** Suggested name — usually the request's own title. */
  defaultName: string;
  lineCount: number;
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    description: string | null;
    default_due_in_days: number | null;
  }) => Promise<void>;
}

export function SaveAsTemplateDialog({
  open,
  defaultName,
  lineCount,
  onClose,
  onSubmit,
}: SaveAsTemplateDialogProps) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [dueInDays, setDueInDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setDescription('');
    setDueInDays('');
    setError('');
  }, [open, defaultName]);

  const submit = async () => {
    if (!name.trim()) {
      setError('Give the template a name — it is how you will find it next time.');
      return;
    }
    const days = dueInDays.trim() === '' ? null : Number(dueInDays);
    if (days !== null && (!Number.isFinite(days) || days < 0)) {
      setError('“Due in” has to be a number of days, or blank.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || null,
        default_due_in_days: days,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save this template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Save as a template</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          Copies these {lineCount} line{lineCount === 1 ? '' : 's'} — their wording, formats,
          criteria and tiers — as they stand right now. A template has no supplier and no
          deadline of its own; you point it at a supplier when you use it. Editing it later
          does not change requests you have already sent.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Stack spacing={2}>
          <TextField
            label="Template name"
            required
            fullWidth
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. New approved vendor — full packet"
          />
          <TextField
            label="What it is for"
            fullWidth
            multiline
            minRows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            helperText="Becomes the introduction on requests made from it, unless you write a different one."
          />
          <TextField
            label="Due in (days)"
            fullWidth
            value={dueInDays}
            onChange={(e) => setDueInDays(e.target.value)}
            placeholder="30"
            helperText="Optional. Counted from the day you use the template — a template cannot hold a fixed date."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save template'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
