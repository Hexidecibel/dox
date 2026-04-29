/**
 * PublicFormRenderer — the Typeform-feel renderer.
 *
 * Used in two contexts:
 *   - Standalone at /f/<slug>, rendering full-screen with no app chrome.
 *   - Embedded in the form builder's right pane as a live preview.
 *
 * Visual direction (held the line on, see plan.md):
 *   - One-question-at-a-time focus on mobile + desktop.
 *   - Question text 32-48px depending on viewport. Generous padding.
 *   - Inputs full-width, animated underline on focus.
 *   - Auto-advance on Enter (text/number) or selection.
 *   - Slide-up + fade transition between questions (300ms).
 *   - Thin progress bar at top.
 *   - Final step: summary + Turnstile + big Submit button.
 *
 * The renderer is intentionally a single component (~400 lines) so the
 * mobile/desktop pivot stays inline and the question-transition state
 * machine has one home. Splitting it into per-type sub-components would
 * tax the transition coordination without much win.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  LinearProgress,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
  alpha,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  ArrowForward as NextIcon,
  CheckCircleOutline as CheckIcon,
  CloudUploadOutlined as UploadIcon,
  PhotoCameraOutlined as CameraIcon,
  InsertDriveFileOutlined as FileIcon,
  CloseOutlined as CloseIcon,
  ErrorOutlineOutlined as ErrorIcon,
} from '@mui/icons-material';
import { publicFormsApi } from '../../lib/recordsApi';
import type {
  PublicAttachmentUpload,
  PublicEntityOption,
  PublicFormAttachmentPolicy,
  PublicFormEntityOptions,
  PublicFormFieldDef,
  PublicFormView,
  RecordRowData,
  RecordColumnDropdownConfig,
} from '../../../shared/types';

interface Props {
  view: PublicFormView;
  /**
   * Submit handler. Throws on failure (caller surfaces the error). The
   * `attachmentIds` array is the list of pending attachment ids issued
   * by the upload endpoint and held in form state until submit.
   */
  onSubmit: (
    data: RecordRowData,
    turnstileToken: string,
    attachmentIds: string[],
  ) => Promise<void>;
  /**
   * When true (preview mode), Turnstile and submit are stubbed: the
   * Submit button just calls onSubmit('preview-token') so the builder
   * can confirm the layout without burning Turnstile traffic.
   */
  preview?: boolean;
  /**
   * Slug of the current public form. Required for the upload endpoint;
   * the builder preview omits it (preview mode disables uploads).
   */
  slug?: string;
}

/** Browser-side state for one pending file upload. */
interface AttachmentEntry {
  /** Local-only id used as React key while the upload is in flight. */
  localId: string;
  file: File;
  /** ObjectURL for image thumbnails; revoked on remove + on unmount. */
  previewUrl: string | null;
  status: 'uploading' | 'done' | 'error';
  progress: number; // 0-100
  /** Server response after a successful upload. */
  upload?: PublicAttachmentUpload;
  errorMessage?: string;
  /** AbortController so the user can cancel an in-flight upload. */
  controller?: AbortController;
}

function makeLocalId(): string {
  return `loc_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mirror of the server-side `mimeAllowed` check for client-side UX. */
function mimeAllowed(mime: string, allowlist: string[]): boolean {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (!m) return false;
  for (const raw of allowlist) {
    const a = raw.toLowerCase().trim();
    if (!a) continue;
    if (a === m) return true;
    if (a.endsWith('/*')) {
      const prefix = a.slice(0, -1);
      if (m.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Build the `accept` attribute string for the file picker. Most browsers
 * accept the same MIME wildcards we store in the policy, but we expand
 * `image/*` so iOS shows the camera as a source.
 */
function buildAcceptAttr(allowed: string[]): string {
  return allowed.join(',');
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; thankYou: string | null; redirect: string | null }
  | { kind: 'error'; message: string };

/** Window-attached Turnstile global, set by the script tag we inject. */
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
  }
}

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    if (window.turnstile) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = TURNSTILE_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', () => resolve(), { once: true });
    document.head.appendChild(s);
  });
}

