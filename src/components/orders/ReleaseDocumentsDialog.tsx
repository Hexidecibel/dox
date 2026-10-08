import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import { formatDateTime } from '../../utils/format';
import type { ApiOrderDocument, OrderDocumentReleaseTarget, PendingOrderDocument } from '../../../shared/types';

/**
 * The last look before QA releases documents on an order (migration 0138).
 *
 * A RELEASE IS OF WHAT IS ON THIS SCREEN. Each row names the document, its
 * version and when it was approved, the item and supplier it was ordered for,
 * who asked and when, and the exact addresses it will be mailed to. Confirming
 * sends the server those same facts back with each line (`targets`), and the
 * server releases a line only if they still hold. If the document, its
 * version or the addresses changed after this list was loaded, that line is
 * not released and the caller reloads.
 */
export interface ReleaseCandidate {
  id: string;
  document_id: string | null;
  document_title: string | null;
  document_type_name: string | null;
  version_number: number | null;
  document_approved_at: string | null;
  product_name: string | null;
  supplier_name: string | null;
  requested_by_name: string | null;
  requested_at: string | null;
  recipients: string[];
  pending_send_id: string | null;
  advisory: string | null;
  /** The release did not finish last time: releasing again withdraws that link first. */
  stuck: boolean;
  /** QA refused this same ask on this order before it was taken off and added again. */
  earlier_refusals: { by_name: string | null; at: string | null; note: string }[];
}

export function candidateFromPending(l: PendingOrderDocument): ReleaseCandidate {
  return {
    id: l.id,
    document_id: l.document_id,
    document_title: l.document_title,
    document_type_name: l.document_type_name,
    version_number: l.version_number,
    document_approved_at: l.document_approved_at,
    product_name: l.product_name,
    supplier_name: l.supplier_name,
    requested_by_name: l.requested_by_name,
    requested_at: l.requested_at,
    recipients: l.recipients,
    pending_send_id: l.pending_send_id,
    advisory: l.advisory,
    stuck: l.stuck,
    earlier_refusals: l.earlier_refusals ?? [],
  };
}

export function candidateFromOrderLine(l: ApiOrderDocument): ReleaseCandidate {
  return {
    id: l.id,
    document_id: l.document_id,
    document_title: l.document_title,
    document_type_name: l.document_type_name,
    version_number: l.version_number,
    document_approved_at: l.document_approved_at,
    product_name: l.product_name,
    supplier_name: l.supplier_name,
    requested_by_name: l.pending_requested_by_name,
    requested_at: l.pending_at,
    recipients: l.pending_recipients,
    pending_send_id: l.pending_send_id,
    advisory: l.advisory,
    stuck: l.release_stuck,
    // The order page does not carry the history; the waiting list does.
    earlier_refusals: [],
  };
}

/** What QA saw, as the release request carries it. Null when a candidate cannot be pinned. */
export function releaseTargets(candidates: ReleaseCandidate[]): OrderDocumentReleaseTarget[] | null {
  const out: OrderDocumentReleaseTarget[] = [];
  for (const c of candidates) {
    if (!c.document_id || !c.pending_send_id || c.version_number == null) return null;
    out.push({ id: c.id, document_id: c.document_id, version_number: c.version_number, pending_send_id: c.pending_send_id });
  }
  return out;
}

export interface ReleaseDocumentsDialogProps {
  open: boolean;
  orderNumber?: string | null;
  candidates: ReleaseCandidate[];
  busy: boolean;
  /** How many documents one release may carry. */
  max: number;
  onClose: () => void;
  onConfirm: (targets: OrderDocumentReleaseTarget[]) => void;
}

export function ReleaseDocumentsDialog({ open, orderNumber, candidates, busy, max, onClose, onConfirm }: ReleaseDocumentsDialogProps) {
  const targets = releaseTargets(candidates);
  const tooMany = candidates.length > max;
  const recipientSets = new Set(candidates.map((c) => [...c.recipients].sort().join(', ')));
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth data-testid="release-documents-dialog">
      <DialogTitle>
        Release {candidates.length === 1 ? 'this document' : `${candidates.length} documents`}
        {orderNumber ? ` · order ${orderNumber}` : ''}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">
            Releasing sends the customer a link that works for 30 days, in your name. You are approving exactly what is
            listed here. If any of it changed since you opened this, it is not released and you are asked to look again.
          </Typography>
          {tooMany && (
            <Alert severity="error" data-testid="release-too-many">
              One release covers at most {max} documents, because they leave on one link, and this is {candidates.length}.
              Release them a few at a time.
            </Alert>
          )}
          {recipientSets.size > 1 && (
            <Alert severity="info">
              These documents were asked for in sends to different addresses, so they go in {recipientSets.size} emails,
              one for each set of addresses.
            </Alert>
          )}
          {candidates.map((c) => (
            <Box key={c.id} sx={{ py: 1, borderTop: 1, borderColor: 'divider' }} data-testid="release-candidate">
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {c.document_title ?? 'Document'}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {[
                  c.document_type_name,
                  c.version_number != null ? `version ${c.version_number}` : null,
                  c.document_approved_at ? `approved ${formatDateTime(c.document_approved_at)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                For {[c.product_name, c.supplier_name].filter(Boolean).join(' · ') || 'an item no longer on file'}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Asked by {c.requested_by_name ?? 'a former user'}
                {c.requested_at ? ` on ${formatDateTime(c.requested_at)}` : ''}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }} data-testid="release-candidate-recipients">
                Goes to {c.recipients.join(', ') || 'nobody on record'}
              </Typography>
              {c.stuck && (
                <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }}>
                  An earlier release of this document did not finish. Its link is withdrawn first, then a new one is sent.
                </Typography>
              )}
              {c.earlier_refusals.map((r, i) => (
                <Typography key={i} variant="caption" sx={{ display: 'block', color: 'error.main' }} data-testid="release-earlier-refusal">
                  Refused before on this order by {r.by_name ?? 'a former user'}
                  {r.at ? ` on ${formatDateTime(r.at)}` : ''}: {r.note}
                </Typography>
              ))}
              {c.advisory && (
                <Typography variant="caption" sx={{ display: 'block', color: 'info.dark' }}>
                  {c.advisory}
                </Typography>
              )}
            </Box>
          ))}
          {!targets && (
            <Alert severity="warning">
              One of these documents cannot be released as it stands. Close this and reload the list.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !targets || tooMany || candidates.length === 0}
          onClick={() => targets && onConfirm(targets)}
          sx={{ textTransform: 'none' }}
          data-testid="release-confirm"
        >
          {busy ? 'Releasing…' : candidates.length === 1 ? 'Release and send' : `Release and send ${candidates.length}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
