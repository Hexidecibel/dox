import { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Alert,
  CircularProgress,
  Tooltip,
  Divider,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckIcon,
  InfoOutlined as InfoIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { parseCoaRecords } from '../lib/types';
import type {
  ProcessingQueueItem,
  CoaRecord,
  CoaRecordsPayload,
  CoaRecordDecision,
  CoaResultCell,
  ExtractedTable,
} from '../lib/types';
import SupplierAutocomplete, { type SupplierValue } from './SupplierAutocomplete';

/**
 * Review tile for records-shaped COA queue items (Option B / sublot split).
 *
 * ONE queue item == one PDF that splits into N records (one per sublot, or per
 * product). We render `page_metadata` once (the fields constant across all
 * records — manufacturer, coa_number, supplier, etc.), then one editable card
 * per record (lot/sublot/fields + tables + structured groups + a source_pages
 * chip + a low-confidence chip). Each card carries a per-record decision
 * (approve / hold / reject), defaulting to approve.
 *
 * On Approve we POST the reviewer-edited `CoaRecordsPayload` as `body.records`
 * plus `body.record_decisions` (a `{ "<record_index>": decision }` map). The
 * server auto-dispatches to the COA-records approve path (produceCoaRecords)
 * because `body.records` parses as a CoaRecordsPayload, producing one document +
 * one lots row per APPROVED record. If ANY record is held the item stays
 * pending; all-approve flips it to approved.
 *
 * Supplier gate: like the flat COA path, the reviewer must confirm/select the
 * supplier before Approve unlocks.
 *
 * Modeled on OrderReviewTile.tsx.
 */

const STAGE_THRESHOLD = 0.7;

/** Decision precedence for the item summary: any reject < any hold < all approve. */
type ItemOutcome = 'approve_all' | 'partial_hold' | 'with_reject';

function isLowConf(conf: number | undefined): boolean {
  return conf != null && conf < STAGE_THRESHOLD;
}

/** Deep-ish clone of a record so edits never mutate the parsed source. */
function cloneRecord(r: CoaRecord): CoaRecord {
  return {
    ...r,
    fields: { ...(r.fields || {}) },
    groups: r.groups
      ? Object.fromEntries(
          Object.entries(r.groups).map(([g, cells]) => [
            g,
            Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { ...v }])),
          ]),
        )
      : undefined,
    tables: r.tables ? r.tables.map((t) => ({ ...t, headers: [...t.headers], rows: t.rows.map((row) => [...row]) })) : undefined,
    source_pages: r.source_pages ? [...r.source_pages] : undefined,
    flags: r.flags ? [...r.flags] : undefined,
  };
}

