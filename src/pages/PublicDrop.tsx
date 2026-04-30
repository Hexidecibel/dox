/**
 * /drop/:slug/:token — Phase B4 public drop page.
 *
 * Anonymous, no app shell, no auth. The route is mounted OUTSIDE the
 * ProtectedRoute boundary in App.tsx so vendors with the link can land
 * here without being redirected to /login.
 *
 * Flow:
 *   1. Mount fires GET /api/public/connectors/:slug?token=<token> to
 *      fetch the connector + tenant name + accepted-extensions list.
 *      A 404 from that endpoint means the link is wrong, expired, or
 *      revoked — we render the "not active" state and stop.
 *   2. The drag-drop zone accepts a single file. On submit (or
 *      auto-submit on drop) we POST to
 *      /api/connectors/:slug/drop with `Authorization: Bearer <token>`
 *      so the link token never appears in the URL we POST against,
 *      and the existing Phase B2 drop endpoint handles the body.
 *   3. Success / error states render inline with no nav, so the vendor
 *      can drop another file or close the tab.
 *
 * Deliberately no metadata fields, no email collection, no login. The
 * link itself is the auth and the vendor knows what they're sending.
 */

import { useEffect, useMemo, useState, useCallback, type DragEvent } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  CheckCircle as CheckIcon,
  ErrorOutline as ErrorIcon,
} from '@mui/icons-material';

interface PublicConnectorInfo {
  connector: { name: string; slug: string | null };
  tenant: { name: string | null };
  accepted_extensions: readonly string[];
  max_size_bytes: { text: number; binary: number };
  expires_at: number | null;
}

type Status = 'loading' | 'idle' | 'uploading' | 'success' | 'error' | 'not-active';

