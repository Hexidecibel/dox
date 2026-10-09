import { useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatDateTime } from '../../utils/format';
import { humanBytes } from '../../../shared/orderSend';
import type { OrderSendFileRecord, OrderSendStatus, OrderSendSummary } from '../../../shared/types';

/**
 * What left on an order, to whom, and how (migration 0134).
 *
 * One card per send: who pressed send and when, the addresses, and every file
 * under the name it travelled under -- attached or linked, the whole
 * certificate or one lot's page, and whether its email was accepted. A send
 * that was split and did not all go says which emails failed and offers to
 * send exactly those again.
 *
 * THERE IS NO REVOKE AND NO OPEN COUNT, and the card says so. An attachment
 * is in the recipient's inbox: it cannot be withdrawn and nothing reports
 * whether it was read. (A file too large to attach went as a link, and that
 * link is listed with the other links on "Sent documents", where it can be
 * revoked.)
 */
const STATUS_LABEL: Record<OrderSendStatus, string> = {
  sent: 'Sent',
  partial: 'Partly sent',
  failed: 'Not sent',
};
const STATUS_COLOR: Record<OrderSendStatus, 'success' | 'warning' | 'error'> = {
  sent: 'success',
  partial: 'warning',
  failed: 'error',
};

/**
 * The chip a send leads with. Read from `outcome`, which the server derives
 * from the per-email record: a send in which nothing left because everything
 * was withdrawn is NOT "Not sent" waiting for a retry and is never "Sent".
 */
export function sendChip(s: OrderSendSummary): { label: string; color: 'success' | 'warning' | 'error' | 'default' } {
  const kind = s.kind ?? 'send';
  if (kind === 'qa_request') return { label: 'Asked QA', color: 'warning' };
  if (kind === 'qa_release') {
    if (s.status === 'sent') return { label: 'Released by QA', color: 'success' };
    if (s.parts[0]?.code === 'undone') return { label: 'Release undone', color: 'error' };
    if (s.status === 'partial') return { label: 'Release did not finish', color: 'error' };
    return { label: 'Release not sent', color: 'error' };
  }
  const outcome = s.outcome ?? s.status;
  if (outcome === 'withdrawn') return { label: 'Withdrawn, nothing sent', color: 'default' };
  if (outcome === 'sent_rest_withdrawn') return { label: 'Partly sent, the rest withdrawn', color: 'warning' };
  return { label: STATUS_LABEL[s.status], color: STATUS_COLOR[s.status] };
}

/** How a file left, in words. A link is one of two kinds and they are never confused. */
export function describeDelivery(f: Pick<OrderSendFileRecord, 'delivery' | 'link_days'>): string {
  if (f.delivery !== 'link') return 'attached';
  return f.link_days ? `sent on a link that works for ${f.link_days} days` : 'sent as a link that does not expire';
}

export interface OrderSendHistoryProps {
  sends: OrderSendSummary[];
  /** Show which order each send belongs to (the "Sent documents" page). */
  showOrder?: boolean;
  /** Called after a resend, so the caller reloads. */
  onChanged?: () => void;
}

