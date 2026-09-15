/**
 * DecideArrivalDialog — say which requirements a supplier's file satisfies.
 *
 * One decision for the ticked requirements, because that is how a reviewer
 * reads a file: "this covers the allergen statement and the kosher letter" or
 * "this is the wrong certificate". Mixed outcomes are two passes, which keeps
 * the notes honest — a note written for the ones sent back is not silently
 * attached to the ones accepted.
 *
 * WHAT IS PRE-TICKED: the requirements the supplier said this file covers and
 * that are still waiting on a person. Anything already decided, or settled from
 * another file, is listed but left unticked; ticking it changes that decision.
 * "Add a requirement" records that the file covers something the supplier did
 * not tick (a staff claim on the server).
 *
 * ACCEPT IS DISABLED UNTIL THE FILE IS APPROVED, and says why, with a way to
 * get there. The server refuses it too (409); disabling it here is so nobody
 * types a note into a form that is going to bounce. Sending back is never
 * disabled.
 *
 * TWO NOTES, TWO AUDIENCES, labelled as such. The internal note never leaves
 * the portal; the reason is the sentence the supplier reads on their link.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type {
  DecideArrivalRequest,
  RequestArrival,
  RequestArrivalDecisionKind,
  RequestLineStatus,
} from '../lib/types';
import { claimChip } from './ArrivalCard';

/** A line on the CURRENT version, offered for "add a requirement". */
export interface DecidableLine {
  id: string;
  name: string;
  status: RequestLineStatus;
}

interface Row {
  lineId: string;
  name: string;
  hint: string;
  staffAdded: boolean;
}

export interface DecideArrivalDialogProps {
  open: boolean;
  arrival: RequestArrival;
  /** Every line on the current version. Omit and "add a requirement" is hidden. */
  lines?: DecidableLine[];
  onClose: () => void;
  onSubmit: (body: DecideArrivalRequest) => Promise<void>;
  /** Go to the Review Queue item. */
  onOpenQueueItem?: (queueId: string) => void;
}

