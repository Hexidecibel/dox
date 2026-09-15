/**
 * /export/:token — the page an "here are the documents you asked for" email
 * points at.
 *
 * The recipient is a customer or a salesperson who will never have an account.
 * They see the list that was sent, they take the zip or one file, and that is
 * the whole surface: no app shell, no nav, no search, no way to reach a
 * document that was not in the email.
 *
 * The server decides what may be shown (functions/lib/document-export.ts).
 * This component only renders the allow-listed payload, and addresses files by
 * the `index` the server handed it — never by a document id, because it never
 * receives one.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import type { DocumentExportLandingView } from '../../shared/types';

const ACCENT = '#1A365D';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function ExportLanding() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<DocumentExportLandingView | null>(null);
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
        const res = await fetch(`/api/document-exports/public/${encodeURIComponent(token)}`);
        if (!res.ok) {
          throw Object.assign(new Error('unavailable'), {
            code: res.status === 429 ? 'rate_limited' : 'not_found',
          });
        }
        const v = (await res.json()) as DocumentExportLandingView;
        if (cancelled) return;
        setView(v);
        document.title = `${v.documents.length} document${v.documents.length === 1 ? '' : 's'} from ${v.tenant_name}`;
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setError(
          code === 'rate_limited'
            ? 'Too many requests from this connection. Try again in a little while.'
            : 'This link has expired or is no longer active. Ask whoever sent it for a new one.',
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
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !view) {
    return (
      <Box sx={{ maxWidth: 640, mx: 'auto', px: 3, py: 8 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          Documents unavailable
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {error}
        </Typography>
      </Box>
    );
  }

  const sentBy = view.sent_by_name ?? view.sent_by_email ?? 'Someone';
  const zipUrl = `/api/document-exports/public/${encodeURIComponent(token ?? '')}/download`;

  return (
    <Box sx={{ maxWidth: 820, mx: 'auto', px: { xs: 2, sm: 3 }, py: { xs: 4, sm: 6 } }}>
      <Typography variant="overline" sx={{ color: ACCENT, fontWeight: 700, letterSpacing: 1 }}>
        {view.tenant_name}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
        {view.documents.length} document{view.documents.length === 1 ? '' : 's'}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Sent by {sentBy}
        {view.on_behalf_of ? ` on behalf of ${view.on_behalf_of}` : ''}. This link works until{' '}
        {formatDate(view.expires_at)}.
      </Typography>

      {view.message && (
        <Box
          sx={{
            mt: 2,
            p: 2,
            borderLeft: '3px solid',
            borderColor: ACCENT,
            bgcolor: 'action.hover',
            whiteSpace: 'pre-wrap',
          }}
        >
          <Typography variant="body2">{view.message}</Typography>
        </Box>
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 3, mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<DownloadIcon />}
          href={zipUrl}
          sx={{ textTransform: 'none', bgcolor: ACCENT }}
          data-testid="export-landing-zip"
        >
          Download all as ZIP
        </Button>
      </Stack>

      <Divider sx={{ mb: 1 }} />

      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 700 }}>Document</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>Supplier</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>Lot</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">
              File
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {view.documents.map((d) => (
            <TableRow key={d.index}>
              <TableCell>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {d.title}
                </Typography>
                {d.document_type_name && (
                  <Typography variant="caption" color="text.secondary">
                    {d.document_type_name}
                    {d.production_date ? ` · produced ${formatDate(d.production_date)}` : ''}
                  </Typography>
                )}
              </TableCell>
              <TableCell>{d.supplier_name ?? '—'}</TableCell>
              <TableCell>{d.lot_label ?? '—'}</TableCell>
              <TableCell align="right">
                <Button
                  size="small"
                  href={`/api/document-exports/public/${encodeURIComponent(token ?? '')}/file/${d.index}`}
                  sx={{ textTransform: 'none' }}
                >
                  {d.file_name}
                </Button>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {formatSize(d.file_size)}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>
        Shared through SupDox. Reply to the email that brought you here to reach {sentBy}.
      </Typography>
    </Box>
  );
}
