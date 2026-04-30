/**
 * Step 2 of the file-first wizard: drop a sample file so the backend can
 * discover the schema. Supports CSV/TSV/TXT (parsed directly), XLSX (workbook
 * walk + sheet picker downstream), PDF (Qwen schema discovery), and .eml
 * (email body parsing + Qwen). Files outside the accepted list get a clear
 * rejection before any network traffic.
 */

import { useCallback, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Description as DescriptionIcon,
  CheckCircle as CheckIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';
import { HelpWell } from '../HelpWell';
import { InfoTooltip } from '../InfoTooltip';
import { helpContent } from '../../lib/helpContent';

/** File size caps. Binary formats (PDF/XLSX) get a higher cap than text. */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;   // 5MB for CSV/TSV/TXT/EML
const MAX_BINARY_BYTES = 10 * 1024 * 1024; // 10MB for PDF/XLSX

interface AcceptedFormat {
  exts: string[];
  mime: string[];
  sourceType: 'csv' | 'xlsx' | 'pdf' | 'eml' | 'text';
  maxBytes: number;
  label: string;
}

const ACCEPTED_FORMATS: AcceptedFormat[] = [
  {
    exts: ['.csv', '.tsv'],
    mime: ['text/csv', 'text/tab-separated-values'],
    sourceType: 'csv',
    maxBytes: MAX_TEXT_BYTES,
    label: 'CSV / TSV',
  },
  {
    exts: ['.txt'],
    mime: ['text/plain'],
    sourceType: 'text',
    maxBytes: MAX_TEXT_BYTES,
    label: 'Plain text',
  },
  {
    exts: ['.xlsx', '.xls'],
    mime: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ],
    sourceType: 'xlsx',
    maxBytes: MAX_BINARY_BYTES,
    label: 'Excel (.xlsx, .xls)',
  },
  {
    exts: ['.pdf'],
    mime: ['application/pdf'],
    sourceType: 'pdf',
    maxBytes: MAX_BINARY_BYTES,
    label: 'PDF',
  },
  {
    exts: ['.eml'],
    mime: ['message/rfc822'],
    sourceType: 'eml',
    maxBytes: MAX_TEXT_BYTES,
    label: 'Email (.eml)',
  },
];

const ACCEPTED_MIME_STRING = ACCEPTED_FORMATS
  .flatMap((f) => [...f.mime, ...f.exts])
  .join(',');

function matchFormat(name: string): AcceptedFormat | null {
  const lower = name.toLowerCase();
  for (const f of ACCEPTED_FORMATS) {
    if (f.exts.some((ext) => lower.endsWith(ext))) return f;
  }
  return null;
}

export interface StepUploadSampleProps {
  sample: DiscoverSchemaResponse | null;
  onSample: (sample: DiscoverSchemaResponse | null) => void;
  currentTenantId: string | null;
}

type PasteContentType = 'auto' | 'eml' | 'csv' | 'tsv';

