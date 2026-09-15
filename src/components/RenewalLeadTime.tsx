/**
 * Renewal alert lead time (migration 0111) — the controls.
 *
 * "Warn owners N days before a document is due." One organization number
 * (RenewalLeadTimePanel, on Settings › Owner Routing, beside the other answer
 * to "who gets told when a record comes due?") and a per-document-type
 * override (LeadDaysField inside the Document Types dialog).
 *
 * Both show WHAT THE CHANGE WOULD DO before it is saved, from the read-only
 * GET /api/expirations/lead-time/preview: a person moving 60 to 90 is deciding
 * that some owners start chasing suppliers tomorrow morning, and should see how
 * many records that is.
 *
 * The rules (range, presets, default, precedence) come from
 * shared/renewalLeadTime.ts so this screen cannot drift from the engine.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { formatDateTime } from '../utils/format';
import type { RenewalAlertLeadTimeResponse, RenewalLeadTimePreview } from '../../shared/types';
import {
  DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
  MAX_RENEWAL_ALERT_LEAD_DAYS,
  MIN_RENEWAL_ALERT_LEAD_DAYS,
  RENEWAL_ALERT_LEAD_PRESETS,
  parseRenewalAlertLeadDays,
} from '../../shared/renewalLeadTime';

type Mode = 'inherit' | 'custom' | `${number}`;

function modeFor(value: number | null): Mode {
  if (value === null) return 'inherit';
  return RENEWAL_ALERT_LEAD_PRESETS.includes(value) ? (String(value) as Mode) : 'custom';
}

export interface LeadDaysFieldProps {
  /** The INITIAL value; null = inherit. Remount (key) to reset. */
  value: number | null;
  /** `valid` is false while a custom value is out of range or not a number. */
  onChange: (value: number | null, valid: boolean) => void;
  label: string;
  /** Text of the null option, e.g. "Use organization default (60 days)". */
  inheritLabel: string;
  disabled?: boolean;
}

/**
 * Presets 30 / 60 / 90, an inherit option, and a custom whole number. One
 * Select plus a number box that appears only for Custom, so the common choice
 * stays one click.
 */
export function LeadDaysField({ value, onChange, label, inheritLabel, disabled }: LeadDaysFieldProps) {
  const [mode, setMode] = useState<Mode>(modeFor(value));
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  // Initialised from `value` once. While a custom number is half-typed the
  // parent holds null, so syncing back from `value` would snap the control to
  // "inherit" mid-keystroke; a parent that needs a reset remounts it via `key`.

  const customError = (() => {
    if (mode !== 'custom') return '';
    const n = Number(draft);
    const parsed = parseRenewalAlertLeadDays(draft.trim() === '' ? undefined : n);
    return parsed.ok ? '' : `A whole number from ${MIN_RENEWAL_ALERT_LEAD_DAYS} to ${MAX_RENEWAL_ALERT_LEAD_DAYS}`;
  })();

  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <FormControl sx={{ minWidth: 260, flex: 1 }} size="small">
        <InputLabel>{label}</InputLabel>
        <Select
          label={label}
          value={mode}
          disabled={disabled}
          inputProps={{ 'aria-label': label }}
          onChange={(e) => {
            const next = e.target.value as Mode;
            setMode(next);
            if (next === 'inherit') onChange(null, true);
            else if (next === 'custom') {
              const n = Number(draft);
              onChange(Number.isInteger(n) ? n : null, parseRenewalAlertLeadDays(draft.trim() === '' ? undefined : n).ok);
            } else onChange(Number(next), true);
          }}
        >
          <MenuItem value="inherit">{inheritLabel}</MenuItem>
          {RENEWAL_ALERT_LEAD_PRESETS.map((d) => (
            <MenuItem key={d} value={String(d)}>
              {d} days before{d === DEFAULT_RENEWAL_ALERT_LEAD_DAYS ? ' (the system default)' : ''}
            </MenuItem>
          ))}
          <MenuItem value="custom">Custom…</MenuItem>
        </Select>
      </FormControl>
      {mode === 'custom' && (
        <TextField
          size="small"
          type="number"
          label="Days before due"
          value={draft}
          disabled={disabled}
          error={!!customError}
          helperText={customError || ' '}
          inputProps={{ min: MIN_RENEWAL_ALERT_LEAD_DAYS, max: MAX_RENEWAL_ALERT_LEAD_DAYS, step: 1 }}
          sx={{ width: 170 }}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value);
            const ok = parseRenewalAlertLeadDays(e.target.value.trim() === '' ? undefined : n).ok;
            onChange(ok ? n : null, ok);
          }}
        />
      )}
    </Box>
  );
}

/**
 * Debounced read-only preview of a proposed value. `enabled: false` (nothing
 * changed, or the value is invalid) clears it rather than asking the server
 * what an unchanged setting would change.
 */
