import { useEffect, useMemo, useState } from 'react';
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
  Collapse,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  CheckCircle as CheckIcon,
  InfoOutlined as InfoIcon,
  NavigateBefore as NavigateBeforeIcon,
  NavigateNext as NavigateNextIcon,
  ExpandMore as ExpandMoreIcon,
  CheckCircle as ApproveDotIcon,
  PauseCircleOutline as HoldDotIcon,
  Cancel as RejectDotIcon,
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
import {
  FieldWarnings,
  InvariantWarningBanner,
  warningsByField,
  warnedFieldSx,
  warningKey,
} from './InvariantWarnings';
import ProductBridgeControl, { type ProductBridgeValue } from './ProductBridgeControl';

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

/**
 * Group record array-indices by the source PDF page they belong to.
 *
 * A "page" is the set of records whose `source_pages` include that page number.
 * A record that spans multiple pages appears under each of its pages (so its
 * decision is reachable from any of them). Records with no `source_pages`
 * (older payloads / EDI rows the worker didn't page-tag) are bucketed under a
 * synthetic page key (0) so they remain reviewable. Returns ordered pages.
 */
const UNTAGGED_PAGE = 0;

interface PageGroup {
  /** Display page number; UNTAGGED_PAGE (0) means "no page tag". */
  page: number;
  /** Record array indices on this page, in original order. */
  indices: number[];
}