export function StepUploadSample({ sample, onSample, currentTenantId }: StepUploadSampleProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [pastedText, setPastedText] = useState('');
  const [pasteContentType, setPasteContentType] = useState<PasteContentType>('auto');

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      const format = matchFormat(file.name);
      if (!format) {
        setError(
          `Unsupported file type for "${file.name}". Accepted: CSV, TSV, TXT, XLSX, XLS, PDF, EML.`,
        );
        return;
      }
      if (file.size > format.maxBytes) {
        setError(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — max is ${Math.round(format.maxBytes / 1024 / 1024)} MB for ${format.label}.`,
        );
        return;
      }
      if (!currentTenantId) {
        setError('No tenant selected. Please select a tenant before uploading a sample.');
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('source_type', format.sourceType);
      formData.append('tenant_id', currentTenantId);

      setUploading(true);
      try {
        const result = await api.connectors.discoverSchema(formData);
        // If discovery returned zero fields, surface the warnings explicitly
        // so the user isn't left staring at an empty Review step.
        if (result.detected_fields.length === 0 && result.warnings.length > 0) {
          setError(`Schema discovery returned no fields: ${result.warnings.join(' ')}`);
        }
        onSample(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message || 'Failed to discover schema');
      } finally {
        setUploading(false);
      }
    },
    [currentTenantId, onSample],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // Reset so selecting the same file again re-triggers.
      if (e.target) e.target.value = '';
    },
    [handleFile],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        inputRef.current?.click();
      }
    },
    [],
  );

  const handleAnalyzePaste = useCallback(async () => {
    setError(null);
    if (!pastedText.trim()) {
      setError('Paste some text before analyzing.');
      return;
    }
    if (!currentTenantId) {
      setError('No tenant selected. Please select a tenant before analyzing pasted text.');
      return;
    }

    // Map the dropdown to the backend's source_type. 'auto' means `text` and
    // the backend will content-sniff (email vs CSV) before dispatch.
    let sourceType: 'csv' | 'eml' | 'text';
    let fileName: string;
    let mime: string;
    switch (pasteContentType) {
      case 'eml':
        sourceType = 'eml';
        fileName = 'pasted-email.eml';
        mime = 'message/rfc822';
        break;
      case 'csv':
        sourceType = 'csv';
        fileName = 'pasted-text.csv';
        mime = 'text/csv';
        break;
      case 'tsv':
        sourceType = 'csv';
        fileName = 'pasted-text.tsv';
        mime = 'text/tab-separated-values';
        break;
      case 'auto':
      default:
        sourceType = 'text';
        fileName = 'pasted-text.txt';
        mime = 'text/plain';
        break;
    }

    const blob = new Blob([pastedText], { type: mime });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('source_type', sourceType);
    formData.append('file_name', fileName);
    formData.append('tenant_id', currentTenantId);

    setUploading(true);
    try {
      const result = await api.connectors.discoverSchema(formData);
      if (result.detected_fields.length === 0 && result.warnings.length > 0) {
        setError(`Schema discovery returned no fields: ${result.warnings.join(' ')}`);
      }
      onSample(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to discover schema');
    } finally {
      setUploading(false);
    }
  }, [pastedText, pasteContentType, currentTenantId, onSample]);

  return (
    <Box>
      <HelpWell
        id="connectors.wizard.step.upload"
        title={helpContent.connectors.wizard.steps.uploadSample.headline}
      >
        {helpContent.connectors.wizard.steps.uploadSample.well}
      </HelpWell>

      <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
        Upload a sample
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Drop a representative export of the data this connector will receive. We'll
        auto-detect the columns and pre-fill the field mappings in the next step.
      </Typography>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as 'file' | 'paste')}
        sx={{ mb: 2, minHeight: 36 }}
      >
        <Tab value="file" label="Upload file" sx={{ minHeight: 36 }} />
        <Tab
          value="paste"
          label={
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
              Paste text
              <InfoTooltip text={helpContent.connectors.wizard.steps.uploadSample.tooltips.paste} />
            </Box>
          }
          sx={{ minHeight: 36 }}
        />
      </Tabs>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {sample && !uploading ? (
        <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
            <CheckIcon color="success" />
            <Typography variant="subtitle2">Sample uploaded</Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
            <DescriptionIcon fontSize="small" color="action" />
            <Typography variant="body2" fontWeight={500}>
              {sample.file_name}
            </Typography>
            <Chip
              label={sample.source_type.toUpperCase()}
              size="small"
              color="primary"
              variant="outlined"
            />
            <Typography variant="caption" color="text.secondary">
              {(sample.size / 1024).toFixed(1)} KB
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block">
            {sample.layout_hint}
          </Typography>
          {sample.warnings.length > 0 && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              {sample.warnings.map((w, i) => (
                <Typography key={i} variant="body2">
                  {w}
                </Typography>
              ))}
            </Alert>
          )}
          <Button
            size="small"
            sx={{ mt: 1 }}
            onClick={() => {
              onSample(null);
              inputRef.current?.click();
            }}
          >
            Upload a different sample
          </Button>
        </Paper>
      ) : tab === 'file' ? (
        <Paper
          variant="outlined"
          role="button"
          tabIndex={0}
          aria-label="Drop a sample file or click to browse"
          onClick={() => inputRef.current?.click()}
          onKeyDown={onKeyDown}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          sx={{
            border: '2px dashed',
            borderColor: dragOver ? 'primary.main' : 'divider',
            borderRadius: 2,
            p: 5,
            textAlign: 'center',
            cursor: uploading ? 'wait' : 'pointer',
            bgcolor: dragOver ? 'action.hover' : 'transparent',
            transition: 'all 0.2s',
            mb: 2,
            '&:hover': {
              borderColor: 'primary.main',
              bgcolor: 'action.hover',
            },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          <UploadIcon sx={{ fontSize: 48, color: 'primary.main', mb: 1 }} />
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            {uploading ? 'Analyzing sample…' : 'Drop a sample file here or click to browse'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            CSV, TSV, TXT, XLSX, PDF, or EML. Text files up to 5 MB; binary up to 10 MB.
          </Typography>
          {uploading && <LinearProgress sx={{ maxWidth: 360, mx: 'auto', mt: 1 }} />}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_MIME_STRING}
            hidden
            onChange={onInputChange}
            aria-label="Connector sample file input"
          />
        </Paper>
      ) : (
        <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Paste the raw contents of an email, CSV, or TSV export. We'll analyze
            it the same way we'd analyze an uploaded file.
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={8}
            maxRows={20}
            placeholder={'Paste the full email, including headers:\n\nSubject: Daily COA Report - April 6, 2026\nFrom: orders@example.com\n...'}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            disabled={uploading}
            sx={{
              mb: 2,
              '& .MuiInputBase-input': {
                fontFamily: 'monospace',
                fontSize: '0.85rem',
              },
            }}
          />
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel id="paste-content-type-label">Content type</InputLabel>
              <Select
                labelId="paste-content-type-label"
                label="Content type"
                value={pasteContentType}
                onChange={(e) => setPasteContentType(e.target.value as PasteContentType)}
                disabled={uploading}
              >
                <MenuItem value="auto">Auto-detect</MenuItem>
                <MenuItem value="eml">Email / .eml</MenuItem>
                <MenuItem value="csv">CSV</MenuItem>
                <MenuItem value="tsv">Tab-separated</MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="contained"
              onClick={() => void handleAnalyzePaste()}
              disabled={uploading || !pastedText.trim()}
            >
              {uploading ? 'Analyzing…' : 'Analyze'}
            </Button>
            {pastedText && !uploading && (
              <Button
                size="small"
                onClick={() => {
                  setPastedText('');
                  setError(null);
                }}
              >
                Clear
              </Button>
            )}
          </Stack>
          {uploading && <LinearProgress sx={{ mt: 2 }} />}
        </Paper>
      )}

      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Supported formats:
          </Typography>
          <InfoTooltip text={helpContent.connectors.wizard.steps.uploadSample.tooltips.fileFormats} />
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {ACCEPTED_FORMATS.map((f) => (
            <Chip
              key={f.sourceType}
              label={f.label}
              size="small"
              variant="outlined"
            />
          ))}
        </Stack>
      </Box>
    </Box>
  );
}
