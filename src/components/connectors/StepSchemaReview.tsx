/**
 * Step 3 of the file-first wizard: review the columns the backend detected
 * and map each one to a canonical dox field (core) or an extended metadata
 * key. Replaces the legacy StepFieldMapping.tsx component.
 *
 * The source of truth is the v2 ConnectorFieldMappings held in
 * state.fieldMappings. Each detected column's current target is derived by
 * scanning that mapping — so the UI always reflects the saved config.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
  type SelectChangeEvent,
} from '@mui/material';
import {
  AutoAwesome as SparkleIcon,
} from '@mui/icons-material';
import type { DetectedField, DiscoverSchemaResponse } from '../../types/connectorSchema';
import {
  TARGET_EXTENDED,
  TARGET_OPTIONS,
  isCoreFieldKey,
  toSnakeCase,
  targetOptionLabel,
  type ConnectorFieldMappings,
  type CoreFieldKey,
} from './doxFields';
import {
  ACCEPT_AI_THRESHOLD,
  acceptAllHighConfidenceSuggestions,
  applyTargetToMappings,
  currentTargetFor,
} from './fieldMappingActions';

interface StepSchemaReviewProps {
  sample: DiscoverSchemaResponse | null;
  fieldMappings: ConnectorFieldMappings;
  onFieldMappingsChange: (mappings: ConnectorFieldMappings) => void;
}

// =============================================================================
// Component
// =============================================================================

function confidenceColor(confidence: number | undefined): 'success' | 'warning' | 'error' | 'default' {
  if (confidence === undefined) return 'default';
  if (confidence >= 0.85) return 'success';
  if (confidence >= 0.5) return 'warning';
  return 'error';
}

function DetectedFieldRow({
  field,
  mappings,
  onChange,
}: {
  field: DetectedField;
  mappings: ConnectorFieldMappings;
  onChange: (m: ConnectorFieldMappings) => void;
}) {
  const current = currentTargetFor(mappings, field.name);
  const [extendedKey, setExtendedKey] = useState<string>(
    current.extendedKey || toSnakeCase(field.name),
  );

  // Look up format_hint from the current target so the TextField stays in sync
  // across re-renders. For core fields we read mappings.core[target].format_hint;
  // for extended we read mappings.extended[key].format_hint.
  const currentFormatHint = useMemo(() => {
    if (isCoreFieldKey(current.target)) {
      return mappings.core[current.target as CoreFieldKey]?.format_hint ?? '';
    }
    if (current.target === TARGET_EXTENDED && current.extendedKey) {
      return (
        mappings.extended.find((e) => e.key === current.extendedKey)?.format_hint ?? ''
      );
    }
    return '';
  }, [mappings, current.target, current.extendedKey]);

  const handleTargetChange = (e: SelectChangeEvent<string>) => {
    const next = applyTargetToMappings(mappings, field, e.target.value, {
      extendedKey,
      extendedLabel: field.name,
    });
    onChange(next);
  };

  const handleExtendedKeyChange = (value: string) => {
    setExtendedKey(value);
    if (current.target === TARGET_EXTENDED) {
      const next = applyTargetToMappings(mappings, field, TARGET_EXTENDED, {
        extendedKey: value,
        extendedLabel: field.name,
        formatHint: currentFormatHint || undefined,
      });
      onChange(next);
    }
  };

  const handleFormatHintChange = (value: string) => {
    // Re-apply using the current target, passing the new format hint through.
    const next = applyTargetToMappings(mappings, field, current.target, {
      extendedKey,
      extendedLabel: field.name,
      formatHint: value,
    });
    onChange(next);
  };

  const showExtendedKey = current.target === TARGET_EXTENDED;
  const showFormatHint =
    isCoreFieldKey(current.target) &&
    (field.inferred_type === 'date' || field.inferred_type === 'id');

  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ pb: '16px !important' }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ xs: 'stretch', md: 'center' }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle2" fontWeight={600}>
                {field.name}
              </Typography>
              <Chip label={field.inferred_type} size="small" variant="outlined" />
              {field.confidence !== undefined && (
                <Chip
                  label={`${Math.round(field.confidence * 100)}% match`}
                  size="small"
                  color={confidenceColor(field.confidence)}
                />
              )}
            </Stack>
            {field.sample_values.length > 0 && (
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                sx={{ mt: 0.5, wordBreak: 'break-word' }}
              >
                Sample: {field.sample_values.slice(0, 3).join(', ')}
                {field.sample_values.length > 3 ? '…' : ''}
              </Typography>
            )}
          </Box>
          <Box sx={{ minWidth: { md: 260 }, flex: { xs: '1 1 auto', md: '0 0 auto' } }}>
            <FormControl fullWidth size="small">
              <InputLabel id={`target-${field.name}`}>Map to</InputLabel>
              <Select
                labelId={`target-${field.name}`}
                label="Map to"
                value={current.target}
                onChange={handleTargetChange}
                inputProps={{ 'aria-label': `Map column ${field.name} to` }}
              >
                {TARGET_OPTIONS.map((opt) => (
                  <MenuItem key={opt} value={opt}>
                    {targetOptionLabel(opt)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </Stack>

        {(showExtendedKey || showFormatHint) && (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mt: 1.5 }}>
            {showExtendedKey && (
              <TextField
                size="small"
                label="Metadata key"
                helperText="snake_case; used in extended_metadata JSON"
                value={extendedKey}
                onChange={(e) => handleExtendedKeyChange(e.target.value)}
                sx={{ flex: 1 }}
              />
            )}
            {(showExtendedKey || showFormatHint) && (
              <TextField
                size="small"
                label="Format hint"
                placeholder="e.g. YYYY-MM-DD"
                value={currentFormatHint}
                onChange={(e) => handleFormatHintChange(e.target.value)}
                sx={{ flex: 1 }}
              />
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function StepSchemaReview({
  sample,
  fieldMappings,
  onFieldMappingsChange,
}: StepSchemaReviewProps) {
  const orderNumberMapped = useMemo(() => {
    const core = fieldMappings.core.order_number;
    return !!core && core.enabled && core.source_labels.length > 0;
  }, [fieldMappings]);

  // Detect which sheet names are present — XLSX flows stamp sheet_name on
  // every detected field; CSV/PDF/email leave it undefined so the picker
  // is hidden.
  const sheetNames = useMemo(() => {
    if (!sample) return [] as string[];
    const names = new Set<string>();
    for (const f of sample.detected_fields) {
      if (f.sheet_name) names.add(f.sheet_name);
    }
    return Array.from(names);
  }, [sample]);

  const hasMultipleSheets = sheetNames.length > 1;

  // Default sheet = whichever sheet has the most detected fields.
  const defaultSheet = useMemo(() => {
    if (!hasMultipleSheets || !sample) return null;
    const counts = new Map<string, number>();
    for (const f of sample.detected_fields) {
      if (f.sheet_name) counts.set(f.sheet_name, (counts.get(f.sheet_name) || 0) + 1);
    }
    let best: string | null = null;
    let bestCount = -1;
    for (const [name, n] of counts) {
      if (n > bestCount) { best = name; bestCount = n; }
    }
    return best;
  }, [sample, hasMultipleSheets]);

  const [activeSheet, setActiveSheet] = useState<string | null>(defaultSheet);

  // If defaultSheet changes (new sample uploaded), resync.
  useEffect(() => {
    setActiveSheet(defaultSheet);
  }, [defaultSheet]);

  const visibleFields = useMemo(() => {
    if (!sample) return [];
    if (!hasMultipleSheets || !activeSheet) return sample.detected_fields;
    return sample.detected_fields.filter((f) => f.sheet_name === activeSheet);
  }, [sample, hasMultipleSheets, activeSheet]);

  const handleAcceptAll = useCallback(() => {
    if (!sample) return;
    const next = acceptAllHighConfidenceSuggestions(fieldMappings, sample.detected_fields);
    onFieldMappingsChange(next);
  }, [sample, fieldMappings, onFieldMappingsChange]);

  if (!sample) {
    return (
      <Alert severity="warning">
        Upload a sample in the previous step before reviewing fields.
      </Alert>
    );
  }

  if (sample.detected_fields.length === 0) {
    return (
      <Alert severity="warning">
        No fields were detected in the uploaded sample. Please go back and upload a different file.
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
        Review detected fields
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        We found {sample.detected_fields.length} column
        {sample.detected_fields.length === 1 ? '' : 's'}. Confirm how each one maps to a dox
        field, add extra columns as extended metadata, or skip anything that isn't relevant.
      </Typography>

      {!orderNumberMapped && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <strong>Order Number</strong> must be mapped to at least one detected column before
          you can continue.
        </Alert>
      )}

      <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
        <Button
          size="small"
          variant="outlined"
          startIcon={<SparkleIcon />}
          onClick={handleAcceptAll}
        >
          Accept all AI suggestions
        </Button>
        <Typography variant="caption" color="text.secondary">
          Applies suggestions with ≥ {Math.round(ACCEPT_AI_THRESHOLD * 100)}% confidence.
        </Typography>
      </Stack>

      {hasMultipleSheets && (
        <FormControl size="small" sx={{ mb: 2, minWidth: 240 }}>
          <InputLabel id="sheet-picker-label">Sheet</InputLabel>
          <Select
            labelId="sheet-picker-label"
            label="Sheet"
            value={activeSheet || ''}
            onChange={(e) => setActiveSheet(e.target.value || null)}
            inputProps={{ 'aria-label': 'Filter detected fields by sheet' }}
          >
            {sheetNames.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {sample.warnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {sample.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </Alert>
      )}

      {visibleFields.map((field) => (
        <DetectedFieldRow
          key={`${field.sheet_name ?? ''}:${field.name}`}
          field={field}
          mappings={fieldMappings}
          onChange={onFieldMappingsChange}
        />
      ))}
    </Box>
  );
}
