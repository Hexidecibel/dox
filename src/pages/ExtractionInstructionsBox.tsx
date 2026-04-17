/**
 * Inline textarea in the Review Queue for per-(supplier, document_type)
 * natural-language extraction instructions.
 *
 * Reviewer flow:
 *   1. They hit a document, spot a recurring error the model keeps making.
 *   2. They type plain-English guidance in here ("COAG values go in column A").
 *   3. On blur (with a ~500ms debounce) we PUT to /api/extraction-instructions.
 *   4. The worker then prepends this text to the Qwen system prompt on every
 *      future extraction for the same (supplier, document_type) pair.
 *
 * This is INTENTIONALLY separate from the per-item `Notes` field (reviewer
 * scratchpad, never sent to the model). Keep that as-is.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, TextField, Typography } from '@mui/material';
import { api } from '../lib/api';

interface Props {
  supplierId: string;
  supplierName: string;
  docTypeId: string;
  docTypeName: string;
  /** super_admin path needs a tenant_id; non-admin paths get it from JWT. */
  tenantId?: string;
  /** Disable editing on approved/rejected items (we still show current text). */
  disabled?: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 500;

export default function ExtractionInstructionsBox({
  supplierId,
  supplierName,
  docTypeId,
  docTypeName,
  tenantId,
  disabled = false,
}: Props) {
  const [value, setValue] = useState('');
  // Snapshot of what's currently persisted on the server — we only save when
  // `value` differs from this (avoids a no-op PUT every blur).
  const [persistedValue, setPersistedValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-load whenever the (supplier, doctype) pair changes. This handles the
  // user scrolling between queue items expanded one at a time.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaveState('idle');
    setErrorMessage(null);
    (async () => {
      try {
        const res = await api.extractionInstructions.get({
          supplier_id: supplierId,
          document_type_id: docTypeId,
          tenant_id: tenantId,
        });
        if (cancelled) return;
        const text = res.instructions || '';
        setValue(text);
        setPersistedValue(text);
      } catch (err) {
        if (cancelled) return;
        // Non-fatal — treat as empty, user can still create a new row.
        setValue('');
        setPersistedValue('');
        console.warn('Failed to load extraction instructions:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId, docTypeId, tenantId]);

  // Shared save path — used by the debounced autosave and the onBlur flush.
  const save = async (text: string) => {
    if (text === persistedValue) return;
    setSaveState('saving');
    setErrorMessage(null);
    try {
      await api.extractionInstructions.put({
        supplier_id: supplierId,
        document_type_id: docTypeId,
        instructions: text,
        tenant_id: tenantId,
      });
      setPersistedValue(text);
      setSaveState('saved');
      // Auto-fade "Saved" back to idle so the UI doesn't stay sticky.
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
    // lose guidance by navigating away mid-debounce.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void save(value);
  };

  const statusLabel = (() => {
    if (loading) return 'Loading...';
    if (saveState === 'saving') return 'Saving...';
    if (saveState === 'saved') return 'Saved';
    if (saveState === 'error') return errorMessage || 'Save failed';
    return '';
  })();

  return (
    <Box sx={{ mt: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          Instructions for future {supplierName} / {docTypeName} extractions
        </Typography>
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
        rows={3}
        fullWidth
        size="small"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled || loading}
        placeholder={'e.g., "COAG values go in column A, not column B"'}
        helperText="Natural-language guidance for this supplier + document type. Applied to every future extraction."
      />
    </Box>
  );
}
