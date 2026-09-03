/**
 * Editor for the DOCUMENT-TYPE layer of the extraction prompt stack
 * (migration 0098).
 *
 * Opened from the Document Types admin screen, because that is where somebody
 * goes when the question in their head is "how should we be reading a
 * Certificate of Insurance" — not "what does Darigold's Certificate of
 * Insurance look like", which is the supplier page's question.
 *
 * THE LAYERING IS SHOWN, NOT HIDDEN. When suppliers have authored their own
 * guidance for the same type, they are listed here with the plain statement
 * that their text is read AFTER this one and refines it. An admin who edits
 * type-level guidance without knowing four suppliers say something narrower
 * will eventually write two rules that contradict each other and have no way
 * to find out.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { DocumentTypeInstructionsSupplierOverride } from '../lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  documentTypeId: string;
  documentTypeName: string;
  /** super_admin has no implicit tenant and the API 400s without one. */
  tenantId?: string;
  /** Fired after a successful save or removal so a list can refresh its badges. */
  onSaved?: () => void;
}

export function DocumentTypeInstructionsDialog({
  open,
  onClose,
  documentTypeId,
  documentTypeName,
  tenantId,
  onSaved,
}: Props) {
  const [value, setValue] = useState('');
  /** What the server currently holds — the Save button compares against this. */
  const [persisted, setPersisted] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<DocumentTypeInstructionsSupplierOverride[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.documentTypeInstructions.get({
        document_type_id: documentTypeId,
        tenant_id: tenantId,
      });
      setValue(res.instructions ?? '');
      setPersisted(res.instructions);
      setOverrides(res.supplier_overrides);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load instructions');
    } finally {
      setLoading(false);
    }
  }, [documentTypeId, tenantId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.documentTypeInstructions.put({
        document_type_id: documentTypeId,
        instructions: value,
        tenant_id: tenantId,
      });
      setPersisted(value.trim());
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save instructions');
    } finally {
      setSaving(false);
    }
  };

  // Removing the layer is distinct from blanking it: a blank row still exists
  // and still reads as "somebody looked at this type and had nothing to add".
  const handleRemove = async () => {
    setSaving(true);
    setError('');
    try {
      await api.documentTypeInstructions.remove({
        document_type_id: documentTypeId,
        tenant_id: tenantId,
      });
      setValue('');
      setPersisted(null);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove instructions');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Extraction instructions — {documentTypeName}
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Guidance for reading this KIND of document, from any supplier — what to pull out and
          where it usually sits on the page. It applies to every supplier, including one that has
          never sent anything before, so a new vendor's first document is not read blind.
          {' '}Guidance can say where to look; it can never make the AI supply a unit, specification
          or verdict the document did not print.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            <TextField
              multiline
              rows={8}
              fullWidth
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={saving}
              placeholder={
                'e.g., "The expiry is the end of the policy period in the top-right box, ' +
                'labelled Policy Exp. The issuing body is the insurer on the letterhead, ' +
                'not the broker in the Producer box."'
              }
            />

            {/* The layering, stated rather than implied. */}
            <Box sx={{ mt: 2 }}>
              {overrides.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  No supplier refines this type yet — this text is the whole instruction for every
                  supplier that sends one.
                </Typography>
              ) : (
                <>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                    {overrides.length} supplier{overrides.length === 1 ? '' : 's'} refine
                    {overrides.length === 1 ? 's' : ''} this type. Their guidance is read AFTER
                    this text, and wins where the two disagree:
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                    {overrides.map((o) => (
                      <Chip key={o.supplier_id} label={o.supplier_name} size="small" variant="outlined" />
                    ))}
                  </Box>
                </>
              )}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {persisted !== null && (
          <Button color="error" onClick={handleRemove} disabled={saving || loading} sx={{ mr: 'auto' }}>
            Remove
          </Button>
        )}
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || loading || value.trim() === (persisted ?? '')}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