export function DecideArrivalDialog({
  open,
  arrival,
  lines,
  onClose,
  onSubmit,
  onOpenQueueItem,
}: DecideArrivalDialogProps) {
  const approved = arrival.pipeline_state === 'document_linked' && Boolean(arrival.document_id);

  const claimRows: Row[] = useMemo(
    () =>
      arrival.claims
        .filter((c) => c.line_id !== null)
        .map((c) => ({
          lineId: c.line_id!,
          name: c.line_name,
          hint: `${c.claimed_by === 'staff' ? 'Added by your team' : 'The supplier said this file covers it'} · ${claimChip(c).label}`,
          staffAdded: false,
        })),
    [arrival],
  );
  const initiallyTicked = useMemo(
    () =>
      new Set(
        arrival.claims
          .filter(
            (c) =>
              c.line_id !== null &&
              c.decision === null &&
              (c.line_status === 'received' || c.line_status === 'under_review'),
          )
          .map((c) => c.line_id!),
      ),
    [arrival],
  );

  const [ticked, setTicked] = useState<Set<string>>(initiallyTicked);
  const [added, setAdded] = useState<Row[]>([]);
  const [addPick, setAddPick] = useState('');
  const [decision, setDecision] = useState<RequestArrivalDecisionKind>(
    approved ? 'accepted' : 'needs_attention',
  );
  const [documentId, setDocumentId] = useState(arrival.document_id ?? '');
  const [statusNote, setStatusNote] = useState('');
  const [attentionReason, setAttentionReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTicked(new Set(initiallyTicked));
    setAdded([]);
    setAddPick('');
    setDecision(approved ? 'accepted' : 'needs_attention');
    setDocumentId(arrival.document_id ?? '');
    setStatusNote('');
    setAttentionReason('');
    setError('');
  }, [open, arrival, initiallyTicked, approved]);

  const rows = [...claimRows, ...added];
  const known = new Set(rows.map((r) => r.lineId));
  const addable = (lines ?? []).filter((l) => !known.has(l.id));

  const toggle = (lineId: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });

  const addLine = (lineId: string) => {
    const line = (lines ?? []).find((l) => l.id === lineId);
    if (!line) return;
    setAdded((prev) => [
      ...prev,
      { lineId: line.id, name: line.name, hint: 'You are adding this — the supplier did not tick it', staffAdded: true },
    ]);
    setTicked((prev) => new Set(prev).add(line.id));
    setAddPick('');
  };

  const count = rows.filter((r) => ticked.has(r.lineId)).length;
  const noun = count === 1 ? 'requirement' : 'requirements';

  const submit = async () => {
    if (count === 0) {
      setError('Tick at least one requirement.');
      return;
    }
    if (decision === 'accepted' && !approved) {
      setError('Approve this file in the Review Queue first.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSubmit({
        decisions: rows
          .filter((r) => ticked.has(r.lineId))
          .map((r) => ({
            line_id: r.lineId,
            decision,
            ...(decision === 'accepted' && documentId && documentId !== arrival.document_id
              ? { document_id: documentId }
              : {}),
            ...(statusNote.trim() ? { status_note: statusNote.trim() } : {}),
            ...(decision === 'needs_attention'
              ? { attention_reason: attentionReason.trim() || null }
              : {}),
          })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That decision did not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>What does this file satisfy?</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <strong>{arrival.file_name}</strong> from {arrival.supplier_name ?? 'the supplier'}, for{' '}
          {arrival.request_title}.
        </Typography>

        {!approved && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Accepting needs an approved document</AlertTitle>
            Nobody has approved what was read from this file yet, so a requirement cannot be
            accepted from it.{' '}
            {arrival.queue_id && onOpenQueueItem ? (
              <Link component="button" onClick={() => onOpenQueueItem(arrival.queue_id!)}>
                Approve it in the Review Queue
              </Link>
            ) : (
              'Approve it in the Review Queue'
            )}
            , then come back. You can send requirements back to the supplier now.
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        <FormLabel component="legend" sx={{ mb: 0.5 }}>
          Requirements
        </FormLabel>
        {rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            The supplier did not name a requirement for this file. Add the one it covers below.
          </Typography>
        )}
        <Stack spacing={0.5} sx={{ mb: 1 }}>
          {rows.map((r) => (
            <Box key={r.lineId}>
              <FormControlLabel
                control={<Checkbox checked={ticked.has(r.lineId)} onChange={() => toggle(r.lineId)} />}
                label={r.name}
              />
              <Typography variant="caption" color="text.secondary" display="block" sx={{ ml: 4, mt: -1 }}>
                {r.hint}
              </Typography>
            </Box>
          ))}
        </Stack>
        {addable.length > 0 && (
          <TextField
            select
            size="small"
            fullWidth
            label="Add a requirement this file also covers"
            value={addPick}
            onChange={(e) => addLine(e.target.value)}
            sx={{ mb: 2 }}
          >
            {addable.map((l) => (
              <MenuItem key={l.id} value={l.id}>
                {l.name}
              </MenuItem>
            ))}
          </TextField>
        )}

        <FormControl sx={{ mt: 1, mb: 2 }}>
          <FormLabel id="decide-arrival-decision">Decision</FormLabel>
          <RadioGroup
            aria-labelledby="decide-arrival-decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value as RequestArrivalDecisionKind)}
          >
            <FormControlLabel
              value="accepted"
              control={<Radio />}
              label="Accept — this document satisfies them"
              disabled={!approved}
            />
            {!approved && (
              <FormHelperText sx={{ mt: -1, ml: 4 }}>
                Available once the file is approved in the Review Queue.
              </FormHelperText>
            )}
            <FormControlLabel
              value="needs_attention"
              control={<Radio />}
              label="Send back — the supplier needs to send something else"
            />
          </RadioGroup>
        </FormControl>

        <Stack spacing={2}>
          {decision === 'accepted' && arrival.documents.length > 1 && (
            <TextField
              select
              label="Accepted from which document"
              fullWidth
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              helperText="This file was filed as more than one document."
            >
              {arrival.documents.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.title}
                </MenuItem>
              ))}
            </TextField>
          )}

          {decision === 'needs_attention' && (
            <TextField
              label="What the supplier needs to fix"
              fullWidth
              multiline
              minRows={2}
              value={attentionReason}
              onChange={(e) => setAttentionReason(e.target.value)}
              placeholder="e.g. This is the 2023 statement; we need one signed this year."
              helperText="The supplier reads this on their link. Leave it blank and they see a sentence built from the requirement's own criteria."
            />
          )}

          <TextField
            label="Internal note"
            fullWidth
            value={statusNote}
            onChange={(e) => setStatusNote(e.target.value)}
            helperText="Only your team sees this. It is never shown to the supplier."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          color={decision === 'accepted' ? 'primary' : 'error'}
          onClick={submit}
          disabled={saving || count === 0 || (decision === 'accepted' && !approved)}
        >
          {saving
            ? 'Saving…'
            : decision === 'accepted'
              ? `Accept ${count} ${noun}`
              : `Send ${count} ${noun} back`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
