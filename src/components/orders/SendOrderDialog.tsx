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
import { SHARING_RULE_LABELS } from '../../../shared/sharingRule';
import { sharingRuleColor } from './OrderDocumentLines';
import type {
  OrderSendDocumentLine,
  OrderSendPlanFile,
  OrderSendPreview,
  OrderSendResponse,
} from '../../../shared/types';

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
  // Two kinds of link: a certificate too large to attach (does not expire),
  // and a document order's documents (the link runs out).
  const expiring = file.delivery === 'link' && !!file.link_days;
  return (
    <Box sx={{ py: 1 }} data-testid="send-file-row">
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
        {file.delivery === 'link' ? <LinkIcon fontSize="small" color={expiring ? 'action' : 'warning'} /> : <AttachFileIcon fontSize="small" color="action" />}
        <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-all' }}>
          {file.file_name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {humanBytes(file.bytes)}
        </Typography>
        {file.delivery === 'link' && !expiring && <Chip size="small" color="warning" variant="outlined" label="Sent as a link" />}
        {expiring && <Chip size="small" variant="outlined" label={`On the ${file.link_days}-day link`} />}
        {file.source === 'original' && <Chip size="small" variant="outlined" label="Whole certificate" />}
      </Stack>
      {(file.document_lines ?? []).map((l) => (
        <Typography key={l.order_document_id} variant="caption" color="text.secondary" sx={{ display: 'block', pl: 3.5 }}>
          {[l.document_type_name, l.product_name, l.supplier_name].filter(Boolean).join(' · ')}
        </Typography>
      ))}
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

/**
 * One of the three groups a document order's lines fall into (migration 0138):
 * goes now, waits for QA, will not go. Each line says what was asked for, the
 * document found, its rule, and the server's own sentence for why.
 */
function DocumentGroup({
  title,
  testId,
  lines,
  tone,
}: {
  title: string;
  testId: string;
  lines: OrderSendDocumentLine[];
  tone: 'success.dark' | 'warning.dark' | 'text.secondary';
}) {
  if (lines.length === 0) return null;
  return (
    <Box data-testid={testId}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, color: tone }}>
        {title} ({lines.length})
      </Typography>
      {lines.map((l) => (
        <Box key={l.order_document_id} sx={{ py: 0.5 }} data-testid="send-document-line">
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {l.document_type_name ?? 'Document'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {[l.product_name, l.supplier_name, l.facility_name].filter(Boolean).join(' · ')}
            </Typography>
            {l.sharing_rule && (
              <Chip size="small" variant="outlined" color={sharingRuleColor(l.sharing_rule)} label={SHARING_RULE_LABELS[l.sharing_rule]} />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {l.document_title ? `${l.document_title}. ` : ''}
            {l.text}
          </Typography>
          {l.stale_note && (
            <Typography variant="caption" sx={{ display: 'block', color: 'warning.dark' }}>
              {l.stale_note}
            </Typography>
          )}
          {l.advisory && (
            <Typography variant="caption" sx={{ display: 'block', color: 'info.dark' }} data-testid="send-document-advisory">
              {l.advisory}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}

/** The addresses the box starts with. Tolerant of a plan from before 0135. */
function defaultRecipients(plan: OrderSendPreview): string[] {
  if (plan.recipients && plan.recipients.length > 0) return plan.recipients;
  return plan.recipient ? [plan.recipient] : [];
}

function recipientHelp(plan: OrderSendPreview): string {
  const who = plan.order.customer_name ?? 'this customer';
  if (plan.recipient_source === 'coa_contacts') {
    return `The contacts marked as receiving COAs for ${who}. Change the addresses here for this send only.`;
  }
  if (defaultRecipients(plan).length > 0) {
    return `The address on file for ${who}. Change it here for this send only.`;
  }
  return 'No address is on file for this customer. Enter the one to send to.';
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
        // Pre-filled with the customer's COA contacts (migration 0135), or
        // the customer's own address when it has none. Still only a starting
        // point: whatever is in the box when Send is pressed is what is used.
        setRecipients((r) => r || defaultRecipients(p).join(', '));
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
  const itemRequirements = plan?.item_requirements ?? [];
  const documents = plan?.documents ?? null;
  // A document line that will not go is in `documents.will_not_go`; the plain
  // "Not sent" list keeps the COA lines only, so nothing is printed twice.
  // ON HOLD (migration 0139) is its own group, COA lines and document lines
  // together: a hold is the one reason a person can act on from here (QA
  // releases it), so it is not buried among "no document on this line".
  const linesOnHold = (plan?.lines_not_sent ?? []).filter((l) => l.sharing_refusal === 'held');
  const heldDocumentLineIds = new Set(linesOnHold.map((l) => l.order_document_id).filter(Boolean));
  const coaLinesNotSent = (plan?.lines_not_sent ?? []).filter((l) => !l.order_document_id && l.sharing_refusal !== 'held');
  const onlyAsksQa = documents?.only_asks_qa === true;
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
                  helperText={recipientHelp(plan)}
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

                {documents && (
                  <Stack spacing={1.5} data-testid="send-documents">
                    {onlyAsksQa && (
                      <Alert severity="info" data-testid="send-only-asks-qa">
                        Nothing reaches the customer with this send. QA is told what is waiting, missing or expired.
                        Documents that QA releases are mailed to the addresses above.
                      </Alert>
                    )}
                    <DocumentGroup title="Goes now" testId="send-documents-goes-now" lines={documents.goes_now} tone="success.dark" />
                    <DocumentGroup title="Waits for QA" testId="send-documents-waits" lines={documents.waits_for_qa} tone="warning.dark" />
                    <DocumentGroup
                      title="Will not go"
                      testId="send-documents-will-not-go"
                      lines={documents.will_not_go.filter((l) => !heldDocumentLineIds.has(l.order_document_id))}
                      tone="text.secondary"
                    />
                    {documents.goes_now.some((l) => l.delivery === 'link') && (
                      <Typography variant="caption" color="text.secondary">
                        Documents go on one link that works for {documents.link_days} days. Certificates of analysis are attached.
                      </Typography>
                    )}
                    <Divider />
                  </Stack>
                )}

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

                {itemRequirements.length > 0 && (
                  <Box data-testid="send-item-requirements">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      What {plan.order.customer_name ?? 'this customer'} asks for
                    </Typography>
                    {itemRequirements.map((r) => (
                      <Typography
                        key={r.order_item_id}
                        variant="caption"
                        color={r.missing ? 'warning.main' : 'text.secondary'}
                        sx={{ display: 'block' }}
                        data-testid={r.missing ? 'send-requirement-missing' : 'send-requirement'}
                      >
                        {[r.product_name ?? 'No product named', r.lot_label ? `Lot ${r.lot_label}` : null].filter(Boolean).join(' · ')} — {r.summary}
                        {r.delivery_contact ? ` · to ${r.delivery_contact.name || r.delivery_contact.email}` : ''}
                        {r.missing ? ' · no certificate on this line' : ''}
                      </Typography>
                    ))}
                  </Box>
                )}

                {linesOnHold.length > 0 && (
                  <Box data-testid="send-lines-on-hold">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'error.main' }}>
                      On hold ({linesOnHold.length})
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      These will not be sent. QA or an administrator releases a hold, on the certificate or on the Holds page.
                    </Typography>
                    {linesOnHold.map((l) => (
                      <Typography
                        key={l.order_document_id || l.order_item_id}
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block' }}
                        data-testid="send-line-on-hold"
                      >
                        {[
                          l.product_name ?? 'No product named',
                          l.order_document_id ? l.document_type_name : null,
                          !l.order_document_id && l.lot_number ? `Lot ${l.lot_number}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {': '}
                        {l.reason}
                      </Typography>
                    ))}
                  </Box>
                )}

                {coaLinesNotSent.length > 0 && (
                  <Box data-testid="send-lines-not-sent">
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      Not sent ({coaLinesNotSent.length})
                    </Typography>
                    {coaLinesNotSent.map((l) => (
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
            : onlyAsksQa
              ? 'Ask QA'
              : plan && plan.part_count > 1
                ? `Send ${plan.part_count} emails`
                : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
