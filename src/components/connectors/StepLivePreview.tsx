/**
 * Step 4 of the file-first wizard: live preview of the extracted rows.
 * Calls /api/connectors/preview-extraction against the uploaded sample on
 * mount and whenever field_mappings change (debounced 800ms). Read-only —
 * no writes happen here.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { api } from '../../lib/api';
import type {
  DiscoverSchemaResponse,
  PreviewExtractionResponse,
  PreviewRow,
} from '../../types/connectorSchema';
import type { ConnectorFieldMappings } from './doxFields';
import { HelpWell } from '../HelpWell';
import { helpContent } from '../../lib/helpContent';

interface StepLivePreviewProps {
  sample: DiscoverSchemaResponse | null;
  fieldMappings: ConnectorFieldMappings;
  /** Optional callback — parent can capture the rows for the final review step. */
  onPreviewLoaded?: (preview: PreviewExtractionResponse | null) => void;
}

const DEBOUNCE_MS = 800;
const PREVIEW_LIMIT = 5;

const DISPLAY_COLUMNS: Array<{ key: keyof PreviewRow; label: string }> = [
  { key: 'order_number', label: 'Order #' },
  { key: 'customer_number', label: 'Customer #' },
  { key: 'customer_name', label: 'Customer' },
  { key: 'po_number', label: 'PO #' },
];

function hasValue(row: PreviewRow, key: keyof PreviewRow): boolean {
  const v = row[key];
  return v !== undefined && v !== null && v !== '';
}

function prettyJson(obj: Record<string, unknown> | undefined): string {
  if (!obj || Object.keys(obj).length === 0) return '';
  return JSON.stringify(obj, null, 2);
}

export function StepLivePreview({ sample, fieldMappings, onPreviewLoaded }: StepLivePreviewProps) {
  const [preview, setPreview] = useState<PreviewExtractionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!sample?.sample_id) return;

    const timer = setTimeout(() => {
      const reqId = ++latestRequest.current;
      setLoading(true);
      setError(null);

      api.connectors
        .previewExtraction({
          sample_id: sample.sample_id,
          field_mappings: fieldMappings,
          limit: PREVIEW_LIMIT,
        })
        .then((res) => {
          if (reqId !== latestRequest.current) return;
          setPreview(res);
          onPreviewLoaded?.(res);
        })
        .catch((err: unknown) => {
          if (reqId !== latestRequest.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg || 'Failed to load preview');
          setPreview(null);
          onPreviewLoaded?.(null);
        })
        .finally(() => {
          if (reqId !== latestRequest.current) return;
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [sample?.sample_id, fieldMappings, onPreviewLoaded]);

  if (!sample) {
    return (
      <Alert severity="warning">
        No sample uploaded yet. Go back to the upload step to select a file.
      </Alert>
    );
  }

  const rows = preview?.rows ?? [];
  // Figure out which of the display columns actually have data in at least one row.
  const activeColumns = DISPLAY_COLUMNS.filter((col) => rows.some((r) => hasValue(r, col.key)));

  return (
    <Box>
      <HelpWell
        id="connectors.wizard.step.preview"
        title={helpContent.connectors.wizard.steps.livePreview.headline}
      >
        {helpContent.connectors.wizard.steps.livePreview.well}
      </HelpWell>

      <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
        Live preview
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Here's what the connector would extract with the current mapping. Adjust the mapping
        in the previous step if anything looks wrong — the preview updates automatically.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {preview?.errors && preview.errors.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            Parser reported {preview.errors.length} error{preview.errors.length === 1 ? '' : 's'}:
          </Typography>
          {preview.errors.slice(0, 5).map((e, i) => (
            <Typography key={i} variant="body2">
              • {e.message}
              {e.row !== undefined ? ` (row ${e.row})` : ''}
              {e.field ? ` [${e.field}]` : ''}
            </Typography>
          ))}
        </Alert>
      )}

      {preview?.warnings && preview.warnings.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {preview.warnings.map((w, i) => (
            <Typography key={i} variant="body2">
              {w}
            </Typography>
          ))}
        </Alert>
      )}

      {loading && (
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Extracting preview rows…
          </Typography>
        </Stack>
      )}

      {!loading && rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            No rows extracted yet — go back and adjust the field mappings.
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                {activeColumns.map((col) => (
                  <TableCell key={col.key} sx={{ fontWeight: 600 }}>
                    {col.label}
                  </TableCell>
                ))}
                <TableCell sx={{ fontWeight: 600 }}>Metadata</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {activeColumns.map((col) => (
                    <TableCell key={col.key}>
                      <Typography variant="body2">{String(row[col.key] ?? '')}</Typography>
                    </TableCell>
                  ))}
                  <TableCell>
                    {row.extended_metadata && Object.keys(row.extended_metadata).length > 0 ? (
                      <Box
                        component="pre"
                        sx={{
                          fontFamily: 'monospace',
                          fontSize: '0.7rem',
                          m: 0,
                          whiteSpace: 'pre-wrap',
                          maxWidth: 320,
                        }}
                      >
                        {prettyJson(row.extended_metadata)}
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.disabled">
                        —
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {preview && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Showing {rows.length} of {preview.total_rows_in_sample} rows · extraction took{' '}
          {preview.duration_ms} ms
        </Typography>
      )}
    </Box>
  );
}
