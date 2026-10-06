/**
 * Renewals > Supplier requests (migration 0133).
 *
 * The scheduled run DRAFTS a renewal request to a supplier; this is where a
 * person reads the draft, edits it if they want to, and sends it. Nothing on
 * this screen is sent without the "Approve and send" button, and the dialog
 * shows everything that will leave before it is pressed:
 *
 *   To         the supplier's document contact, by name and address;
 *   Subject    editable;
 *   Body       editable -- the fixed template, filled in;
 *   Link       NOT editable. It is appended by the system at send and shown
 *              here as it will read, so "can I take the link out" is answered
 *              by the screen rather than by trying.
 *
 * Three groups, most pressing first: waiting for an approval, sent (the chase
 * in progress, with the exact text of every message), and escalated (the
 * portal has stopped writing to the supplier; a person decides what is next).
 * Below them, the alerting documents NO request could be drafted for and why --
 * the reason a supplier with no contact on file is never silently skipped.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate } from '../utils/format';
import { renewalStageLabel } from '../../shared/renewalRequestTemplate';
import type {
  RenewalNotDraftedDocument,
  RenewalRequestItem,
  RenewalRequestListResponse,
  RenewalRequestSend,
} from '../../shared/types';

const ENDED_REASON: Record<string, string> = {
  replacement_accepted: 'A replacement was accepted',
  due_date_changed: 'The renewal date changed',
  document_archived: 'The document was archived',
  no_longer_renews: 'The document no longer has a renewal date',
  supplier_changed: 'The document was moved to another supplier',
  no_response: 'No replacement was accepted',
};

function waitingSend(r: RenewalRequestItem): RenewalRequestSend | null {
  return r.sends.find((s) => s.id === r.waiting_send_id) ?? null;
}

function approverText(s: RenewalRequestSend): string {
  if (s.approver_name) return s.approver_name;
  return 'An administrator';
}

/** Who would approve, and why it is them: the rung of D-050 that answered. */
function approverWhy(s: RenewalRequestSend): string {
  switch (s.approver_via) {
    case 'owner_route':
      return "the document's owner";
    case 'master_user':
      return 'the master user';
    default:
      return 'no owner or master user resolved';
  }
}

interface ReviewDialogProps {
  request: RenewalRequestItem;
  send: RenewalRequestSend;
  linkBlock: string;
  emailConfigured: boolean;
  onClose: () => void;
  onDone: (message: string, request: RenewalRequestItem | null) => void;
}