/** Cells inside a structured group, rendered read-only (verbatim specs). */
function GroupCells({ cells }: { cells: Record<string, CoaResultCell> }) {
  const entries = Object.entries(cells);
  if (entries.length === 0) return null;
  return (
    <TableContainer sx={{ mt: 0.5 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Measure</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Value</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Unit</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Spec</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map(([key, cell]) => (
            <TableRow key={key}>
              <TableCell>{key.replace(/_/g, ' ')}</TableCell>
              <TableCell>{cell.value ?? '—'}</TableCell>
              <TableCell>{cell.unit ?? '—'}</TableCell>
              <TableCell>{cell.spec ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** A single extracted table, rendered read-only. */
function RecordTable({ table }: { table: ExtractedTable }) {
  return (
    <Box sx={{ mb: 1.5 }}>
      {table.name && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          {table.name}
        </Typography>
      )}
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              {table.headers.map((h, i) => (
                <TableCell key={i} sx={{ fontWeight: 600 }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {table.rows.map((row, ri) => (
              <TableRow key={ri}>
                {row.map((cell, ci) => (
                  <TableCell key={ci}>{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default function CoaRecordsReviewTile({
  item,
  onApproved,
}: {
  item: ProcessingQueueItem;
  onApproved: () => void;
}) {
  const initial = useMemo<CoaRecordsPayload | null>(
    () => parseCoaRecords(item.ai_records),
    [item.ai_records],
  );

  const [pageMetadata, setPageMetadata] = useState<Record<string, string | null>>(
    () => ({ ...(initial?.page_metadata || {}) }),
  );
  const [records, setRecords] = useState<CoaRecord[]>(() =>
    (initial?.records || []).map(cloneRecord),
  );
  // Per-record decision keyed by array index; defaults to 'approve' when absent.
  const [decisions, setDecisions] = useState<Record<number, CoaRecordDecision>>({});

  const [supplier, setSupplier] = useState<SupplierValue>(() => ({
    supplierId: item.supplier_id || undefined,
    supplierName: item.supplier || '',
    verified: !!item.supplier_id,
  }));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const readOnly = item.status !== 'pending';
  const supplierVerified = supplier.verified && !!supplier.supplierName.trim();

  const decisionFor = (idx: number): CoaRecordDecision => decisions[idx] ?? 'approve';

  const setDecision = (idx: number, val: CoaRecordDecision) => {
    setDecisions((prev) => ({ ...prev, [idx]: val }));
  };

  const updatePageMetaField = (key: string, value: string) => {
    setPageMetadata((prev) => ({ ...prev, [key]: value }));
  };

  const updateRecordField = (idx: number, key: string, value: string) => {
    setRecords((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, fields: { ...r.fields, [key]: value } } : r)),
    );
  };

  const addRecordField = (idx: number) => {
    const key = window.prompt('New field name (snake_case)')?.trim();
    if (!key) return;
    setRecords((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, fields: { ...r.fields, [key]: '' } } : r)),
    );
  };

  const removeRecordField = (idx: number, key: string) => {
    setRecords((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const fields = { ...r.fields };
        delete fields[key];
        return { ...r, fields };
      }),
    );
  };

  // Item-level outcome (drives the summary blurb + button color).
  const outcome: ItemOutcome = useMemo(() => {
    let hold = false;
    for (let i = 0; i < records.length; i++) {
      const d = decisionFor(i);
      if (d === 'reject') return 'with_reject';
      if (d === 'hold') hold = true;
    }
    return hold ? 'partial_hold' : 'approve_all';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, decisions]);

  const approveCount = records.filter((_, i) => decisionFor(i) === 'approve').length;

  const handleApprove = async () => {
    if (!supplierVerified) {
      setError('Verify the supplier before approving.');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      // Re-index records so record_index is contiguous + matches the array
      // position we key decisions on.
      const payload: CoaRecordsPayload = {
        record_cardinality: initial?.record_cardinality ?? 'multi_lot',
        record_key_basis: initial?.record_key_basis ?? 'lot+sublot',
        page_metadata: pageMetadata,
        records: records.map((r, i) => ({ ...r, record_index: i })),
      };

      // Only send NON-default decisions; absent index => 'approve' on the server.
      const recordDecisions: Record<string, CoaRecordDecision> = {};
      records.forEach((_, i) => {
        const d = decisionFor(i);
        if (d !== 'approve') recordDecisions[String(i)] = d;
      });

      const supplierPayload: { supplier_id?: string; supplier_name?: string } = supplier.supplierId
        ? { supplier_id: supplier.supplierId }
        : { supplier_name: supplier.supplierName.trim() };

      const res = await api.queue.approve(item.id, {
        ...supplierPayload,
        records: payload,
        record_decisions: recordDecisions,
        selected_source: 'text',
      });
      setSuccess(
        res.summary ||
          (outcome === 'approve_all'
            ? `All ${records.length} record(s) approved`
            : `${approveCount} record(s) approved; held records keep this item pending`),
      );
      onApproved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (!initial) {
    return (
      <Alert severity="warning">
        This COA item is not in records form (no valid CoaRecordsPayload on ai_records).
      </Alert>
    );
  }

  const pageMetaKeys = Object.keys(pageMetadata);

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        COA records ({records.length})
        <Chip
          label={initial.record_cardinality.replace(/_/g, ' ')}
          size="small"
          variant="outlined"
        />
        <Chip label={`key: ${initial.record_key_basis}`} size="small" variant="outlined" />
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {/* Supplier verification gate (shared with the flat COA path). */}
      <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'action.hover' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
          <Typography variant="subtitle2">Supplier</Typography>
          <Tooltip
            title="Verify the supplier before approving. Select an existing supplier, or confirm creating a new name."
            arrow
          >
            <InfoIcon fontSize="small" color="action" />
          </Tooltip>
        </Box>
        <SupplierAutocomplete
          tenantId={item.tenant_id}
          value={supplier}
          onChange={setSupplier}
          disabled={readOnly || submitting}
        />
        {!supplierVerified && !readOnly && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
            Verify the supplier before approving.
          </Typography>
        )}
      </Paper>

      {/* Shared / constant fields — edited once. */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Shared fields (page metadata)
        </Typography>
        {pageMetaKeys.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No constant fields were hoisted for this document.
          </Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 1.5,
            }}
          >
            {pageMetaKeys.map((key) => (
              <TextField
                key={key}
                label={key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                value={pageMetadata[key] ?? ''}
                onChange={(e) => updatePageMetaField(key, e.target.value)}
                size="small"
                fullWidth
                disabled={readOnly || submitting}
              />
            ))}
          </Box>
        )}
      </Paper>

      {records.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No COA records were extracted from this document.
        </Alert>
      )}

      {records.map((record, idx) => {
        const lowConf = isLowConf(record._confidence);
        const decision = decisionFor(idx);
        const fieldEntries = Object.entries(record.fields || {});
        const groupEntries = record.groups ? Object.entries(record.groups) : [];
        const dimmed = decision === 'reject';
        return (
          <Paper
            key={idx}
            variant="outlined"
            sx={{
              p: 2,
              mb: 2,
              opacity: dimmed ? 0.6 : 1,
              borderColor: decision === 'hold' ? 'warning.main' : undefined,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
              <Typography variant="subtitle2">Record {idx + 1}</Typography>
              {record.fields?.lot_code && (
                <Chip label={`lot ${record.fields.lot_code}`} size="small" />
              )}
              {record.fields?.sub_lot_code && (
                <Chip label={`sublot ${record.fields.sub_lot_code}`} size="small" color="primary" variant="outlined" />
              )}
              {record.source_pages && record.source_pages.length > 0 && (
                <Chip
                  label={`p. ${record.source_pages.join(', ')}`}
                  size="small"
                  variant="outlined"
                />
              )}
              {lowConf && (
                <Tooltip
                  title={`LLM confidence ${Math.round((record._confidence ?? 0) * 100)}% — below the ${Math.round(
                    STAGE_THRESHOLD * 100,
                  )}% threshold.`}
                  arrow
                >
                  <Chip label="Low confidence" size="small" color="warning" variant="outlined" />
                </Tooltip>
              )}
              {record.flags?.map((f) => (
                <Chip key={f} label={f.replace(/_/g, ' ')} size="small" color="warning" variant="outlined" />
              ))}

              <Box sx={{ flexGrow: 1 }} />

              {!readOnly && (
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={decision}
                  onChange={(_, v: CoaRecordDecision | null) => v && setDecision(idx, v)}
                  disabled={submitting}
                >
                  <ToggleButton value="approve" color="success">
                    Approve
                  </ToggleButton>
                  <ToggleButton value="hold" color="warning">
                    Hold
                  </ToggleButton>
                  <ToggleButton value="reject" color="error">
                    Reject
                  </ToggleButton>
                </ToggleButtonGroup>
              )}
            </Box>

            {/* Editable per-record fields. */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                gap: 1.5,
                mb: groupEntries.length || record.tables?.length ? 2 : 0,
              }}
            >
              {fieldEntries.map(([key, value]) => (
                <Box key={key} sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                  <TextField
                    label={key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                    value={value ?? ''}
                    onChange={(e) => updateRecordField(idx, key, e.target.value)}
                    size="small"
                    fullWidth
                    disabled={readOnly || submitting}
                  />
                  {!readOnly && (
                    <IconButton
                      size="small"
                      onClick={() => removeRecordField(idx, key)}
                      disabled={submitting}
                      title="Remove field"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              ))}
            </Box>
            {!readOnly && (
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => addRecordField(idx)}
                disabled={submitting}
                sx={{ mb: groupEntries.length || record.tables?.length ? 2 : 0 }}
              >
                Add field
              </Button>
            )}

            {/* Structured groups (read-only verbatim). */}
            {groupEntries.length > 0 && (
              <>
                <Divider sx={{ mb: 1 }} />
                {groupEntries.map(([groupName, cells]) => (
                  <Box key={groupName} sx={{ mb: 1.5 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {groupName.replace(/_/g, ' ')}
                    </Typography>
                    <GroupCells cells={cells} />
                  </Box>
                ))}
              </>
            )}

            {/* Tables (read-only). */}
            {record.tables && record.tables.length > 0 && (
              <>
                <Divider sx={{ mb: 1 }} />
                {record.tables.map((t, ti) => (
                  <RecordTable key={ti} table={t} />
                ))}
              </>
            )}
          </Paper>
        );
      })}

      {!readOnly && (
        <>
          {outcome !== 'approve_all' && (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              {outcome === 'with_reject'
                ? 'Some records are rejected (they will not be produced) and/or held — this item stays pending until all records are approved.'
                : 'Some records are held — this item stays pending until all records are approved.'}
            </Alert>
          )}
          <Button
            variant="contained"
            color={outcome === 'approve_all' ? 'success' : 'warning'}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
            onClick={handleApprove}
            disabled={submitting || records.length === 0 || !supplierVerified}
          >
            {outcome === 'approve_all'
              ? `Approve ${records.length} record${records.length === 1 ? '' : 's'}`
              : `Approve ${approveCount} record${approveCount === 1 ? '' : 's'} (keep pending)`}
          </Button>
        </>
      )}
    </Box>
  );
}
