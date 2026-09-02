/**
 * /alert/:token — the landing page for someone who is NOT a portal user.
 *
 * They got an email. They clicked one link. This page shows the one thing that
 * needs attention and nothing else. No app shell, no nav, no search, no
 * document download, no way to reach a second record. If you are about to add
 * a link out of here, the honest answer is a portal account.
 *
 * The server decides what may be shown (see functions/lib/alert-links.ts); this
 * component only renders the allow-listed payload. It must never fetch a second
 * endpoint to "fill in" a missing field.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  alpha,
} from '@mui/material';
import type { AlertLandingView } from '../../shared/types';

const ACCENT = '#1A365D';
const DANGER = '#8B1A1A';

async function fetchAlert(token: string): Promise<AlertLandingView> {
  const res = await fetch(`/api/alerts/public/${encodeURIComponent(token)}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const code = res.status === 429 ? 'rate_limited' : 'not_found';
    throw Object.assign(new Error('Alert unavailable'), { code });
  }
  return res.json();
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysText(d: number | null): string {
  if (d == null) return '';
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago`;
  if (d === 0) return 'today';
  return `in ${d} day${d === 1 ? '' : 's'}`;
}

export function AlertLanding() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<AlertLandingView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is no longer valid.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await fetchAlert(token);
        if (cancelled) return;
        setView(v);
        document.title =
          v.kind === 'spec_alert' ? 'Out-of-spec result' : 'Documents needing renewal';
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setError(
          code === 'rate_limited'
            ? 'Too many requests from this connection. Try again in a little while.'
            : 'This link has expired or is no longer active.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: '#FAFAFA',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !view) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: '#FAFAFA',
          p: 2,
        }}
      >
        <Box sx={{ maxWidth: 480, textAlign: 'center' }}>
          <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
            This link is no longer active
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {error ?? 'Alert links expire. Ask the sender to send a fresh one.'}
          </Typography>
        </Box>
      </Box>
    );
  }

  const isSpec = view.kind === 'spec_alert';
  const headerColor = isSpec ? DANGER : ACCENT;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: alpha(ACCENT, 0.03), py: { xs: 4, md: 8 }, px: 2 }}>
      <Box
        sx={{
          maxWidth: 720,
          mx: 'auto',
          bgcolor: 'background.paper',
          borderRadius: 3,
          boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          overflow: 'hidden',
        }}
      >
        <Box sx={{ p: { xs: 3, md: 4 }, bgcolor: headerColor, color: 'white' }}>
          <Typography variant="caption" sx={{ opacity: 0.85, fontWeight: 600, letterSpacing: 0.5 }}>
            {isSpec ? 'OUT-OF-SPEC RESULT' : 'RENEWAL ATTENTION NEEDED'}
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5, lineHeight: 1.3 }}>
            {isSpec
              ? view.document?.title || 'A certificate of analysis'
              : `${view.renewals.length} document${view.renewals.length === 1 ? '' : 's'} need${view.renewals.length === 1 ? 's' : ''} attention`}
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.85, mt: 1 }}>
            {view.tenant_name}
          </Typography>
        </Box>

        <Box sx={{ p: { xs: 3, md: 4 } }}>
          {isSpec && view.document && (
            <>
              <Stack spacing={1} sx={{ mb: 3 }}>
                <Detail label="Supplier" value={view.document.supplier_name} />
                <Detail label="Document type" value={view.document.document_type_name} />
                <Detail label="Received" value={formatDate(view.document.received_date)} />
              </Stack>
              <Divider sx={{ mb: 3 }} />

              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
                {view.failures.length === 1
                  ? 'This result is outside its limit'
                  : `${view.failures.length} results are outside their limits`}
              </Typography>

              <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow sx={{ bgcolor: 'background.default' }}>
                      <TableCell sx={{ fontWeight: 700 }}>Test</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Result</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Judged against</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {view.failures.map((f, i) => (
                      <TableRow key={`${f.test}-${i}`}>
                        <TableCell sx={{ fontWeight: 600 }}>{f.test}</TableCell>
                        <TableCell sx={{ color: DANGER, fontWeight: 600 }}>
                          {[f.value, f.unit].filter(Boolean).join(' ') || '—'}
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>
                          {f.judged_against === 'printed'
                            ? `the certificate's own stated limit${f.printed_limit ? ` (${f.printed_limit})` : ''}`
                            : 'an internal acceptance limit'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 3, lineHeight: 1.7 }}>
                These values were read from the document and compared against the limits on file.
                Nothing has been rejected or held automatically — this is for a person to look at.
              </Typography>
            </>
          )}

          {!isSpec && (
            <>
              {view.renewals.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Everything in this alert has since been resolved. Nothing needs attention.
                </Typography>
              ) : (
                <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflowX: 'auto' }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow sx={{ bgcolor: 'background.default' }}>
                        <TableCell sx={{ fontWeight: 700 }}>Document</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Category</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Due</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {view.renewals.map((r, i) => (
                        <TableRow key={`${r.title}-${i}`}>
                          <TableCell sx={{ fontWeight: 600 }}>{r.title}</TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{r.category || '—'}</TableCell>
                          <TableCell>
                            {r.due_date || '—'}
                            <Typography variant="caption" sx={{ display: 'block', color: 'text.disabled' }}>
                              {daysText(r.days_until)}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={r.status}
                              sx={{
                                textTransform: 'capitalize',
                                bgcolor:
                                  r.status === 'expiring'
                                    ? alpha('#ed6c02', 0.12)
                                    : alpha(DANGER, 0.12),
                                color: r.status === 'expiring' ? '#ed6c02' : DANGER,
                                fontWeight: 600,
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
              )}
            </>
          )}

          <Divider sx={{ my: 3 }} />
          <Typography variant="caption" sx={{ color: 'text.disabled', lineHeight: 1.6 }}>
            You are seeing this because you were emailed about it. This link is read-only and stops
            working on {formatDate(view.expires_at)}.
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <Stack direction="row" spacing={2} alignItems="baseline">
      <Typography
        variant="caption"
        sx={{
          color: 'text.secondary',
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          minWidth: 130,
        }}
      >
        {label}
      </Typography>
      <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-word' }}>
        {value || '—'}
      </Typography>
    </Stack>
  );
}
