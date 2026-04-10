import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Alert,
  Checkbox,
  FormControlLabel,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  MenuItem,
  FormControl,
  Paper,
} from '@mui/material';
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';

interface WizardState {
  connectorType: 'email' | 'api_poll' | 'webhook' | 'file_watch' | null;
  name: string;
  systemType: 'erp' | 'wms' | 'other';
  config: Record<string, unknown>;
  fieldMappings: Record<string, string>;
  credentials: Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
}

interface StepProps {
  state: WizardState;
  onChange: (updates: Partial<WizardState>) => void;
}

const DOX_FIELDS = [
  { key: 'order_number', label: 'Order Number', required: true, hint: 'Order or SO number' },
  { key: 'customer_number', label: 'Customer Number', required: false, hint: 'Customer ID (e.g., K00123)' },
  { key: 'customer_name', label: 'Customer Name', required: false, hint: 'Business name' },
  { key: 'po_number', label: 'PO Number', required: false, hint: 'Purchase order reference' },
  { key: 'product_name', label: 'Product Name', required: false, hint: 'Product description' },
  { key: 'product_code', label: 'Product Code', required: false, hint: 'SKU or product code' },
  { key: 'quantity', label: 'Quantity', required: false, hint: 'Order quantity' },
  { key: 'lot_number', label: 'Lot Number', required: false, hint: 'Lot or batch number' },
];

const DEFAULT_CHECKED = ['order_number', 'customer_number', 'customer_name'];

