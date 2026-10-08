import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  DeleteOutline as DeleteIcon,
  Description as DocIcon,
  InfoOutlined as AdvisoryIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { humanDay } from '../../../shared/orderSend';
import { SHARING_RULE_LABELS, type SharingRule } from '../../../shared/sharingRule';
import { RELEASE_STATUS_LABELS } from '../../../shared/orderDocuments';
import { RELEASE_MAX_DOCUMENTS, announceQaWaitingChanged } from '../../lib/qaWaiting';
import { ReleaseDocumentsDialog, candidateFromOrderLine } from './ReleaseDocumentsDialog';
import type { ApiOrderDocument, OrderDocumentDisposition, OrderDocumentReleaseTarget } from '../../../shared/types';

/**
 * The document lines of an order (migration 0138): for each item and
 * supplier, the document the portal resolved, the rule it leaves under, and
 * what a send would do with it.
 *
 * EVERYTHING HERE IS THE SERVER'S ANSWER, judged against the document's rule
 * as it stands now for the person looking. The chip that says "Goes now" is
 * the same decision the send will make, not a guess in the browser.
 *
 * A line holds the document that was current when it was added. When a newer
 * one arrives the line says so and offers Refresh; nothing swaps the document
 * behind the person's back.
 */
export interface OrderDocumentLinesProps {
  orderId: string;
  documents: ApiOrderDocument[];
  /** Adding, removing and refreshing: any login, on an order that is not staged. */
  canBuild: boolean;
  /**
   * A read-only account: it may not remove or refresh a line that is waiting
   * for QA, being released or released (the server refuses), so it is not
   * offered those buttons on such a line.
   */
  readOnly?: boolean;
  /** The caller may release or refuse a document waiting for QA. */
  canRelease: boolean;
  onChanged: () => void;
  onOpenDocument: (documentId: string) => void;
}

export function sharingRuleColor(rule: SharingRule): 'success' | 'warning' | 'error' {
  return rule === 'free' ? 'success' : rule === 'qa' ? 'warning' : 'error';
}

const DISPOSITION_LABEL: Record<OrderDocumentDisposition, string> = {
  goes_now: 'Goes now',
  waits_for_qa: 'Waits for QA',
  will_not_go: 'Will not go',
};
const DISPOSITION_COLOR: Record<OrderDocumentDisposition, 'success' | 'warning' | 'default'> = {
  goes_now: 'success',
  waits_for_qa: 'warning',
  will_not_go: 'default',
};

/** The status chip: what QA decided when there is a decision, else what a send would do. */
export function documentLineStatus(line: ApiOrderDocument): { label: string; color: 'success' | 'warning' | 'error' | 'default' } {
  if (line.release_status === 'pending_qa') return { label: RELEASE_STATUS_LABELS.pending_qa, color: 'warning' };
  // Claimed and not recorded as sent: never worded as sent.
  if (line.release_status === 'releasing') {
    return line.release_stuck
      ? { label: 'Release did not finish', color: 'error' }
      : { label: RELEASE_STATUS_LABELS.releasing, color: 'warning' };
  }
  if (line.release_status === 'refused') return { label: RELEASE_STATUS_LABELS.refused, color: 'error' };
  if (line.release_status === 'released') return { label: RELEASE_STATUS_LABELS.released, color: 'success' };
  if (line.disposition === 'will_not_go') {
    if (line.disposition_reason === 'missing') return { label: 'Missing', color: 'error' };
    if (line.disposition_reason === 'expired') return { label: 'Expired', color: 'error' };
    if (line.disposition_reason === 'locked') return { label: 'Locked', color: 'error' };
    if (line.disposition_reason === 'stale') return { label: 'Refresh needed', color: 'warning' };
  }
  if (line.last_sent_at && line.disposition === 'goes_now') return { label: 'Sent', color: 'success' };
  return { label: DISPOSITION_LABEL[line.disposition], color: DISPOSITION_COLOR[line.disposition] };
}

