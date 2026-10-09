import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';
import { EmptyState } from '../components/EmptyState';
import { formatDateTime } from '../utils/format';
import { SHARING_RULE_LABELS } from '../../shared/sharingRule';
import { sharingRuleColor } from '../components/orders/OrderDocumentLines';
import { ReleaseDocumentsDialog, candidateFromPending } from '../components/orders/ReleaseDocumentsDialog';
import { RELEASE_MAX_DOCUMENTS, announceQaWaitingChanged } from '../lib/qaWaiting';
import type { OrderDocumentReleaseTarget, PendingOrderDocument, PendingOrderDocumentsResponse } from '../../shared/types';

/**
 * Waiting for QA (migration 0138): every document held on an order because
 * the person who sent the order could not approve it.
 *
 * One card per order, because that is how a release works: the documents of
 * one order released together go to the customer in ONE email, on one link.
 * Each line says who asked, who the release will mail, and the document's
 * rule as it stands now. A document that can no longer be released (archived,
 * expired or locked since the order was sent) says why instead of offering a
 * button the server would refuse.
 *
 * Releasing mints the link in the releaser's own name. Refusing needs a note,
 * which the person who ordered the document reads on the order.
 */
export function OrdersWaitingForQa() {
  const { selectedTenantId } = useTenant();
  const [data, setData] = useState<PendingOrderDocumentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusing, setRefusing] = useState<PendingOrderDocument | null>(null);
  const [note, setNote] = useState('');
  // What QA is about to release: shown in full before anything is sent.
  const [releasing, setReleasing] = useState<PendingOrderDocument[]>([]);

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true);
      api.orderDocuments
        .pending({ tenant_id: selectedTenantId || undefined })
        .then(setData)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load what is waiting'))
        .finally(() => setLoading(false));
    },
    [selectedTenantId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // The targets are what was on the screen: document, version and asking send
  // for each line. The server releases a line only if they still hold; either
  // way the list is reloaded, so a line that changed is shown as it is now.
  const release = async (targets: OrderDocumentReleaseTarget[]) => {
    const orderId = releasing[0]?.order_id;
    if (!orderId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.orders.releaseDocuments(orderId, targets);
      const kept = res.refused.length;
      setNotice(
        `Released ${res.released.length} document${res.released.length === 1 ? '' : 's'} in one email.` +
          (kept > 0 ? ` ${kept} still waiting: ${res.refused[0].reason}` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The release did not go through');
    } finally {
      setBusy(false);
      setReleasing([]);
      announceQaWaitingChanged();
      load(true);
    }
  };

  const giveBack = async (line: PendingOrderDocument) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.orders.giveBackDocument(line.order_id, line.id);
      setNotice('Put back in the waiting list. The link from the unfinished release was withdrawn.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
      load(true);
    }
  };

  const refuse = async () => {
    if (!refusing) return;
    const line = refusing;
    setRefusing(null);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.orders.refuseDocument(line.order_id, line.id, note.trim(), {
        document_id: line.document_id ?? '',
        pending_send_id: line.pending_send_id ?? '',
      });
      setNotice('Refused. The note is on the order.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The refusal did not go through');
    } finally {
      setBusy(false);
      announceQaWaitingChanged();
      load(true);
    }
  };

  const byOrder = new Map<string, PendingOrderDocument[]>();
  for (const line of data?.lines ?? []) {
    const list = byOrder.get(line.order_id) ?? [];
    list.push(line);
    byOrder.set(line.order_id, list);
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" fontWeight={700}>
          Waiting for QA
        </Typography>
        {data && data.can_release && (
          <Typography variant="body2" color="text.secondary" data-testid="waiting-count">
            ({data.count})
          </Typography>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Documents ordered for a customer that need QA approval before they leave. Releasing sends the customer a link
        that works for 30 days. Nothing here goes to a supplier.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : data && !data.can_release ? (
        <Alert severity="info" data-testid="waiting-not-a-releaser">
          Releasing a document that needs QA approval is done by QA or an administrator. Documents you ordered that are
          waiting show on the order itself.
        </Alert>
      ) : byOrder.size === 0 ? (
        <EmptyState title="Nothing is waiting" description="When somebody orders a document that needs QA approval, it shows here." />
      ) : (
        <Stack spacing={2}>
          {[...byOrder.entries()].map(([orderId, lines]) => {
            const releasable = lines.filter((l) => l.releasable);
            return (
              <Paper key={orderId} variant="outlined" sx={{ p: 2 }} data-testid="waiting-order">
                <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', mb: 0.5 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                    Order{' '}
                    <Link component={RouterLink} to={`/orders/${orderId}`} underline="hover">
                      {lines[0].order_number}
                    </Link>
                  </Typography>
                  {lines[0].customer_name && (
                    <Typography variant="body2" color="text.secondary">
                      for {lines[0].customer_name}
                    </Typography>
                  )}
                  <Box sx={{ flex: 1 }} />
                  {releasable.length > 1 && (
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busy}
                      sx={{ textTransform: 'none' }}
                      onClick={() => setReleasing(releasable)}
                      data-testid="waiting-release-all"
                    >
                      Review and release all {releasable.length}
                    </Button>
                  )}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Asked by {lines[0].requested_by_name ?? 'a former user'}
                  {lines[0].requested_at ? ` on ${formatDateTime(lines[0].requested_at)}` : ''} · goes to{' '}
                  {lines[0].recipients.join(', ') || 'nobody on record'}
                </Typography>

                {lines.map((line) => (
                  <Box key={line.id} sx={{ py: 1, borderTop: 1, borderColor: 'divider' }} data-testid="waiting-line">
                    <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {line.document_type_name ?? 'Document'}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {[line.product_name, line.supplier_name, line.facility_name].filter(Boolean).join(' · ')}
                      </Typography>
                      {line.hold && <Chip size="small" color="error" label="On hold" data-testid="waiting-hold-chip" />}
                      {line.sharing_rule && (
                        <Chip size="small" variant="outlined" color={sharingRuleColor(line.sharing_rule)} label={SHARING_RULE_LABELS[line.sharing_rule]} />
                      )}
                      <Box sx={{ flex: 1 }} />
                      {line.stuck && (
                        <Button
                          size="small"
                          disabled={busy}
                          sx={{ textTransform: 'none' }}
                          onClick={() => giveBack(line)}
                          data-testid="waiting-give-back"
                        >
                          Put back
                        </Button>
                      )}
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy || !line.releasable}
                        sx={{ textTransform: 'none' }}
                        onClick={() => setReleasing([line])}
                        data-testid="waiting-release"
                      >
                        {line.release_status === 'releasing' ? 'Release again' : 'Release'}
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        disabled={busy || line.release_status !== 'pending_qa'}
                        sx={{ textTransform: 'none' }}
                        onClick={() => {
                          setNote('');
                          setRefusing(line);
                        }}
                        data-testid="waiting-refuse"
                      >
                        Refuse
                      </Button>
                    </Stack>
                    {line.document_id && (
                      <Link component={RouterLink} to={`/documents/${line.document_id}`} underline="hover" variant="caption">
                        {line.document_title ?? 'Open the document'}
                      </Link>
                    )}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} data-testid="waiting-document-facts">
                      {[
                        line.version_number != null ? `Version ${line.version_number}` : null,
                        line.document_approved_at ? `approved ${formatDateTime(line.document_approved_at)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                    {line.release_status === 'releasing' && (
                      <Typography variant="caption" sx={{ display: 'block', color: line.stuck ? 'error.main' : 'warning.dark' }} data-testid="waiting-releasing">
                        {line.stuck
                          ? 'A release of this document did not finish. It has not been recorded as sent. Release it again, or put it back.'
                          : 'This document is being released right now.'}
                      </Typography>
                    )}
                    {(line.earlier_refusals ?? []).map((r, i) => (
                      <Typography key={i} variant="caption" sx={{ display: 'block', color: 'error.main' }} data-testid="waiting-earlier-refusal">
                        Refused before on this order by {r.by_name ?? 'a former user'}
                        {r.at ? ` on ${formatDateTime(r.at)}` : ''}: {r.note}
                      </Typography>
                    ))}
                    {line.blocked_reason && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'error.main' }} data-testid="waiting-blocked">
                        {line.blocked_reason}
                      </Typography>
                    )}
                    {line.advisory && (
                      <Typography variant="caption" sx={{ display: 'block', color: 'info.dark' }}>
                        {line.advisory}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Paper>
            );
          })}
        </Stack>
      )}

      <ReleaseDocumentsDialog
        open={releasing.length > 0}
        orderNumber={releasing[0]?.order_number}
        candidates={releasing.map(candidateFromPending)}
        busy={busy}
        max={RELEASE_MAX_DOCUMENTS}
        onClose={() => setReleasing([])}
        onConfirm={release}
      />

      <Dialog open={!!refusing} onClose={() => setRefusing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Refuse this document</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {refusing?.document_title ?? 'This document'} will not be sent on order {refusing?.order_number}. The
              person who ordered it reads your note, so say what they should do instead.
            </Typography>
            <TextField
              label="Why"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
              multiline
              minRows={3}
              autoFocus
              inputProps={{ 'data-testid': 'waiting-refuse-note' }}
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
            disabled={note.trim() === ''}
            onClick={refuse}
            sx={{ textTransform: 'none' }}
            data-testid="waiting-refuse-confirm"
          >
            Refuse
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