/** Fuzzy match a source field name to a dox field key */
function autoSuggest(sourceField: string, doxFields: typeof DOX_FIELDS): string {
  const normalized = sourceField.toLowerCase().replace(/[^a-z0-9]/g, '');

  const matchers: [RegExp, string][] = [
    [/order(?:num|no|number|id|#)?/, 'order_number'],
    [/(?:so|sales)(?:num|no|number|id)?/, 'order_number'],
    [/cust(?:omer)?(?:num|no|number|id|#|code)?/, 'customer_number'],
    [/cust(?:omer)?name/, 'customer_name'],
    [/(?:business|company|acct)name/, 'customer_name'],
    [/po(?:num|no|number|#)?/, 'po_number'],
    [/purchase(?:order)?(?:num|no|number)?/, 'po_number'],
    [/prod(?:uct)?(?:name|desc(?:ription)?)/, 'product_name'],
    [/item(?:name|desc(?:ription)?)/, 'product_name'],
    [/prod(?:uct)?(?:code|sku|id|num|no)/, 'product_code'],
    [/sku/, 'product_code'],
    [/qty|quantity|amount/, 'quantity'],
    [/lot(?:num|no|number|id|#)?/, 'lot_number'],
    [/batch(?:num|no|number|id)?/, 'lot_number'],
  ];

  for (const [regex, doxKey] of matchers) {
    if (regex.test(normalized) && doxFields.some((f) => f.key === doxKey)) {
      return doxKey;
    }
  }
  return '__skip__';
}

/** Parse CSV header into column names */
function parseCsvHeaders(header: string): string[] {
  if (!header.trim()) return [];
  return header
    .split(',')
    .map((h) => h.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Extract keys from JSON (top level + one level of nesting) */
function extractJsonKeys(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== 'object') return [];

    const keys: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      keys.push(key);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const nestedKey of Object.keys(value as object)) {
          keys.push(`${key}.${nestedKey}`);
        }
      }
    }
    return keys;
  } catch {
    return [];
  }
}

function isAiMode(connectorType: string | null): boolean {
  return connectorType === 'email';
}

function AiFieldSelector({ state, onChange }: StepProps) {
  const checkedFields = Object.keys(state.fieldMappings);
  const fieldHints = (state.config.field_hints as Record<string, string>) || {};

  // Initialize defaults if empty
  const effectiveChecked = checkedFields.length > 0 ? checkedFields : DEFAULT_CHECKED;

  const handleToggle = (key: string) => {
    const newMappings = { ...state.fieldMappings };
    if (newMappings[key]) {
      delete newMappings[key];
    } else {
      newMappings[key] = key;
    }
    onChange({ fieldMappings: newMappings });
  };

  const handleHint = (key: string, hint: string) => {
    const newHints = { ...fieldHints, [key]: hint };
    if (!hint) delete newHints[key];
    onChange({ config: { ...state.config, field_hints: newHints } });
  };

  // Auto-initialize default checked fields on first render
  if (checkedFields.length === 0) {
    const initial: Record<string, string> = {};
    for (const key of DEFAULT_CHECKED) {
      initial[key] = key;
    }
    onChange({ fieldMappings: initial });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Alert severity="info">
        Our AI automatically extracts these fields from your emails. Check the fields you expect in your data.
      </Alert>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {DOX_FIELDS.map((field) => (
          <FormControlLabel
            key={field.key}
            control={
              <Checkbox
                checked={effectiveChecked.includes(field.key)}
                onChange={() => handleToggle(field.key)}
                size="small"
              />
            }
            label={
              <Box>
                <Typography variant="body2" component="span" fontWeight={500}>
                  {field.label}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                  {field.hint}
                </Typography>
              </Box>
            }
          />
        ))}
      </Box>

      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2">Format hints</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            Provide example values to help the AI recognize each field in your emails.
          </Typography>
          {DOX_FIELDS.filter((f) => effectiveChecked.includes(f.key)).map((field) => (
            <TextField
              key={field.key}
              label={field.label}
              size="small"
              fullWidth
              value={fieldHints[field.key] || ''}
              onChange={(e) => handleHint(field.key, e.target.value)}
              placeholder={
                field.key === 'customer_number'
                  ? 'e.g., K00123, P000456'
                  : field.key === 'order_number'
                    ? 'e.g., SO-12345, ORD-2026-001'
                    : `Example ${field.label.toLowerCase()}`
              }
            />
          ))}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

function ManualFieldMapper({ state, onChange }: StepProps) {
  const [sampleInput, setSampleInput] = useState('');
  const [sourceFields, setSourceFields] = useState<string[]>([]);

  const isJsonMode = state.connectorType === 'api_poll' || state.connectorType === 'webhook';

  const handleSampleChange = (value: string) => {
    setSampleInput(value);
    const detected = isJsonMode ? extractJsonKeys(value) : parseCsvHeaders(value);
    setSourceFields(detected);

    // Auto-suggest mappings for newly detected fields
    if (detected.length > 0) {
      const newMappings: Record<string, string> = {};
      for (const source of detected) {
        const suggested = autoSuggest(source, DOX_FIELDS);
        if (suggested !== '__skip__') {
          // Only auto-suggest if no other source already maps to the same dox field
          const alreadyMapped = Object.values(newMappings).includes(suggested);
          if (!alreadyMapped) {
            newMappings[source] = suggested;
          }
        }
      }
      onChange({ fieldMappings: newMappings });
    }
  };

  // Validation: check required fields
  const mappedKeys = new Set(Object.values(state.fieldMappings));
  const missingRequired = DOX_FIELDS.filter((f) => f.required && !mappedKeys.has(f.key));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {isJsonMode ? 'Paste a sample JSON response' : 'Paste a CSV header row'}
        </Typography>
        <TextField
          fullWidth
          size="small"
          multiline={isJsonMode}
          rows={isJsonMode ? 6 : 1}
          value={sampleInput}
          onChange={(e) => handleSampleChange(e.target.value)}
          placeholder={
            isJsonMode
              ? '{"order_number": "SO-123", "customer": "Acme Corp", ...}'
              : 'order_no, customer_id, customer_name, po, sku, qty, lot'
          }
          sx={isJsonMode ? { '& .MuiInputBase-input': { fontFamily: 'monospace', fontSize: '0.8rem' } } : {}}
        />
      </Box>

      {sourceFields.length > 0 && (
        <>
          {missingRequired.length > 0 && (
            <Alert severity="warning" sx={{ py: 0.5 }}>
              Required fields not mapped: {missingRequired.map((f) => f.label).join(', ')}
            </Alert>
          )}

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>dox Field</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Maps From</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {DOX_FIELDS.map((field) => {
                  // Find which source field currently maps to this dox field
                  const currentSource = Object.entries(state.fieldMappings).find(
                    ([, v]) => v === field.key
                  )?.[0] || '__skip__';

                  return (
                    <TableRow key={field.key}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={500}>
                          {field.label}
                          {field.required && (
                            <Typography component="span" color="error.main"> *</Typography>
                          )}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {field.hint}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <FormControl fullWidth size="small">
                          <Select
                            value={currentSource}
                            onChange={(e) => {
                              // Remove old mapping for this dox field
                              const newMappings = { ...state.fieldMappings };
                              const oldSource = Object.entries(newMappings).find(
                                ([, v]) => v === field.key
                              )?.[0];
                              if (oldSource) delete newMappings[oldSource];

                              // Set new mapping
                              if (e.target.value !== '__skip__') {
                                // Remove any existing mapping from this source
                                delete newMappings[e.target.value];
                                newMappings[e.target.value] = field.key;
                              }

                              onChange({ fieldMappings: newMappings });
                            }}
                            displayEmpty
                          >
                            <MenuItem value="__skip__">
                              <Typography variant="body2" color="text.secondary">
                                Skip
                              </Typography>
                            </MenuItem>
                            {sourceFields.map((sf) => {
                              const mappedTo = state.fieldMappings[sf];
                              const isUsed = mappedTo && mappedTo !== field.key;
                              return (
                                <MenuItem key={sf} value={sf} disabled={!!isUsed}>
                                  {sf}
                                </MenuItem>
                              );
                            })}
                          </Select>
                        </FormControl>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      {sourceFields.length === 0 && sampleInput.trim() && (
        <Alert severity="warning">
          Could not detect any fields. {isJsonMode ? 'Make sure the JSON is valid.' : 'Enter a comma-separated header row.'}
        </Alert>
      )}
    </Box>
  );
}

export function StepFieldMapping({ state, onChange }: StepProps) {
  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Field Mapping
      </Typography>

      {isAiMode(state.connectorType) ? (
        <AiFieldSelector state={state} onChange={onChange} />
      ) : (
        <ManualFieldMapper state={state} onChange={onChange} />
      )}
    </Box>
  );
}
