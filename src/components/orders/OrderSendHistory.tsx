import { useState } from 'react';
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatDateTime } from '../../utils/format';
import { humanBytes } from '../../../shared/orderSend';
import type { OrderSendStatus, OrderSendSummary } from '../../../shared/types';

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
        const failedParts = s.parts.filter((p) => !p.ok);
        return (
          <Paper key={s.id} variant="outlined" sx={{ p: 2 }} data-testid="order-send-card">
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', mb: 0.5 }}>
              <Chip size="small" color={STATUS_COLOR[s.status]} label={STATUS_LABEL[s.status]} />
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
                {formatDateTime(s.created_at)} · by {s.sent_by_name ?? s.sent_by_email ?? 'a former user'}
              </Typography>
            </Stack>
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
                {f.sent_ok ? '✓' : '✗'} {f.file_name} · {humanBytes(f.bytes)} ·{' '}
                {f.delivery === 'link' ? 'sent as a link that does not expire' : 'attached'} ·{' '}
                {f.source === 'original' ? 'the whole certificate' : 'the document on file'}
                {f.lot_label ? ` · Lot ${f.lot_label}` : ''}
                {s.part_count > 1 ? ` · email ${f.part_number} of ${s.part_count}` : ''}
              </Typography>
            ))}

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
                {failedParts.length === s.part_count
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
