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
import type { PendingOrderDocument, PendingOrderDocumentsResponse } from '../../shared/types';

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

  const release = async (orderId: string, lineIds: string[]) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api.orders.releaseDocuments(orderId, lineIds);
      const kept = res.refused.length;
      setNotice(
        `Released ${res.released.length} document${res.released.length === 1 ? '' : 's'} in one email.` +
          (kept > 0 ? ` ${kept} still waiting: ${res.refused[0].reason}` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The release did not go through');
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
      await api.orders.refuseDocument(line.order_id, line.id, note.trim());
      setNotice('Refused. The note is on the order.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The refusal did not go through');
    } finally {
      setBusy(false);
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
                      onClick={() => release(orderId, releasable.map((l) => l.id))}
                      data-testid="waiting-release-all"
                    >
                      Release all {releasable.length} in one email
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
                      {line.sharing_rule && (
                        <Chip size="small" variant="outlined" color={sharingRuleColor(line.sharing_rule)} label={SHARING_RULE_LABELS[line.sharing_rule]} />
                      )}
                      <Box sx={{ flex: 1 }} />
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={busy || !line.releasable}
                        sx={{ textTransform: 'none' }}
                        onClick={() => release(orderId, [line.id])}
                        data-testid="waiting-release"
                      >
                        Release
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        disabled={busy}
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
