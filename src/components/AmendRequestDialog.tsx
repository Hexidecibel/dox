/**
 * AmendRequestDialog — correct an ask the supplier is ALREADY HOLDING.
 *
 * Amend and re-issue are the easy thing to confuse in this feature, so the two
 * dialogs are separate files with separate words and no shared "mode" prop:
 *
 *   AMEND (this file)          same ask, next version. The version the supplier
 *                              holds is preserved verbatim and stamped
 *                              superseded; the new one goes out immediately and
 *                              per-line progress is carried forward, so a
 *                              document already under review is not re-chased.
 *                              A reason is mandatory — `amendRequest` refuses
 *                              one without, because an amendment with no stated
 *                              reason is an untraceable rewrite.
 *
 *   RE-ISSUE (ReissueRequestDialog)
 *                              a NEW ask at version 1 on its own root, landing
 *                              as a draft with progress reset. Last year's
 *                              record is not touched.
 *
 * WHAT THE `lines` SWITCH DOES, AND WHY IT IS OFF
 * ----------------------------------------------
 * `amendRequest` treats an absent `lines` as "keep the previous composition
 * verbatim" and a present one as a WHOLESALE REPLACEMENT. Sending the current
 * line set back unchanged would therefore look identical and would not be — it
 * re-keys every line and re-derives which progress carries. So the switch is
 * off by default and, when off, the request body omits `lines` entirely. That
 * covers the common amendment: the due date moved.
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
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type {
  AmendDocumentRequestRequest,
  DocumentRequestDetail,
  RequestIssueChannel,
} from '../lib/types';
import {
  RequestLineComposer,
  draftsFromLines,
  draftsToLineInputs,
  type RequestLineDraft,
  type RequirementOption,
} from './RequestLineComposer';

export interface AmendRequestDialogProps {
  open: boolean;
  request: DocumentRequestDetail;
  /** The tenant's checklist, for the line composer behind the switch. */
  vocab: RequirementOption[];
  assignees: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (body: AmendDocumentRequestRequest) => Promise<void>;
}

export function AmendRequestDialog({
  open,
  request,
  vocab,
  assignees,
  onClose,
  onSubmit,
}: AmendRequestDialogProps) {
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState(request.title);
  const [intro, setIntro] = useState(request.intro ?? '');
  const [dueDate, setDueDate] = useState(request.due_date ?? '');
  const [assignedTo, setAssignedTo] = useState(request.assigned_to ?? '');
  const [channel, setChannel] = useState<RequestIssueChannel>(
    request.routing?.channel ?? 'portal',
  );
  const [recipient, setRecipient] = useState(request.routing?.recipient ?? '');
  const [internalNotes, setInternalNotes] = useState('');
  const [changeLines, setChangeLines] = useState(false);
  const [drafts, setDrafts] = useState<RequestLineDraft[]>(() => draftsFromLines(request.lines));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    setTitle(request.title);
    setIntro(request.intro ?? '');
    setDueDate(request.due_date ?? '');
    setAssignedTo(request.assigned_to ?? '');
    setChannel(request.routing?.channel ?? 'portal');
    setRecipient(request.routing?.recipient ?? '');
    setInternalNotes('');
    setChangeLines(false);
    setDrafts(draftsFromLines(request.lines));
    setError('');
  }, [open, request]);

  const submit = async () => {
    if (!reason.trim()) {
      setError('Say what changed — the amendment is recorded against this reason.');
      return;
    }
    if (changeLines && drafts.length === 0) {
      setError('An amended request must still ask for at least one thing.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        amendment_reason: reason.trim(),
        title: title.trim(),
        intro: intro.trim() || null,
        due_date: dueDate || null,
        assigned_to: assignedTo || null,
        channel,
        recipient: recipient.trim() || null,
        internal_notes: internalNotes.trim() || null,
        // Omitted entirely unless the switch is on — see the header note.
        ...(changeLines ? { lines: draftsToLineInputs(drafts) } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to amend this request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Amend this request</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>This replaces what the supplier is holding</AlertTitle>
          They already have version {request.version}. Amending sends them version{' '}
          {request.version + 1} of the <strong>same ask</strong> and marks the old one
          superseded — nothing about it is erased, and anything already received or under
          review keeps its progress. If this is a new ask rather than a correction to this
          one, close this and use <strong>Re-issue</strong> instead.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <Stack spacing={2}>
          <TextField
            label="What changed, and why"
            required
            fullWidth
            multiline
            minRows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Deadline moved to the 30th at the supplier’s request"
            helperText="Recorded on the amendment permanently. An amendment with no stated reason is an untraceable rewrite."
          />
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
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              select
              label="How it goes out"
              fullWidth
              value={channel}
              onChange={(e) => setChannel(e.target.value as RequestIssueChannel)}
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
            />
          </Stack>
          <TextField
            label="Internal note"
            fullWidth
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            helperText="Ours only. Never shown to the supplier."
          />

          <FormControlLabel
            control={
              <Switch
                checked={changeLines}
                onChange={(e) => setChangeLines(e.target.checked)}
              />
            }
            label="Also change what is being asked for"
          />
          {changeLines ? (
            <>
              <Typography variant="body2" color="text.secondary">
                This replaces the line set on the new version. Lines that stay the same keep
                whatever progress they already had; new ones start at not started.
              </Typography>
              <RequestLineComposer
                vocab={vocab}
                value={drafts}
                onChange={setDrafts}
                emptyMessage="This tenant has no checklist items configured yet."
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              The {request.counts.total} line
              {request.counts.total === 1 ? '' : 's'} carry over exactly as issued.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={saving}>
          {saving ? 'Amending…' : `Issue version ${request.version + 1}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
