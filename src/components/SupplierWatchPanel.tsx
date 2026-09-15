/**
 * Suppliers on watch — the supplier-specific limits and required analytes that
 * sit over a tenant's company defaults, and when each is due for review.
 *
 * SME ruling (AJ Conner, 2026-09-14): supplier-specific limits layered over
 * company limits (most specific wins) ARE the "supplier on watch" mechanism —
 * tighter thresholds and extra required analytes for a watch period, then back
 * to company defaults. A review-by date exists because nobody remembers to
 * loosen by hand.
 *
 * WHAT A PASSED REVIEW-BY DOES, AND DOES NOT: the rule still applies. This panel
 * says "Watch period ended <date> — review" and offers the two actions that
 * resolve it — extend the date, or remove the rule (which returns the supplier
 * to the company default). Nothing lapses on its own.
 *
 * Mounted in two places, one component: Settings › Spec Limits (every supplier)
 * and a supplier's own page (`supplierId` given), each linking to the other.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  EventRepeat as ExtendIcon,
  Visibility as WatchIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  ApiDocumentType,
  ApiRequiredAnalyte,
  ApiSpecLimit,
  ApiSpecTest,
  ApiSupplier,
} from '../lib/types';
import { watchEndedLabel, watchStatus } from '../../shared/specCheck';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function limitText(l: ApiSpecLimit): string {
  const u = l.unit ? ` ${l.unit}` : '';
  switch (l.operator) {
    case 'absent':
      return 'absent';
    case 'between':
      return `${l.value_min}–${l.value_max}${u}`;
    case '<':
      return `<${l.value_max}${u}`;
    case '<=':
      return `≤${l.value_max}${u}`;
    case '>':
      return `>${l.value_min}${u}`;
    case '>=':
      return `≥${l.value_min}${u}`;
    default:
      return `${l.value_min}${u}`;
  }
}

/** One watch row: a supplier limit or a required analyte, same columns. */
type WatchRow =
  | { kind: 'limit'; id: string; supplierId: string; analyte: string; detail: string; reviewBy: string | null; limit: ApiSpecLimit }
  | { kind: 'required'; id: string; supplierId: string; analyte: string; detail: string; reviewBy: string | null; required: ApiRequiredAnalyte };

/** The review-by cell: the date, and the ended flag once it has passed. */
export function ReviewByCell({ reviewBy, asOf }: { reviewBy: string | null; asOf: string }) {
  if (!reviewBy) {
    return (
      <Typography variant="caption" color="text.secondary">
        No review date
      </Typography>
    );
  }
  const status = watchStatus(reviewBy, asOf);
  if (status?.review_overdue) {
    return (
      <Tooltip arrow title="Still applies. Extend the date to keep the watch, or remove the rule to return this supplier to the company default.">
        <Chip size="small" color="warning" icon={<WatchIcon sx={{ fontSize: 14 }} />} label={watchEndedLabel(reviewBy)} data-testid="watch-ended" />
      </Tooltip>
    );
  }
  return <Typography variant="body2">Review by {reviewBy}</Typography>;
}

