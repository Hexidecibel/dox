import { useEffect, useState } from 'react';
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
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import LinkIcon from '@mui/icons-material/Link';
import { api } from '../../lib/api';
import { humanBytes } from '../../../shared/orderSend';
import type { OrderSendPlanFile, OrderSendPreview, OrderSendResponse } from '../../../shared/types';

/**
 * "Review and send" -- the last look before an order's documents reach the
 * customer (migration 0134).
 *
 * EVERYTHING HERE IS WHAT WILL HAPPEN, read from the server's own plan
 * (GET /api/orders/:id/send-preview), not a guess made in the browser:
 *
 *   - each file under the GENERATED name it travels under, with the product,
 *     lot and production date of every line it stands for -- so a wrong pick
 *     is visible before it goes;
 *   - whether a certificate goes WHOLE or only as one lot's page, and why;
 *   - the split, when the files do not fit in one email ("Email 1 of 3");
 *   - anything that leaves as a link instead of an attachment;
 *   - the lines that will NOT be sent.
 *
 * Send hands the plan's fingerprint back, so if the order changed while this
 * was open nothing is sent and the person reviews again.
 */
export interface SendOrderDialogProps {
  open: boolean;
  orderId: string;
  onClose: () => void;
  /** Called with the outcome when at least one email went. */
  onSent: (result: OrderSendResponse) => void;
  /** Called when nothing went, so the page can reload and show the failed record. */
  onFailed: () => void;
}

function FileRow({ file }: { file: OrderSendPlanFile }) {
  return (
    <Box sx={{ py: 1 }} data-testid="send-file-row">
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
        {file.delivery === 'link' ? <LinkIcon fontSize="small" color="warning" /> : <AttachFileIcon fontSize="small" color="action" />}
        <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-all' }}>
          {file.file_name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {humanBytes(file.bytes)}
        </Typography>
        {file.delivery === 'link' && <Chip size="small" color="warning" variant="outlined" label="Sent as a link" />}
        {file.source === 'original' && <Chip size="small" variant="outlined" label="Whole certificate" />}
      </Stack>
      {file.lines.map((l) => (
        <Typography key={l.order_item_id} variant="caption" color="text.secondary" sx={{ display: 'block', pl: 3.5 }}>
          {[l.product_name ?? l.product_code ?? 'No product named', l.lot_label ? `Lot ${l.lot_label}` : 'No lot', l.production_date_label ? `Produced ${l.production_date_label}` : null]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      ))}
      {file.notes.map((n) => (
        <Typography key={n} variant="caption" sx={{ display: 'block', pl: 3.5, color: 'warning.dark' }}>
          {n}
        </Typography>
      ))}
    </Box>
  );
}

export function SendOrderDialog({ open, orderId, onClose, onSent, onFailed }: SendOrderDialogProps) {
  const [plan, setPlan] = useState<OrderSendPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // `keepError` re-reads the plan after a refused send WITHOUT wiping the
  // reason it was refused: the person needs both on screen at once.
  const load = (keepError = false) => {
    setLoading(true);
    if (!keepError) setError('');
    api.orders
      .sendPreview(orderId)
      .then((p) => {
        setPlan(p);
        setRecipients((r) => r || p.recipient || '');
        setSubject((s) => s || p.default_subject);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not prepare the send'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) {
      setPlan(null);
      setRecipients('');
      setSubject('');
      setMessage('');
      setError('');
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);

  const send = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.orders.send(orderId, {
        recipients: recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
        subject: subject.trim() || undefined,
        message: message.trim() || undefined,
        fingerprint: plan.fingerprint,
      });
      onSent(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The send failed');
      // The order may have changed, or a failed send was recorded: show the
      // plan as it stands now, and let the page pick up the record.
      load(true);
      onFailed();
    } finally {
      setBusy(false);
    }
  };

  const blocked = plan?.blocked ?? null;
  const canSend = !!plan && !blocked && plan.email_configured && recipients.trim() !== '' && !busy && !loading;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth data-testid="send-order-dialog">
      <DialogTitle>Review and send{plan ? ` · order ${plan.order.order_number}` : ''}</DialogTitle>
      <DialogContent dividers>
        {loading && !plan ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            {plan && !plan.email_configured && (
              <Alert severity="warning">Email is not configured for this portal, so nothing can be sent from here yet.</Alert>
            )}
            {blocked && <Alert severity="error" data-testid="send-blocked">{blocked.message}</Alert>}
            {plan?.warnings.map((w) => (
              <Alert key={w} severity="warning">
                {w}
              </Alert>
            ))}

            {plan && (
              <>
                <TextField
                  label="To"
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  fullWidth
                  size="small"
                  helperText={
                    plan.recipient
                      ? `The address on file for ${plan.order.customer_name ?? 'this customer'}. Change it here for this send only.`
                      : 'No address is on file for this customer. Enter the one to send to.'
                  }
                  inputProps={{ 'data-testid': 'send-order-recipients' }}
                />
                <TextField
                  label="Subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  fullWidth
                  size="small"
                  helperText={plan.part_count > 1 ? `Each email adds its number, e.g. "${subject || plan.default_subject} (1 of ${plan.part_count})".` : undefined}
                  inputProps={{ 'data-testid': 'send-order-subject' }}
                />
                <TextField
                  label="Message (optional)"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  fullWidth
                  size="small"
                  multiline
                  minRows={3}
                  inputProps={{ 'data-testid': 'send-order-message' }}
                />
                <Typography variant="caption" color="text.secondary">
                  Sent as “{plan.from_name}”. Replies go to {plan.reply_to}. The customer receives an exact copy of each file,
                  attached, under the name shown below. The name a file was uploaded under is never sent.
                </Typography>

                <Divider />

                {plan.parts.map((part) => {
                  const inPart = plan.files.filter((f) => f.part_number === part.part_number);
                  return (
                    <Box key={part.part_number} data-testid="send-part">
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                        {plan.part_count > 1 ? `Email ${part.part_number} of ${plan.part_count}` : 'One email'}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          {inPart.length} file{inPart.length === 1 ? '' : 's'} · {humanBytes(part.bytes)} attached
                        </Typography>
                      </Typography>
                      {inPart.map((f) => (
                        <FileRow key={f.key} file={f} />
                      ))}
                    </Box>
                  );
                })}

                {plan.lines_not_sent.length > 0 && (
                  <Box data-testid="send-lines-not-sent">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      Not sent ({plan.lines_not_sent.length})
                    </Typography>
                    {plan.lines_not_sent.map((l) => (
                      <Typography key={l.order_item_id} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {[l.product_name ?? 'No product named', l.lot_number ? `Lot ${l.lot_number}` : null].filter(Boolean).join(' · ')} — {l.reason}
                      </Typography>
                    ))}
                  </Box>
                )}
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button variant="contained" onClick={send} disabled={!canSend} sx={{ textTransform: 'none' }} data-testid="send-order-confirm">
          {busy
            ? 'Sending…'
            : plan && plan.part_count > 1
              ? `Send ${plan.part_count} emails`
              : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
