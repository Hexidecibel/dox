/**
 * ArrivalCard — one file a supplier sent through their request link.
 *
 * The card answers the reviewer's questions in the order they ask them: what
 * is it, who sent it for which request, can I read it, has anyone approved it,
 * and what did the supplier say it covers. The per-requirement chips are the
 * decision state, not the line status: "waiting on you" means this file's
 * claim is undecided while the requirement is still open.
 *
 * ACCEPTING NEEDS AN APPROVED DOCUMENT. When the file is not approved yet the
 * card sends the reviewer to the Review Queue item rather than hiding the
 * Decide button — sending an item back is allowed at any stage, so the button
 * stays, and the dialog explains why Accept is unavailable.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  Link,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AttachFile as FileIcon,
  RateReview as ReviewIcon,
  PlaylistAddCheck as DecideIcon,
  Replay as EnqueueIcon,
} from '@mui/icons-material';
import type {
  RequestArrival,
  RequestArrivalClaim,
  RequestArrivalPipelineState,
} from '../lib/types';
import { REJECTION_REASON_LABELS } from '../lib/types';

const STATE_LABEL: Record<RequestArrivalPipelineState, string> = {
  not_read: 'Not read yet',
  extracting: 'Being read',
  extraction_error: 'Could not be read',
  awaiting_approval: 'Waiting for approval',
  rejected_in_queue: 'Rejected in the Review Queue',
  document_linked: 'Approved',
};

const STATE_COLOR: Record<
  RequestArrivalPipelineState,
  'default' | 'info' | 'warning' | 'error' | 'success'
> = {
  not_read: 'warning',
  extracting: 'info',
  extraction_error: 'error',
  awaiting_approval: 'warning',
  rejected_in_queue: 'error',
  document_linked: 'success',
};

/** What this state means for the person looking at it. One sentence. */
export function arrivalStateSentence(a: RequestArrival): string {
  switch (a.pipeline_state) {
    case 'not_read':
      return 'This file never reached the Review Queue, so nobody has read it.';
    case 'extracting':
      return 'The file is being read. It will show up in the Review Queue shortly.';
    case 'extraction_error':
      return 'Reading this file failed. Reprocess it from the Review Queue.';
    case 'awaiting_approval':
      return 'Approve it in the Review Queue before any requirement can be accepted from it.';
    case 'rejected_in_queue':
      return 'A reviewer rejected what was read from this file. You can still send the requirements back to the supplier.';
    case 'document_linked': {
      const filed = a.document_title ? `Filed as “${a.document_title}”.` : 'Filed as a document.';
      return a.pending_count > 0 ? `${filed} Ready for you to decide.` : filed;
    }
  }
}

