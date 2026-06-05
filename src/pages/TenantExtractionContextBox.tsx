/**
 * Settings-hub editor for the per-TENANT extraction context — the org-wide
 * prompt layer prepended to every extraction for this organization.
 *
 * Two-layer extraction prompt model:
 *   - Tenant layer (this box): stable org/domain context ("we're a milk
 *     company; lot is king; capture specs verbatim, never derive pass/fail").
 *   - (Supplier x doc-type) layer: per-source quirks, authored in the
 *     SupplierDetail "Extraction Instructions" tab (ExtractionInstructionsBox).
 *
 * Leave this empty to fall back to the built-in dairy default. The "Load
 * default dairy template" button seeds the box from that default so the user
 * can start from it and edit into the tenant record.
 *
 * Modeled on ExtractionInstructionsBox: debounced autosave, save-state label,
 * load-on-mount. Scoped to the caller's own tenant.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../lib/api';

interface Props {
  /**
   * super_admin path needs a tenant_id; org_admin gets it from the JWT. We pass
   * `user.tenant_id` regardless — it's harmless and the server scopes it.
   */
  tenantId?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 600;

function formatTimestamp(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function TenantExtractionContextBox({ tenantId }: Props) {
  const { user } = useAuth();
  const effectiveTenantId = tenantId ?? user?.tenant_id ?? undefined;

  const [value, setValue] = useState('');
  // Snapshot of what's persisted on the server — we only save when `value`
  // differs from this (avoids a no-op PUT on every blur).
  const [persistedValue, setPersistedValue] = useState('');
  const [defaultTemplate, setDefaultTemplate] = useState('');
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaveState('idle');
    setErrorMessage(null);
    (async () => {
      try {
        const res = await api.tenantExtractionContext.get({ tenant_id: effectiveTenantId });
        if (cancelled) return;
        const text = res.extraction_context || '';
        setValue(text);
        setPersistedValue(text);
        setDefaultTemplate(res.default_template || '');
        setUpdatedBy(res.updated_by);
        setUpdatedAt(res.updated_at);
      } catch (err) {
        if (cancelled) return;
        // Non-fatal — treat as empty, user can still author a value.
        setValue('');
        setPersistedValue('');
        console.warn('Failed to load tenant extraction context:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTenantId]);

  // Shared save path — used by debounced autosave, onBlur flush, and the
  // "load default" button.
  const save = async (text: string) => {
    if (text === persistedValue) return;
    setSaveState('saving');
    setErrorMessage(null);
    try {
      const res = await api.tenantExtractionContext.put({
        extraction_context: text,
        tenant_id: effectiveTenantId,
      });
      setPersistedValue(text);
      setUpdatedBy(res.updated_by);
      setUpdatedAt(res.updated_at);
      setSaveState('saved');
      setTimeout(() => {
        setSaveState((prev) => (prev === 'saved' ? 'idle' : prev));
      }, 1500);
    } catch (err) {
      setSaveState('error');
      setErrorMessage(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const scheduleSave = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void save(text);
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const handleChange = (next: string) => {
    setValue(next);
    scheduleSave(next);
  };

  const handleBlur = () => {
    // Flush any pending debounced save immediately on blur so the user doesn't
    // lose edits by navigating away mid-debounce.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void save(value);
  };

  const handleLoadDefault = () => {
    if (!defaultTemplate) return;
    // Confirm-guard so we don't silently clobber existing edits.
    if (value.trim() && !window.confirm(
      'Replace the current extraction context with the default dairy template? This overwrites your existing text.'
    )) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setValue(defaultTemplate);
    void save(defaultTemplate);
  };

  const statusLabel = (() => {
    if (loading) return 'Loading...';
    if (saveState === 'saving') return 'Saving...';
    if (saveState === 'saved') return 'Saved';
    if (saveState === 'error') return errorMessage || 'Save failed';
    return '';
  })();

  return (
    <Box>
      <Typography variant="h6" fontWeight={700} gutterBottom>
        Extraction Context
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 720 }}>
        This is the organization-wide context prepended to every extraction for
        your tenant — stable domain rules and conventions that apply across all
        suppliers and document types. Leave it empty to use the built-in dairy
        default. Per-supplier quirks belong in each supplier's "Extraction
        Instructions" tab instead.
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Button
          size="small"
          variant="outlined"
          onClick={handleLoadDefault}
          disabled={loading || !defaultTemplate}
        >
          Load default dairy template
        </Button>
        {statusLabel && (
          <Typography
            variant="caption"
            color={saveState === 'error' ? 'error' : 'text.secondary'}
            sx={{ fontStyle: 'italic' }}
          >
            {statusLabel}
          </Typography>
        )}
      </Box>

      <TextField
        multiline
        rows={20}
        fullWidth
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        disabled={loading}
        placeholder="Org-wide extraction context. Leave empty to use the built-in dairy default."
      />

      {updatedBy && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Last edited by {updatedBy}
          {updatedAt ? ` on ${formatTimestamp(updatedAt)}` : ''}
        </Typography>
      )}
    </Box>
  );
}
