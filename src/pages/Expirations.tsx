import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Snackbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Link,
  Stack,
  MenuItem,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';
import { formatDate } from '../utils/format';
import type {
  ExpirationRow,
  ExpirationSummary,
  ExpirationStatus,
  RenewalType,
} from '../lib/types';

const STATUS_CHIP: Record<ExpirationStatus, { label: string; color: 'success' | 'error' | 'warning' | 'default' }> = {
  current: { label: 'Current', color: 'success' },
  expiring: { label: 'Expiring', color: 'warning' },
  expired: { label: 'Expired', color: 'error' },
  overdue: { label: 'Overdue', color: 'error' },
  stale: { label: 'Stale', color: 'default' },
};

const RENEWAL_LABEL: Record<RenewalType | 'unknown', string> = {
  renewal_application: 'Renewal application',
  hard_expiry: 'Hard expiry',
  keep_current: 'Keep current',
  review_cycle: 'Review cycle',
  unknown: 'Expiry',
};

function StatusChip({ status }: { status: ExpirationStatus }) {
  const cfg = STATUS_CHIP[status];
  return <Chip size="small" label={cfg.label} color={cfg.color} variant={status === 'current' ? 'outlined' : 'filled'} />;
}

function SummaryCards({ summary }: { summary: ExpirationSummary }) {
  const s = summary.by_status;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
      <Chip
        label={`${summary.alerting} need${summary.alerting === 1 ? 's' : ''} attention`}
        color={summary.alerting ? 'warning' : 'success'}
        sx={{ fontWeight: 700 }}
      />
      <Chip label={`${summary.total} tracked`} variant="outlined" />
      <Chip label={`Expired ${s.expired}`} color={s.expired ? 'error' : 'default'} variant="outlined" />
      <Chip label={`Overdue ${s.overdue}`} color={s.overdue ? 'error' : 'default'} variant="outlined" />
      <Chip label={`Expiring ${s.expiring}`} color={s.expiring ? 'warning' : 'default'} variant="outlined" />
      <Chip label={`Current ${s.current}`} color="success" variant="outlined" />
      {s.stale > 0 && <Chip label={`Stale ${s.stale}`} variant="outlined" />}
    </Stack>
  );
}

function daysText(d: number | null): string {
  if (d == null) return '—';
  if (d < 0) return `${Math.abs(d)}d ago`;
  if (d === 0) return 'today';
  return `in ${d}d`;
}

const WINDOW_OPTIONS = [30, 60, 90, 180];

export function Expirations() {
  const { selectedTenantId } = useTenant();
  const [rows, setRows] = useState<ExpirationRow[]>([]);
  const [summary, setSummary] = useState<ExpirationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [windowDays, setWindowDays] = useState(60);
  const [onlyAttention, setOnlyAttention] = useState(true);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; severity: 'success' | 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.expirations.list({
        tenantId: selectedTenantId || undefined,
        windowDays,
      });
      setRows(result.rows);
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load renewals');
    } finally {
      setLoading(false);
    }
  }, [selectedTenantId, windowDays]);

  useEffect(() => {
    load();
  }, [selectedTenantId, windowDays]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendAlert = useCallback(async () => {
    setSending(true);
    try {
      const res = await api.expirations.notify({
        tenantId: selectedTenantId || undefined,
        windowDays,
      });
      if (res.sent) {
        setToast({
          msg: `Alert sent to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'} (${res.document_count} document${res.document_count === 1 ? '' : 's'}).`,
          severity: 'success',
        });
      } else {
        const reasonMsg =
          res.reason === 'no_documents'
            ? 'Nothing to alert on — no expiring, overdue, or expired documents.'
            : res.reason === 'no_recipients'
              ? 'No org admins or super admins to notify.'
              : res.reason === 'email_not_configured'
                ? 'Email is not configured on the server (RESEND_API_KEY unset).'
                : 'Alert not sent.';
        setToast({ msg: reasonMsg, severity: 'info' });
      }
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : 'Failed to send alert', severity: 'error' });
    } finally {
      setSending(false);
    }
  }, [selectedTenantId, windowDays]);

  const visibleRows = onlyAttention
    ? rows.filter((r) => r.status === 'expiring' || r.status === 'expired' || r.status === 'overdue')
    : rows;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Renewals
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Registry documents by renewal status. Expiring, overdue, and expired records are flagged.
      </Typography>

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 3 }}>
        <TextField
          select
          label="Look-ahead"
          size="small"
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          sx={{ minWidth: 140 }}
        >
          {WINDOW_OPTIONS.map((d) => (
            <MenuItem key={d} value={d}>{d} days</MenuItem>
          ))}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        <Button
          variant={onlyAttention ? 'contained' : 'outlined'}
          color="warning"
          size="small"
          onClick={() => setOnlyAttention(true)}
        >
          Needs attention{summary ? ` (${summary.alerting})` : ''}
        </Button>
        <Button
          variant={!onlyAttention ? 'contained' : 'outlined'}
          size="small"
          onClick={() => setOnlyAttention(false)}
        >
          All tracked
        </Button>
        <Button
          variant="contained"
          size="small"
          onClick={sendAlert}
          disabled={sending || loading || !summary || summary.alerting === 0}
        >
          {sending ? 'Sending…' : 'Send alert now'}
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {summary && <SummaryCards summary={summary} />}

          {visibleRows.length === 0 ? (
            <Alert severity="success">
              {onlyAttention ? 'No documents need renewal attention.' : 'No tracked renewal documents.'}
            </Alert>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '10%' }} />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell>Document</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell>Owner</TableCell>
                    <TableCell>Renewal type</TableCell>
                    <TableCell>Due</TableCell>
                    <TableCell align="right">Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleRows.map((row) => (
                    <TableRow key={row.id} hover>
                      <TableCell sx={{ wordBreak: 'break-word' }}>
                        <Link component={RouterLink} to={`/documents/${row.id}`} underline="hover">
                          {row.title}
                        </Link>
                      </TableCell>
                      <TableCell sx={{ wordBreak: 'break-word' }}>{row.primary_category_name || '—'}</TableCell>
                      <TableCell sx={{ wordBreak: 'break-word' }}>{row.owner || '—'}</TableCell>
                      <TableCell sx={{ wordBreak: 'break-word' }}>{RENEWAL_LABEL[row.renewal_type]}</TableCell>
                      <TableCell>
                        {row.renewal_due_date ? formatDate(row.renewal_due_date) : '—'}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {daysText(row.days_until)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <StatusChip status={row.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)} sx={{ width: '100%' }}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
