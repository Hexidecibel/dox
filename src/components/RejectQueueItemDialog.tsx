import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { REJECTION_REASONS, REJECTION_REASON_LABELS } from '../lib/types';
import type { RejectionReason } from '../lib/types';

/**
 * Ask WHY before rejecting.
 *
 * Rejections used to record `{file_name}` and nothing else, which made every
 * post-mortem guesswork: the 2026-08-01 study had to reconstruct causes with an
 * LLM grader running at 29% precision, because the reviewer's own answer —
 * free, accurate, and known at the moment of the click — was never captured.
 *
 * The options mirror that study's A/B/C taxonomy so future rejections are
 * countable without a grader. A reason is REQUIRED (one click, pre-selected to
 * nothing so it is a real choice); the note is optional except for "Something
 * else", where the enum by definition says nothing.
 */
export default function RejectQueueItemDialog({
  open,
  fileName,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  fileName?: string;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (reason: RejectionReason, note: string) => void;
}) {
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [note, setNote] = useState('');

  // Fresh choice per item — never carry the last reason into the next reject.
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);

  const noteRequired = reason === 'other';
  const canSubmit = !!reason && (!noteRequired || note.trim().length > 0) && !submitting;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Reject this document</DialogTitle>
      <DialogContent>
        {fileName && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {fileName}
          </Typography>
        )}
        <FormControl>
          <FormLabel sx={{ mb: 1 }}>Why?</FormLabel>
          <RadioGroup
            value={reason}
            onChange={(e) => setReason(e.target.value as RejectionReason)}
          >
            {REJECTION_REASONS.map((r) => (
              <FormControlLabel
                key={r}
                value={r}
                control={<Radio size="small" />}
                sx={{ alignItems: 'flex-start', mb: 0.5 }}
                label={
                  <>
                    <Typography variant="body2">{REJECTION_REASON_LABELS[r].label}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {REJECTION_REASON_LABELS[r].help}
                    </Typography>
                  </>
                }
              />
            ))}
          </RadioGroup>
        </FormControl>
        <TextField
          label={noteRequired ? 'What happened? (required)' : 'Anything to add? (optional)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          multiline
          rows={2}
          fullWidth
          size="small"
          sx={{ mt: 2 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          The file is kept, not deleted — a rejected document can still be opened
          and re-processed later.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={!canSubmit}
          onClick={() => reason && onConfirm(reason, note.trim())}
        >
          Reject
        </Button>
      </DialogActions>
    </Dialog>
  );
}