export function useLeadTimePreview(params: {
  enabled: boolean;
  leadDays: number | null;
  documentTypeId?: string;
  tenantId?: string;
}): { preview: RenewalLeadTimePreview | null; loading: boolean; error: string } {
  const [preview, setPreview] = useState<RenewalLeadTimePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { enabled, leadDays, documentTypeId, tenantId } = params;

  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      setError('');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api.expirations.leadTime
        .preview({ leadDays, documentTypeId, tenantId })
        .then((p) => {
          if (!cancelled) {
            setPreview(p);
            setError('');
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [enabled, leadDays, documentTypeId, tenantId]);

  return { preview, loading, error };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The sentence form of a preview: what the next scheduled run would do differently. */
export function describeLeadTimePreview(p: RenewalLeadTimePreview): string {
  if (p.newly_entering_count === 0 && p.leaving_count === 0) {
    return 'No change at the next run: no document enters or leaves the warning window.';
  }
  const parts: string[] = [];
  if (p.newly_entering_count > 0) {
    const held = p.newly_entering_count - p.newly_entering_would_send_count;
    parts.push(
      `${plural(p.newly_entering_count, 'document')} would newly enter the warning window` +
        ` (${p.newly_entering_would_send_count} would be emailed to ${p.newly_entering_would_send_count === 1 ? 'its owner' : 'their owners'}` +
        `${held > 0 ? `; ${held} already emailed in the last week stay quiet` : ''})`,
    );
  }
  if (p.leaving_count > 0) {
    parts.push(`${plural(p.leaving_count, 'document')} would leave it until ${p.leaving_count === 1 ? 'it comes' : 'they come'} closer to due`);
  }
  return `At the next run: ${parts.join('; ')}.`;
}

export function LeadTimePreviewNote({
  preview,
  loading,
  error,
}: {
  preview: RenewalLeadTimePreview | null;
  loading: boolean;
  error: string;
}) {
  if (loading) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', color: 'text.secondary' }}>
        <CircularProgress size={14} />
        <Typography variant="body2">Checking what this changes…</Typography>
      </Box>
    );
  }
  if (error) return <Alert severity="warning">Could not preview this change: {error}</Alert>;
  if (!preview) return null;
  const titles = preview.newly_entering.slice(0, 5).map((d) => d.title);
  return (
    <Alert severity={preview.newly_entering_would_send_count > 0 ? 'warning' : 'info'} data-testid="lead-time-preview">
      {describeLeadTimePreview(preview)}
      {titles.length > 0 && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>
          Newly in the window: {titles.join(', ')}
          {preview.newly_entering_count > titles.length ? ` and ${preview.newly_entering_count - titles.length} more` : ''}
        </Typography>
      )}
    </Alert>
  );
}

/**
 * The organization setting. Lives on Settings › Owner Routing because that
 * page already answers "who gets told when a record comes due?" — this is the
 * "when".
 */
export function RenewalLeadTimePanel({ tenantId }: { tenantId?: string }) {
  const [setting, setSetting] = useState<RenewalAlertLeadTimeResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [value, setValue] = useState<number | null>(null);
  const [valid, setValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [savedNote, setSavedNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSetting(null);
    setLoadError('');
    api.expirations.leadTime
      .get({ tenantId })
      .then((s) => {
        if (cancelled) return;
        setSetting(s);
        setValue(s.lead_days);
        setValid(true);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const dirty = !!setting && value !== setting.lead_days;
  const { preview, loading, error } = useLeadTimePreview({
    enabled: dirty && valid,
    leadDays: value,
    tenantId,
  });

  const save = async () => {
    setSaving(true);
    setSaveError('');
    setSavedNote('');
    try {
      const s = await api.expirations.leadTime.put({ lead_days: value, tenantId });
      setSetting(s);
      setValue(s.lead_days);
      setSavedNote(`Saved. Owners are now warned ${s.effective.days} days before a document is due.`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }} data-testid="renewal-lead-time-panel">
      <Typography variant="h6" fontWeight={600} gutterBottom>
        When owners are warned
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Warn owners <strong>N days before a document is due</strong>. A longer lead gives time to
        chase suppliers; a shorter one avoids chasing them about something that cannot be renewed
        yet. Each owner still hears about a record at most once a week unless it becomes overdue.
        The Renewals page's look-ahead only changes that view; it never changes who is emailed.
      </Typography>

      {loadError && <Alert severity="error">{loadError}</Alert>}
      {!setting && !loadError && <CircularProgress size={20} />}

      {setting && (
        <>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', mb: 1.5 }}>
            <Box sx={{ flex: 1, minWidth: 260 }}>
              <LeadDaysField
                key={`${setting.tenant_id}:${setting.lead_days ?? 'default'}`}
                label="Warn owners"
                inheritLabel={`System default (${setting.default_lead_days} days before)`}
                value={value}
                disabled={saving}
                onChange={(v, ok) => {
                  setValue(v);
                  setValid(ok);
                  setSavedNote('');
                }}
              />
            </Box>
            <Button variant="contained" onClick={save} disabled={!dirty || !valid || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>

          <Box sx={{ mb: 1.5 }}>
            <LeadTimePreviewNote preview={preview} loading={loading} error={error} />
          </Box>
          {saveError && <Alert severity="error" sx={{ mb: 1.5 }}>{saveError}</Alert>}
          {savedNote && <Alert severity="success" sx={{ mb: 1.5 }}>{savedNote}</Alert>}

          <Typography variant="caption" color="text.secondary" component="div">
            {setting.updated_at
              ? `Last changed ${formatDateTime(setting.updated_at)}${setting.updated_by_name ? ` by ${setting.updated_by_name}` : ''}.`
              : 'Never changed — the system default applies.'}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" data-testid="lead-time-overrides">
            {setting.document_type_overrides.length === 0
              ? 'No document type overrides this. Set one on Settings › Document Types.'
              : `Document types with their own lead time: ${setting.document_type_overrides
                  .map((o) => `${o.name} (${o.lead_days} days)`)
                  .join(', ')}.`}
          </Typography>
        </>
      )}
    </Paper>
  );
}