export function OrderSendHistory({ sends, showOrder = false, onChanged }: OrderSendHistoryProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (sends.length === 0) return null;

  const resend = async (send: OrderSendSummary) => {
    setBusy(send.id);
    setError('');
    try {
      await api.orders.resendFailed(send.order_id, send.id);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The resend failed');
      onChanged?.();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack spacing={1.5} data-testid="order-send-history">
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {sends.map((s) => {
        // An email that was withdrawn did not fail: nothing was left to put in it.
        const failedParts = s.parts.filter((p) => !p.ok && !p.withdrawn);
        const chip = sendChip(s);
        const outcome = s.outcome ?? s.status;
        // Document orders (0138): a send that only asked QA, and the mail a QA
        // release produced, are their own kinds and are worded as what they are.
        const kind = s.kind ?? 'send';
        const who = s.sent_by_name ?? s.sent_by_email ?? 'a former user';
        return (
          <Paper key={s.id} variant="outlined" sx={{ p: 2 }} data-testid="order-send-card" data-kind={kind}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', mb: 0.5 }}>
              <Chip size="small" color={chip.color} label={chip.label} data-testid="order-send-chip" />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {showOrder ? (
                  <>
                    Order{' '}
                    <Box component={RouterLink} to={`/orders/${s.order_id}`} sx={{ color: 'primary.main' }}>
                      {s.order_number}
                    </Box>
                    {s.customer_name ? ` · ${s.customer_name}` : ''}
                  </>
                ) : (
                  `To ${s.recipients.join(', ')}`
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(s.created_at)} · {kind === 'qa_release' ? 'released by' : 'by'} {who}
              </Typography>
            </Stack>
            {kind === 'qa_request' && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} data-testid="order-send-qa-request">
                Nothing was sent to the customer. QA was told what is waiting, missing or expired. Documents QA releases
                are mailed to these addresses.
              </Typography>
            )}
            {showOrder && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                To {s.recipients.join(', ')}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              “{s.subject}”{s.part_count > 1 ? ` · ${s.part_count} emails` : ''}
            </Typography>

            {s.files.map((f) => (
              <Typography key={f.position} variant="caption" sx={{ display: 'block', color: f.sent_ok ? 'text.primary' : 'error.main' }}>
                {f.not_sent_reason && (
                  <Box component="span" sx={{ display: 'block' }} data-testid="order-send-file-withdrawn">
                    {f.not_sent_reason}
                  </Box>
                )}
                {f.sent_ok ? '✓' : '✗'} {f.file_name} · {humanBytes(f.bytes)} ·{' '}
                {describeDelivery(f)} ·{' '}
                {f.source === 'original' ? 'the whole certificate' : 'the document on file'}
                {f.lot_label ? ` · Lot ${f.lot_label}` : ''}
                {s.part_count > 1 ? ` · email ${f.part_number} of ${s.part_count}` : ''}
              </Typography>
            ))}

            {(outcome === 'withdrawn' || outcome === 'sent_rest_withdrawn') && (
              <Alert severity="info" sx={{ mt: 1 }} data-testid="order-send-withdrawn">
                {outcome === 'withdrawn'
                  ? 'No email left on this send, and none will: every document in it was refused, removed or changed after it was reviewed. Send the order again to send what is on it now.'
                  : 'Part of this send reached the customer. The rest was withdrawn: those documents were refused, removed or changed after it was reviewed. There is nothing left to resend.'}
              </Alert>
            )}
            {failedParts.length > 0 && (
              <Alert
                severity={s.status === 'failed' ? 'error' : 'warning'}
                sx={{ mt: 1 }}
                action={
                  s.can_resend ? (
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => resend(s)}
                      disabled={busy === s.id}
                      sx={{ textTransform: 'none' }}
                      data-testid="order-send-resend"
                    >
                      {busy === s.id ? 'Sending…' : failedParts.length === s.part_count ? 'Try again' : 'Resend failed parts'}
                    </Button>
                  ) : undefined
                }
              >
                {kind === 'qa_release' && s.parts[0]?.code === 'undone'
                  ? ''
                  : kind === 'qa_release' && s.status === 'partial'
                  ? 'This release did not finish, and it is not known whether the email reached the customer. The documents show as "release did not finish" until QA releases them again or puts them back.'
                  : kind === 'qa_release'
                  ? 'The release email did not go, so nothing reached the customer. The documents are waiting for QA again.'
                  : failedParts.length === s.part_count
                  ? 'Nothing reached the customer.'
                  : `${failedParts.length} of ${s.part_count} emails did not go. The others reached the customer and will not be sent again.`}
                {failedParts.map((p) => (
                  <Box key={p.part_number} component="span" sx={{ display: 'block', fontSize: '0.75rem' }}>
                    {s.part_count > 1 ? `Email ${p.part_number}: ` : ''}
                    {p.error ?? 'not attempted'}
                  </Box>
                ))}
              </Alert>
            )}
          </Paper>
        );
      })}
      <Typography variant="caption" color="text.secondary">
        Attachments cannot be recalled, and nothing reports whether they were opened. A file that went as a link is
        listed with the other links on Sent documents, where it can be revoked.
      </Typography>
    </Stack>
  );
}