export function PublicDrop() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const [info, setInfo] = useState<PublicConnectorInfo | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string>('');

  // Initial load: fetch the connector info via the gated public endpoint.
  // Failure here means link not active — we don't differentiate between
  // "no such connector", "wrong token", "expired", or "revoked".
  useEffect(() => {
    if (!slug || !token) {
      setStatus('not-active');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/public/connectors/${encodeURIComponent(slug)}?token=${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setStatus('not-active');
          return;
        }
        const data = (await res.json()) as PublicConnectorInfo;
        setInfo(data);
        setStatus('idle');
        document.title = `Upload to ${data.connector.name}`;
      } catch {
        if (!cancelled) setStatus('not-active');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, token]);

  const acceptedExtsAttr = useMemo(
    () => (info ? info.accepted_extensions.join(',') : ''),
    [info],
  );
  const acceptedExtsHuman = useMemo(
    () => (info ? info.accepted_extensions.join(', ') : ''),
    [info],
  );

  const submitFile = useCallback(
    async (file: File) => {
      if (!slug || !token) return;
      setStatus('uploading');
      setUploadedFileName(file.name);
      setErrorMessage('');
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/connectors/${encodeURIComponent(slug)}/drop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) {
          let msg = `Upload failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) msg = body.error;
          } catch {
            /* fall through with the default message */
          }
          setErrorMessage(msg);
          setStatus('error');
          return;
        }
        setStatus('success');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Upload failed');
        setStatus('error');
      }
    },
    [slug, token],
  );

  const handleFiles = useCallback(
    (files: FileList | null | undefined) => {
      if (!files || files.length === 0) return;
      void submitFile(files[0]);
    },
    [submitFile],
  );

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (status === 'uploading') return;
    handleFiles(e.dataTransfer.files);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === 'uploading') return;
    setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const reset = () => {
    setStatus('idle');
    setErrorMessage('');
    setUploadedFileName('');
  };

  return (
    <Box
      sx={{
        minHeight: { xs: '100dvh', md: '100vh' },
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: { xs: 2, md: 4 },
      }}
    >
      <Paper
        elevation={3}
        sx={{
          width: '100%',
          maxWidth: 560,
          p: { xs: 3, md: 5 },
          borderRadius: 2,
        }}
      >
        {/* Loading */}
        {status === 'loading' && (
          <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
            <CircularProgress />
            <Typography color="text.secondary">Loading…</Typography>
          </Stack>
        )}

        {/* Not active */}
        {status === 'not-active' && (
          <Stack alignItems="center" spacing={2} sx={{ py: 4, textAlign: 'center' }}>
            <ErrorIcon color="warning" sx={{ fontSize: 48 }} />
            <Typography variant="h5" fontWeight={600}>
              This link is no longer active
            </Typography>
            <Typography color="text.secondary">
              It may have been revoked or expired. Contact the connector owner
              for a new one.
            </Typography>
          </Stack>
        )}

        {/* Active states (idle / uploading / success / error) all share the header */}
        {info && status !== 'loading' && status !== 'not-active' && (
          <>
            <Box sx={{ textAlign: 'center', mb: 3 }}>
              <Typography variant="overline" color="text.secondary">
                Upload to
              </Typography>
              <Typography variant="h4" fontWeight={700} sx={{ mt: 0.5 }}>
                {info.connector.name}
              </Typography>
              {info.tenant.name && (
                <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                  {info.tenant.name}
                </Typography>
              )}
            </Box>

            {status === 'idle' || status === 'uploading' || status === 'error' ? (
              <Box>
                <Box
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => {
                    if (status === 'uploading') return;
                    const input = document.getElementById(
                      'public-drop-file-input',
                    ) as HTMLInputElement | null;
                    input?.click();
                  }}
                  sx={{
                    border: '2px dashed',
                    borderColor: dragActive ? 'primary.main' : 'divider',
                    bgcolor: dragActive ? 'action.hover' : 'background.paper',
                    borderRadius: 2,
                    p: { xs: 4, md: 6 },
                    textAlign: 'center',
                    cursor: status === 'uploading' ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                    '&:hover': {
                      borderColor: status === 'uploading' ? 'divider' : 'primary.main',
                      bgcolor: status === 'uploading' ? 'background.paper' : 'action.hover',
                    },
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label="Drop a file here or click to pick"
                >
                  {status === 'uploading' ? (
                    <Stack alignItems="center" spacing={1.5}>
                      <CircularProgress size={36} />
                      <Typography>
                        Uploading {uploadedFileName}…
                      </Typography>
                    </Stack>
                  ) : (
                    <Stack alignItems="center" spacing={1}>
                      <UploadIcon
                        sx={{ fontSize: 48, color: 'text.secondary' }}
                      />
                      <Typography variant="h6">
                        Drop a file here, or click to browse
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Accepted: {acceptedExtsHuman}
                      </Typography>
                    </Stack>
                  )}
                </Box>
                <input
                  id="public-drop-file-input"
                  type="file"
                  accept={acceptedExtsAttr}
                  onChange={(e) => handleFiles(e.target.files)}
                  style={{ display: 'none' }}
                  aria-hidden="true"
                  tabIndex={-1}
                />

                {status === 'error' && errorMessage && (
                  <Alert
                    severity="error"
                    sx={{ mt: 3 }}
                    action={
                      <Button color="inherit" size="small" onClick={reset}>
                        Try again
                      </Button>
                    }
                  >
                    {errorMessage}
                  </Alert>
                )}
              </Box>
            ) : null}

            {status === 'success' && (
              <Stack alignItems="center" spacing={2} sx={{ py: 3, textAlign: 'center' }}>
                <CheckIcon color="success" sx={{ fontSize: 56 }} />
                <Typography variant="h5" fontWeight={600}>
                  File received
                </Typography>
                <Typography color="text.secondary">
                  Thanks — {uploadedFileName} is in the queue.
                </Typography>
                <Button variant="outlined" onClick={reset} sx={{ mt: 1 }}>
                  Upload another
                </Button>
              </Stack>
            )}
          </>
        )}
      </Paper>
    </Box>
  );
}
