/**
 * Supplier › Lot format (migration 0109).
 *
 * Declare how this supplier's lot codes are built — segments, sublot, which date
 * the code encodes — and test it live against a typed lot and against every lot
 * on file, before saving. Everything here runs the same pure engine the server
 * uses (shared/lotScheme.ts), so what the tester says is what the Review Queue,
 * the lot writer and search will do.
 *
 * A declared format is a VALIDATOR and a labelled FALLBACK (AJ §6): saving one
 * rewrites no stored lot and no stored date, a decoded date never outranks a
 * stated one, and a disagreement is flagged for a person. Saving is audited and
 * appends a new version; nothing is ever overwritten.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { api } from '../lib/api';
import type { SupplierLotSchemeResponse } from '../lib/types';
import {
  decodeLot,
  formatLotIso,
  LOT_SCHEME_TEMPLATES,
  LOT_SEGMENT_KINDS,
  lotSchemeLabel,
  previewLotFit,
  validateLotSchemeSpec,
  type LotSchemeSpec,
  type LotSegment,
  type LotSegmentKind,
} from '../../shared/lotScheme';
import { formatDate } from '../utils/format';

const KIND_LABEL: Record<LotSegmentKind, string> = {
  digits: 'Digits',
  letters: 'Letters',
  alnum: 'Letters or digits',
  yy: 'Year (YY)',
  julian_day: 'Julian day (DDD)',
  mmddyy: 'Date MMDDYY',
  yymmdd: 'Date YYMMDD',
};

const FIXED_KINDS = new Set<LotSegmentKind>(['yy', 'julian_day', 'mmddyy', 'yymmdd']);

type TemplateKey = keyof typeof LOT_SCHEME_TEMPLATES;

function clone(spec: LotSchemeSpec): LotSchemeSpec {
  return JSON.parse(JSON.stringify(spec)) as LotSchemeSpec;
}

function numOrUndef(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === '' || Number.isNaN(n) ? undefined : n;
}

interface Props {
  supplierId: string;
  supplierName: string;
  canEdit: boolean;
}

export default function SupplierLotFormatPanel({ supplierId, supplierName, canEdit }: Props) {
  const [data, setData] = useState<SupplierLotSchemeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<LotSchemeSpec | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [testLot, setTestLot] = useState('');
  const [testSublot, setTestSublot] = useState('');
  const [showNotFitting, setShowNotFitting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.suppliers.lotScheme.get(supplierId);
      setData(res);
      setDraft(clone(res.current ? res.current.spec : LOT_SCHEME_TEMPLATES.none.spec));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the lot format');
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    load();
  }, [load]);

  const validation = useMemo(() => (draft ? validateLotSchemeSpec(draft) : null), [draft]);
  const valid = validation?.ok ? validation.spec : null;
  const preview = useMemo(() => (valid && data ? previewLotFit(valid, data.lots) : null), [valid, data]);
  const test = useMemo(
    () => (valid && testLot.trim() ? decodeLot(valid, testLot, testSublot || null) : null),
    [valid, testLot, testSublot],
  );
  const dirty = !!(valid && data && JSON.stringify(valid) !== JSON.stringify(data.current?.spec ?? null));

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (error || !data || !draft) return <Alert severity="error">{error || 'Failed to load the lot format'}</Alert>;

  const setSegments = (segments: LotSegment[]) => setDraft({ ...draft, segments });
  const updateSegment = (i: number, patch: Partial<LotSegment>) => {
    const segs = [...(draft.segments ?? [])];
    const next: LotSegment = { ...segs[i], ...patch };
    if (patch.kind && FIXED_KINDS.has(patch.kind)) {
      delete next.width;
      delete next.min_width;
      delete next.max_width;
      delete next.values;
    }
    for (const k of ['width', 'min_width', 'max_width'] as const) if (next[k] === undefined) delete next[k];
    if (next.values && next.values.length === 0) delete next.values;
    segs[i] = next;
    setSegments(segs);
  };

  const applyTemplate = (key: TemplateKey | 'current') => {
    setSaved('');
    if (key === 'current') setDraft(clone(data.effective.spec));
    else setDraft(clone(LOT_SCHEME_TEMPLATES[key].spec));
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    setSaved('');
    try {
      const res = await api.suppliers.lotScheme.put(supplierId, { spec: valid, note: note.trim() || null });
      setData(res);
      setDraft(clone(res.current ? res.current.spec : valid));
      setNote('');
      setSaved(res.unchanged ? 'That is already the declared format — nothing was saved.' : `Saved as version ${res.current?.version}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the lot format');
    } finally {
      setSaving(false);
    }
  };

  const structured = draft.kind === 'structured';

  return (
    <Stack spacing={2} data-testid="supplier-lot-format">
      <Box>
        <Typography variant="h6" fontWeight={600}>Lot format</Typography>
        <Typography variant="body2" color="text.secondary">
          How {supplierName}'s lot codes are built. A declared format checks every lot in the Review Queue, splits a
          lot and sublot the same way on certificates and orders, and — when the code encodes a date — supplies that
          date only where the certificate states none, labelled as decoded. It never overrides a stated date; a
          disagreement is flagged for a person.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2 }}>
        {data.current ? (
          <Typography variant="body2">
            <strong>Declared:</strong> {lotSchemeLabel(data.current.spec)} — version {data.current.version},{' '}
            {data.current.source === 'seed' ? 'seeded' : `by ${data.current.created_by_name ?? 'an admin'}`} on {formatDate(data.current.created_at)}
            {data.current.note ? ` · “${data.current.note}”` : ''}
          </Typography>
        ) : (
          <Typography variant="body2">
            <strong>Not declared.</strong> Lots are keyed by the older setting (
            <code>{data.supplier.lot_scheme ?? 'auto'}</code>), and nothing is checked or decoded.
          </Typography>
        )}
        {data.versions.length > 1 && (
          <Button size="small" sx={{ mt: 1 }} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Hide' : 'Show'} {data.versions.length} versions
          </Button>
        )}
        <Collapse in={showHistory}>
          <Stack spacing={0.5} sx={{ mt: 1 }}>
            {data.versions.map((v) => (
              <Typography key={v.id} variant="caption" color="text.secondary">
                v{v.version} · {lotSchemeLabel(v.spec)} · {v.source === 'seed' ? 'seed' : v.created_by_name ?? 'admin'} · {formatDate(v.created_at)}
                {v.note ? ` · “${v.note}”` : ''}
              </Typography>
            ))}
          </Stack>
        </Collapse>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2" sx={{ alignSelf: 'center', mr: 1 }}>Start from</Typography>
          {(Object.keys(LOT_SCHEME_TEMPLATES) as TemplateKey[]).map((k) => (
            <Chip key={k} label={LOT_SCHEME_TEMPLATES[k].title} onClick={() => applyTemplate(k)} variant="outlined" disabled={!canEdit} />
          ))}
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <FormControl size="small" sx={{ minWidth: 200 }} disabled={!canEdit}>
            <InputLabel id="lot-format-kind">Format</InputLabel>
            <Select
              labelId="lot-format-kind"
              label="Format"
              value={draft.kind}
              onChange={(e) => applyTemplate(e.target.value === 'none' ? 'none' : 'plant_yy_julian')}
            >
              <MenuItem value="structured">Structured segments</MenuItem>
              <MenuItem value="none">None — no decodable lot</MenuItem>
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="Name (how you'd say it)"
            value={draft.label ?? ''}
            onChange={(e) => setDraft({ ...draft, label: e.target.value || undefined })}
            disabled={!canEdit}
            sx={{ flex: 1 }}
          />
        </Stack>

        {structured && (
          <>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Kind</TableCell>
                  <TableCell>Width</TableCell>
                  <TableCell>Allowed values</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {(draft.segments ?? []).map((seg, i) => {
                  const fixed = FIXED_KINDS.has(seg.kind);
                  const variable = !fixed && seg.width == null;
                  return (
                    <TableRow key={i}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell>
                        <TextField size="small" value={seg.name} onChange={(e) => updateSegment(i, { name: e.target.value })} disabled={!canEdit} sx={{ width: 120 }} />
                      </TableCell>
                      <TableCell>
                        <Select size="small" value={seg.kind} onChange={(e) => updateSegment(i, { kind: e.target.value as LotSegmentKind })} disabled={!canEdit} sx={{ minWidth: 170 }}>
                          {LOT_SEGMENT_KINDS.map((k) => <MenuItem key={k} value={k}>{KIND_LABEL[k]}</MenuItem>)}
                        </Select>
                      </TableCell>
                      <TableCell>
                        {fixed ? (
                          <Typography variant="body2" color="text.secondary">{seg.kind === 'yy' ? 2 : seg.kind === 'julian_day' ? 3 : 6}</Typography>
                        ) : variable ? (
                          <Stack direction="row" spacing={0.5}>
                            <TextField size="small" label="min" value={seg.min_width ?? ''} onChange={(e) => updateSegment(i, { min_width: numOrUndef(e.target.value) })} disabled={!canEdit} sx={{ width: 64 }} />
                            <TextField size="small" label="max" value={seg.max_width ?? ''} onChange={(e) => updateSegment(i, { max_width: numOrUndef(e.target.value) })} disabled={!canEdit} sx={{ width: 64 }} />
                            <Tooltip title="Make fixed width"><Button size="small" disabled={!canEdit} onClick={() => updateSegment(i, { width: 1, min_width: undefined, max_width: undefined })}>fixed</Button></Tooltip>
                          </Stack>
                        ) : (
                          <Stack direction="row" spacing={0.5}>
                            <TextField size="small" value={seg.width ?? ''} onChange={(e) => updateSegment(i, { width: numOrUndef(e.target.value) })} disabled={!canEdit} sx={{ width: 64 }} />
                            {i === (draft.segments ?? []).length - 1 && (
                              <Tooltip title="Variable width (last segment only)"><Button size="small" disabled={!canEdit} onClick={() => updateSegment(i, { width: undefined, min_width: 0, max_width: 4 })}>variable</Button></Tooltip>
                            )}
                          </Stack>
                        )}
                      </TableCell>
                      <TableCell>
                        {!fixed && (
                          <TextField
                            size="small"
                            placeholder="any"
                            value={(seg.values ?? []).join(', ')}
                            onChange={(e) => updateSegment(i, { values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
                            disabled={!canEdit}
                            sx={{ width: 160 }}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <IconButton size="small" disabled={!canEdit} onClick={() => setSegments((draft.segments ?? []).filter((_, j) => j !== i))} aria-label="Remove segment">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Button size="small" startIcon={<AddIcon />} disabled={!canEdit} onClick={() => setSegments([...(draft.segments ?? []), { name: `part${(draft.segments ?? []).length + 1}`, kind: 'digits', width: 2 }])}>
              Add segment
            </Button>

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 2 }}>
              <FormControl size="small" sx={{ minWidth: 180 }} disabled={!canEdit}>
                <InputLabel id="lot-format-sublot">Sublot</InputLabel>
                <Select
                  labelId="lot-format-sublot"
                  label="Sublot"
                  value={draft.sublot ? String(draft.sublot.width) : 'none'}
                  onChange={(e) => setDraft({ ...draft, sublot: e.target.value === 'none' ? null : { width: Number(e.target.value), kind: draft.sublot?.kind ?? 'digits' } })}
                >
                  <MenuItem value="none">No sublot</MenuItem>
                  {[1, 2, 3, 4].map((w) => <MenuItem key={w} value={String(w)}>{w}-character sublot</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 220 }} disabled={!canEdit}>
                <InputLabel id="lot-format-key">Lot identity</InputLabel>
                <Select
                  labelId="lot-format-key"
                  label="Lot identity"
                  value={draft.key ?? 'base_plus_sublot'}
                  onChange={(e) => setDraft({
                    ...draft,
                    key: e.target.value as 'base_plus_sublot' | 'segments',
                    key_segments: e.target.value === 'segments' ? [(draft.segments ?? [])[0]?.name].filter(Boolean) as string[] : undefined,
                  })}
                >
                  <MenuItem value="base_plus_sublot">Whole lot + sublot</MenuItem>
                  <MenuItem value="segments">Only some segments</MenuItem>
                </Select>
              </FormControl>
              {draft.key === 'segments' && (
                <FormControl size="small" sx={{ minWidth: 200 }} disabled={!canEdit}>
                  <InputLabel id="lot-format-key-segments">Identity segments</InputLabel>
                  <Select
                    labelId="lot-format-key-segments"
                    label="Identity segments"
                    multiple
                    value={draft.key_segments ?? []}
                    onChange={(e) => setDraft({ ...draft, key_segments: typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value })}
                  >
                    {(draft.segments ?? []).map((s) => <MenuItem key={s.name} value={s.name}>{s.name}</MenuItem>)}
                  </Select>
                </FormControl>
              )}
              <FormControl size="small" sx={{ minWidth: 220 }} disabled={!canEdit}>
                <InputLabel id="lot-format-date">The date it encodes</InputLabel>
                <Select
                  labelId="lot-format-date"
                  label="The date it encodes"
                  value={draft.date_role ?? 'none'}
                  onChange={(e) => setDraft({ ...draft, date_role: e.target.value === 'none' ? null : (e.target.value as 'production' | 'best_by') })}
                >
                  <MenuItem value="none">No date</MenuItem>
                  <MenuItem value="production">Production date</MenuItem>
                  <MenuItem value="best_by">Best-by date</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </>
        )}

        {validation && !validation.ok && (
          <Alert severity="warning" sx={{ mt: 2 }} data-testid="lot-format-errors">
            This format can't be saved yet:
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {validation.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </Alert>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }} data-testid="lot-format-tester">
        <Typography variant="subtitle2" gutterBottom>Try a lot</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField size="small" label="Lot" placeholder="10426203-03" value={testLot} onChange={(e) => setTestLot(e.target.value)} sx={{ flex: 1 }} />
          <TextField size="small" label="Sublot (optional)" value={testSublot} onChange={(e) => setTestSublot(e.target.value)} sx={{ width: 160 }} />
        </Stack>
        {test && (
          test.fits ? (
            <Alert severity="success" sx={{ mt: 1.5 }} data-testid="lot-format-test-result">
              <strong>Fits.</strong> Lot {test.base}{test.sublot ? ` · sublot ${test.sublot}` : ''} · stored as <code>{test.key}</code>
              {' · '}
              {test.segments.map((s) => `${s.name} ${s.value || '—'}`).join(' · ')}
              {test.decoded_date && (
                <> · <strong>{test.date_role === 'production' ? 'implies production' : 'implies best-by'} {formatLotIso(test.decoded_date)}</strong></>
              )}
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mt: 1.5 }} data-testid="lot-format-test-result">
              <strong>Doesn't fit.</strong> {test.reason} Stored as written: <code>{test.key}</code>
            </Alert>
          )
        )}
        {!valid && testLot.trim() && <Typography variant="caption" color="text.secondary">Fix the format above to test a lot.</Typography>}
      </Paper>

      {preview && (
        <Paper variant="outlined" sx={{ p: 2 }} data-testid="lot-format-preview">
          <Typography variant="subtitle2" gutterBottom>Lots on file (read-only preview — saving changes none of them)</Typography>
          {valid?.kind === 'structured' ? (
            <>
              <Typography variant="body2">
                <strong>{preview.fits} of {preview.total}</strong> lot{preview.total === 1 ? '' : 's'} on file fit this format
                {preview.not_fitting.length > 0 ? `; ${preview.not_fitting.length} don't.` : '.'}
                {data.lots_truncated ? ' (First 2,000 lots only.)' : ''}
              </Typography>
              {preview.date_disagreements.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {preview.date_disagreements.length} lot{preview.date_disagreements.length === 1 ? '' : 's'} decode to a different production date than the one on file:{' '}
                  {preview.date_disagreements.slice(0, 5).map((d) => `${d.lot_number}${d.sub_lot_code ? `-${d.sub_lot_code}` : ''} (on file ${d.on_file}, code says ${d.decoded})`).join('; ')}
                  {preview.date_disagreements.length > 5 ? '…' : ''}
                </Alert>
              )}
              {preview.key_differs > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {preview.key_differs} stored lot key{preview.key_differs === 1 ? '' : 's'} differ from what this format would store for a new certificate. Existing keys are not rewritten.
                </Typography>
              )}
              {preview.not_fitting.length > 0 && (
                <>
                  <Button size="small" sx={{ mt: 1 }} onClick={() => setShowNotFitting((v) => !v)}>
                    {showNotFitting ? 'Hide' : 'Show'} the lots that don't fit
                  </Button>
                  <Collapse in={showNotFitting}>
                    <Stack spacing={0.25} sx={{ mt: 1 }}>
                      {preview.not_fitting.map((l) => (
                        <Typography key={l.lot_id} variant="caption">
                          <code>{l.lot_number}{l.sub_lot_code ? ` / ${l.sub_lot_code}` : ''}</code> — {l.reason}
                        </Typography>
                      ))}
                    </Stack>
                  </Collapse>
                </>
              )}
            </>
          ) : (
            <Typography variant="body2">{preview.total} lot{preview.total === 1 ? '' : 's'} on file. With no lot format nothing is checked or decoded.</Typography>
          )}
        </Paper>
      )}

      {canEdit && (
        <Box>
          <Divider sx={{ mb: 2 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
            <TextField size="small" label="Note (why, and the evidence)" value={note} onChange={(e) => setNote(e.target.value)} sx={{ flex: 1 }} />
            <Button variant="contained" onClick={save} disabled={!valid || saving || !dirty}>
              {saving ? 'Saving…' : data.current ? 'Save as a new version' : 'Declare this format'}
            </Button>
          </Stack>
          {saved && <Alert severity="success" sx={{ mt: 1 }}>{saved}</Alert>}
        </Box>
      )}
    </Stack>
  );
}
