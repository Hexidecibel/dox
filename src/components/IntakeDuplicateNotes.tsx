/**
 * What intake knows about a file being byte-identical to something already
 * here (migration 0107), in the words a reviewer reads.
 *
 *   IntakeHistoryChips   one-glance chips for the collapsed Review Queue row
 *   IntakeHistoryAlerts  the sentences on the opened card
 *   ReceivedAgainList    every file recorded as received again, with
 *                        "Review anyway" (Review Queue › Received again)
 *   ReceivedAgainPanel   the same, for one document (document page)
 *
 * None of this blocks anything. A card identical to a rejected file can still
 * be approved; a file recorded as received again can always be reviewed.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Link,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../lib/api';
import { REJECTION_REASON_LABELS } from '../lib/types';
import { formatDateTime } from '../utils/format';
import type { IntakeDuplicate, QueueIntakeHistory } from '../../shared/types';

/** Where a file came from, as a person would say it. */
export function intakeSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'import':
      return 'an upload';
    case 'email':
      return 'email';
    case 'api':
      return 'an API drop';
    case 'public_link':
      return 'a drop link';
    case 's3':
      return 'a watched bucket';
    case 'manual':
      return 'a source run';
    case 'request_link':
      return 'a supplier request link';
    default:
      return source ? source.replace(/_/g, ' ') : 'an unknown door';
  }
}

/** The email sender, when the source detail carries one. */
function senderOf(detail: string | null | undefined): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as { sender?: string };
    if (parsed && typeof parsed.sender === 'string') return parsed.sender;
  } catch {
    // Not JSON; a connector detail like "email:someone@x" or "connector:Name".
  }
  const m = /^email:(.+)$/.exec(detail);
  return m ? m[1] : null;
}

function fromPhrase(source: string, detail: string | null): string {
  const sender = senderOf(detail);
  return sender ? `${intakeSourceLabel(source)} (${sender})` : intakeSourceLabel(source);
}

function rejectionLabel(reason: string | null | undefined): string {
  if (!reason) return 'no reason recorded';
  const label = (REJECTION_REASON_LABELS as Record<string, { label: string }>)[reason]?.label;
  return label ? label.toLowerCase() : reason.replace(/_/g, ' ');
}

export function IntakeHistoryChips({ history }: { history: QueueIntakeHistory | undefined }) {
  if (!history) return null;
  return (
    <>
      {history.also_received.length > 0 && (
        <Tooltip title="The same file arrived again while this was waiting. No second card was made." arrow>
          <Chip
            label={`Received ${history.also_received.length + 1}×`}
            size="small"
            color="info"
            variant="outlined"
            sx={{ ml: 0.5 }}
          />
        </Tooltip>
      )}
      {history.previously_rejected && (
        <Tooltip title="This exact file was rejected before." arrow>
          <Chip label="Rejected before" size="small" color="warning" variant="outlined" sx={{ ml: 0.5 }} />
        </Tooltip>
      )}
      {history.identical_documents.length > 0 && (
        <Tooltip title="This exact file is already a document." arrow>
          <Chip label="Already a document" size="small" color="warning" variant="outlined" sx={{ ml: 0.5 }} />
        </Tooltip>
      )}
    </>
  );
}

export function IntakeHistoryAlerts({ history }: { history: QueueIntakeHistory | undefined }) {
  if (!history) return null;
  const { also_received, previously_rejected, identical_documents, sent_anyway } = history;
  if (!also_received.length && !previously_rejected && !identical_documents.length && !sent_anyway) return null;
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {previously_rejected && (
        <Alert severity="warning" data-testid="intake-previously-rejected">
          This exact file was rejected
          {previously_rejected.rejected_at ? ` on ${formatDateTime(previously_rejected.rejected_at)}` : ''} for{' '}
          {rejectionLabel(previously_rejected.rejection_reason)}
          {previously_rejected.rejection_note ? ` ("${previously_rejected.rejection_note}")` : ''}. It was sent
          again, so it is here for you to look at.
        </Alert>
      )}
      {identical_documents.length > 0 && (
        <Alert severity="warning" data-testid="intake-identical-documents">
          This exact file is already{' '}
          {identical_documents.map((d, i) => (
            <span key={d.id}>
              {i > 0 ? ', ' : ''}
              <Link component={RouterLink} to={`/documents/${d.id}`} onClick={(e) => e.stopPropagation()}>
                {d.title}
              </Link>
            </span>
          ))}
          .
          {sent_anyway
            ? ` ${sent_anyway.overridden_by_name ?? 'Someone'} sent it for review anyway${
                sent_anyway.overridden_at ? ` on ${formatDateTime(sent_anyway.overridden_at)}` : ''
              }.`
            : ' Approving it will make a second copy.'}
        </Alert>
      )}
      {sent_anyway && identical_documents.length === 0 && (
        <Alert severity="info">
          {sent_anyway.overridden_by_name ?? 'Someone'} sent this for review anyway after it arrived identical to{' '}
          {sent_anyway.match_kind === 'already_waiting' ? 'a file already waiting here' : 'a file already approved'}.
        </Alert>
      )}
      {also_received.length > 0 && (
        <Alert severity="info" data-testid="intake-also-received">
          Also received{' '}
          {also_received.map((a, i) => (
            <span key={a.id}>
              {i > 0 ? '; ' : ''}
              from {fromPhrase(a.source, a.source_detail)} on {formatDateTime(a.received_at)}
            </span>
          ))}
          . Identical to this file, so no second card was made.
        </Alert>
      )}
    </Stack>
  );
}

