/**
 * Documents you sent — the list of export links, and the button that kills one.
 *
 * WHY THIS PAGE. v2.20.0 made it one click to mail a dozen certificates to an
 * address outside the portal, and then said nothing more about them: there was
 * no list of what had been sent and no way to pull a link back short of an
 * UPDATE against the database. AJ Conner, reviewing v2.7.0-v2.20.0: "the link
 * is the credential, so a forwarded mail hands the set to whoever holds the
 * URL."
 *
 * THE OPEN COUNTS ARE HONEST AND THE PAGE SAYS SO IN WORDS. A count here is a
 * count of REQUESTS against the link, not of people, and it cannot say which
 * recipient made them: the URL is a bearer credential and travels. Numbers
 * beside a recipient list invite exactly the wrong reading ("Dana opened it"),
 * so the caption under them says what they are before anybody has to ask.
 *
 * THERE IS NO EXTEND BUTTON, deliberately. Lengthening a link after the fact
 * silently changes the terms of a mail already sent, and hides that decision
 * where nobody re-reads it. A new send is the honest answer: it names its own
 * recipients and writes its own audit row.
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
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { Block as RevokeIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';
import type {
  DocumentExportLinkSummary,
  DocumentExportLinkState,
} from '../../shared/types';

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDay(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATE_LABEL: Record<DocumentExportLinkState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

const STATE_COLOR: Record<DocumentExportLinkState, 'success' | 'default' | 'error'> = {
  active: 'success',
  expired: 'default',
  revoked: 'error',
};

function StateChip({ link }: { link: DocumentExportLinkSummary }) {
  const title =
    link.state === 'revoked'
      ? `Revoked ${formatWhen(link.revoked_at)}${link.revoked_by_name ? ` by ${link.revoked_by_name}` : ''} — the link now opens nothing`
      : link.state === 'expired'
        ? `Expired ${formatDay(link.expires_at)} on its own`
        : `Opens until ${formatDay(link.expires_at)}`;
  return (
    <Tooltip arrow title={title}>
      <Chip size="small" label={STATE_LABEL[link.state]} color={STATE_COLOR[link.state]} variant="outlined" />
    </Tooltip>
  );
}

export function SentDocuments() {
  const { user } = useAuth();
  const { selectedTenantId } = useTenant();
  const [links, setLinks] = useState<DocumentExportLinkSummary[]>([]);
  const [scope, setScope] = useState<'tenant' | 'mine'>('tenant');
  const [canSeeTenant, setCanSeeTenant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<DocumentExportLinkSummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.documentExports.listLinks({
        scope,
        tenant_id: selectedTenantId || undefined,
      });
      setLinks(res.links);
      setCanSeeTenant(res.can_see_tenant);
      // The server decides the scope; reflect what it actually answered rather
      // than what was asked, so the toggle never lies about what is on screen.
      setScope(res.scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sent documents');
    } finally {
      setLoading(false);
    }
  }, [scope, selectedTenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const doRevoke = async () => {
    if (!confirming) return;
    setRevoking(true);
    setError('');
    try {
      const res = await api.documentExports.revokeLink(confirming.id);
      setLinks((prev) => prev.map((l) => (l.id === res.link.id ? res.link : l)));
      setNotice(
        `That link is off. Anyone opening it now — including anyone it was forwarded to — sees nothing. ` +
          `Files already downloaded cannot be recalled.`,
      );
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke that link');
    } finally {
      setRevoking(false);
    }
  };

  const activeCount = useMemo(() => links.filter((l) => l.state === 'active').length, [links]);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h4" fontWeight={700}>
          Documents you sent
        </Typography>
        {canSeeTenant && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={scope}
            onChange={(_e, v) => v && setScope(v as 'tenant' | 'mine')}
          >
            <ToggleButton value="tenant">Everyone</ToggleButton>
            <ToggleButton value="mine">Only mine</ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>

      <HelpWell id="documents.sent" title={helpContent.sentDocuments.headline}>
        {helpContent.sentDocuments.well}
      </HelpWell>

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

      <Paper variant="outlined" sx={{ p: 2 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : links.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {scope === 'mine'
              ? 'You have not sent any documents by link yet. Select results on Search and choose "Send to someone".'
              : 'Nobody here has sent documents by link yet. Select results on Search and choose "Send to someone".'}
          </Typography>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              {links.length} send{links.length === 1 ? '' : 's'}, {activeCount} still open.{' '}
              <strong>Opens and downloads count requests against the link, not people.</strong>{' '}
              The link is the credential and can be forwarded, so the portal cannot tell which
              recipient opened it — only that somebody holding the URL did.
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>Sent</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>By</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>To</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Documents</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>Opened</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>State</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {links.map((l) => (
                    <TableRow key={l.id} sx={{ opacity: l.state === 'active' ? 1 : 0.65 }}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatWhen(l.created_at)}
                        <Typography variant="caption" color="text.secondary" display="block">
                          {l.state === 'revoked'
                            ? `Revoked ${formatDay(l.revoked_at)}`
                            : `Expires ${formatDay(l.expires_at)}`}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {l.sent_by_name || l.sent_by_email || 'Unknown'}
                        {l.sent_by_id === user?.id && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            you
                          </Typography>
                        )}
                        {l.on_behalf_of && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            on behalf of {l.on_behalf_of}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Stack spacing={0.25}>
                          {l.recipients.map((r) => (
                            <Typography key={r} variant="body2">
                              {r}
                            </Typography>
                          ))}
                          {l.recipients.length === 0 && (
                            <Typography variant="body2" color="text.secondary">
                              —
                            </Typography>
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Tooltip
                          arrow
                          title={
                            l.document_titles.join(' · ') +
                            (l.documents_truncated ? ' · …' : '')
                          }
                        >
                          <span>
                            {l.document_count} document{l.document_count === 1 ? '' : 's'}
                          </span>
                        </Tooltip>
                        <Typography variant="caption" color="text.secondary" display="block">
                          {l.document_titles.slice(0, 2).join(' · ')}
                          {l.documents_truncated || l.document_titles.length > 2 ? ' …' : ''}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {l.view_count === 0 && l.download_count === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            Not opened
                          </Typography>
                        ) : (
                          <>
                            <Typography variant="body2">
                              {l.view_count} open{l.view_count === 1 ? '' : 's'} ·{' '}
                              {l.download_count} download{l.download_count === 1 ? '' : 's'}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block">
                              last {formatWhen(l.last_downloaded_at || l.last_viewed_at)}
                            </Typography>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <StateChip link={l} />
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {l.state === 'active' && l.can_revoke && (
                          <Button
                            size="small"
                            color="error"
                            startIcon={<RevokeIcon fontSize="small" />}
                            onClick={() => setConfirming(l)}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </Paper>

      <Dialog open={Boolean(confirming)} onClose={() => !revoking && setConfirming(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Revoke this link?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body2" paragraph>
              {confirming?.document_count} document
              {confirming?.document_count === 1 ? '' : 's'} sent to{' '}
              {confirming?.recipients.join(', ')} on {formatWhen(confirming?.created_at ?? null)}.
            </Typography>
            <Typography variant="body2" paragraph>
              Revoking takes effect at once: the landing page, the ZIP and every single-file
              download stop working for everybody, including anyone the mail was forwarded to.
            </Typography>
            <Typography variant="body2" paragraph>
              It <strong>cannot</strong> recall files already downloaded
              {confirming && confirming.download_count > 0
                ? ` — and this link has been downloaded from ${confirming.download_count} time${confirming.download_count === 1 ? '' : 's'}.`
                : '.'}
            </Typography>
            <Typography variant="body2">
              There is no undo and no way to extend a link later. If these documents still need to
              reach somebody, send them again — that names its own recipients and expiry.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)} disabled={revoking}>
            Keep it
          </Button>
          <Button color="error" variant="contained" onClick={doRevoke} disabled={revoking}>
            {revoking ? 'Revoking…' : 'Revoke now'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
