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
import type { ResolvedRenewalAlertLead } from '../../shared/types';
import { renewalAlertLeadSourceLabel } from '../../shared/renewalLeadTime';

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

/** "the organization setting" / "the system default", for the look-ahead helper text. */
function tenantLeadPhrase(lead: ResolvedRenewalAlertLead): string {
  return lead.source === 'tenant' ? 'the organization setting' : 'the system default';
}

export function Expirations() {
  const { selectedTenantId } = useTenant();
  const [rows, setRows] = useState<ExpirationRow[]>([]);
  const [summary, setSummary] = useState<ExpirationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * The look-ahead. null until the first load, which asks the server for its
   * default: the organization's renewal alert lead time (migration 0111). It is
   * a VIEW filter only: the alert engine judges each document against its own
   * lead time and never reads this.
   */
  const [windowDays, setWindowDays] = useState<number | null>(null);
  const [tenantLead, setTenantLead] = useState<ResolvedRenewalAlertLead | null>(null);
  const [onlyAttention, setOnlyAttention] = useState(true);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ msg: string; severity: 'success' | 'error' | 'info' | 'warning' } | null>(null);

  /**
   * `days === null`: ask without a window and take the server's (the tenant's
   * lead time) as the selector value. Done on first load and on a tenant
   * switch, because a different tenant has a different lead time.
   */
  const load = useCallback(
    async (days: number | null) => {
      setLoading(true);
      setError('');
      try {
        const result = await api.expirations.list({
          tenantId: selectedTenantId || undefined,
          windowDays: days ?? undefined,
        });
        setRows(result.rows);
        setSummary(result.summary);
        setTenantLead(result.tenant_lead ?? null);
        if (days === null) setWindowDays(result.window_days);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load renewals');
      } finally {
        setLoading(false);
      }
    },
    [selectedTenantId],
  );

  // Tenant switch (and first mount): back to that tenant's default look-ahead.
  useEffect(() => {
    void load(null);
  }, [load]);

  const changeWindow = (days: number) => {
    setWindowDays(days);
    void load(days);
  };

  const windowOptions = [...new Set([...WINDOW_OPTIONS, ...(tenantLead ? [tenantLead.days] : []), ...(windowDays ? [windowDays] : [])])].sort(
    (a, b) => a - b,
  );

  const sendAlert = useCallback(async () => {
    setSending(true);
    try {
      // No window: who is emailed is decided by each document's lead time.
      const res = await api.expirations.notify({
        tenantId: selectedTenantId || undefined,
      });
      // The unrouted count is reported WHETHER OR NOT anything sent. A run
      // that mailed three owners and silently skipped two records is not a
      // success, and the toast is the only place a person sees that.
      const gap =
        res.unrouted && res.unrouted.count > 0
          ? ` ${res.unrouted.count} record${res.unrouted.count === 1 ? '' : 's'} had no resolvable owner and reached nobody${res.unrouted.notice_sent ? ' — admins were sent a routing-gap notice' : ''}.`
          : '';

      if (res.sent) {
        const groupCount = (res.groups ?? []).filter((g) => g.sent).length;
        setToast({
          msg:
            `Sent ${groupCount} owner digest${groupCount === 1 ? '' : 's'} to ` +
            `${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'} ` +
            `(${res.document_count} document${res.document_count === 1 ? '' : 's'}).${gap}`,
          severity: gap ? 'warning' : 'success',
        });
      } else {
        const reasonMsg =
          res.reason === 'no_documents'
            ? 'Nothing to alert on — no expiring, overdue, or expired documents.'
            : res.reason === 'all_suppressed'
              ? 'Everything in the window was already alerted on recently.'
              : res.reason === 'all_unrouted'
                ? 'Nothing was sent — not one of these records resolves to an owner.'
                : res.reason === 'no_recipients'
                  ? 'No owner resolved to a deliverable address.'
                  : res.reason === 'email_not_configured'
                    ? 'Email is not configured on the server (RESEND_API_KEY unset).'
                    : 'Alert not sent.';
        setToast({ msg: `${reasonMsg}${gap}`, severity: gap ? 'warning' : 'info' });
      }
    } catch (err) {
      setToast({ msg: err instanceof Error ? err.message : 'Failed to send alert', severity: 'error' });
    } finally {
      setSending(false);
    }
  }, [selectedTenantId]);

  // What "Send alert now" would consider: judged on each row's OWN lead time,
  // not the look-ahead, so a narrow view cannot disable a real send.
  const mailAlertingCount = rows.filter(
    (r) => r.alert_status === 'expiring' || r.alert_status === 'expired' || r.alert_status === 'overdue',
  ).length;

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
          label="Look-ahead (this view)"
          size="small"
          value={windowDays ?? ''}
          onChange={(e) => changeWindow(Number(e.target.value))}
          sx={{ minWidth: 170 }}
          disabled={windowDays === null}
        >
          {windowOptions.map((d) => (
            <MenuItem key={d} value={d}>
              {d} days{tenantLead && d === tenantLead.days ? ' (alert lead time)' : ''}
            </MenuItem>
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
          disabled={sending || loading || !summary || mailAlertingCount === 0}
        >
          {sending ? 'Sending…' : 'Send alert now'}
        </Button>
      </Box>

      {tenantLead && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: -2, mb: 3 }} data-testid="lead-time-note">
          The look-ahead only changes this view. Owners are emailed {tenantLead.days} days before a
          document is due ({tenantLeadPhrase(tenantLead)}), or at their document type's own lead
          time where one is set — the look-ahead never changes who is emailed, including by{' '}
          <em>Send alert now</em>.{' '}
          <Link component={RouterLink} to="/settings/owner-routes" underline="hover">
            Change when owners are warned
          </Link>
        </Typography>
      )}

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
                        {row.alert_lead_days != null && row.alert_lead_source && (
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                            title={`Owner is warned ${row.alert_lead_days} days before due (${renewalAlertLeadSourceLabel(row.alert_lead_source)})`}
                          >
                            warned {row.alert_lead_days}d ahead
                            {row.alert_lead_source === 'document_type' ? ' (type)' : ''}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <StatusChip status={row.status} />
                        {/* The view and the mail path can disagree: a type that
                            warns 120 days ahead is being mailed about while a
                            60-day look-ahead still calls it Current. Say so. */}
                        {row.alert_status === 'expiring' && row.status === 'current' && (
                          <Typography
                            variant="caption"
                            color="warning.main"
                            sx={{ display: 'block', mt: 0.5 }}
                            data-testid="in-warning-window"
                          >
                            owner being warned
                          </Typography>
                        )}
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
