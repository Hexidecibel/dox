/**
 * Inline field-mappings editor for the ConnectorDetail page.
 *
 * This is a sibling to StepSchemaReview, not a replacement. The wizard's
 * StepSchemaReview operates on *detected* columns from a freshly-uploaded
 * sample — each row represents a source column and the user picks which
 * canonical dox field it maps onto. This editor, by contrast, operates on
 * the *current v2 ConnectorFieldMappings* directly: one row per core field,
 * plus one row per extended field, with the core field row showing an
 * enabled toggle + source-label chip input + format-hint field.
 *
 * Keep this file JSX-only + presentational. All mutation logic must remain
 * in parent state so the parent can batch saves and roll back on API error.
 *
 * Deliberately NOT importing from StepSchemaReview or touching
 * fieldMappingActions.ts — the parallel "auto-suggestion matching" agent
 * owns that module.
 */

import { useRef, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Delete as DeleteIcon, Add as AddIcon } from '@mui/icons-material';
import {
  CORE_FIELD_DEFINITIONS,
  type ConnectorFieldMappings,
  type CoreFieldKey,
  type FieldMappingExtended,
  toSnakeCase,
} from './doxFields';
import {
  appendBlankExtendedField,
  deleteExtendedField,
  updateCoreField,
  updateExtendedField,
} from './detailMappingActions';

interface Props {
  mappings: ConnectorFieldMappings;
  onCommit: (next: ConnectorFieldMappings) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function CoreFieldRow({
  defKey,
  label,
  required,
  enabled,
  sourceLabels,
  formatHint,
  disabled,
  onChange,
}: {
  defKey: CoreFieldKey;
  label: string;
  required: boolean;
  enabled: boolean;
  sourceLabels: string[];
  formatHint: string;
  disabled?: boolean;
  onChange: (patch: { enabled?: boolean; sourceLabels?: string[]; formatHint?: string }) => void;
}) {
  // Local copy of format hint so typing doesn't blur-save on every keystroke.
  const [localHint, setLocalHint] = useState(formatHint);
  // Keep local in sync when the mapping is reset externally (save rollback).
  if (localHint !== formatHint && document.activeElement?.getAttribute('data-field-key') !== defKey) {
    setLocalHint(formatHint);
  }

  // Buffered input for the chip Autocomplete so we can auto-commit on
  // comma/semicolon/blur, not just Enter.
  const [labelInput, setLabelInput] = useState('');
  const sourceLabelsRef = useRef(sourceLabels);
  sourceLabelsRef.current = sourceLabels;

  const commitLabels = (list: string[]) => {
    const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const s of cleaned) {
      const k = s.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(s);
      }
    }
    onChange({ sourceLabels: dedup });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5, bgcolor: enabled ? undefined : 'grey.50' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ xs: 'stretch', md: 'flex-start' }}>
        <Box sx={{ minWidth: 180, pt: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Switch
              size="small"
              checked={enabled}
              disabled={disabled || required}
              onChange={(e) => onChange({ enabled: e.target.checked })}
              inputProps={{ 'aria-label': `Enable ${label}` }}
            />
            <Box>
              <Typography variant="subtitle2" fontWeight={600}>
                {label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {defKey}
                {required ? ' · required' : ''}
              </Typography>
            </Box>
          </Stack>
        </Box>
        <Box sx={{ flex: 1 }}>
          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={[]}
            value={sourceLabels}
            inputValue={labelInput}
            disabled={disabled || !enabled}
            onChange={(_, next) => commitLabels(next as string[])}
            onInputChange={(_, newInput, reason) => {
              if (reason === 'input' && /[,;]/.test(newInput)) {
                const parts = newInput.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
                if (parts.length > 0) {
                  commitLabels([...sourceLabelsRef.current, ...parts]);
                }
                setLabelInput('');
                return;
              }
              if (reason !== 'reset') {
                setLabelInput(newInput);
              } else {
                setLabelInput('');
              }
            }}
            onBlur={() => {
              const text = labelInput.trim();
              if (text) {
                commitLabels([...sourceLabelsRef.current, text]);
                setLabelInput('');
              }
            }}
            renderTags={(value: readonly string[], getTagProps) =>
              value.map((option: string, index: number) => {
                const { key, ...tagProps } = getTagProps({ index });
                return <Chip key={key} label={option} size="small" {...tagProps} />;
              })
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Source labels"
                placeholder="Type a column header and press Enter, comma, or Tab"
                helperText="Column headers that should map onto this field (case-insensitive). Press Enter, comma, semicolon, or Tab to add."
              />
            )}
          />
          <TextField
            size="small"
            label="Format hint"
            placeholder="e.g. SO-12345"
            value={localHint}
            disabled={disabled || !enabled}
            onChange={(e) => setLocalHint(e.target.value)}
            onBlur={() => {
              if (localHint !== formatHint) {
                onChange({ formatHint: localHint });
              }
            }}
            inputProps={{ 'data-field-key': defKey }}
            fullWidth
            sx={{ mt: 1.5 }}
          />
        </Box>
      </Stack>
    </Paper>
  );
}