function groupRecordsByPage(records: CoaRecord[]): PageGroup[] {
  const byPage = new Map<number, number[]>();
  records.forEach((r, idx) => {
    const pages = r.source_pages && r.source_pages.length > 0 ? r.source_pages : [UNTAGGED_PAGE];
    for (const p of pages) {
      const bucket = byPage.get(p);
      if (bucket) bucket.push(idx);
      else byPage.set(p, [idx]);
    }
  });
  return [...byPage.keys()]
    .sort((a, b) => a - b)
    .map((page) => ({ page, indices: byPage.get(page)! }));
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
  onPageChange,
}: {
  item: ProcessingQueueItem;
  onApproved: () => void;
  /**
   * Fired with the currently-reviewed source PDF page (1-based) whenever the
   * page navigator moves. ReviewQueue feeds this into the left-side PdfViewer
   * so the PDF follows the records being reviewed. Not fired for untagged
   * records (which have no real page to jump to).
   */
  onPageChange?: (page: number) => void;
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

  // Per-record taught COA-product -> order-product bridge, keyed by array index.
  // Written into the approve body as `product_maps` for approved records.
  const [productMaps, setProductMaps] = useState<Record<number, ProductBridgeValue | null>>({});

  // Page grouping: records bucketed by their source PDF page. Drives the page
  // navigator; the records column shows only the active page's records.
  const pageGroups = useMemo(() => groupRecordsByPage(records), [records]);
  const multiPage = pageGroups.length > 1;
  // Index into pageGroups (NOT the page number itself), so untagged-only docs
  // and gappy page sets both navigate cleanly.
  const [activePageIdx, setActivePageIdx] = useState(0);
  // Collapsible shared-fields header, open by default so nothing is hidden.
  const [pageMetaOpen, setPageMetaOpen] = useState(true);

  const [supplier, setSupplier] = useState<SupplierValue>(() => ({
    supplierId: item.supplier_id || undefined,
    supplierName: item.supplier || '',
    verified: !!item.supplier_id,
  }));

  /**
   * Server-computed invariant warnings, dismissible per reviewer session. Scope
   * strings match the extraction shape: 'page_metadata' for the shared header,
   * 'record[N]' for the Nth record — the same indices this tile renders, so a
   * warning lands on the card it belongs to.
   */
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(new Set());
  const dismissWarning = (key: string) =>
    setDismissedWarnings((prev) => new Set(prev).add(key));
  const sharedWarnings = useMemo(
    () => warningsByField(item.invariant_warnings, 'page_metadata'),
    [item.invariant_warnings],
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const readOnly = item.status !== 'pending';
  const supplierVerified = supplier.verified && !!supplier.supplierName.trim();

  const decisionFor = (idx: number): CoaRecordDecision => decisions[idx] ?? 'approve';

  /** The COA product name for a record (record field, falling back to shared). */
  const coaProductNameFor = (r: CoaRecord): string =>
    (r.fields?.product_name || pageMetadata.product_name || '').trim();

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

  // Keep activePageIdx in range if pages ever change (e.g. records mutated).
  useEffect(() => {
    if (activePageIdx > pageGroups.length - 1) {
      setActivePageIdx(Math.max(0, pageGroups.length - 1));
    }
  }, [pageGroups.length, activePageIdx]);

  // Drive the left-side PDF: announce the active page (skip the untagged bucket,
  // which has no real PDF page to jump to).
  const activeGroup = pageGroups[activePageIdx];
  useEffect(() => {
    if (activeGroup && activeGroup.page !== UNTAGGED_PAGE) {
      onPageChange?.(activeGroup.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup?.page]);

  /** Worst-case decision across a page's records, for the page-strip dot. */
  const pageOutcome = (indices: number[]): ItemOutcome => {
    let hold = false;
    for (const i of indices) {
      const d = decisionFor(i);
      if (d === 'reject') return 'with_reject';
      if (d === 'hold') hold = true;
    }
    return hold ? 'partial_hold' : 'approve_all';
  };

  /** Count of records on other pages that are held or rejected. */
  const offPageFlagged = useMemo(() => {
    const visible = new Set(activeGroup?.indices ?? []);
    let held = 0;
    let rejected = 0;
    records.forEach((_, i) => {
      if (visible.has(i)) return;
      const d = decisionFor(i);
      if (d === 'hold') held++;
      else if (d === 'reject') rejected++;
    });
    return { held, rejected };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, decisions, activeGroup]);

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

      // Taught product bridges for APPROVED records only. The server writes each
      // entry to supplier_product_map AFTER resolving the supplier_id, keying on
      // the record's COA product name.
      const productMapsBody: Record<
        string,
        { coa_product: string; order_product_id: string; distributor_sku?: string | null }
      > = {};
      records.forEach((r, i) => {
        if (decisionFor(i) !== 'approve') return;
        const map = productMaps[i];
        const coaProduct = coaProductNameFor(r);
        if (!map || !coaProduct) return;
        productMapsBody[String(i)] = {
          coa_product: coaProduct,
          order_product_id: map.order_product_id,
          distributor_sku: map.distributor_sku ?? undefined,
        };
      });

      const res = await api.queue.approve(item.id, {
        ...supplierPayload,
        records: payload,
        record_decisions: recordDecisions,
        ...(Object.keys(productMapsBody).length > 0 ? { product_maps: productMapsBody } : {}),
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

  /** Render one editable record card by its array index. */
  const renderRecordCard = (idx: number) => {
    const record = records[idx];
    if (!record) return null;
    const recordWarnings = warningsByField(item.invariant_warnings, `record[${idx}]`);
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
          {record.fields?.lot_code && <Chip label={`lot ${record.fields.lot_code}`} size="small" />}
          {record.fields?.sub_lot_code && (
            <Chip
              label={`sublot ${record.fields.sub_lot_code}`}
              size="small"
              color="primary"
              variant="outlined"
            />
          )}
          {record.source_pages && record.source_pages.length > 0 && (
            <Chip label={`p. ${record.source_pages.join(', ')}`} size="small" variant="outlined" />
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
            <Chip
              key={f}
              label={f.replace(/_/g, ' ')}
              size="small"
              color="warning"
              variant="outlined"
            />
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
          {fieldEntries.map(([key, value]) => {
            const fieldWarnings = recordWarnings[key];
            const live = (fieldWarnings || []).filter((w) => !dismissedWarnings.has(warningKey(w)));
            return (
              <Box key={key} sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <TextField
                    label={key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                    value={value ?? ''}
                    onChange={(e) => updateRecordField(idx, key, e.target.value)}
                    size="small"
                    fullWidth
                    disabled={readOnly || submitting}
                    sx={live.length > 0 ? warnedFieldSx : undefined}
                  />
                  <FieldWarnings
                    warnings={fieldWarnings}
                    dismissed={dismissedWarnings}
                    onDismiss={dismissWarning}
                  />
                </Box>
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
            );
          })}
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

        {/* Teach the COA-product -> order-product bridge for this record. Only
            available once the supplier is saved (we need its id to key the map).
            Disabled until the supplier is verified. */}
        <Box sx={{ mt: 1.5, mb: groupEntries.length || record.tables?.length ? 2 : 0 }}>
          {supplier.supplierId ? (
            <ProductBridgeControl
              tenantId={item.tenant_id}
              supplierId={supplier.supplierId}
              supplierName={supplier.supplierName}
              coaProductName={coaProductNameFor(record)}
              disabled={readOnly || submitting || !supplierVerified}
              value={productMaps[idx] ?? null}
              onChange={(v) => setProductMaps((prev) => ({ ...prev, [idx]: v }))}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              Map products after the supplier is saved.
            </Typography>
          )}
        </Box>

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
  };

  /** Small colored status dot for the page strip / stepper summary. */
  const PageOutcomeDot = ({ o }: { o: ItemOutcome }) => {
    if (o === 'with_reject') return <RejectDotIcon sx={{ fontSize: 14, color: 'error.main' }} />;
    if (o === 'partial_hold') return <HoldDotIcon sx={{ fontSize: 14, color: 'warning.main' }} />;
    return <ApproveDotIcon sx={{ fontSize: 14, color: 'success.main' }} />;
  };

  if (!initial) {
    return (
      <Alert severity="warning">
        This COA item is not in records form (no valid CoaRecordsPayload on ai_records).
      </Alert>
    );
  }

  const pageMetaKeys = Object.keys(pageMetadata);
  const pageLabel = (p: number) => (p === UNTAGGED_PAGE ? 'untagged' : `p.${p}`);

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

      {/* Anything the document itself contradicts, before the reviewer scrolls. */}
      <InvariantWarningBanner warnings={item.invariant_warnings} dismissed={dismissedWarnings} />

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

      {/* Shared / constant fields — edited once, collapsible so they stay out
          of the way while paging but remain reachable from any page. */}
      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Box
          onClick={() => setPageMetaOpen((o) => !o)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1.25,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <Typography variant="subtitle2">Shared fields (page metadata)</Typography>
          <Chip label={`${pageMetaKeys.length}`} size="small" variant="outlined" />
          <Box sx={{ flexGrow: 1 }} />
          <ExpandMoreIcon
            fontSize="small"
            sx={{
              transform: pageMetaOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              color: 'text.secondary',
            }}
          />
        </Box>
        <Collapse in={pageMetaOpen} unmountOnExit>
          <Box sx={{ px: 2, pb: 2 }}>
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
                {pageMetaKeys.map((key) => {
                  const fieldWarnings = sharedWarnings[key];
                  const live = (fieldWarnings || []).filter((w) => !dismissedWarnings.has(warningKey(w)));
                  return (
                    <Box key={key}>
                      <TextField
                        label={key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                        value={pageMetadata[key] ?? ''}
                        onChange={(e) => updatePageMetaField(key, e.target.value)}
                        size="small"
                        fullWidth
                        disabled={readOnly || submitting}
                        sx={live.length > 0 ? warnedFieldSx : undefined}
                      />
                      <FieldWarnings
                        warnings={fieldWarnings}
                        dismissed={dismissedWarnings}
                        onDismiss={dismissWarning}
                      />
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        </Collapse>
      </Paper>

      {records.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No COA records were extracted from this document.
        </Alert>
      )}

      {/* PAGE NAVIGATOR — only when the doc spans >1 distinct source page. The
          records column below shows only the active page's records; the stepper
          + tab strip carry a per-page decision dot so the reviewer can see the
          overall state without scrolling every page. */}
      {multiPage && (
        <Paper variant="outlined" sx={{ p: 1, mb: 2, bgcolor: 'action.hover' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <IconButton
              size="small"
              onClick={() => setActivePageIdx((i) => Math.max(0, i - 1))}
              disabled={activePageIdx <= 0}
              title="Previous page"
            >
              <NavigateBeforeIcon />
            </IconButton>
            <Typography variant="subtitle2" sx={{ minWidth: 0, flexShrink: 0 }}>
              Page {activePageIdx + 1} of {pageGroups.length}
              {activeGroup && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                  ({pageLabel(activeGroup.page)} · {activeGroup.indices.length} record
                  {activeGroup.indices.length === 1 ? '' : 's'})
                </Typography>
              )}
            </Typography>
            <Box sx={{ flexGrow: 1 }} />
            <IconButton
              size="small"
              onClick={() => setActivePageIdx((i) => Math.min(pageGroups.length - 1, i + 1))}
              disabled={activePageIdx >= pageGroups.length - 1}
              title="Next page"
            >
              <NavigateNextIcon />
            </IconButton>
          </Box>

          {/* Compact page tab strip with per-page status dots. */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {pageGroups.map((g, i) => {
              const o = pageOutcome(g.indices);
              const active = i === activePageIdx;
              return (
                <Chip
                  key={g.page}
                  size="small"
                  clickable
                  onClick={() => setActivePageIdx(i)}
                  color={active ? 'primary' : 'default'}
                  variant={active ? 'filled' : 'outlined'}
                  icon={<PageOutcomeDot o={o} />}
                  label={pageLabel(g.page)}
                />
              );
            })}
          </Box>
        </Paper>
      )}

      {/* Active-page records (or all records, when single-page). */}
      {(activeGroup ? activeGroup.indices : records.map((_, i) => i)).map((idx) =>
        renderRecordCard(idx),
      )}

      {/* Heads-up: records on OTHER pages are held/rejected. */}
      {multiPage && (offPageFlagged.held > 0 || offPageFlagged.rejected > 0) && (
        <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
          On other pages:
          {offPageFlagged.held > 0 && ` ${offPageFlagged.held} held`}
          {offPageFlagged.held > 0 && offPageFlagged.rejected > 0 && ' ·'}
          {offPageFlagged.rejected > 0 && ` ${offPageFlagged.rejected} rejected`}
          . Approving submits decisions for ALL pages.
        </Alert>
      )}

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