function ReviewDialog({ request, send, linkBlock, emailConfigured, onClose, onDone }: ReviewDialogProps) {
  const [subject, setSubject] = useState(send.draft_subject);
  const [body, setBody] = useState(send.draft_body);
  const [busy, setBusy] = useState<'send' | 'skip' | null>(null);
  const [error, setError] = useState('');

  const canSend = request.can_approve && !!request.contact && emailConfigured && !!subject.trim() && !!body.trim();

  const approve = async () => {
    setBusy('send');
    setError('');
    try {
      const res = await api.renewalRequests.approve(request.id, send.id, { subject, body });
      onDone(`Sent to ${request.contact?.email ?? 'the supplier'}.`, res.request);
    } catch (err) {
      // A refused send keeps the dialog open with the reason; the draft is
      // still waiting (or marked failed) and can be sent again.
      setError(err instanceof Error ? err.message : 'The request could not be sent');
    } finally {
      setBusy(null);
    }
  };

  const skip = async () => {
    setBusy('skip');
    setError('');
    try {
      const res = await api.renewalRequests.skip(request.id, send.id);
      onDone('Skipped. Nothing was sent; the next reminder will still be drafted when it is due.', res.request);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not skip this request');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={() => !busy && onClose()} fullWidth maxWidth="md">
      <DialogTitle>
        Review request to {request.supplier.name}
        <Typography variant="body2" color="text.secondary">
          {request.document.title} · due {formatDate(request.due_date)} · {renewalStageLabel(send.stage)}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {send.status === 'failed' && !error && (
            <Alert severity="warning">
              The last attempt to send this was refused{send.failure ? `: ${send.failure}` : '.'} Nothing
              reached the supplier. You can send it again.
            </Alert>
          )}
          {!emailConfigured && (
            <Alert severity="warning">
              Email is not configured on this server, so this request cannot be sent yet.
            </Alert>
          )}
          {!request.can_approve && (
            <Alert severity="info">
              This request is waiting for {approverText(send)} ({approverWhy(send)}). An
              administrator can also send it.
            </Alert>
          )}

          <Box>
            <Typography variant="caption" color="text.secondary">To</Typography>
            {request.contact ? (
              <Typography data-testid="review-to">
                {request.contact.name ? `${request.contact.name} <${request.contact.email}>` : request.contact.email}
              </Typography>
            ) : (
              <Alert severity="warning" data-testid="review-no-contact">
                No document contact on file for {request.supplier.name}.{' '}
                <Link component={RouterLink} to={`/admin/suppliers/${request.supplier.id}`} underline="hover">
                  Add one on the supplier's Contacts tab
                </Link>
                , then send.
              </Alert>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Sent as “your organization via SupDox”. Replies go to the person who approves it.
            </Typography>
          </Box>

          <TextField
            label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            fullWidth
            size="small"
            disabled={!request.can_approve}
          />
          <TextField
            label="Message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            fullWidth
            multiline
            minRows={10}
            disabled={!request.can_approve}
            inputProps={{ 'aria-label': 'Message' }}
          />

          <Box>
            <Typography variant="caption" color="text.secondary">
              Added below your message when it is sent — this part cannot be edited or removed
            </Typography>
            <Paper
              variant="outlined"
              sx={{ p: 1.5, bgcolor: 'action.hover', whiteSpace: 'pre-wrap', fontSize: 14 }}
              data-testid="review-link-block"
            >
              {linkBlock}
            </Paper>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              The link opens a page showing only this document, where the supplier uploads the new
              one. No attachment is sent.
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={!!busy}>Close</Button>
        <Box sx={{ flexGrow: 1 }} />
        {request.can_approve && (
          <Button onClick={() => void skip()} disabled={!!busy}>
            {busy === 'skip' ? 'Skipping…' : 'Skip this one'}
          </Button>
        )}
        <Button variant="contained" onClick={() => void approve()} disabled={!canSend || !!busy}>
          {busy === 'send' ? 'Sending…' : 'Approve and send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** What was actually sent: the stored text, verbatim. */
function SentDialog({ request, onClose }: { request: RenewalRequestItem; onClose: () => void }) {
  const sent = request.sends.filter((s) => s.status === 'sent');
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        Sent to {request.supplier.name}
        <Typography variant="body2" color="text.secondary">
          {request.document.title} · due {formatDate(request.due_date)}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {sent.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Nothing was sent to the supplier for this document.
            </Typography>
          )}
          {sent.map((s) => (
            <Paper key={s.id} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2">{renewalStageLabel(s.stage)}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                To {s.sent_to} · approved by {s.approved_by_name ?? 'unknown'}
                {s.sent_at ? ` · ${formatDate(s.sent_at)}` : ''}
              </Typography>
              <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                {s.sent_subject}
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {s.sent_body}
              </Typography>
            </Paper>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        {request.request_id && (
          <Button component={RouterLink} to={`/requests/${request.request_id}`}>
            Open the request
          </Button>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function NotDraftedList({ title, docs, action }: { title: string; docs: RenewalNotDraftedDocument[]; action?: boolean }) {
  if (docs.length === 0) return null;
  return (
    <Box sx={{ mb: 1 }}>
      <Typography variant="body2" fontWeight={600}>
        {title} ({docs.length})
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 3 }}>
        {docs.slice(0, 10).map((d) => (
          <Typography component="li" variant="body2" key={d.document_id}>
            <Link component={RouterLink} to={`/documents/${d.document_id}`} underline="hover">
              {d.title}
            </Link>
            {d.due_date ? ` — due ${formatDate(d.due_date)}` : ''}
            {action && d.supplier_id && (
              <>
                {' · '}
                <Link component={RouterLink} to={`/admin/suppliers/${d.supplier_id}`} underline="hover">
                  {d.supplier_name ?? 'supplier'}
                </Link>
              </>
            )}
          </Typography>
        ))}
        {docs.length > 10 && (
          <Typography component="li" variant="body2" color="text.secondary">
            and {docs.length - 10} more
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function SupplierRenewalRequests({ tenantId }: { tenantId?: string }) {
  const [data, setData] = useState<RenewalRequestListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.renewalRequests.list({ tenantId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier requests');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The link in the approver's email: /expirations?supplier_request=<send id>.
  const linked = searchParams.get('supplier_request');
  useEffect(() => {
    if (!linked || !data) return;
    const hit = data.requests.find((r) => r.sends.some((s) => s.id === linked));
    if (hit) {
      if (hit.waiting_send_id === linked) setReviewing(hit.id);
      else setViewing(hit.id);
    } else {
      setNotice('That supplier request is no longer waiting.');
    }
    const next = new URLSearchParams(searchParams);
    next.delete('supplier_request');
    setSearchParams(next, { replace: true });
  }, [linked, data, searchParams, setSearchParams]);

  const groups = useMemo(() => {
    const requests = data?.requests ?? [];
    return {
      waiting: requests.filter((r) => r.status === 'open' && r.waiting_send_id),
      sent: requests.filter((r) => r.status === 'open' && !r.waiting_send_id && r.emails_sent > 0),
      escalated: requests.filter((r) => r.status === 'escalated'),
      ended: requests.filter((r) => r.status === 'satisfied' || r.status === 'stopped'),
    };
  }, [data]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (error && !data) return <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>;
  if (!data) return null;

  const nd = data.not_drafted;
  const notDraftedCount = nd.no_contact.length + nd.no_supplier.length + nd.past_escalation.length;
  const nothing = data.requests.length === 0 && notDraftedCount === 0;
  // Quiet when there is nothing to say: a tenant that has never added a
  // supplier contact should not find a new empty section on its Renewals page.
  if (nothing) return null;

  const reviewRequest = reviewing ? data.requests.find((r) => r.id === reviewing) ?? null : null;
  const reviewSend = reviewRequest ? waitingSend(reviewRequest) : null;
  const viewRequest = viewing ? data.requests.find((r) => r.id === viewing) ?? null : null;

  const replace = (request: RenewalRequestItem | null) => {
    if (!request) return;
    setData((d) => (d ? { ...d, requests: d.requests.map((r) => (r.id === request.id ? request : r)) } : d));
  };

  return (
    <Box sx={{ mb: 4 }} data-testid="supplier-requests">
      <Typography variant="h6" sx={{ mb: 0.5 }}>
        Supplier requests
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A request to the supplier is drafted when a document enters its warning window, on the day it
        expires, and 7 and 14 days after. <strong>Nothing is sent to a supplier until a person approves
        it.</strong> After {data.escalate_after_days} days with no replacement accepted, reminders stop
        and your administrators are told.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      {groups.waiting.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Waiting for approval ({groups.waiting.length})</TableCell>
                <TableCell>Supplier</TableCell>
                <TableCell>Due</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell>Approver</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.waiting.map((r) => {
                const s = waitingSend(r)!;
                return (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      <Link component={RouterLink} to={`/documents/${r.document.id}`} underline="hover">
                        {r.document.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.supplier.name}
                      {!r.contact && (
                        <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                          no document contact on file
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{formatDate(r.due_date)}</TableCell>
                    <TableCell>
                      {renewalStageLabel(s.stage)}
                      {s.status === 'failed' && (
                        <Chip size="small" color="error" label="Send failed" sx={{ ml: 1 }} />
                      )}
                      {r.emails_sent > 0 && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {r.emails_sent} already sent
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{approverText(s)}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant={r.can_approve ? 'contained' : 'outlined'}
                        onClick={() => setReviewing(r.id)}
                      >
                        {r.can_approve ? 'Review and send' : 'View draft'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {(groups.sent.length > 0 || groups.escalated.length > 0 || groups.ended.length > 0) && (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Sent and closed</TableCell>
                <TableCell>Supplier</TableCell>
                <TableCell>Due</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {[...groups.escalated, ...groups.sent, ...groups.ended].map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ wordBreak: 'break-word' }}>
                    <Link component={RouterLink} to={`/documents/${r.document.id}`} underline="hover">
                      {r.document.title}
                    </Link>
                  </TableCell>
                  <TableCell>{r.supplier.name}</TableCell>
                  <TableCell>{formatDate(r.due_date)}</TableCell>
                  <TableCell>
                    {r.status === 'escalated' ? (
                      <Chip size="small" color="error" label="Escalated — reminders stopped" />
                    ) : r.status === 'open' ? (
                      <Chip size="small" color="info" variant="outlined" label="Waiting on the supplier" />
                    ) : (
                      <Chip
                        size="small"
                        color={r.status === 'satisfied' ? 'success' : 'default'}
                        variant="outlined"
                        label={r.status === 'satisfied' ? 'Replacement accepted' : 'Ended'}
                      />
                    )}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {r.emails_sent} of 4 sent
                      {r.status !== 'open' && r.status_reason
                        ? ` · ${ENDED_REASON[r.status_reason] ?? r.status_reason}`
                        : ''}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => setViewing(r.id)}>
                      What was sent
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {notDraftedCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="supplier-requests-not-drafted">
          <Typography variant="body2" sx={{ mb: 1 }}>
            No supplier request was drafted for {notDraftedCount} document{notDraftedCount === 1 ? '' : 's'} that
            need renewal attention:
          </Typography>
          <NotDraftedList
            title="No document contact on file for the supplier — add one on the supplier's Contacts tab"
            docs={nd.no_contact}
            action
          />
          <NotDraftedList title="No supplier on the document, so there is nobody to ask" docs={nd.no_supplier} />
          <NotDraftedList
            title={`Already more than ${data.escalate_after_days} days past due when first seen — no reminders are started`}
            docs={nd.past_escalation}
            action
          />
        </Alert>
      )}

      {reviewRequest && reviewSend && (
        <ReviewDialog
          key={reviewSend.id}
          request={reviewRequest}
          send={reviewSend}
          linkBlock={data.link_block_preview}
          emailConfigured={data.email_configured}
          onClose={() => {
            setReviewing(null);
            // A refused send changed the row (failed); show it as it now is.
            void load();
          }}
          onDone={(message, request) => {
            setReviewing(null);
            setNotice(message);
            replace(request);
          }}
        />
      )}
      {viewRequest && <SentDialog request={viewRequest} onClose={() => setViewing(null)} />}
    </Box>
  );
}

export default SupplierRenewalRequests;
