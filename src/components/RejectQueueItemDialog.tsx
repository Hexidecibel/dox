import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
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
import { ATTENTION_REASON_PRESETS, REJECTION_REASONS, REJECTION_REASON_LABELS } from '../lib/types';
import type { QueueArrivalDecisionInput, RejectionReason, RequestArrival } from '../lib/types';
import { AttentionReasonField, initialTickedLineIds } from './SupplierClaimPanel';

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
 *
 * SUPPLIER-PORTAL FILES: when `arrival` is passed (the item came through a
 * request link), the same action can send the requirements the supplier
 * claimed back to them, with the sentence they will read. Off unless ticked,
 * except for "Sales sheet, not a spec sheet", where sending it back is the
 * whole point and the preset sentence is filled in.
 */
export default function RejectQueueItemDialog({
  open,
  fileName,
  submitting,
  onClose,
  onConfirm,
  arrival,
}: {
  open: boolean;
  fileName?: string;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (reason: RejectionReason, note: string, arrivalDecision?: QueueArrivalDecisionInput) => void;
  /** The supplier arrival this item came from, when it came through a request link. */
  arrival?: RequestArrival | null;
}) {
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [note, setNote] = useState('');
  const [sendBack, setSendBack] = useState(false);
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [attentionReason, setAttentionReason] = useState('');

  const salesSheet = ATTENTION_REASON_PRESETS.find((p) => p.key === 'sales_sheet')!;
  const canSendBack = Boolean(arrival && arrival.current_request_status === 'issued');
  const claimed = (arrival?.claims ?? []).filter((c) => c.line_id !== null);

  // Fresh choice per item — never carry the last reason into the next reject.
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
      setSendBack(false);
      setLineIds(arrival ? initialTickedLineIds(arrival) : []);
      setAttentionReason('');
    }
  }, [open, arrival]);

  const pickReason = (r: RejectionReason) => {
    setReason(r);
    if (r === 'sales_sheet' && canSendBack) {
      setSendBack(true);
      if (!attentionReason.trim()) setAttentionReason(salesSheet.text);
    }
  };

  const noteRequired = reason === 'other';
  const sendBackReady = !sendBack || lineIds.length > 0;
  const canSubmit =
    !!reason && (!noteRequired || note.trim().length > 0) && sendBackReady && !submitting;

  const confirm = () => {
    if (!reason) return;
    const decision: QueueArrivalDecisionInput | undefined =
      canSendBack && sendBack && lineIds.length > 0
        ? {
            decisions: lineIds.map((id) => ({
              line_id: id,
              decision: 'needs_attention' as const,
              attention_reason: attentionReason.trim() || null,
            })),
          }
        : undefined;
    onConfirm(reason, note.trim(), decision);
  };

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
            onChange={(e) => pickReason(e.target.value as RejectionReason)}
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
        {canSendBack && (
          <Box sx={{ mt: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
            <FormControlLabel
              control={<Checkbox size="small" checked={sendBack} onChange={(e) => setSendBack(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  Also send {claimed.length === 1 ? 'the requirement' : 'requirements'} back to{' '}
                  {arrival?.supplier_name ?? 'the supplier'}
                </Typography>
              }
            />
            {sendBack && (
              <Box sx={{ pl: 3.5 }}>
                {claimed.length === 0 ? (
                  <Typography variant="caption" color="text.secondary" display="block">
                    The supplier did not say which requirement this file covers, so there is nothing to send
                    back from here. Use the request's arrivals screen.
                  </Typography>
                ) : (
                  claimed.map((c) => (
                    <FormControlLabel
                      key={c.claim_id}
                      sx={{ display: 'flex' }}
                      control={
                        <Checkbox
                          size="small"
                          checked={lineIds.includes(c.line_id!)}
                          onChange={() =>
                            setLineIds((prev) =>
                              prev.includes(c.line_id!) ? prev.filter((x) => x !== c.line_id) : [...prev, c.line_id!],
                            )
                          }
                        />
                      }
                      label={<Typography variant="body2">{c.line_name}</Typography>}
                    />
                  ))
                )}
                <Box sx={{ mt: 1 }}>
                  <AttentionReasonField value={attentionReason} onChange={setAttentionReason} />
                </Box>
              </Box>
            )}
          </Box>
        )}
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
          onClick={confirm}
        >
          {canSendBack && sendBack && lineIds.length > 0 ? 'Reject & send back' : 'Reject'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
