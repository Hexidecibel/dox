/**
 * /u/:token — Recipient view for a Records update request.
 *
 * No app shell, no nav, no auth. Mounted outside ProtectedRoute in
 * App.tsx. The token in the URL is the gate; tokens are 32 random bytes
 * encoded as base64url.
 *
 * Visual reuse: same one-question-at-a-time Typeform-feel as
 * /f/<slug> via PublicFormRenderer's exported FieldStep / SuccessScreen
 * / isFieldEmpty helpers. We don't reuse the full renderer because the
 * update flow differs in three ways:
 *   1. No Turnstile (token IS the gate).
 *   2. No file uploads (deferred for v1; spec calls this out).
 *   3. Pre-filled current values + a "Sender asked you to update X"
 *      header so the recipient understands the context.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  LinearProgress,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  ArrowForward as NextIcon,
} from '@mui/icons-material';
import { publicUpdateRequestsApi } from '../../lib/recordsApi';
import {
  FieldStep,
  SuccessScreen,
  isFieldEmpty,
} from '../../components/forms/PublicFormRenderer';
import type {
  PublicUpdateRequestView,
  RecordRowData,
} from '../../../shared/types';

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; fieldsUpdated: number }
  | { kind: 'error'; message: string };

const ACCENT = '#1A365D';

function formatFriendlyDate(iso: string): string {
  try {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function UpdateRequestForm() {
  const { token } = useParams<{ token: string }>();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [view, setView] = useState<PublicUpdateRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The form data starts as a copy of current_values — recipient sees
  // the existing values pre-filled and edits in place.
  const [data, setData] = useState<RecordRowData>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [stepKey, setStepKey] = useState(0);
  const [state, setState] = useState<FormState>({ kind: 'idle' });
  const [stepError, setStepError] = useState<string | null>(null);

  // ---- Initial fetch ----
  useEffect(() => {
    if (!token) {
      setError('This request is no longer accepting updates.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await publicUpdateRequestsApi.get(token);
        if (cancelled) return;
        setView(v);
        setData({ ...v.current_values });
        document.title = `Update: ${v.request.sheet_name}`;
      } catch (err) {
        if (cancelled) return;
        const code = (err as { code?: string }).code;
        setError(
          code === 'not_found'
            ? 'This request is no longer accepting updates.'
            : 'We couldn’t load this request. Please try again.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const fields = view?.fields ?? [];
  const totalSteps = fields.length + 1; // +1 for review/submit
  const currentField = stepIndex < fields.length ? fields[stepIndex] : null;
  const isReviewStep = !currentField;

  const setValue = useCallback((key: string, value: unknown) => {
    setData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const goNext = useCallback(() => {
    setStepError(null);
    setStepIndex((s) => Math.min(s + 1, totalSteps - 1));
    setStepKey((k) => k + 1);
  }, [totalSteps]);

  const goBack = useCallback(() => {
    setStepError(null);
    setStepIndex((s) => Math.max(s - 1, 0));
    setStepKey((k) => k + 1);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!token) return;
    // Final required-field sweep so the recipient sees a clean error
    // before we hit the server.
    for (const f of fields) {
      if (f.required && isFieldEmpty(data[f.key])) {
        setStepError(`"${f.label}" is required.`);
        return;
      }
    }
    setState({ kind: 'submitting' });
    try {
      const res = await publicUpdateRequestsApi.submit(token, { data });
      setState({ kind: 'success', fieldsUpdated: res.fields_updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Submission failed.';
      setState({ kind: 'error', message: msg });
    }
  }, [token, fields, data]);

  const isCurrentValid = useMemo(() => {
    if (!currentField) return true;
    if (!currentField.required) return true;
    return !isFieldEmpty(data[currentField.key]);
  }, [currentField, data]);

  // ---- Render branches ----

  if (loading) {
    return (
      <Box
        sx={{
          minHeight: { xs: '100dvh', md: '100vh' },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.paper',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !view) {
    return <UnavailableScreen message={error ?? 'This request is no longer accepting updates.'} />;
  }

  if (state.kind === 'success') {
    return (
      <SuccessScreen
        accent={ACCENT}
        thankYou={`Your updates have been recorded${state.fieldsUpdated > 0 ? ` (${state.fieldsUpdated} field${state.fieldsUpdated === 1 ? '' : 's'})` : ''}. The team will be notified.`}
        redirect={null}
        title="Thanks!"
      />
    );
  }

  const senderLabel = view.request.sender_name || 'A teammate';
  const rowLabel = view.request.row_title?.trim() || 'this row';

  return (
    <Box
      sx={{
        minHeight: { xs: '100dvh', md: '100vh' },
        bgcolor: 'background.paper',
        color: 'text.primary',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Progress bar */}
      <Box
        sx={{
          height: 3,
          bgcolor: alpha(ACCENT, 0.08),
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            height: '100%',
            width: `${((stepIndex + 1) / totalSteps) * 100}%`,
            bgcolor: ACCENT,
            transition: 'width 300ms ease-out',
          }}
        />
      </Box>

      {/* Header */}
      <Box
        sx={{
          px: { xs: 3, md: 6 },
          pt: { xs: 2, md: 3 },
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          minHeight: 56,
        }}
      >
        {stepIndex > 0 && (
          <IconButton
            aria-label="Previous question"
            onClick={goBack}
            size="small"
            sx={{ color: alpha(ACCENT, 0.7), minWidth: 44, minHeight: 44 }}
          >
            <BackIcon />
          </IconButton>
        )}
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            flex: 1,
            letterSpacing: 0.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {view.request.sheet_name}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {Math.min(stepIndex + 1, totalSteps)} / {totalSteps}
        </Typography>
      </Box>

      {/* Step body */}
      <Box
        key={stepKey}
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          px: { xs: 3, md: 6 },
          py: { xs: 4, md: 6 },
          maxWidth: 720,
          width: '100%',
          mx: 'auto',
          animation: 'fadeSlideUp 300ms ease-out both',
          '@keyframes fadeSlideUp': {
            from: { opacity: 0, transform: 'translateY(16px)' },
            to: { opacity: 1, transform: 'translateY(0)' },
          },
        }}
      >
        {/* Sender pitch banner — only on the first field step. The reviewer
            screen has its own framing so we don't duplicate it. */}
        {stepIndex === 0 && currentField && (
          <Box sx={{ mb: 4 }}>
            <Typography
              sx={{
                fontSize: { xs: 13, md: 14 },
                color: 'text.secondary',
                letterSpacing: 0.3,
                textTransform: 'uppercase',
                fontWeight: 600,
                mb: 1,
              }}
            >
              Update request
            </Typography>
            <Typography
              sx={{
                fontSize: { xs: 18, md: 22 },
                fontWeight: 500,
                lineHeight: 1.4,
                color: 'text.primary',
              }}
            >
              <Box component="span" sx={{ fontWeight: 600 }}>{senderLabel}</Box>
              {' asked you to update fields on '}
              <Box component="span" sx={{ fontWeight: 600 }}>{rowLabel}</Box>.
            </Typography>
            {view.request.message && (
              <Typography
                sx={{
                  mt: 1.5,
                  fontStyle: 'italic',
                  color: 'text.secondary',
                  fontSize: { xs: 14, md: 15 },
                  borderLeft: 3,
                  borderColor: alpha(ACCENT, 0.3),
                  pl: 1.5,
                  py: 0.5,
                }}
              >
                "{view.request.message}"
              </Typography>
            )}
            {view.request.due_date && (
              <Typography
                sx={{ mt: 1.5, color: 'text.secondary', fontSize: 14 }}
              >
                Response requested by{' '}
                <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                  {formatFriendlyDate(view.request.due_date)}
                </Box>
                .
              </Typography>
            )}
          </Box>
        )}

        {currentField ? (
          <Box>
            <FieldStep
              field={currentField}
              value={data[currentField.key]}
              onChange={(v) => setValue(currentField.key, v)}
              onSubmit={() => {
                if (currentField.required && isFieldEmpty(data[currentField.key])) {
                  setStepError(`"${currentField.label}" is required.`);
                  return;
                }
                goNext();
              }}
              isMobile={isMobile}
              accent={ACCENT}
            />
            {/* Show the row's previous value as a hint so the recipient
                understands what they're editing. Only show when there's
                a meaningful current value. */}
            {!isFieldEmpty(view.current_values[currentField.key]) && (
              <Typography
                sx={{
                  mt: 1.5,
                  fontSize: 13,
                  color: 'text.disabled',
                }}
              >
                Current value: {formatCurrentValue(view.current_values[currentField.key])}
              </Typography>
            )}
          </Box>
        ) : (
          <ReviewBlock
            view={view}
            data={data}
            senderLabel={senderLabel}
            rowLabel={rowLabel}
          />
        )}

        {stepError && (
          <Typography sx={{ mt: 2, color: '#9A1F1F', fontSize: 14, fontWeight: 500 }}>
            {stepError}
          </Typography>
        )}
        {state.kind === 'error' && (
          <Typography sx={{ mt: 2, color: '#9A1F1F', fontSize: 14, fontWeight: 500 }}>
            {state.message}
          </Typography>
        )}
      </Box>

      {/* Sticky bottom bar */}
      <Box
        sx={{
          position: 'sticky',
          bottom: 0,
          bgcolor: 'background.paper',
          borderTop: 1,
          borderColor: 'divider',
          px: { xs: 2, md: 6 },
          py: { xs: 1.5, md: 2 },
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <Box sx={{ flex: 1 }} />
        {isReviewStep ? (
          <Button
            variant="contained"
            disableElevation
            disabled={state.kind === 'submitting'}
            onClick={handleSubmit}
            sx={{
              bgcolor: ACCENT,
              color: '#fff',
              fontWeight: 600,
              fontSize: 16,
              px: 4,
              py: 1.5,
              minHeight: 48,
              '&:hover': { bgcolor: alpha(ACCENT, 0.85) },
            }}
          >
            {state.kind === 'submitting' ? (
              <CircularProgress size={20} sx={{ color: '#fff' }} />
            ) : (
              'Submit updates'
            )}
          </Button>
        ) : (
          <Button
            variant="contained"
            disableElevation
            disabled={!isCurrentValid}
            endIcon={<NextIcon />}
            onClick={() => {
              if (currentField?.required && isFieldEmpty(data[currentField.key])) {
                setStepError(`"${currentField.label}" is required.`);
                return;
              }
              goNext();
            }}
            sx={{
              bgcolor: ACCENT,
              color: '#fff',
              fontWeight: 600,
              fontSize: 16,
              px: 4,
              py: 1.5,
              minHeight: 48,
              '&:hover': { bgcolor: alpha(ACCENT, 0.85) },
            }}
          >
            Next
          </Button>
        )}
      </Box>

      {/* Indeterminate bar at top during submit so the recipient sees
          something is happening even before the success screen lands. */}
      {state.kind === 'submitting' && (
        <LinearProgress
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            bgcolor: alpha(ACCENT, 0.08),
            '& .MuiLinearProgress-bar': { bgcolor: ACCENT },
          }}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------
// Review block — recipient sees their proposed values vs. current row
// values side-by-side, plus a final summary.
// ---------------------------------------------------------------------

interface ReviewBlockProps {
  view: PublicUpdateRequestView;
  data: RecordRowData;
  senderLabel: string;
  rowLabel: string;
}

function ReviewBlock({ view, data, senderLabel, rowLabel }: ReviewBlockProps) {
  return (
    <Box>
      <Typography sx={{ fontSize: { xs: 28, md: 36 }, fontWeight: 600, letterSpacing: -0.5, mb: 1 }}>
        Review and send
      </Typography>
      <Typography sx={{ color: 'text.secondary', mb: 4, fontSize: { xs: 14, md: 16 } }}>
        Confirm your updates below. {senderLabel} will be notified once you submit.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
        {view.fields.map((f) => {
          const next = data[f.key];
          const previous = view.current_values[f.key];
          const changed =
            JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null);
          return (
            <Box
              key={f.key}
              sx={{
                pb: 1.5,
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'text.secondary',
                  mb: 0.5,
                }}
              >
                {f.label}
              </Typography>
              {changed ? (
                <Typography sx={{ fontSize: 16, color: 'text.primary' }}>
                  <Box component="span" sx={{ color: 'text.disabled', textDecoration: 'line-through', mr: 1 }}>
                    {formatCurrentValue(previous) || '(blank)'}
                  </Box>
                  {formatCurrentValue(next) || '(blank)'}
                </Typography>
              ) : (
                <Typography sx={{ fontSize: 16, color: 'text.disabled' }}>
                  {formatCurrentValue(next) || '(blank)'} (unchanged)
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>

      <Typography sx={{ fontSize: 13, color: 'text.disabled' }}>
        Submitting will update <Box component="span" sx={{ fontWeight: 600, color: 'text.secondary' }}>{rowLabel}</Box>.
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------
// Polished "no longer accepting updates" page.
// ---------------------------------------------------------------------

function UnavailableScreen({ message }: { message: string }) {
  return (
    <Box
      sx={{
        minHeight: { xs: '100dvh', md: '100vh' },
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.paper',
        textAlign: 'center',
        px: 3,
      }}
    >
      <Box sx={{ maxWidth: 460 }}>
        <Typography
          sx={{
            fontSize: { xs: 28, md: 34 },
            fontWeight: 600,
            letterSpacing: -0.4,
            color: 'text.primary',
            mb: 1.5,
            lineHeight: 1.2,
          }}
        >
          This request isn’t available
        </Typography>
        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: { xs: 15, md: 16 },
            lineHeight: 1.6,
          }}
        >
          {message} If you think this is a mistake, reach back out to whoever sent you the link.
        </Typography>
      </Box>
    </Box>
  );
}

/** Render a row value as a one-line preview; mirrors PublicFormRenderer.formatPreview. */
function formatCurrentValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .map((v) => formatCurrentValue(v))
      .filter((s) => !!s)
      .join(', ');
  }
  if (typeof value === 'object') {
    const obj = value as { id?: string; name?: string; label?: string };
    return obj.name || obj.label || obj.id || '';
  }
  return String(value);
}