export function SupplierWatchPanel({
  supplierId,
  tenantId,
  canEdit = true,
  reloadKey = 0,
  onChanged,
  asOf = todayIso(),
}: {
  /** One supplier's page; omitted = every supplier with a watch rule. */
  supplierId?: string;
  /** Needed by super_admin writes; ignored for org_admin. */
  tenantId?: string;
  canEdit?: boolean;
  /** Bump to make the panel re-read after a change made elsewhere on the page. */
  reloadKey?: number;
  onChanged?: () => void;
  asOf?: string;
}) {
  const [limits, setLimits] = useState<ApiSpecLimit[]>([]);
  const [required, setRequired] = useState<ApiRequiredAnalyte[]>([]);
  const [specTests, setSpecTests] = useState<ApiSpecTest[]>([]);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [docTypes, setDocTypes] = useState<ApiDocumentType[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addSupplier, setAddSupplier] = useState(supplierId || '');
  const [addDocType, setAddDocType] = useState('');
  const [addTest, setAddTest] = useState('');
  const [addFrom, setAddFrom] = useState('');
  const [addReviewBy, setAddReviewBy] = useState('');
  const [addReason, setAddReason] = useState('');
  const [saving, setSaving] = useState(false);

  const [extending, setExtending] = useState<WatchRow | null>(null);
  const [extendTo, setExtendTo] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [l, r, t, s, d] = await Promise.all([
        api.specLimits.list({ tenant_id: tenantId }),
        api.specRequiredAnalytes.list({ tenant_id: tenantId, supplier_id: supplierId }),
        api.specTests.list({ tenant_id: tenantId }),
        supplierId ? Promise.resolve({ suppliers: [] as ApiSupplier[] }) : api.suppliers.list({ tenant_id: tenantId, limit: 200 }).catch(() => ({ suppliers: [] as ApiSupplier[] })),
        api.documentTypes.list({ tenant_id: tenantId }).catch(() => ({ documentTypes: [] as ApiDocumentType[] })),
      ]);
      setLimits(l.specLimits);
      setRequired(r.requiredAnalytes);
      setSpecTests(t.specTests);
      setSuppliers((s as { suppliers: ApiSupplier[] }).suppliers || []);
      setDocTypes((d as { documentTypes: ApiDocumentType[] }).documentTypes || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier watches');
    } finally {
      setLoaded(true);
    }
  }, [tenantId, supplierId]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const rows = useMemo<WatchRow[]>(() => {
    const out: WatchRow[] = [];
    for (const l of limits) {
      if (!l.supplier_id || (supplierId && l.supplier_id !== supplierId)) continue;
      out.push({
        kind: 'limit',
        id: l.id,
        supplierId: l.supplier_id,
        analyte: l.test_name || 'Analyte',
        detail: `Limit ${limitText(l)}${l.document_type_name ? ` on ${l.document_type_name}` : ''}`,
        reviewBy: l.review_by ?? null,
        limit: l,
      });
    }
    for (const r of required) {
      out.push({
        kind: 'required',
        id: r.id,
        supplierId: r.supplier_id,
        analyte: r.test_name || 'Analyte',
        detail: `Must be reported on ${r.document_type_name || 'this document type'}${r.effective_from ? ` from ${r.effective_from}` : ''}${r.reason ? ` — ${r.reason}` : ''}`,
        reviewBy: r.review_by,
        required: r,
      });
    }
    return out;
  }, [limits, required, supplierId]);

  const bySupplier = useMemo(() => {
    const m = new Map<string, { name: string; rows: WatchRow[] }>();
    for (const row of rows) {
      const name =
        row.kind === 'limit' ? row.limit.supplier_name || 'Supplier' : row.required.supplier_name || 'Supplier';
      const entry = m.get(row.supplierId) ?? { name, rows: [] };
      entry.rows.push(row);
      m.set(row.supplierId, entry);
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows]);

  const overdue = rows.filter((r) => watchStatus(r.reviewBy, asOf)?.review_overdue).length;

  const changed = () => {
    load();
    onChanged?.();
  };

  const openAdd = () => {
    setAddSupplier(supplierId || '');
    setAddDocType(docTypes.find((d) => /analysis/i.test(d.name))?.id || docTypes[0]?.id || '');
    setAddTest(specTests[0]?.id || '');
    setAddFrom('');
    setAddReviewBy(plusDays(asOf, 90));
    setAddReason('');
    setAddOpen(true);
  };

  const saveAdd = async () => {
    setSaving(true);
    setError('');
    try {
      await api.specRequiredAnalytes.create({
        supplier_id: addSupplier,
        document_type_id: addDocType,
        spec_test_id: addTest,
        effective_from: addFrom || null,
        review_by: addReviewBy || null,
        reason: addReason.trim() || null,
        tenant_id: tenantId,
      });
      setAddOpen(false);
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add the required analyte');
    } finally {
      setSaving(false);
    }
  };

  const saveExtend = async () => {
    if (!extending) return;
    setSaving(true);
    setError('');
    try {
      if (extending.kind === 'limit') {
        await api.specLimits.update(extending.id, { review_by: extendTo || null });
      } else {
        await api.specRequiredAnalytes.update(extending.id, { review_by: extendTo || null });
      }
      setExtending(null);
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the review date');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: WatchRow) => {
    const what =
      row.kind === 'limit'
        ? `the supplier-specific ${row.analyte} limit (${limitText(row.limit)})? This supplier returns to the company default for ${row.analyte}.`
        : `${row.analyte} as a required analyte? Certificates from this supplier will no longer be flagged incomplete without it.`;
    if (!window.confirm(`Remove ${what}`)) return;
    try {
      if (row.kind === 'limit') await api.specLimits.remove(row.id);
      else await api.specRequiredAnalytes.remove(row.id);
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    }
  };

  if (!loaded) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }} data-testid="supplier-watch-panel">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <WatchIcon color="action" />
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {supplierId ? 'Spec watch' : 'Suppliers on watch'}
        </Typography>
        {overdue > 0 && (
          <Chip size="small" color="warning" label={`${overdue} past review-by`} />
        )}
        <Box sx={{ flexGrow: 1 }} />
        {canEdit && (
          <Button size="small" startIcon={<AddIcon />} onClick={openAdd} disabled={specTests.length === 0 || docTypes.length === 0}>
            Add required analyte
          </Button>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1 }}>
        A supplier-specific limit overrides the company limit for that supplier, and a required
        analyte makes a certificate that does not report it incomplete. Give each a review-by date:
        when it passes, the rule <strong>still applies</strong> and is flagged here and in the
        Review Queue until you extend it or remove it.{' '}
        {supplierId ? (
          <Link component={RouterLink} to={`/settings/spec-limits?watch_supplier=${supplierId}`}>
            Add a tighter limit in Settings › Spec Limits
          </Link>
        ) : (
          'Add a tighter limit with "Add Limit" and choose the supplier.'
        )}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {bySupplier.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {supplierId
            ? 'This supplier is on company defaults: no supplier-specific limits and no required analytes.'
            : 'No supplier is on watch — every supplier is judged against the company limits, and every certificate is complete as reported.'}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {bySupplier.map(([sid, group]) => (
            <Box key={sid}>
              {!supplierId && (
                <Link component={RouterLink} to={`/admin/suppliers/${sid}`} variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {group.name}
                </Link>
              )}
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>Analyte</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>Rule</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>Review</TableCell>
                      {canEdit && <TableCell align="right" />}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {group.rows.map((row) => (
                      <TableRow key={`${row.kind}:${row.id}`}>
                        <TableCell>
                          {row.analyte}
                          <Typography variant="caption" color="text.secondary" display="block">
                            {row.kind === 'limit' ? 'Supplier limit' : 'Required analyte'}
                          </Typography>
                        </TableCell>
                        <TableCell>{row.detail}</TableCell>
                        <TableCell>
                          <ReviewByCell reviewBy={row.reviewBy} asOf={asOf} />
                        </TableCell>
                        {canEdit && (
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            <Tooltip arrow title="Extend or change the review-by date">
                              <IconButton
                                size="small"
                                onClick={() => {
                                  setExtending(row);
                                  setExtendTo(plusDays(row.reviewBy && row.reviewBy > asOf ? row.reviewBy : asOf, 90));
                                }}
                              >
                                <ExtendIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip arrow title="Remove — back to the company default">
                              <IconButton size="small" onClick={() => remove(row)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          ))}
        </Stack>
      )}

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add required analyte</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            A certificate of this type from this supplier that does not report the analyte (under
            its name or any alias) is flagged incomplete in the Review Queue and on the document.
          </Typography>
          {!supplierId && (
            <FormControl fullWidth margin="normal">
              <InputLabel>Supplier</InputLabel>
              <Select label="Supplier" value={addSupplier} onChange={(e) => setAddSupplier(e.target.value)}>
                {suppliers.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <FormControl fullWidth margin="normal">
            <InputLabel>Document type</InputLabel>
            <Select label="Document type" value={addDocType} onChange={(e) => setAddDocType(e.target.value)}>
              {docTypes.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth margin="normal">
            <InputLabel>Analyte</InputLabel>
            <Select label="Analyte" value={addTest} onChange={(e) => setAddTest(e.target.value)}>
              {specTests.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              label="Effective from"
              type="date"
              value={addFrom}
              onChange={(e) => setAddFrom(e.target.value)}
              margin="normal"
              InputLabelProps={{ shrink: true }}
              helperText="Blank = from now"
              fullWidth
            />
            <TextField
              label="Review by"
              type="date"
              value={addReviewBy}
              onChange={(e) => setAddReviewBy(e.target.value)}
              margin="normal"
              InputLabelProps={{ shrink: true }}
              helperText="Still applies after this date — flagged for review"
              fullWidth
            />
          </Stack>
          <TextField
            label="Why"
            value={addReason}
            onChange={(e) => setAddReason(e.target.value)}
            fullWidth
            margin="normal"
            placeholder="Sanitation watch after the August coliform finding"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveAdd} disabled={saving || !addSupplier || !addDocType || !addTest}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!extending} onClose={() => setExtending(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Review-by date</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {extending?.analyte} for this supplier. Clearing the date keeps the rule with no reminder.
          </Typography>
          <TextField
            type="date"
            label="Review by"
            value={extendTo}
            onChange={(e) => setExtendTo(e.target.value)}
            fullWidth
            margin="normal"
            InputLabelProps={{ shrink: true }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExtending(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveExtend} disabled={saving}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

export default SupplierWatchPanel;
