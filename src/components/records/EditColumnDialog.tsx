/**
 * EditColumnDialog — edit an existing column's name, help text, required
 * flag, and (for dropdown_single / dropdown_multi) its options list.
 *
 * Out of scope by design:
 *   - Changing the column TYPE post-creation. Data migration is non-trivial
 *     (text -> dropdown can't safely auto-coerce, etc.) so the type is
 *     surfaced as read-only with help text. If the user wants a different
 *     type they delete and recreate.
 *
 * Behavior notes:
 *   - Options reorder uses up/down arrow buttons (same pattern as the
 *     form-field reorder elsewhere) — drag&drop would be heavier than the
 *     surface deserves.
 *   - Save is disabled until the user has actually changed something.
 *   - Cells whose values reference an option that was renamed/removed
 *     keep their raw value — CellRenderer falls back to the value string
 *     so nothing breaks visually.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  FormControlLabel,
} from '@mui/material';
import {
  Close as CloseIcon,
  Add as AddIcon,
  DeleteOutline as DeleteIcon,
  ArrowUpward as ArrowUpIcon,
  ArrowDownward as ArrowDownIcon,
} from '@mui/icons-material';
import type {
  ApiRecordColumn,
  RecordColumnDropdownOption,
  RecordColumnDropdownConfig,
  UpdateColumnRequest,
} from '../../../shared/types';
import { parseConfig } from './cellHelpers';

interface EditColumnDialogProps {
  open: boolean;
  column: ApiRecordColumn | null;
  onClose: () => void;
  onSave: (columnId: string, data: UpdateColumnRequest) => Promise<void>;
}

const DROPDOWN_TYPES = new Set(['dropdown_single', 'dropdown_multi']);

interface OptionDraft {
  value: string;
  label: string;
}

function configToDrafts(column: ApiRecordColumn | null): OptionDraft[] {
  if (!column) return [];
  const cfg = parseConfig(column) as RecordColumnDropdownConfig | undefined;
  const opts = cfg?.options ?? [];
  return opts.map((o) => ({ value: o.value, label: o.label ?? o.value }));
}

function readHelpText(column: ApiRecordColumn | null): string {
  if (!column) return '';
  const cfg = parseConfig(column) as { help_text?: unknown } | undefined;
  return typeof cfg?.help_text === 'string' ? cfg.help_text : '';
}

export function EditColumnDialog({ open, column, onClose, onSave }: EditColumnDialogProps) {
  const [label, setLabel] = useState('');
  const [helpText, setHelpText] = useState('');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isDropdown = column ? DROPDOWN_TYPES.has(column.type) : false;

  // Initial values, captured for change-detection on save-disabled.
  const initial = useMemo(() => {
    return {
      label: column?.label ?? '',
      helpText: readHelpText(column),
      required: column ? column.required === 1 : false,
      options: configToDrafts(column),
    };
  }, [column]);

  // Reset local state whenever the dialog opens for a different column.
  useEffect(() => {
    if (open && column) {
      setLabel(initial.label);
      setHelpText(initial.helpText);
      setRequired(initial.required);
      setOptions(initial.options);
      setError('');
    }
  }, [open, column, initial]);

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  const setOptionLabel = (idx: number, next: string) => {
    setOptions((prev) => prev.map((o, i) => (i === idx ? { ...o, label: next, value: next } : o)));
  };

  const removeOption = (idx: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  };

  const addOption = () => {
    setOptions((prev) => [...prev, { value: '', label: '' }]);
  };

  const moveOption = (idx: number, dir: -1 | 1) => {
    setOptions((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  // Has the user actually changed anything? Used to disable the Save button
  // when the form would be a no-op.
  const dirty = useMemo(() => {
    if (!column) return false;
    if (label.trim() !== initial.label) return true;
    if (helpText !== initial.helpText) return true;
    if (required !== initial.required) return true;
    if (isDropdown) {
      const a = initial.options;
      const b = options;
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i++) {
        if (a[i].value !== b[i].value || a[i].label !== b[i].label) return true;
      }
    }
    return false;
  }, [column, label, helpText, required, options, initial, isDropdown]);

  const handleSubmit = async () => {
    if (!column) return;
    if (!label.trim()) {
      setError('Column name is required');
      return;
    }
    if (isDropdown) {
      const cleaned = options.map((o) => o.label.trim()).filter(Boolean);
      const seen = new Set<string>();
      for (const v of cleaned) {
        if (seen.has(v)) {
          setError(`Duplicate option: "${v}"`);
          return;
        }
        seen.add(v);
      }
    }

    setSubmitting(true);
    setError('');
    try {
      const data: UpdateColumnRequest = {};
      if (label.trim() !== initial.label) {
        data.label = label.trim();
      }
      if (required !== initial.required) {
        data.required = required;
      }

      // Build a merged config that preserves any non-options/help_text
      // keys we don't manage in this dialog.
      const existingCfg = (parseConfig(column) ?? {}) as Record<string, unknown>;
      const nextCfg: Record<string, unknown> = { ...existingCfg };
      let configChanged = false;

      if (helpText !== initial.helpText) {
        if (helpText.trim()) {
          nextCfg.help_text = helpText;
        } else {
          delete nextCfg.help_text;
        }
        configChanged = true;
      }

      if (isDropdown) {
        const optsOut: RecordColumnDropdownOption[] = options
          .map((o) => o.label.trim())
          .filter(Boolean)
          .map((v) => ({ value: v, label: v }));
        const initialMatches =
          optsOut.length === initial.options.length &&
          optsOut.every((o, i) => o.value === initial.options[i].value && o.label === initial.options[i].label);
        if (!initialMatches) {
          nextCfg.options = optsOut;
          configChanged = true;
        }
      }

      if (configChanged) {
        data.config = nextCfg;
      }

      if (Object.keys(data).length === 0) {
        // Nothing changed — just close.
        onClose();
        return;
      }

      await onSave(column.id, data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save column');
    } finally {
      setSubmitting(false);
    }
  };

  if (!column) return null;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Edit column
        <IconButton size="small" onClick={handleClose} disabled={submitting}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Column name"
            fullWidth
            autoFocus
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={submitting}
          />

          <TextField
            label="Help text (optional)"
            placeholder="Shown to users filling out forms"
            fullWidth
            value={helpText}
            onChange={(e) => setHelpText(e.target.value)}
            disabled={submitting}
          />

          {/* Type — read-only. Changing the type would require migrating
              existing cell data, which is out of scope. The user can
              delete and recreate if they want a different type. */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Type
            </Typography>
            <TextField
              fullWidth
              value={column.type}
              disabled
              helperText="Type can't be changed after creation."
            />
          </Box>

          <FormControlLabel
            control={
              <Switch
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                disabled={submitting}
              />
            }
            label="Required"
          />

          {isDropdown && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Options
              </Typography>
              {options.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  No options yet. Add one below.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {options.map((opt, idx) => (
                    <Stack key={idx} direction="row" spacing={0.5} alignItems="center">
                      <TextField
                        value={opt.label}
                        onChange={(e) => setOptionLabel(idx, e.target.value)}
                        placeholder="Option label"
                        size="small"
                        fullWidth
                        disabled={submitting}
                      />
                      <Tooltip title="Move up">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => moveOption(idx, -1)}
                            disabled={submitting || idx === 0}
                            aria-label="Move option up"
                          >
                            <ArrowUpIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move down">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => moveOption(idx, 1)}
                            disabled={submitting || idx === options.length - 1}
                            aria-label="Move option down"
                          >
                            <ArrowDownIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Remove option">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => removeOption(idx)}
                            disabled={submitting}
                            aria-label="Remove option"
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  ))}
                </Stack>
              )}
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={addOption}
                disabled={submitting}
                sx={{ mt: 1 }}
              >
                Add option
              </Button>
            </Box>
          )}

          {error && <Typography variant="body2" color="error">{error}</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={!label.trim() || !dirty || submitting}
        >
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