function ExtendedFieldRow({
  field,
  disabled,
  onChange,
  onDelete,
}: {
  field: FieldMappingExtended;
  disabled?: boolean;
  onChange: (patch: Partial<FieldMappingExtended>) => void;
  onDelete: () => void;
}) {
  const [localLabel, setLocalLabel] = useState(field.label);
  const [localKey, setLocalKey] = useState(field.key);
  const [localHint, setLocalHint] = useState(field.format_hint ?? '');

  const [labelInput, setLabelInput] = useState('');
  const sourceLabelsRef = useRef(field.source_labels);
  sourceLabelsRef.current = field.source_labels;

  const commitLabels = (list: string[]) => {
    const cleaned = list.map((s) => s.trim()).filter((s) => s.length > 0);
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const s of cleaned) {
      const k = s.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(s);
      }
    }
    onChange({ source_labels: dedup });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ xs: 'stretch', md: 'flex-start' }}>
        <Box sx={{ minWidth: 180 }}>
          <TextField
            size="small"
            label="Label"
            value={localLabel}
            disabled={disabled}
            onChange={(e) => setLocalLabel(e.target.value)}
            onBlur={() => {
              if (localLabel !== field.label) onChange({ label: localLabel });
            }}
            fullWidth
          />
          <TextField
            size="small"
            label="Metadata key"
            value={localKey}
            disabled={disabled}
            onChange={(e) => setLocalKey(toSnakeCase(e.target.value))}
            onBlur={() => {
              const snake = toSnakeCase(localKey);
              setLocalKey(snake);
              if (snake && snake !== field.key) onChange({ key: snake });
            }}
            fullWidth
            sx={{ mt: 1 }}
            helperText="snake_case"
          />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Autocomplete
            multiple
            freeSolo
            size="small"
            options={[]}
            value={field.source_labels}
            inputValue={labelInput}
            disabled={disabled}
            onChange={(_, next) => commitLabels(next as string[])}
            onInputChange={(_, newInput, reason) => {
              if (reason === 'input' && /[,;]/.test(newInput)) {
                const parts = newInput.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
                if (parts.length > 0) {
                  commitLabels([...sourceLabelsRef.current, ...parts]);
                }
                setLabelInput('');
                return;
              }
              if (reason !== 'reset') {
                setLabelInput(newInput);
              } else {
                setLabelInput('');
              }
            }}
            onBlur={() => {
              const text = labelInput.trim();
              if (text) {
                commitLabels([...sourceLabelsRef.current, text]);
                setLabelInput('');
              }
            }}
            renderTags={(value: readonly string[], getTagProps) =>
              value.map((option: string, index: number) => {
                const { key, ...tagProps } = getTagProps({ index });
                return <Chip key={key} label={option} size="small" {...tagProps} />;
              })
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Source labels"
                placeholder="Type a column header and press Enter, comma, or Tab"
              />
            )}
          />
          <TextField
            size="small"
            label="Format hint"
            value={localHint}
            disabled={disabled}
            onChange={(e) => setLocalHint(e.target.value)}
            onBlur={() => {
              const next = localHint.trim();
              if (next !== (field.format_hint ?? '')) {
                onChange({ format_hint: next || undefined });
              }
            }}
            fullWidth
            sx={{ mt: 1.5 }}
          />
        </Box>
        <Box sx={{ pt: 0.5 }}>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={onDelete}
            disabled={disabled}
          >
            Remove
          </Button>
        </Box>
      </Stack>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Main editor
// ---------------------------------------------------------------------------

export function FieldMappingEditor({ mappings, onCommit, disabled }: Props) {
  const commit = (next: ConnectorFieldMappings) => onCommit(next);

  const updateCore = (
    key: CoreFieldKey,
    patch: { enabled?: boolean; sourceLabels?: string[]; formatHint?: string },
  ) => {
    commit(
      updateCoreField(mappings, key, {
        enabled: patch.enabled,
        source_labels: patch.sourceLabels,
        format_hint: patch.formatHint,
      }),
    );
  };

  const updateExtended = (idx: number, patch: Partial<FieldMappingExtended>) => {
    commit(updateExtendedField(mappings, idx, patch));
  };

  const deleteExtended = (idx: number) => {
    commit(deleteExtendedField(mappings, idx));
  };

  const addExtended = () => {
    commit(appendBlankExtendedField(mappings));
  };

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
        Core fields
      </Typography>
      {CORE_FIELD_DEFINITIONS.map((def) => {
        const core = mappings.core[def.key];
        if (!core) return null;
        return (
          <CoreFieldRow
            key={def.key}
            defKey={def.key}
            label={def.label}
            required={def.required}
            enabled={core.enabled}
            sourceLabels={core.source_labels}
            formatHint={core.format_hint ?? ''}
            disabled={disabled}
            onChange={(patch) => updateCore(def.key, patch)}
          />
        );
      })}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 3, mb: 1 }}>
        <Typography variant="subtitle1" fontWeight={600}>
          Extended fields
        </Typography>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={addExtended}
          disabled={disabled}
        >
          Add extended field
        </Button>
      </Box>
      {mappings.extended.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          No extended fields yet. Add one to capture source columns that don't map onto a core dox field.
        </Typography>
      ) : (
        mappings.extended.map((e, idx) => (
          <ExtendedFieldRow
            key={`${e.key}-${idx}`}
            field={e}
            disabled={disabled}
            onChange={(patch) => updateExtended(idx, patch)}
            onDelete={() => deleteExtended(idx)}
          />
        ))
      )}
    </Box>
  );
}