function matchSentence(d: IntakeDuplicate): React.ReactNode {
  if (d.match_kind === 'already_approved') {
    if (d.matched_document_id) {
      return (
        <>
          Identical to{' '}
          <Link component={RouterLink} to={`/documents/${d.matched_document_id}`}>
            {d.matched_document_title ?? 'a document'}
          </Link>
        </>
      );
    }
    return <>Identical to {d.matched_queue_file_name ?? 'a file'}, already approved</>;
  }
  const then =
    d.matched_queue_status === 'approved'
      ? 'which was waiting in the Review Queue and has since been approved'
      : d.matched_queue_status === 'rejected'
        ? 'which was waiting in the Review Queue and has since been rejected'
        : 'still waiting in the Review Queue';
  return (
    <>
      Identical to{' '}
      {d.matched_queue_id ? (
        <Link component={RouterLink} to={`/review?item=${d.matched_queue_id}`}>
          {d.matched_queue_file_name ?? 'a file'}
        </Link>
      ) : (
        (d.matched_queue_file_name ?? 'a file')
      )}
      , {then}
    </>
  );
}

function DuplicateRow({
  d,
  onReviewed,
  showMatch,
}: {
  d: IntakeDuplicate;
  onReviewed: (updated: IntakeDuplicate) => void;
  showMatch: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const review = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.intakeDuplicates.reviewAnyway(d.id);
      onReviewed(res.duplicate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send it for review');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box
      data-testid={`received-again-${d.id}`}
      sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography variant="body2" fontWeight={600}>
            {d.file_name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Received again on {formatDateTime(d.received_at)} from {fromPhrase(d.source, d.source_detail)}
            {showMatch ? <> — {matchSentence(d)}</> : ' — identical to this document'}
          </Typography>
          {d.queue_id && (
            <Typography variant="caption" color="text.secondary">
              Sent for review anyway by {d.overridden_by_name ?? 'someone'}
              {d.overridden_at ? ` on ${formatDateTime(d.overridden_at)}` : ''}
            </Typography>
          )}
          {error && (
            <Typography variant="caption" color="error" display="block">
              {error}
            </Typography>
          )}
        </Box>
        {d.queue_id ? (
          <Button size="small" component={RouterLink} to={`/review?item=${d.queue_id}`}>
            Open review
          </Button>
        ) : (
          <Button
            size="small"
            variant="outlined"
            onClick={review}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} /> : undefined}
          >
            Review anyway
          </Button>
        )}
      </Box>
    </Box>
  );
}

/** Review Queue › Received again. */
export function ReceivedAgainList({ tenantId }: { tenantId?: string }) {
  const [state, setState] = useState<'open' | 'all'>('open');
  const [rows, setRows] = useState<IntakeDuplicate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.intakeDuplicates.list({ state, tenant_id: tenantId || undefined, limit: 200 });
      setRows(res.duplicates);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    } finally {
      setLoading(false);
    }
  }, [state, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (updated: IntakeDuplicate) =>
    setRows((prev) =>
      state === 'open' ? prev.filter((r) => r.id !== updated.id) : prev.map((r) => (r.id === updated.id ? updated : r)),
    );

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Files that arrived again, byte for byte identical to one already approved or already waiting. They were
        kept, not reviewed twice. Nothing here was deleted or rejected; send any of them for review if it needs a
        second look.
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, mb: 1.5 }}>
        <Chip
          label="Not reviewed"
          size="small"
          variant={state === 'open' ? 'filled' : 'outlined'}
          color={state === 'open' ? 'primary' : 'default'}
          onClick={() => setState('open')}
        />
        <Chip
          label="All"
          size="small"
          variant={state === 'all' ? 'filled' : 'outlined'}
          color={state === 'all' ? 'primary' : 'default'}
          onClick={() => setState('all')}
        />
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          {state === 'open' ? 'Nothing has arrived twice.' : 'No file has arrived twice yet.'}
        </Typography>
      ) : (
        <Card variant="outlined">
          <CardContent sx={{ py: 0.5, '&:last-child': { pb: 0.5 } }}>
            {rows.map((d) => (
              <DuplicateRow key={d.id} d={d} onReviewed={replace} showMatch />
            ))}
          </CardContent>
        </Card>
      )}
    </Box>
  );
}

/** Document page: every time this document's file arrived again. Renders nothing when it never has. */
export function ReceivedAgainPanel({ documentId }: { documentId: string }) {
  const [rows, setRows] = useState<IntakeDuplicate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.intakeDuplicates
      .list({ document_id: documentId, limit: 50 })
      .then((res) => {
        if (!cancelled) setRows(res.duplicates);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!rows || rows.length === 0) return null;
  return (
    <Card variant="outlined" sx={{ mb: 3 }} data-testid="received-again-panel">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Received again
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          This exact file arrived {rows.length === 1 ? 'once more' : `${rows.length} more times`} after it was first
          received. Nobody was asked to review it twice, unless it says so below.
        </Typography>
        {rows.map((d) => (
          <DuplicateRow
            key={d.id}
            d={d}
            showMatch={false}
            onReviewed={(u) => setRows((prev) => (prev ?? []).map((r) => (r.id === u.id ? u : r)))}
          />
        ))}
      </CardContent>
    </Card>
  );
}