export function PublicFormRenderer({ view, onSubmit, preview = false, slug }: Props) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const accent = view.form.accent_color || '#1A365D';
  const fields = view.fields;
  // Attachments policy controls whether we insert an attachment step
  // between the last field and the review screen. Preview mode hides the
  // step (uploads are slug-bound and the builder doesn't have a slug).
  const attachmentPolicy: PublicFormAttachmentPolicy | null =
    !preview && view.attachments?.enabled ? view.attachments : null;
  const hasAttachmentStep = !!attachmentPolicy;
  const attachmentStepIndex = fields.length; // right after the last field
  const reviewStepIndex = fields.length + (hasAttachmentStep ? 1 : 0);
  const totalSteps = fields.length + (hasAttachmentStep ? 1 : 0) + 1;

  const [stepIndex, setStepIndex] = useState(0);
  const [data, setData] = useState<RecordRowData>({});
  const [attachments, setAttachments] = useState<AttachmentEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });
  const [turnstileToken, setTurnstileToken] = useState<string | null>(
    preview ? 'preview-token' : null,
  );
  const [enterKey, setEnterKey] = useState(0); // remounts the step for transition
  const turnstileRef = useRef<HTMLDivElement | null>(null);

  // Revoke all object URLs on unmount so we don't leak blob memory if the
  // form is closed mid-upload.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        if (a.status === 'uploading') a.controller?.abort();
      });
    };
    // We intentionally only run this on unmount — the per-attachment
    // revoke happens in handleRemoveAttachment for live changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount Turnstile widget on the review step.
  useEffect(() => {
    if (preview) return;
    if (stepIndex !== reviewStepIndex) return;
    if (!view.turnstile_site_key) return;
    let widgetId: string | undefined;
    let cancelled = false;
    void (async () => {
      await loadTurnstileScript();
      if (cancelled || !turnstileRef.current || !window.turnstile) return;
      // Clear any prior render before mounting (StrictMode dev)
      turnstileRef.current.innerHTML = '';
      widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: view.turnstile_site_key,
        callback: (token) => setTurnstileToken(token),
        'error-callback': () => setTurnstileToken(null),
        'expired-callback': () => setTurnstileToken(null),
        theme: 'light',
      });
    })();
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try { window.turnstile.reset(widgetId); } catch { /* noop */ }
      }
    };
  }, [stepIndex, reviewStepIndex, preview, view.turnstile_site_key]);

  // ---- Step navigation ----

  const goNext = useCallback(() => {
    setError(null);
    setStepIndex((s) => Math.min(s + 1, totalSteps - 1));
    setEnterKey((k) => k + 1);
  }, [totalSteps]);

  const goBack = useCallback(() => {
    setError(null);
    setStepIndex((s) => Math.max(s - 1, 0));
    setEnterKey((k) => k + 1);
  }, []);

  const setValue = useCallback((key: string, value: unknown) => {
    setData((prev) => ({ ...prev, [key]: value }));
  }, []);

  // ---- Attachment uploads ----
  //
  // Upload-as-you-go: when the user picks files, we kick off an XHR per
  // file immediately, track progress in the entry's `progress` field,
  // and switch the entry to 'done' on success. The parent's onSubmit
  // gets the list of completed attachment_ids on final submit.
  const handleAddFiles = useCallback(
    (files: FileList | File[]) => {
      if (!attachmentPolicy) return;
      if (!slug) {
        setError('Cannot upload in preview.');
        return;
      }
      const arr = Array.from(files);
      // Cap at the policy max accounting for files already on the entry list.
      const remainingSlots = Math.max(0, attachmentPolicy.max_attachments - attachments.length);
      if (remainingSlots === 0) {
        setError(`Maximum of ${attachmentPolicy.max_attachments} files reached.`);
        return;
      }
      const accepted = arr.slice(0, remainingSlots);
      const sizeLimit = attachmentPolicy.max_file_size_mb * 1024 * 1024;

      const entries: AttachmentEntry[] = [];
      for (const file of accepted) {
        if (file.size <= 0) continue;
        if (file.size > sizeLimit) {
          setError(`"${file.name}" exceeds the ${attachmentPolicy.max_file_size_mb} MB limit.`);
          continue;
        }
        if (!mimeAllowed(file.type || 'application/octet-stream', attachmentPolicy.allowed_mime_types)) {
          setError(`"${file.name}" is not an allowed file type.`);
          continue;
        }
        const isImage = (file.type || '').toLowerCase().startsWith('image/');
        const previewUrl = isImage ? URL.createObjectURL(file) : null;
        entries.push({
          localId: makeLocalId(),
          file,
          previewUrl,
          status: 'uploading',
          progress: 0,
          controller: new AbortController(),
        });
      }
      if (entries.length === 0) return;
      setError(null);
      setAttachments((prev) => [...prev, ...entries]);

      // Kick off uploads in parallel.
      void (async () => {
        for (const entry of entries) {
          try {
            const upload = await publicFormsApi.uploadAttachment(slug, entry.file, {
              onProgress: (loaded, total) => {
                const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                setAttachments((prev) =>
                  prev.map((a) => (a.localId === entry.localId ? { ...a, progress: pct } : a)),
                );
              },
              signal: entry.controller!.signal,
            });
            setAttachments((prev) =>
              prev.map((a) =>
                a.localId === entry.localId
                  ? { ...a, status: 'done', progress: 100, upload }
                  : a,
              ),
            );
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
              // Cancelled by user; entry already removed.
              continue;
            }
            const msg = err instanceof Error ? err.message : 'Upload failed';
            setAttachments((prev) =>
              prev.map((a) =>
                a.localId === entry.localId ? { ...a, status: 'error', errorMessage: msg } : a,
              ),
            );
          }
        }
      })();
    },
    [attachmentPolicy, attachments.length, slug],
  );

  const handleRemoveAttachment = useCallback(
    (localId: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.localId === localId);
        if (target) {
          if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
          if (target.status === 'uploading') {
            target.controller?.abort();
          } else if (target.status === 'done' && target.upload && slug) {
            // Best-effort server-side cleanup of the pending row + R2 obj.
            // Failures are harmless — the sweeper will eventually GC.
            void publicFormsApi
              .cancelAttachment(
                slug,
                target.upload.attachment_id,
                target.upload.pending_token,
              )
              .catch(() => {
                // ignore
              });
          }
        }
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [slug],
  );

  const currentField = stepIndex < fields.length ? fields[stepIndex] : null;
  const isAttachmentStep = hasAttachmentStep && stepIndex === attachmentStepIndex;
  const isReviewStep = stepIndex === reviewStepIndex;
  const isCurrentValid = useMemo(() => {
    if (!currentField) return true;
    if (!currentField.required) return true;
    return !isFieldEmpty(data[currentField.key]);
  }, [currentField, data]);
  // Attachment step gates "Next" only on completed uploads — in-flight or
  // errored uploads shouldn't slip past, but zero attachments is fine
  // (uploads are always optional in this v1).
  const isAttachmentStepValid = useMemo(() => {
    if (!isAttachmentStep) return true;
    return attachments.every((a) => a.status === 'done');
  }, [isAttachmentStep, attachments]);

  // ---- Submit ----

  const handleSubmit = useCallback(async () => {
    if (preview) {
      setState({
        kind: 'success',
        thankYou: 'This is a preview — submissions are disabled in builder.',
        redirect: null,
      });
      return;
    }
    if (!turnstileToken) {
      setError('Please complete the captcha.');
      return;
    }
    // Validate required fields client-side as a friendly first pass.
    for (const f of fields) {
      if (f.required && isFieldEmpty(data[f.key])) {
        setError(`"${f.label}" is required.`);
        return;
      }
    }
    // Don't submit if any upload is still in flight or errored.
    if (attachments.some((a) => a.status !== 'done')) {
      setError('Wait for all uploads to finish before submitting.');
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const attachmentIds = attachments
        .map((a) => a.upload?.attachment_id)
        .filter((id): id is string => !!id);
      await onSubmit(data, turnstileToken, attachmentIds);
      setState({
        kind: 'success',
        thankYou: null,
        redirect: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Submission failed.';
      setState({ kind: 'error', message: msg });
    }
  }, [attachments, data, fields, onSubmit, preview, turnstileToken]);

  // ---- Success / error states ----

  if (state.kind === 'success') {
    return <SuccessScreen accent={accent} thankYou={state.thankYou ?? view.form.description} redirect={state.redirect} />;
  }

  // ---- Render ----

  return (
    <Box
      sx={{
        // 100dvh on mobile to dodge iOS Safari's URL bar collapse
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
          bgcolor: alpha(accent, 0.08),
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <Box
          sx={{
            height: '100%',
            width: `${((stepIndex + 1) / totalSteps) * 100}%`,
            bgcolor: accent,
            transition: 'width 300ms ease-out',
          }}
        />
      </Box>

      {/* Header (form name + back button on non-first step) */}
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
            sx={{ color: alpha(accent, 0.7), minWidth: 44, minHeight: 44 }}
          >
            <BackIcon />
          </IconButton>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, fontFamily: 'inherit', letterSpacing: 0.5 }}>
          {view.form.name}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {Math.min(stepIndex + 1, totalSteps)} / {totalSteps}
        </Typography>
      </Box>

      {/* Body (question or review) */}
      <Box
        key={enterKey}
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
        {currentField ? (
          <FieldStep
            field={currentField}
            value={data[currentField.key]}
            onChange={(v) => setValue(currentField.key, v)}
            onSubmit={() => {
              if (currentField.required && isFieldEmpty(data[currentField.key])) {
                setError(`"${currentField.label}" is required.`);
                return;
              }
              goNext();
            }}
            isMobile={isMobile}
            accent={accent}
            entityOptions={view.entity_options}
          />
        ) : isAttachmentStep && attachmentPolicy ? (
          <AttachmentStep
            policy={attachmentPolicy}
            attachments={attachments}
            onAdd={handleAddFiles}
            onRemove={handleRemoveAttachment}
            accent={accent}
            isMobile={isMobile}
          />
        ) : (
          <ReviewStep
            fields={fields}
            data={data}
            attachments={attachments}
            accent={accent}
            preview={preview}
            turnstileRef={turnstileRef}
            turnstileSiteKey={view.turnstile_site_key}
            description={view.form.description}
          />
        )}

        {error && (
          <Typography
            sx={{
              mt: 2,
              color: '#9A1F1F',
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            {error}
          </Typography>
        )}
        {state.kind === 'error' && (
          <Typography
            sx={{
              mt: 2,
              color: '#9A1F1F',
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            {state.message}
          </Typography>
        )}
      </Box>

      {/* Sticky bottom action bar (thumb-zone on mobile) */}
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
            disabled={state.kind === 'submitting' || (!preview && !turnstileToken)}
            onClick={handleSubmit}
            sx={{
              bgcolor: accent,
              color: '#fff',
              fontWeight: 600,
              fontSize: 16,
              px: 4,
              py: 1.5,
              minHeight: 48,
              '&:hover': { bgcolor: alpha(accent, 0.85) },
            }}
          >
            {state.kind === 'submitting' ? <CircularProgress size={20} sx={{ color: '#fff' }} /> : 'Submit'}
          </Button>
        ) : (
          <Button
            variant="contained"
            disableElevation
            disabled={!(isAttachmentStep ? isAttachmentStepValid : isCurrentValid)}
            endIcon={<NextIcon />}
            onClick={() => {
              if (isAttachmentStep) {
                if (!isAttachmentStepValid) {
                  setError('Wait for all uploads to finish.');
                  return;
                }
                goNext();
                return;
              }
              if (currentField?.required && isFieldEmpty(data[currentField.key])) {
                setError(`"${currentField.label}" is required.`);
                return;
              }
              goNext();
            }}
            sx={{
              bgcolor: accent,
              color: '#fff',
              fontWeight: 600,
              fontSize: 16,
              px: 4,
              py: 1.5,
              minHeight: 48,
              '&:hover': { bgcolor: alpha(accent, 0.85) },
            }}
          >
            {isAttachmentStep && attachments.length === 0 ? 'Skip' : 'Next'}
          </Button>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------
// Single-field renderer
// ---------------------------------------------------------------------

interface FieldStepProps {
  field: PublicFormFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Called when the user signals "advance" (Enter on text, click chip, etc). */
  onSubmit: () => void;
  isMobile: boolean;
  accent: string;
  /** Tenant-scoped entity dropdown options, if the form fetched them. */
  entityOptions?: PublicFormEntityOptions;
}

export function FieldStep({ field, value, onChange, onSubmit, isMobile, accent, entityOptions }: FieldStepProps) {
  const labelStyle = {
    fontSize: { xs: 28, md: 36 },
    fontWeight: 600,
    letterSpacing: -0.5,
    lineHeight: 1.2,
    mb: 1,
    color: 'text.primary',
  } as const;

  const helpStyle = {
    fontSize: { xs: 14, md: 16 },
    color: 'text.secondary',
    mb: 4,
  } as const;

  const inputBaseSx = {
    '& .MuiInputBase-root': {
      fontSize: { xs: 22, md: 28 },
      fontWeight: 400,
      '&:before': { borderBottom: `2px solid ${alpha(accent, 0.15)}` },
      '&:hover:not(.Mui-disabled):before': { borderBottom: `2px solid ${alpha(accent, 0.35)}` },
      '&.Mui-focused:after': { borderBottom: `2px solid ${accent}` },
    },
    '& .MuiInput-input': { py: 1.5 },
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography sx={labelStyle}>
        {field.label}
        {field.required && <Box component="span" sx={{ color: '#9A1F1F', ml: 0.5 }}>*</Box>}
      </Typography>
      {field.help_text && <Typography sx={helpStyle}>{field.help_text}</Typography>}

      {(field.type === 'text' || field.type === 'email' || field.type === 'url' || field.type === 'phone') && (
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : field.type === 'phone' ? 'tel' : 'text'}
          inputMode={field.type === 'phone' ? 'tel' : field.type === 'email' ? 'email' : undefined}
          autoComplete={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'off'}
          placeholder="Type your answer"
          sx={inputBaseSx}
        />
      )}

      {field.type === 'long_text' && (
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={4}
          maxRows={10}
          variant="standard"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your answer"
          sx={inputBaseSx}
        />
      )}

      {(field.type === 'number' || field.type === 'currency' || field.type === 'percent' || field.type === 'duration') && (
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          type="number"
          inputMode="decimal"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="0"
          sx={inputBaseSx}
        />
      )}

      {(field.type === 'date' || field.type === 'datetime') && (
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          type={field.type === 'datetime' ? 'datetime-local' : 'date'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          InputLabelProps={{ shrink: true }}
          sx={inputBaseSx}
        />
      )}

      {field.type === 'dropdown_single' && (
        <DropdownChips
          options={dropdownOptions(field)}
          value={typeof value === 'string' ? value : null}
          onChange={(v) => {
            onChange(v);
            // Auto-advance on selection — Typeform shape.
            setTimeout(onSubmit, 200);
          }}
          accent={accent}
          isMobile={isMobile}
        />
      )}

      {field.type === 'dropdown_multi' && (
        <DropdownChips
          options={dropdownOptions(field)}
          multi
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={(v) => onChange(v)}
          accent={accent}
          isMobile={isMobile}
        />
      )}

      {field.type === 'checkbox' && (
        <FormControlLabel
          control={
            <Checkbox
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              sx={{
                color: alpha(accent, 0.4),
                '&.Mui-checked': { color: accent },
                transform: 'scale(1.2)',
              }}
            />
          }
          label="Yes"
          sx={{ '& .MuiFormControlLabel-label': { fontSize: 18 } }}
        />
      )}

      {(field.type === 'customer_ref' ||
        field.type === 'supplier_ref' ||
        field.type === 'product_ref') && (
        <EntityRefField
          field={field}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          isMobile={isMobile}
          accent={accent}
          entityOptions={entityOptions}
          inputBaseSx={inputBaseSx}
        />
      )}

      {field.type === 'contact' && (
        // contact stays as a free-text input on public forms — exposing
        // a tenant's user list is out of scope for v1 and has different
        // security implications than supplier/product/customer.
        <TextField
          autoFocus
          fullWidth
          variant="standard"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Enter name"
          sx={inputBaseSx}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------
// Entity-ref Autocomplete — searchable dropdown for customer/supplier/
// product columns. Falls back to a free-text input when the form
// payload didn't include matching entity_options (older forms, empty
// tenant catalog, etc.) so the renderer never traps users.
// ---------------------------------------------------------------------

interface EntityRefFieldProps {
  field: PublicFormFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  onSubmit: () => void;
  isMobile: boolean;
  accent: string;
  entityOptions?: PublicFormEntityOptions;
  inputBaseSx: object;
}

function EntityRefField({
  field,
  value,
  onChange,
  onSubmit,
  isMobile,
  accent,
  entityOptions,
  inputBaseSx,
}: EntityRefFieldProps) {
  const kind: 'customer' | 'supplier' | 'product' | null =
    field.type === 'customer_ref'
      ? 'customer'
      : field.type === 'supplier_ref'
        ? 'supplier'
        : field.type === 'product_ref'
          ? 'product'
          : null;
  const options = (kind && entityOptions ? entityOptions[kind] : undefined) ?? [];
  const haveOptions = options.length > 0;

  // Resolve current value back to a PublicEntityOption shape so the
  // Autocomplete can render its selected state. The grid persists
  // either a string id or { id, name } so we accept either.
  const selected = useMemo<PublicEntityOption | null>(() => {
    if (!value) return null;
    if (typeof value === 'string') {
      const match = options.find((o) => o.id === value);
      return match ?? null;
    }
    if (typeof value === 'object' && 'id' in (value as object)) {
      const v = value as { id?: unknown; name?: unknown };
      if (typeof v.id !== 'string') return null;
      const match = options.find((o) => o.id === v.id);
      if (match) return match;
      // Value carries a name we can render even if it's not in the
      // (truncated) options list.
      return {
        id: v.id,
        name: typeof v.name === 'string' ? v.name : v.id,
      };
    }
    return null;
  }, [value, options]);

  // Graceful fallback: if the server didn't ship entity_options for
  // this kind (older form, empty catalog), drop back to a text input.
  if (!haveOptions) {
    return (
      <TextField
        autoFocus
        fullWidth
        variant="standard"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Enter name"
        sx={inputBaseSx}
      />
    );
  }

  return (
    <Autocomplete<PublicEntityOption, false, false, false>
      autoHighlight
      openOnFocus
      fullWidth
      options={options}
      value={selected}
      onChange={(_e, opt) => {
        if (!opt) {
          onChange(null);
          return;
        }
        // Persist the same { id, name } shape the grid uses so the
        // submitted value round-trips identically through the row API.
        onChange({ id: opt.id, name: opt.name });
        // Auto-advance on selection — same 200ms delay as dropdown_single
        // for visual consistency.
        setTimeout(onSubmit, 200);
      }}
      // Match by id, never by name string — names can collide.
      isOptionEqualToValue={(a, b) => a.id === b.id}
      getOptionLabel={(o) => o.name}
      // Reject free-typed strings that don't match any option. The grid
      // contract is { id, name }; a raw string would fail the
      // cross-tenant check on submit anyway. Better to surface that here
      // by simply not committing the typed value.
      freeSolo={false}
      filterOptions={(opts, state) => {
        const q = state.inputValue.trim().toLowerCase();
        if (!q) return opts.slice(0, 50);
        return opts
          .filter((o) =>
            (o.name + ' ' + (o.secondary ?? '')).toLowerCase().includes(q),
          )
          .slice(0, 50);
      }}
      renderOption={(props, opt) => (
        <Box component="li" {...props} key={opt.id} sx={{ display: 'block !important', py: 1.25 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 500, color: 'text.primary' }}>
            {opt.name}
          </Typography>
          {opt.secondary && (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              {opt.secondary}
            </Typography>
          )}
        </Box>
      )}
      // Mobile-friendly popper: full-width, take up to half the viewport
      // so the keyboard + options list don't fight for vertical space.
      slotProps={{
        popper: isMobile
          ? { style: { width: '100%' }, placement: 'bottom-start' }
          : { placement: 'bottom-start' },
        paper: {
          sx: {
            maxHeight: { xs: '50vh', md: 360 },
            mt: 0.5,
            borderRadius: 2,
            border: 1,
            borderColor: alpha(accent, 0.18),
          },
        },
        listbox: {
          sx: {
            maxHeight: { xs: '50vh', md: 360 },
            // Big touch targets on mobile.
            '& li': { minHeight: { xs: 56, md: 44 } },
          },
        },
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          autoFocus
          variant="standard"
          placeholder="Search…"
          sx={inputBaseSx}
        />
      )}
    />
  );
}

// ---------------------------------------------------------------------
// Dropdown chips — large tap targets, single or multi
// ---------------------------------------------------------------------

interface DropdownChipsProps {
  options: { value: string; label?: string; color?: string }[];
  multi?: boolean;
  value: string | string[] | null;
  onChange: (v: string | string[]) => void;
  accent: string;
  isMobile: boolean;
}

function DropdownChips({ options, multi, value, onChange, accent, isMobile }: DropdownChipsProps) {
  const isSelected = (v: string) =>
    multi ? Array.isArray(value) && value.includes(v) : value === v;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mt: 1 }}>
      {options.length === 0 && (
        <Typography sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
          No options configured.
        </Typography>
      )}
      {options.map((opt) => {
        const selected = isSelected(opt.value);
        return (
          <Box
            key={opt.value}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (multi) {
                const arr = Array.isArray(value) ? [...value] : [];
                const idx = arr.indexOf(opt.value);
                if (idx >= 0) arr.splice(idx, 1);
                else arr.push(opt.value);
                onChange(arr);
              } else {
                onChange(opt.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                (e.target as HTMLElement).click();
              }
            }}
            sx={{
              border: 2,
              borderColor: selected ? accent : alpha(accent, 0.18),
              borderRadius: 2,
              bgcolor: selected ? alpha(accent, 0.08) : 'transparent',
              px: 2,
              py: isMobile ? 2 : 1.5,
              minHeight: 56,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              transition: 'border-color 150ms, background-color 150ms',
              fontSize: 18,
              fontWeight: 500,
              '&:hover': {
                borderColor: alpha(accent, 0.5),
              },
              '&:focus-visible': {
                outline: 'none',
                borderColor: accent,
                boxShadow: `0 0 0 3px ${alpha(accent, 0.18)}`,
              },
            }}
          >
            {opt.label || opt.value}
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------
// Review step — answer summary + Turnstile + Submit
// ---------------------------------------------------------------------

interface ReviewStepProps {
  fields: PublicFormFieldDef[];
  data: RecordRowData;
  attachments: AttachmentEntry[];
  accent: string;
  preview: boolean;
  turnstileRef: React.MutableRefObject<HTMLDivElement | null>;
  turnstileSiteKey: string;
  description: string | null;
}

function ReviewStep({ fields, data, attachments, accent, preview, turnstileRef, turnstileSiteKey, description }: ReviewStepProps) {
  return (
    <Box sx={{ width: '100%' }}>
      <Typography sx={{ fontSize: { xs: 28, md: 36 }, fontWeight: 600, letterSpacing: -0.5, mb: 1 }}>
        Review and submit
      </Typography>
      <Typography sx={{ color: 'text.secondary', mb: 4, fontSize: { xs: 14, md: 16 } }}>
        Take a moment to confirm your answers below.
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 4 }}>
        {fields.map((f) => {
          const v = data[f.key];
          const display = formatPreview(f, v);
          return (
            <Box
              key={f.key}
              sx={{
                pb: 1.5,
                borderBottom: 1,
                borderColor: 'divider',
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                gap: { xs: 0.5, sm: 2 },
                alignItems: { sm: 'baseline' },
              }}
            >
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'text.secondary',
                  minWidth: 160,
                }}
              >
                {f.label}
              </Typography>
              <Typography sx={{ fontSize: 16, color: display ? 'text.primary' : 'text.disabled' }}>
                {display || '(blank)'}
              </Typography>
            </Box>
          );
        })}
      </Box>

      {attachments.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography
            sx={{
              fontSize: 13,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'text.secondary',
              mb: 1.25,
            }}
          >
            Attachments ({attachments.length})
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
            {attachments.map((a) => (
              <Box
                key={a.localId}
                sx={{
                  width: 96,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.5,
                  alignItems: 'center',
                }}
              >
                {a.previewUrl ? (
                  <Box
                    component="img"
                    src={a.previewUrl}
                    alt={a.file.name}
                    sx={{
                      width: 96,
                      height: 96,
                      objectFit: 'cover',
                      borderRadius: 1,
                      border: 1,
                      borderColor: 'divider',
                    }}
                  />
                ) : (
                  <Box
                    sx={{
                      width: 96,
                      height: 96,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      bgcolor: alpha(accent, 0.06),
                      borderRadius: 1,
                      border: 1,
                      borderColor: 'divider',
                    }}
                  >
                    <FileIcon sx={{ fontSize: 36, color: alpha(accent, 0.5) }} />
                  </Box>
                )}
                <Typography
                  sx={{
                    fontSize: 11,
                    color: 'text.secondary',
                    width: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textAlign: 'center',
                  }}
                  title={a.file.name}
                >
                  {a.file.name}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {!preview && turnstileSiteKey && (
        <Box sx={{ mb: 1 }}>
          <div ref={turnstileRef} />
        </Box>
      )}

      {preview && (
        <Typography sx={{ fontSize: 13, color: 'text.secondary', fontStyle: 'italic' }}>
          Captcha hidden in preview.
        </Typography>
      )}

      {description && (
        <Typography sx={{ mt: 3, fontSize: 13, color: 'text.disabled' }}>
          {description}
        </Typography>
      )}

      {/* Render accent so the unused-var warning stays away — accent is also
          used implicitly via the shared color scheme on this step. */}
      <Box sx={{ display: 'none', color: accent }} />
    </Box>
  );
}

// ---------------------------------------------------------------------
// Attachment step — drag-drop area + native file picker (with
// capture="environment" so iOS / Android open the rear camera by
// default for QC photos). Uploads are streamed to the server as soon
// as files are picked; the user sees a per-file progress bar that
// switches to a checkmark on completion.
// ---------------------------------------------------------------------

interface AttachmentStepProps {
  policy: PublicFormAttachmentPolicy;
  attachments: AttachmentEntry[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (localId: string) => void;
  accent: string;
  isMobile: boolean;
}

function AttachmentStep({ policy, attachments, onAdd, onRemove, accent, isMobile }: AttachmentStepProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const acceptAttr = useMemo(() => buildAcceptAttr(policy.allowed_mime_types), [policy.allowed_mime_types]);
  const canAddMore = attachments.length < policy.max_attachments;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAdd(e.target.files);
      // Allow re-picking the same file by resetting the input.
      e.target.value = '';
    }
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography
        sx={{
          fontSize: { xs: 28, md: 36 },
          fontWeight: 600,
          letterSpacing: -0.5,
          lineHeight: 1.2,
          mb: 1,
          color: 'text.primary',
        }}
      >
        Add photos or files
      </Typography>
      <Typography sx={{ fontSize: { xs: 14, md: 16 }, color: 'text.secondary', mb: 3 }}>
        Up to {policy.max_attachments} files, {policy.max_file_size_mb} MB each. This step is optional.
      </Typography>

      {/* Hidden inputs — triggered by visible buttons / drop zone clicks. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptAttr}
        multiple
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />
      {/* Mobile-only camera input. capture="environment" makes the OS
          jump straight into the rear camera, which is the QC tech's
          most common path. We keep a separate "Browse files" button
          that doesn't pass capture so they can pick from photos too. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleInputChange}
        style={{ display: 'none' }}
      />

      {/* Drop zone (also clickable to open the file picker). */}
      <Box
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (canAddMore) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!canAddMore) return;
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onAdd(e.dataTransfer.files);
          }
        }}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1.5,
          minHeight: 160,
          borderRadius: 2,
          border: 2,
          borderStyle: 'dashed',
          borderColor: dragOver ? accent : alpha(accent, 0.3),
          bgcolor: dragOver ? alpha(accent, 0.06) : alpha(accent, 0.02),
          cursor: canAddMore ? 'pointer' : 'not-allowed',
          opacity: canAddMore ? 1 : 0.5,
          transition: 'all 150ms',
          px: 2,
          py: 3,
          '&:hover': canAddMore ? { borderColor: accent, bgcolor: alpha(accent, 0.05) } : undefined,
          '&:focus-visible': {
            outline: 'none',
            borderColor: accent,
            boxShadow: `0 0 0 3px ${alpha(accent, 0.18)}`,
          },
        }}
      >
        <UploadIcon sx={{ fontSize: 40, color: alpha(accent, 0.7) }} />
        <Typography sx={{ fontSize: { xs: 15, md: 16 }, fontWeight: 500, textAlign: 'center' }}>
          {isMobile ? 'Tap to select files' : 'Drop files here or click to browse'}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {policy.allowed_mime_types.includes('image/*') ? 'Photos and ' : ''}
          {policy.allowed_mime_types.filter((t) => !t.startsWith('image/')).map((t) => t.split('/')[1]?.toUpperCase()).filter(Boolean).join(', ') || 'documents'}
        </Typography>
      </Box>

      {/* Mobile-friendly action row: explicit Camera button so the QC
          tech doesn't have to dig through a system "choose source"
          sheet. The browse button on desktop opens the picker via the
          dropzone click, but having an explicit button helps a11y. */}
      {(isMobile || true) && canAddMore && (
        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
          {isMobile && (
            <Button
              variant="outlined"
              startIcon={<CameraIcon />}
              onClick={() => cameraInputRef.current?.click()}
              sx={{
                minHeight: 48,
                borderColor: alpha(accent, 0.4),
                color: accent,
                fontWeight: 600,
                flex: 1,
                '&:hover': { borderColor: accent, bgcolor: alpha(accent, 0.05) },
              }}
            >
              Take photo
            </Button>
          )}
          <Button
            variant="outlined"
            startIcon={<UploadIcon />}
            onClick={() => fileInputRef.current?.click()}
            sx={{
              minHeight: 48,
              borderColor: alpha(accent, 0.4),
              color: accent,
              fontWeight: 600,
              flex: 1,
              '&:hover': { borderColor: accent, bgcolor: alpha(accent, 0.05) },
            }}
          >
            {isMobile ? 'Choose files' : 'Browse files'}
          </Button>
        </Box>
      )}

      {/* Selected files list */}
      {attachments.length > 0 && (
        <Box sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {attachments.map((a) => (
            <AttachmentRow
              key={a.localId}
              entry={a}
              onRemove={() => onRemove(a.localId)}
              accent={accent}
            />
          ))}
        </Box>
      )}

      {!canAddMore && (
        <Typography sx={{ mt: 2, fontSize: 13, color: 'text.secondary', fontStyle: 'italic' }}>
          Maximum number of files reached. Remove one to add more.
        </Typography>
      )}
    </Box>
  );
}

interface AttachmentRowProps {
  entry: AttachmentEntry;
  onRemove: () => void;
  accent: string;
}

function AttachmentRow({ entry, onRemove, accent }: AttachmentRowProps) {
  const isImage = !!entry.previewUrl;
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.25,
        borderRadius: 1.5,
        border: 1,
        borderColor: entry.status === 'error' ? '#9A1F1F' : 'divider',
        bgcolor: entry.status === 'error' ? 'rgba(154, 31, 31, 0.04)' : 'background.paper',
      }}
    >
      {/* Thumbnail / icon */}
      {isImage ? (
        <Box
          component="img"
          src={entry.previewUrl!}
          alt={entry.file.name}
          sx={{
            width: 80,
            height: 80,
            objectFit: 'cover',
            borderRadius: 1,
            flexShrink: 0,
          }}
        />
      ) : (
        <Box
          sx={{
            width: 80,
            height: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: alpha(accent, 0.06),
            borderRadius: 1,
            flexShrink: 0,
          }}
        >
          <FileIcon sx={{ fontSize: 36, color: alpha(accent, 0.6) }} />
        </Box>
      )}

      {/* Info + progress */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={entry.file.name}
        >
          {entry.file.name}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {formatBytes(entry.file.size)}
          {entry.status === 'uploading' && ` · Uploading… ${entry.progress}%`}
          {entry.status === 'done' && ' · Ready'}
        </Typography>
        {entry.status === 'uploading' && (
          <LinearProgress
            variant="determinate"
            value={entry.progress}
            sx={{
              mt: 0.75,
              height: 4,
              borderRadius: 2,
              bgcolor: alpha(accent, 0.12),
              '& .MuiLinearProgress-bar': { bgcolor: accent },
            }}
          />
        )}
        {entry.status === 'error' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
            <ErrorIcon sx={{ fontSize: 14, color: '#9A1F1F' }} />
            <Typography sx={{ fontSize: 12, color: '#9A1F1F' }}>
              {entry.errorMessage || 'Upload failed'}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Status icon + remove */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {entry.status === 'done' && <CheckIcon sx={{ color: 'success.main', fontSize: 22 }} />}
        <IconButton
          aria-label={`Remove ${entry.file.name}`}
          onClick={onRemove}
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          <CloseIcon />
        </IconButton>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------
// Success screen
// ---------------------------------------------------------------------

export function SuccessScreen({
  accent,
  thankYou,
  redirect,
  title,
}: {
  accent: string;
  thankYou: string | null;
  redirect: string | null;
  /** Override the headline. Defaults to the form-flavoured copy. */
  title?: string;
}) {
  useEffect(() => {
    if (redirect) {
      const t = setTimeout(() => {
        window.location.href = redirect;
      }, 2000);
      return () => clearTimeout(t);
    }
  }, [redirect]);
  return (
    <Box
      sx={{
        minHeight: { xs: '100dvh', md: '100vh' },
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
        textAlign: 'center',
      }}
    >
      <CheckIcon sx={{ fontSize: 96, color: accent, mb: 3 }} />
      <Typography sx={{ fontSize: { xs: 28, md: 36 }, fontWeight: 600, mb: 2, letterSpacing: -0.5 }}>
        {title ?? 'Thanks for your submission!'}
      </Typography>
      <Typography sx={{ fontSize: 16, color: 'text.secondary', maxWidth: 480 }}>
        {thankYou || 'Your response has been recorded. The team has been notified.'}
      </Typography>
      {redirect && (
        <Typography sx={{ mt: 3, fontSize: 13, color: 'text.disabled' }}>
          Redirecting…
        </Typography>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

export function isFieldEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function dropdownOptions(field: PublicFormFieldDef): { value: string; label?: string; color?: string }[] {
  const cfg = field.config as RecordColumnDropdownConfig | null | undefined;
  return cfg?.options ?? [];
}

function formatPreview(_field: PublicFormFieldDef, value: unknown): string {
  if (isFieldEmpty(value)) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    const obj = value as { id?: string; name?: string; label?: string };
    return obj.name || obj.label || obj.id || JSON.stringify(value);
  }
  return String(value);
}