export function OrderDocumentLines({ orderId, documents, canBuild, readOnly = false, canRelease, onChanged, onOpenDocument }: OrderDocumentLinesProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refusing, setRefusing] = useState<ApiOrderDocument | null>(null);
  const [note, setNote] = useState('');
  // Release goes through a last look at exactly what is being approved.
  const [releasing, setReleasing] = useState<ApiOrderDocument[]>([]);

  const confirmRelease = async (targets: OrderDocumentReleaseTarget[]) => {
    setBusy('release');
    setError('');
    setNotice('');
    try {
      const res = await api.orders.releaseDocuments(orderId, targets);
      setNotice(
        `Released ${res.released.length} document${res.released.length === 1 ? '' : 's'} in one email.` +
          (res.refused.length > 0 ? ` ${res.refused.length} not released: ${res.refused[0].reason}` : ''),
      );
    } catch (e) {
      // Includes "changed since you opened it": the reload below shows what is there now.
      setError(e instanceof Error ? e.message : 'The release did not go through');
    } finally {
      setBusy(null);
      setReleasing([]);
      announceQaWaitingChanged();
      onChanged();
    }
  };

  const act = async (lineId: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(lineId);
    setError('');
    setNotice('');
    try {
      await run();
      if (done) setNotice(done);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const waiting = documents.filter((d) => d.release_status === 'pending_qa');
  const canBeReleased = (d: ApiOrderDocument) =>
    d.release_status === 'pending_qa' || (d.release_status === 'releasing' && d.release_stuck);

  return (
    <Box sx={{ mb: 3 }} data-testid="order-document-lines">
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 1 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {canRelease && waiting.length > 1 && (
        <Alert
          severity="warning"
          sx={{ mb: 1 }}
          action={
            <Button
              color="inherit"
              size="small"
              sx={{ textTransform: 'none' }}
              disabled={busy !== null}
              onClick={() => setReleasing(waiting)}
              data-testid="order-documents-release-all"
            >
              Review and release all {waiting.length}
            </Button>
          }
        >
          {waiting.length} documents on this order are waiting for QA. Released together, they go in one email.
        </Alert>
      )}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Item</TableCell>
              <TableCell>Supplier</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Document</TableCell>
              <TableCell>Sharing</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {documents.map((line) => {
              const status = documentLineStatus(line);
              const ruleMoved = line.sharing_rule && line.rule_at_resolve && line.sharing_rule !== line.rule_at_resolve;
              return (
                <TableRow key={line.id} data-testid="order-document-line" data-disposition={line.disposition}>
                  <TableCell>
                    <Typography variant="body2">{line.product_name ?? 'Item no longer on file'}</Typography>
                    {line.advisory && (
                      <Stack direction="row" spacing={0.5} alignItems="flex-start" sx={{ color: 'info.dark', mt: 0.25 }} data-testid="order-document-advisory">
                        <AdvisoryIcon sx={{ fontSize: 16, mt: '2px' }} />
                        <Typography variant="caption">{line.advisory}</Typography>
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{line.supplier_name ?? '-'}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {line.facility
                        ? `${line.facility.name}${line.facility.plant_code ? ` (${line.facility.plant_code})` : ''}`
                        : 'No plant recorded'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{line.document_type_name ?? '-'}</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 280 }}>
                    {line.document_id ? (
                      <Button
                        size="small"
                        startIcon={<DocIcon fontSize="small" />}
                        onClick={() => onOpenDocument(line.document_id as string)}
                        sx={{ textTransform: 'none', textAlign: 'left', px: 0.5 }}
                      >
                        {line.document_title ?? 'Document'}
                      </Button>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Nothing on file
                      </Typography>
                    )}
                    {line.document_due_date && (
                      <Typography variant="caption" color={line.resolution === 'expired' ? 'error.main' : 'text.secondary'} sx={{ display: 'block' }}>
                        {line.resolution === 'expired' ? 'Expired' : 'Due'} {humanDay(line.document_due_date)}
                      </Typography>
                    )}
                    {line.resolution_note && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }}>
                        {line.resolution_note}
                      </Typography>
                    )}
                    {line.stale_note && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }} data-testid="order-document-stale">
                        {line.stale_note}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {line.sharing_rule ? (
                      <Tooltip
                        title={
                          ruleMoved
                            ? `This was "${SHARING_RULE_LABELS[line.rule_at_resolve as SharingRule]}" when the line was added. The rule as it stands now is the one that decides.`
                            : ''
                        }
                      >
                        <Chip
                          size="small"
                          color={sharingRuleColor(line.sharing_rule)}
                          variant="outlined"
                          label={SHARING_RULE_LABELS[line.sharing_rule]}
                          data-testid="order-document-rule"
                        />
                      </Tooltip>
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        -
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 300 }}>
                    <Chip size="small" color={status.color} label={status.label} data-testid="order-document-status" />
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                      {line.disposition_text}
                    </Typography>
                    {line.release_status === 'released' && line.decided_by_name && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Released by {line.decided_by_name}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {canRelease && line.release_status === 'releasing' && line.release_stuck && (
                      <Button
                        size="small"
                        sx={{ textTransform: 'none', mr: 0.5 }}
                        disabled={busy !== null}
                        onClick={() =>
                          act(line.id, async () => {
                            await api.orders.giveBackDocument(orderId, line.id);
                            announceQaWaitingChanged();
                          }, 'Put back in the waiting list. The link from the unfinished release was withdrawn.')
                        }
                        data-testid="order-document-give-back"
                      >
                        Put back
                      </Button>
                    )}
                    {canRelease && canBeReleased(line) && (
                      <Button
                        size="small"
                        variant="contained"
                        sx={{ textTransform: 'none', mr: 0.5 }}
                        disabled={busy !== null}
                        onClick={() => setReleasing([line])}
                        data-testid="order-document-release"
                      >
                        {line.release_status === 'releasing' ? 'Release again' : 'Release'}
                      </Button>
                    )}
                    {canRelease && line.release_status === 'pending_qa' && (
                      <>
                        <Button
                          size="small"
                          color="error"
                          sx={{ textTransform: 'none', mr: 0.5 }}
                          disabled={busy !== null}
                          onClick={() => {
                            setNote('');
                            setRefusing(line);
                          }}
                          data-testid="order-document-refuse"
                        >
                          Refuse
                        </Button>
                      </>
                    )}
                    {canBuild &&
                      // Nobody takes a line out from under a release in progress, and a
                      // read-only account does not undo what QA is looking at or decided.
                      line.release_status !== 'releasing' &&
                      !(readOnly && ['pending_qa', 'released', 'refused'].includes(line.release_status)) && (
                      <>
                        <Tooltip title="Look again for the current document">
                          <span>
                            <IconButton
                              size="small"
                              disabled={busy !== null}
                              onClick={() => act(line.id, () => api.orders.refreshDocument(orderId, line.id))}
                              aria-label="Refresh this line"
                              data-testid="order-document-refresh"
                            >
                              <RefreshIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Take this document off the order">
                          <span>
                            <IconButton
                              size="small"
                              disabled={busy !== null}
                              onClick={() => act(line.id, () => api.orders.removeDocument(orderId, line.id))}
                              aria-label="Remove this line"
                              data-testid="order-document-remove"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <ReleaseDocumentsDialog
        open={releasing.length > 0}
        candidates={releasing.map(candidateFromOrderLine)}
        busy={busy === 'release'}
        max={RELEASE_MAX_DOCUMENTS}
        onClose={() => setReleasing([])}
        onConfirm={confirmRelease}
      />

      <Dialog open={!!refusing} onClose={() => setRefusing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Refuse this document</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {refusing?.document_title ?? 'This document'} will not be sent on this order. The person who ordered it
              reads your note, so say what they should do instead.
            </Typography>
            <TextField
              label="Why"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
              multiline
              minRows={3}
              autoFocus
              inputProps={{ 'data-testid': 'order-document-refuse-note' }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRefusing(null)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={note.trim() === '' || busy !== null}
            sx={{ textTransform: 'none' }}
            onClick={() => {
              const line = refusing;
              if (!line) return;
              setRefusing(null);
              void act(line.id, async () => {
                // What QA saw goes with the refusal, as it does with a release.
                await api.orders.refuseDocument(orderId, line.id, note.trim(), {
                  document_id: line.document_id ?? '',
                  pending_send_id: line.pending_send_id ?? '',
                });
                announceQaWaitingChanged();
              });
            }}
            data-testid="order-document-refuse-confirm"
          >
            Refuse
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