export function claimChip(c: RequestArrivalClaim): {
  label: string;
  color: 'default' | 'primary' | 'success' | 'error' | 'warning';
} {
  if (c.line_id === null) return { label: 'No longer on the request', color: 'default' };
  if (c.decision === 'accepted') return { label: 'Accepted', color: 'success' };
  if (c.decision === 'needs_attention') return { label: 'Sent back', color: 'error' };
  if (c.decided_elsewhere) return { label: 'Settled from another file', color: 'default' };
  if (c.line_status === 'received' || c.line_status === 'under_review') {
    return { label: 'Waiting on you', color: 'warning' };
  }
  return { label: 'Not open', color: 'default' };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ArrivalCardProps {
  arrival: RequestArrival;
  /** Show which request this came in on (the inbox does; the request page does not). */
  showRequest?: boolean;
  /** super_admin, org_admin, user. */
  canDecide: boolean;
  /** super_admin, org_admin. */
  canEnqueue: boolean;
  busy?: boolean;
  onOpenFile: (arrival: RequestArrival) => void;
  onDecide: (arrival: RequestArrival) => void;
  onEnqueue: (arrival: RequestArrival) => void;
  /** Navigate to /review?item=<queue_id>. */
  onOpenQueueItem: (queueId: string) => void;
  onOpenRequest?: (arrival: RequestArrival) => void;
  onOpenDocument?: (documentId: string) => void;
}

export function ArrivalCard({
  arrival: a,
  showRequest = false,
  canDecide,
  canEnqueue,
  busy = false,
  onOpenFile,
  onDecide,
  onEnqueue,
  onOpenQueueItem,
  onOpenRequest,
  onOpenDocument,
}: ArrivalCardProps) {
  const live = a.current_request_status === 'issued';
  const reasonLabel = a.rejection_reason
    ? (REJECTION_REASON_LABELS as Record<string, { label: string }>)[a.rejection_reason]?.label ??
      a.rejection_reason
    : null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid={`arrival-${a.id}`}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Box sx={{ flexGrow: 1, minWidth: 260 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Link
              component="button"
              variant="body1"
              fontWeight={700}
              onClick={() => onOpenFile(a)}
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, textAlign: 'left' }}
            >
              <FileIcon fontSize="small" />
              {a.file_name}
            </Link>
            <Chip size="small" color={STATE_COLOR[a.pipeline_state]} label={STATE_LABEL[a.pipeline_state]} />
            {a.spec && a.spec.out_of_spec > 0 && (
              <Tooltip
                title={
                  a.spec.source === 'register'
                    ? 'From the out-of-spec register, frozen at approval.'
                    : 'Computed from what was read, the same way the Review Queue shows it.'
                }
              >
                <Chip size="small" color="error" variant="outlined" label={`${a.spec.out_of_spec} out of spec`} />
              </Tooltip>
            )}
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {a.supplier_name ?? 'Supplier'} sent this {a.uploaded_at}
            {a.uploader_label ? ` · signed “${a.uploader_label}”` : ''} · {formatBytes(a.file_size)}
          </Typography>
          {showRequest && (
            <Typography variant="body2" color="text.secondary">
              For{' '}
              {onOpenRequest ? (
                <Link component="button" variant="body2" onClick={() => onOpenRequest(a)}>
                  {a.request_title}
                </Link>
              ) : (
                a.request_title
              )}
            </Typography>
          )}

          <Typography variant="body2" sx={{ mt: 1 }}>
            {arrivalStateSentence(a)}
          </Typography>
          {a.pipeline_state === 'rejected_in_queue' && (reasonLabel || a.rejection_note) && (
            <Typography variant="caption" color="text.secondary" display="block">
              {reasonLabel}
              {reasonLabel && a.rejection_note ? ': ' : ''}
              {a.rejection_note}
            </Typography>
          )}
          {a.pipeline_state === 'extraction_error' && a.processing_error && (
            <Typography variant="caption" color="text.secondary" display="block">
              {a.processing_error}
            </Typography>
          )}
          {a.pipeline_state === 'document_linked' && a.document_id && onOpenDocument && (
            <Link
              component="button"
              variant="caption"
              onClick={() => onOpenDocument(a.document_id!)}
              sx={{ display: 'block' }}
            >
              Open the document
            </Link>
          )}

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5, mb: 0.5 }}>
            What this file covers
          </Typography>
          {a.claims.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              The supplier did not name a requirement.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {a.claims.map((c) => {
                const chip = claimChip(c);
                return (
                  <Box key={c.claim_id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ minWidth: 180 }}>
                      {c.line_name}
                    </Typography>
                    <Chip size="small" color={chip.color} label={chip.label} variant={chip.color === 'default' ? 'outlined' : 'filled'} />
                    <Typography variant="caption" color="text.secondary">
                      {c.claimed_by === 'staff'
                        ? `Added by ${c.added_by_name ?? 'your team'}`
                        : 'The supplier said this file covers it'}
                      {c.decided_by_name && c.decision ? ` · decided by ${c.decided_by_name}` : ''}
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          )}
          {!live && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              This request is {a.current_request_status}, so nothing on it can be decided.
            </Typography>
          )}
        </Box>

        <Stack spacing={1} sx={{ minWidth: 200 }}>
          {canDecide && live && (
            <Button
              variant={a.pending_count > 0 ? 'contained' : 'outlined'}
              startIcon={<DecideIcon />}
              onClick={() => onDecide(a)}
              disabled={busy}
            >
              {a.pending_count > 0 ? 'Decide' : 'Change a decision'}
            </Button>
          )}
          {a.queue_id && a.pipeline_state !== 'document_linked' && (
            <Button
              variant="outlined"
              startIcon={<ReviewIcon />}
              onClick={() => onOpenQueueItem(a.queue_id!)}
            >
              Open in Review Queue
            </Button>
          )}
          {a.pipeline_state === 'not_read' && canEnqueue && (
            <Button variant="outlined" startIcon={<EnqueueIcon />} onClick={() => onEnqueue(a)} disabled={busy}>
              Read it now
            </Button>
          )}
          {a.pipeline_state === 'not_read' && !canEnqueue && (
            <Alert severity="warning" sx={{ py: 0 }}>
              Ask an admin to put this file in the Review Queue.
            </Alert>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}
