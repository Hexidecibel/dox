/**
 * /a/:token — Public approval page.
 *
 * No app shell, no auth. Token is the gate. Same Typeform-feel polish as
 * /u/:token and /f/:slug. Two big buttons (Approve / Reject), optional
 * comment, row-context fields rendered read-only above.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  CheckCircleOutline as ApproveIcon,
  CancelOutlined as RejectIcon,
} from '@mui/icons-material';
import { publicApprovalsApi } from '../../lib/recordsApi';
import type { PublicApprovalView } from '../../../shared/types';

const ACCENT = '#1A365D';

export function PublicApprovalPage() {
  const { token } = useParams<{ token: string }>();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [view, setView] = useState<PublicApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittedDecision, setSubmittedDecision] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This approval link is no longer valid.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await publicApprovalsApi.get(token);
        if (cancelled) return;
        setView(v);
        document.title = `Approval: ${v.step.workflow_name}`;
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        if (code === 'not_found') {
          setError('This approval is no longer accepting responses.');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleSubmit = async (decision: 'approve' | 'reject') => {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await publicApprovalsApi.submit(token, { decision, comment: comment.trim() || null });
      setSubmittedDecision(decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

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
            {error ?? 'The approval may have already been resolved or the link expired.'}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (submittedDecision) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: alpha(ACCENT, 0.04),
          p: 2,
        }}
      >
        <Box sx={{ maxWidth: 520, textAlign: 'center' }}>
          {submittedDecision === 'approve' ? (
            <ApproveIcon sx={{ fontSize: 64, color: 'success.main', mb: 2 }} />
          ) : (
            <RejectIcon sx={{ fontSize: 64, color: 'error.main', mb: 2 }} />
          )}
          <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
            Thanks — your decision is recorded.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            You {submittedDecision === 'approve' ? 'approved' : 'rejected'} the
            <Box component="span" sx={{ fontWeight: 600 }}> {view.step.name}</Box> step of
            <Box component="span" sx={{ fontWeight: 600 }}> {view.step.workflow_name}</Box>.
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: alpha(ACCENT, 0.03),
        py: { xs: 4, md: 8 },
        px: 2,
      }}
    >
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
        {/* Header */}
        <Box sx={{ p: { xs: 3, md: 4 }, borderBottom: 1, borderColor: 'divider', bgcolor: ACCENT, color: 'white' }}>
          <Typography variant="caption" sx={{ opacity: 0.85, fontWeight: 600, letterSpacing: 0.5 }}>
            APPROVAL REQUEST
          </Typography>
          <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5, lineHeight: 1.3 }}>
            {view.step.sender_name} needs your sign-off
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.85, mt: 1 }}>
            <Box component="span" sx={{ fontWeight: 600 }}>{view.step.name}</Box>
            {' · '}
            {view.step.workflow_name}
          </Typography>
        </Box>

        {/* Body */}
        <Box sx={{ p: { xs: 3, md: 4 } }}>
          {view.step.message && (
            <Box
              sx={{
                p: 2,
                mb: 3,
                borderLeft: 4,
                borderColor: ACCENT,
                bgcolor: alpha(ACCENT, 0.04),
                fontStyle: 'italic',
              }}
            >
              <Typography variant="body2">"{view.step.message}"</Typography>
            </Box>
          )}

          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 600, letterSpacing: 0.4, mb: 1 }}>
            REVIEWING
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
            {view.row.title || 'Untitled record'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            in {view.row.sheet_name}
          </Typography>

          {view.row.fields.length > 0 && (
            <Box
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: 2,
                mb: 3,
                bgcolor: 'background.default',
              }}
            >
              <Stack spacing={1.5}>
                {view.row.fields.map((f) => (
                  <Stack
                    key={f.key}
                    direction={isMobile ? 'column' : 'row'}
                    spacing={isMobile ? 0.25 : 2}
                    alignItems={isMobile ? 'flex-start' : 'baseline'}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        color: 'text.secondary',
                        fontWeight: 600,
                        letterSpacing: 0.4,
                        textTransform: 'uppercase',
                        minWidth: isMobile ? undefined : 140,
                      }}
                    >
                      {f.label}
                    </Typography>
                    <Typography variant="body2" sx={{ flex: 1, wordBreak: 'break-word' }}>
                      {renderFieldValue(f.value)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          <TextField
            label="Comment (optional)"
            placeholder="Add context for the team — especially helpful when rejecting."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            fullWidth
            multiline
            minRows={3}
            sx={{ mb: 3 }}
            inputProps={{ maxLength: 2000 }}
          />

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <Button
              size="large"
              variant="contained"
              disableElevation
              startIcon={<ApproveIcon />}
              disabled={submitting}
              onClick={() => handleSubmit('approve')}
              sx={{
                flex: 1,
                py: 1.5,
                bgcolor: 'success.main',
                '&:hover': { bgcolor: 'success.dark' },
                fontWeight: 600,
              }}
            >
              Approve
            </Button>
            <Button
              size="large"
              variant="outlined"
              startIcon={<RejectIcon />}
              disabled={submitting}
              onClick={() => handleSubmit('reject')}
              sx={{
                flex: 1,
                py: 1.5,
                borderColor: 'error.main',
                color: 'error.main',
                fontWeight: 600,
                '&:hover': { borderColor: 'error.dark', bgcolor: alpha('#d32f2f', 0.04) },
              }}
            >
              Reject
            </Button>
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}

function renderFieldValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : JSON.stringify(v)))
      .join(', ');
  }
  if (typeof value === 'object' && value && 'name' in value) {
    return String((value as { name: unknown }).name);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
