/**
 * Spec Limits — the acceptance criteria a COA result is judged against.
 *
 * This is the screen the person who OWNS the specs maintains. The portal has
 * always read COAs; these rows are what let it judge one. A coliform result of
 * 40 CFU/g against a 10 CFU/g limit is a food-safety event, and until this page
 * has rows in it, that COA reaches a reviewer looking exactly like a clean one.
 *
 * TWO THINGS TO CONFIGURE, AND THE SECOND IS THE EASY ONE
 * ------------------------------------------------------
 * 1. The ANALYTE and its aliases. This is the actual work. One supplier prints
 *    "Coliform", another "Coliforms (MPN)", another "Total Coliform"; SPC / APC
 *    / TPC / Standard Plate Count are one test wearing four names. Matching is
 *    exact on the normalized text — deliberately never fuzzy, because
 *    "Coliform" would substring-match "Fecal Coliform", a different test with a
 *    different limit, and applying the wrong limit invisibly is the worst
 *    outcome available. So every printed spelling has to be listed.
 * 2. The LIMIT itself: an operator and a number.
 *
 * SCOPE. A limit with no supplier and no document type is a tenant-wide
 * default, and that is the row worth writing first — it works immediately,
 * before a single supplier is configured. Narrower rows override it.
 *
 * Product scoping exists in the schema but is not offered here yet: the review
 * queue cannot resolve a document's products at review time, so a
 * product-scoped limit would sit in this list looking active while never
 * firing. Better to omit the option than to ship a lie.
 *
 * ONE SETTING ON THIS PAGE CHANGES HOW A LIMIT IS READ rather than adding
 * another one: unit equivalence (migration 0093). It is deliberately at the top
 * and worded as the QA judgement it is, because a tenant that turns it on is
 * saying something about its products — that a millilitre and a gram of them
 * are the same quantity for counting purposes — and that is not a claim code
 * should make on anyone's behalf. Off by default.
 *
 * CRITICALITY RANKS WHAT THIS SCREEN SHOWS (migration 0095). A spec sheet is
 * mostly parameters written tighter than the plant can consistently hit, to
 * support a nutrition-panel claim — they are TRACKED, not acted on, and only a
 * few would ever stop a load. Listing all of them flat is how the owner of this
 * page stops reading it, and how the reviewer downstream stops reading the
 * warnings it produces. So each limit carries a tier, every new limit starts on
 * the middle one, and the list can be grouped by tier to put the load-stopping
 * few above the tracked many.
 *
 * The tier changes NO verdict — the same results are judged, the same way. See
 * shared/specCriticality.ts, which owns the vocabulary (still provisional).
 *
 * NOTHING HERE BLOCKS AN APPROVAL. These rows produce warnings.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Science as AnalyteIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import {
  DEFAULT_SPEC_CRITICALITY,
  SPEC_CRITICALITY_COLOR,
  SPEC_CRITICALITY_HELP,
  SPEC_CRITICALITY_LABELS,
  SPEC_CRITICALITY_VALUES,
  compareSpecCriticality,
  parseSpecCriticality,
} from '../../../shared/specCriticality';
import type { SpecCriticality } from '../../../shared/specCriticality';
import type { ApiSpecTest, ApiSpecLimit, ApiSupplier, ApiDocumentType } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { EmptyState } from '../../components/EmptyState';
import { ReviewByCell, SupplierWatchPanel } from '../../components/SupplierWatchPanel';
import { UnmatchedAnalytesPanel } from '../../components/UnmatchedAnalytesPanel';
import type { UnmatchedAnalyteGroup } from '../../lib/types';
import { useSearchParams } from 'react-router-dom';

/** Operators, worded the way someone writing a spec would say them. */
const OPERATORS: Array<{ value: string; label: string; needs: 'max' | 'min' | 'both' | 'none' }> = [
  { value: '<=', label: 'at most (≤)', needs: 'max' },
  { value: '<', label: 'less than (<)', needs: 'max' },
  { value: '>=', label: 'at least (≥)', needs: 'min' },
  { value: '>', label: 'greater than (>)', needs: 'min' },
  { value: 'between', label: 'between', needs: 'both' },
  { value: '==', label: 'exactly', needs: 'min' },
  { value: 'absent', label: 'absent / negative', needs: 'none' },
];

const needsFor = (op: string) => OPERATORS.find((o) => o.value === op)?.needs ?? 'max';

/** Render a stored limit the way a reviewer will see it. */
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

/** The tier a stored limit sits in, tolerating a row written before 0095. */
function criticalityOf(l: ApiSpecLimit): SpecCriticality {
  return parseSpecCriticality(l.criticality);
}

/** Most critical first — the whole reason this attribute exists. */
function byCriticality(a: ApiSpecLimit, b: ApiSpecLimit): number {
  return compareSpecCriticality(criticalityOf(a), criticalityOf(b));
}

/** One tier, worded and coloured the same way everywhere it appears. */
function CriticalityChip({ limit }: { limit: ApiSpecLimit }) {
  const tier = criticalityOf(limit);
  return (
    <Tooltip arrow title={SPEC_CRITICALITY_HELP[tier]}>
      <Chip
        size="small"
        variant={tier === 'high' ? 'filled' : 'outlined'}
        color={SPEC_CRITICALITY_COLOR[tier]}
        label={SPEC_CRITICALITY_LABELS[tier]}
      />
    </Tooltip>
  );
}

/**
 * A limit's recorded reason, where there is one — and the ABSENCE of one on a
 * supplier watch, which is the thing AJ asked to be able to see.
 *
 * The column is 0084's `notes` and has been there since the beginning; nothing
 * in the app has ever read it. Nine limits on the live tenant carry a note
 * nobody could see, two of them open questions addressed to a person.
 *
 * A note on a TENANT-WIDE limit is printed but never chased: the company
 * standard does not have to justify itself to itself. A supplier-scoped limit
 * is a decision to hold one vendor tighter than what they certify against, and
 * "no reason recorded" on one of those is itself the finding.
 */
export function LimitRationale({ limit }: { limit: ApiSpecLimit }) {
  if (limit.notes) {
    return (
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
        {limit.supplier_id ? 'Why: ' : ''}
        {limit.notes}
      </Typography>
    );
  }
  if (!limit.supplier_id) return null;
  return (
    <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.25 }}>
      No reason recorded — edit to say why this supplier is held tighter.
    </Typography>
  );
}

/**
 * The limit rows themselves. One renderer for both layouts so the analyte view
 * and the criticality view can never drift into showing different facts about
 * the same limit. Module scope, handlers passed in — a component redefined on
 * every render would remount this table on every keystroke elsewhere.
 */
function LimitTable({
  rows,
  showAnalyte = false,
  onEdit,
  onRemove,
}: {
  rows: ApiSpecLimit[];
  /** Adds the analyte column and drops the tier chip (the section is the tier). */
  showAnalyte?: boolean;
  onEdit: (l: ApiSpecLimit) => void;
  onRemove: (l: ApiSpecLimit) => void;
}) {
  return (
    <TableContainer sx={{ mt: 1.5 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            {showAnalyte && <TableCell sx={{ fontWeight: 600 }}>Analyte</TableCell>}
            <TableCell sx={{ fontWeight: 600 }}>Limit</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Applies to</TableCell>
            {!showAnalyte && (
              <TableCell sx={{ fontWeight: 600 }}>
                <Tooltip
                  arrow
                  title="How much this parameter matters. It ranks and colours the warning; it never changes the verdict."
                >
                  <span>How much it matters</span>
                </Tooltip>
              </TableCell>
            )}
            <TableCell sx={{ fontWeight: 600 }}>On failure</TableCell>
            <TableCell align="right" />
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((l) => (
            <TableRow key={l.id} sx={{ opacity: l.active ? 1 : 0.5 }}>
              {showAnalyte && <TableCell>{l.test_name}</TableCell>}
              <TableCell sx={{ fontWeight: 600 }}>{limitText(l)}</TableCell>
              <TableCell>
                {scopeText(l)}
                {l.supplier_id && l.review_by && (
                  <Box sx={{ mt: 0.25 }}>
                    <ReviewByCell reviewBy={l.review_by} asOf={new Date().toISOString().slice(0, 10)} />
                  </Box>
                )}
                <LimitRationale limit={l} />
              </TableCell>
              {/* Grouped by tier, the chip on every row would repeat the
                  section heading, so it is dropped there instead of shown
                  twice. */}
              {!showAnalyte && (
                <TableCell>
                  <CriticalityChip limit={l} />
                </TableCell>
              )}
              <TableCell>
                <Chip
                  size="small"
                  variant="outlined"
                  color={l.severity === 'alert' ? 'error' : 'default'}
                  label={l.severity === 'alert' ? 'Notify owner' : 'Queue only'}
                />
              </TableCell>
              <TableCell align="right">
                <IconButton size="small" onClick={() => onEdit(l)}>
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton size="small" onClick={() => onRemove(l)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function scopeText(l: ApiSpecLimit): string {
  const parts: string[] = [];
  if (l.supplier_name) parts.push(l.supplier_name);
  if (l.document_type_name) parts.push(l.document_type_name);
  if (l.product_name) parts.push(l.product_name);
  return parts.length ? parts.join(' · ') : 'All suppliers';
}

export function SpecLimits() {
  const [specTests, setSpecTests] = useState<ApiSpecTest[]>([]);
  const [limits, setLimits] = useState<ApiSpecLimit[]>([]);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [docTypes, setDocTypes] = useState<ApiDocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Unit equivalence (migration 0093). `null` = we could not read it — the
  // control is then shown disabled rather than defaulted to "off", because a
  // switch that shows a state it did not load is a lie about a safety setting.
  const [unitEquiv, setUnitEquiv] = useState<boolean | null>(null);
  const [unitEquivSaving, setUnitEquivSaving] = useState(false);

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const activeTenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  // Analyte dialog
  const [testDialog, setTestDialog] = useState(false);
  const [editingTest, setEditingTest] = useState<ApiSpecTest | null>(null);
  const [testName, setTestName] = useState('');
  const [testAliases, setTestAliases] = useState('');
  const [testUnit, setTestUnit] = useState('');

  // Limit dialog
  const [limitDialog, setLimitDialog] = useState(false);
  const [editingLimit, setEditingLimit] = useState<ApiSpecLimit | null>(null);
  const [limitTestId, setLimitTestId] = useState('');
  const [limitOperator, setLimitOperator] = useState('<=');
  const [limitMin, setLimitMin] = useState('');
  const [limitMax, setLimitMax] = useState('');
  const [limitUnit, setLimitUnit] = useState('');
  const [limitSupplier, setLimitSupplier] = useState('');
  const [limitDocType, setLimitDocType] = useState('');
  const [limitSeverity, setLimitSeverity] = useState('alert');
  const [limitCriticality, setLimitCriticality] = useState<SpecCriticality>(DEFAULT_SPEC_CRITICALITY);
  // Watch review-by (migration 0109) — offered only once a supplier is chosen.
  const [limitReviewBy, setLimitReviewBy] = useState('');
  // WHY this limit is written this way (0084's `notes`, asked for at last).
  // AJ Conner, reviewing v2.7.0-v2.20.0: "tightening past what a supplier
  // certifies against is a decision purchasing and the supplier will ask
  // about, and it is hard to defend a year later with no recorded rationale."
  // It sits beside the review-by because they are one question in two halves:
  // why, and when to look again.
  const [limitNotes, setLimitNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // Bumped after every load so the watch panel re-reads what this page changed.
  const [watchReload, setWatchReload] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();

  // How the list is laid out. 'analyte' is the original shape and stays the
  // default — it is how the person maintaining aliases thinks. 'criticality'
  // answers the other question this page has never been able to answer at a
  // glance: which of these would actually stop a load?
  const [groupBy, setGroupBy] = useState<'analyte' | 'criticality'>('analyte');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [t, l, s, d, p] = await Promise.all([
        api.specTests.list({ tenant_id: activeTenantId }),
        api.specLimits.list({ tenant_id: activeTenantId }),
        api.suppliers.list({ tenant_id: activeTenantId, limit: 200 }).catch(() => ({ suppliers: [] })),
        api.documentTypes.list({ tenant_id: activeTenantId }).catch(() => ({ documentTypes: [] })),
        api.specUnitPolicy.get({ tenant_id: activeTenantId }).catch(() => null),
      ]);
      setSpecTests(t.specTests);
      setLimits(l.specLimits);
      setSuppliers((s as { suppliers: ApiSupplier[] }).suppliers || []);
      setDocTypes((d as { documentTypes: ApiDocumentType[] }).documentTypes || []);
      setUnitEquiv(p ? p.volume_mass_equivalent : null);
      setWatchReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load spec limits');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenantId]);

  // Arriving from a supplier's Spec watch tab ("Add a tighter limit"): open the
  // limit dialog already scoped to that supplier, once analytes have loaded.
  useEffect(() => {
    const watchSupplier = searchParams.get('watch_supplier');
    if (!watchSupplier || specTests.length === 0) return;
    openCreateLimit(undefined, watchSupplier);
    const next = new URLSearchParams(searchParams);
    next.delete('watch_supplier');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, specTests.length]);

  const limitsByTest = useMemo(() => {
    const out: Record<string, ApiSpecLimit[]> = {};
    for (const l of limits) (out[l.spec_test_id] ||= []).push(l);
    // Critical first inside every analyte, even in the analyte view — a tenant
    // with a tenant-wide tracked limit and one supplier-specific critical
    // override should not have to read past the softer row to find the hard one.
    for (const rows of Object.values(out)) rows.sort(byCriticality);
    return out;
  }, [limits]);

  /**
   * The same limits, bucketed by tier. Every tier gets a bucket even when it is
   * empty: "nothing is marked critical" is itself worth seeing on this page,
   * and a silently missing section reads as "no such thing" instead.
   */
  const limitsByCriticality = useMemo(() => {
    const out = {} as Record<SpecCriticality, ApiSpecLimit[]>;
    for (const tier of SPEC_CRITICALITY_VALUES) out[tier] = [];
    for (const l of limits) out[criticalityOf(l)].push(l);
    for (const tier of SPEC_CRITICALITY_VALUES) {
      out[tier].sort((a, b) => (a.test_name || '').localeCompare(b.test_name || ''));
    }
    return out;
  }, [limits]);

  /**
   * Flip the equivalence. Optimistic-free on purpose: the switch only moves
   * once the server has said it moved, so the page never shows a rule that is
   * not actually in force.
   */
  const saveUnitEquiv = async (next: boolean) => {
    setUnitEquivSaving(true);
    setError('');
    try {
      const saved = await api.specUnitPolicy.put({
        volume_mass_equivalent: next,
        tenant_id: isSuperAdmin ? activeTenantId : undefined,
      });
      setUnitEquiv(saved.volume_mass_equivalent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the unit setting');
    } finally {
      setUnitEquivSaving(false);
    }
  };

  const openCreateTest = () => {
    setEditingTest(null);
    setTestName('');
    setTestAliases('');
    setTestUnit('');
    setTestDialog(true);
  };

  /**
   * "New analyte" from the unmatched panel: the dialog opens already carrying
   * every spelling the certificates printed, so the analyte that gets created
   * matches them on the next document rather than needing a second pass. The
   * NAME is the commonest spelling and is meant to be edited — what a lab prints
   * is not always what a QA manager calls it.
   */
  const openCreateTestFromUnmatched = (group: UnmatchedAnalyteGroup) => {
    setEditingTest(null);
    setTestName(group.name);
    setTestAliases(group.spellings.map((s) => s.name).join(', '));
    setTestUnit(group.example?.unit_raw || '');
    setTestDialog(true);
  };

  const openEditTest = (t: ApiSpecTest) => {
    setEditingTest(t);
    setTestName(t.name);
    setTestAliases((t.aliases || []).join(', '));
    setTestUnit(t.default_unit || '');
    setTestDialog(true);
  };

  const saveTest = async () => {
    setSaving(true);
    setError('');
    try {
      const aliases = testAliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      if (editingTest) {
        await api.specTests.update(editingTest.id, {
          name: testName.trim(),
          aliases,
          default_unit: testUnit.trim() || null,
        });
      } else {
        await api.specTests.create({
          name: testName.trim(),
          aliases,
          default_unit: testUnit.trim() || null,
          tenant_id: isSuperAdmin ? activeTenantId : undefined,
        });
      }
      setTestDialog(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save analyte');
    } finally {
      setSaving(false);
    }
  };

  const removeTest = async (t: ApiSpecTest) => {
    const n = (limitsByTest[t.id] || []).length;
    const warning = n
      ? `Delete "${t.name}" and its ${n} limit${n === 1 ? '' : 's'}? Those checks stop running.`
      : `Delete "${t.name}"?`;
    if (!window.confirm(warning)) return;
    try {
      await api.specTests.remove(t.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete analyte');
    }
  };

  const openCreateLimit = (specTestId?: string, supplierId?: string) => {
    setEditingLimit(null);
    setLimitTestId(specTestId || specTests[0]?.id || '');
    setLimitOperator('<=');
    setLimitMin('');
    setLimitMax('');
    setLimitUnit(specTests.find((t) => t.id === specTestId)?.default_unit || '');
    setLimitSupplier(supplierId || '');
    setLimitDocType('');
    setLimitSeverity('alert');
    setLimitCriticality(DEFAULT_SPEC_CRITICALITY);
    setLimitReviewBy('');
    setLimitNotes('');
    setLimitDialog(true);
  };

  const openEditLimit = (l: ApiSpecLimit) => {
    setEditingLimit(l);
    setLimitTestId(l.spec_test_id);
    setLimitOperator(l.operator);
    setLimitMin(l.value_min == null ? '' : String(l.value_min));
    setLimitMax(l.value_max == null ? '' : String(l.value_max));
    setLimitUnit(l.unit || '');
    setLimitSupplier(l.supplier_id || '');
    setLimitDocType(l.document_type_id || '');
    setLimitSeverity(l.severity);
    setLimitCriticality(criticalityOf(l));
    setLimitReviewBy(l.review_by || '');
    setLimitNotes(l.notes || '');
    setLimitDialog(true);
  };

  const saveLimit = async () => {
    setSaving(true);
    setError('');
    try {
      const needs = needsFor(limitOperator);
      const payload = {
        operator: limitOperator,
        value_min: needs === 'min' || needs === 'both' ? Number(limitMin) : null,
        value_max: needs === 'max' || needs === 'both' ? Number(limitMax) : null,
        unit: limitUnit.trim() || null,
        supplier_id: limitSupplier || null,
        document_type_id: limitDocType || null,
        severity: limitSeverity,
        criticality: limitCriticality,
        // A review-by only exists on a supplier watch; moving a limit to
        // "all suppliers" clears it in the same request.
        review_by: limitSupplier ? limitReviewBy || null : null,
        // Sent whatever the scope: a tenant-wide limit may carry a note too,
        // it simply is not asked for. Nine limits on the live tenant already
        // hold one written before anything in the app could show it.
        notes: limitNotes.trim() || null,
      };
      if (editingLimit) {
        await api.specLimits.update(editingLimit.id, payload);
      } else {
        await api.specLimits.create({
          ...payload,
          spec_test_id: limitTestId,
          tenant_id: isSuperAdmin ? activeTenantId : undefined,
        });
      }
      setLimitDialog(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save limit');
    } finally {
      setSaving(false);
    }
  };

  const removeLimit = async (l: ApiSpecLimit) => {
    if (!window.confirm(`Delete the ${limitText(l)} limit for ${l.test_name}?`)) return;
    try {
      await api.specLimits.remove(l.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete limit');
    }
  };

  if (loading && specTests.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const needs = needsFor(limitOperator);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 1,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h4" fontWeight={700}>
          Spec Limits
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<AnalyteIcon />} onClick={openCreateTest}>
            Add Analyte
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => openCreateLimit()}
            disabled={specTests.length === 0}
          >
            Add Limit
          </Button>
        </Stack>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A result outside one of these limits is flagged for the reviewer when the
        COA arrives. Limits never block an approval — they ask for eyes. A limit
        with no supplier applies everywhere; add a narrower one to override it.
        Mark the few that would actually stop a load as{' '}
        <strong>{SPEC_CRITICALITY_LABELS.high}</strong> so they are not read at
        the same volume as the many you simply track.
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="caption" color="text.secondary">
          Group by
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={groupBy}
          onChange={(_e, v: 'analyte' | 'criticality' | null) => v && setGroupBy(v)}
        >
          <ToggleButton value="analyte">Analyte</ToggleButton>
          <ToggleButton value="criticality">How much it matters</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <FormControlLabel
          sx={{ alignItems: 'flex-start', m: 0 }}
          control={
            <Switch
              sx={{ mt: 0.25, mr: 1 }}
              checked={unitEquiv === true}
              disabled={unitEquiv === null || unitEquivSaving}
              onChange={(e) => saveUnitEquiv(e.target.checked)}
            />
          }
          label={
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Judge results in CFU/mL against limits written in CFU/g
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Suppliers print fluid results per millilitre and your limits are
                written per gram. With this <strong>on</strong>, a result of
                120 CFU/mL is compared against a ≤20,000 CFU/g limit as the same
                number — which is right for milk and cream, where a millilitre
                and a gram differ by about 3%. With it <strong>off</strong>,
                those results come back as “could not be judged” — never as a
                pass. The same applies to MPN/mL against MPN/g.
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                <strong>This is a QA decision, not a technical one.</strong>{' '}
                Leave it off if you handle powders or dry blends, where a gram
                and a millilitre are genuinely different quantities and treating
                them alike would let a real failure read as a pass. It does not
                loosen anything else: a percentage against a CFU limit, or CFU
                against MPN, is still refused either way. Every result judged
                under this setting says so on the review screen and in the
                out-of-spec register.
              </Typography>
              {unitEquiv === null && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  Setting unavailable — pick a tenant first, or this environment
                  has not taken migration 0093 yet.
                </Typography>
              )}
            </Box>
          }
        />
      </Paper>

      {/* Before the limits themselves, deliberately: a limit that never matches
          a spelling is the one failure this page cannot otherwise show, and it
          looks identical to everything being fine. */}
      <UnmatchedAnalytesPanel
        tenantId={activeTenantId}
        specTests={specTests}
        reloadKey={watchReload}
        onAliasAdded={load}
        onCreateAnalyte={openCreateTestFromUnmatched}
      />

      {specTests.length > 0 && (
        <SupplierWatchPanel
          tenantId={activeTenantId}
          reloadKey={watchReload}
          onChanged={load}
        />
      )}

      {specTests.length === 0 ? (
        <EmptyState
          title="No analytes yet"
          description="Start with the test you care most about — coliform, for instance — and list every spelling your suppliers print for it. Then give it a limit."
          actionLabel="Add Analyte"
          onAction={openCreateTest}
        />
      ) : groupBy === 'criticality' ? (
        <Stack spacing={2}>
          {SPEC_CRITICALITY_VALUES.map((tier) => {
            const rows = limitsByCriticality[tier];
            return (
              <Paper key={tier} variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    size="small"
                    variant={tier === 'high' ? 'filled' : 'outlined'}
                    color={SPEC_CRITICALITY_COLOR[tier]}
                    label={SPEC_CRITICALITY_LABELS[tier]}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {SPEC_CRITICALITY_HELP[tier]}
                  </Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  <Typography variant="caption" color="text.secondary">
                    {rows.length} {rows.length === 1 ? 'limit' : 'limits'}
                  </Typography>
                </Stack>
                {rows.length === 0 ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    {tier === 'high'
                      ? 'Nothing is marked critical yet — every limit is being read at the same volume.'
                      : 'Nothing in this tier.'}
                  </Typography>
                ) : (
                  <LimitTable rows={rows} showAnalyte onEdit={openEditLimit} onRemove={removeLimit} />
                )}
              </Paper>
            );
          })}
        </Stack>
      ) : (
        <Stack spacing={2}>
          {specTests.map((t) => {
            const rows = limitsByTest[t.id] || [];
            return (
              <Paper key={t.id} variant="outlined" sx={{ p: 2 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    flexWrap: 'wrap',
                  }}
                >
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      {t.name}
                      {t.default_unit && (
                        <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                          {t.default_unit}
                        </Typography>
                      )}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {(t.aliases || []).length === 0 ? (
                        <Tooltip
                          arrow
                          title="Only the exact name above will match. If a supplier prints anything else, this analyte is skipped on their COAs."
                        >
                          <Chip size="small" variant="outlined" color="warning" label="no aliases" />
                        </Tooltip>
                      ) : (
                        (t.aliases || []).map((a) => (
                          <Chip key={a} size="small" variant="outlined" label={a} />
                        ))
                      )}
                    </Box>
                  </Box>
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title="Edit analyte and aliases" arrow>
                      <IconButton size="small" onClick={() => openEditTest(t)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete analyte" arrow>
                      <IconButton size="small" onClick={() => removeTest(t)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Box>

                {rows.length === 0 ? (
                  <Alert severity="info" sx={{ mt: 1.5 }}>
                    No limit yet — nothing is checked for {t.name}.
                    <Button size="small" onClick={() => openCreateLimit(t.id)} sx={{ ml: 1 }}>
                      Add one
                    </Button>
                  </Alert>
                ) : (
                  <LimitTable rows={rows} onEdit={openEditLimit} onRemove={removeLimit} />
                )}
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Analyte dialog */}
      <Dialog open={testDialog} onClose={() => setTestDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingTest ? 'Edit Analyte' : 'Add Analyte'}</DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            value={testName}
            onChange={(e) => setTestName(e.target.value)}
            fullWidth
            margin="normal"
            placeholder="Coliform"
            helperText="What you call this test."
          />
          <TextField
            label="Aliases"
            value={testAliases}
            onChange={(e) => setTestAliases(e.target.value)}
            fullWidth
            margin="normal"
            placeholder="Coliforms (MPN), Total Coliform, COLIFORM CT"
            helperText="Comma-separated. Every spelling your suppliers actually print — matching is exact, so a name that isn't listed is skipped rather than guessed at."
          />
          <TextField
            label="Default unit"
            value={testUnit}
            onChange={(e) => setTestUnit(e.target.value)}
            fullWidth
            margin="normal"
            placeholder="CFU/g"
            helperText="Used when a limit doesn't state its own. A result in a different unit family (CFU/mL, MPN/g) is reported as not checked, never converted."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTestDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={saveTest} disabled={saving || !testName.trim()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Limit dialog */}
      <Dialog open={limitDialog} onClose={() => setLimitDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingLimit ? 'Edit Limit' : 'Add Limit'}</DialogTitle>
        <DialogContent>
          <FormControl fullWidth margin="normal" disabled={!!editingLimit}>
            <InputLabel>Analyte</InputLabel>
            <Select
              label="Analyte"
              value={limitTestId}
              onChange={(e) => {
                setLimitTestId(e.target.value);
                const t = specTests.find((x) => x.id === e.target.value);
                if (t?.default_unit && !limitUnit) setLimitUnit(t.default_unit);
              }}
            >
              {specTests.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <FormControl sx={{ minWidth: 170 }} margin="normal">
              <InputLabel>Condition</InputLabel>
              <Select
                label="Condition"
                value={limitOperator}
                onChange={(e) => setLimitOperator(e.target.value)}
              >
                {OPERATORS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {(needs === 'min' || needs === 'both') && (
              <TextField
                label={needs === 'both' ? 'From' : 'Value'}
                value={limitMin}
                onChange={(e) => setLimitMin(e.target.value)}
                margin="normal"
                type="number"
              />
            )}
            {(needs === 'max' || needs === 'both') && (
              <TextField
                label={needs === 'both' ? 'To' : 'Value'}
                value={limitMax}
                onChange={(e) => setLimitMax(e.target.value)}
                margin="normal"
                type="number"
              />
            )}
            <TextField
              label="Unit"
              value={limitUnit}
              onChange={(e) => setLimitUnit(e.target.value)}
              margin="normal"
              sx={{ width: 120 }}
              placeholder="CFU/g"
            />
          </Stack>

          <FormControl fullWidth margin="normal">
            <InputLabel>Supplier</InputLabel>
            <Select
              label="Supplier"
              value={limitSupplier}
              onChange={(e) => setLimitSupplier(e.target.value)}
            >
              <MenuItem value="">All suppliers (tenant default)</MenuItem>
              {suppliers.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* WHY, AND WHEN TO LOOK AGAIN — one box, because they are one
              question. A supplier-specific limit is a decision to hold this
              vendor tighter than what they certify against; purchasing and the
              vendor will ask about it, and in a year nobody will remember. The
              review-by says when to revisit, the rationale says what to
              revisit. Neither is offered on a tenant-wide limit: the company
              standard needs no defence against itself. */}
          {limitSupplier && (
            <Box sx={{ mt: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
              <Typography variant="subtitle2" fontWeight={600}>
                This supplier is on watch
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Holding one supplier tighter than the company default is a decision somebody will
                be asked to defend. Record why, and when to look at it again.
              </Typography>
              <TextField
                label="Why this supplier is held tighter"
                value={limitNotes}
                onChange={(e) => setLimitNotes(e.target.value)}
                fullWidth
                margin="normal"
                multiline
                minRows={2}
                required
                error={!limitNotes.trim()}
                placeholder="e.g. Three coliform excursions in Q2 2026; agreed with the supplier on 14 Aug pending their corrective action."
                helperText={
                  limitNotes.trim()
                    ? 'Shown wherever this watch appears, and frozen onto every result it judges — so a verdict a year from now still says why.'
                    : 'Needed: a limit tighter than what the supplier certifies against is hard to defend later with no recorded reason.'
                }
              />
              <TextField
                label="Review by"
                type="date"
                value={limitReviewBy}
                onChange={(e) => setLimitReviewBy(e.target.value)}
                fullWidth
                margin="normal"
                InputLabelProps={{ shrink: true }}
                helperText="On this date the watch is flagged for review — it keeps applying until you extend or remove it. Nothing lapses on its own."
              />
            </Box>
          )}

          <FormControl fullWidth margin="normal">
            <InputLabel>Document type</InputLabel>
            <Select
              label="Document type"
              value={limitDocType}
              onChange={(e) => setLimitDocType(e.target.value)}
            >
              <MenuItem value="">Any document type</MenuItem>
              {docTypes.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth margin="normal">
            <InputLabel>How much it matters</InputLabel>
            <Select
              label="How much it matters"
              value={limitCriticality}
              onChange={(e) => setLimitCriticality(e.target.value as SpecCriticality)}
            >
              {SPEC_CRITICALITY_VALUES.map((tier) => (
                <MenuItem key={tier} value={tier}>
                  {SPEC_CRITICALITY_LABELS[tier]} — {SPEC_CRITICALITY_HELP[tier]}
                </MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              Ranks and colours the warning a reviewer sees. It changes nothing
              about the check itself — the same result is judged the same way,
              whichever tier this is. New limits start on{' '}
              {SPEC_CRITICALITY_LABELS[DEFAULT_SPEC_CRITICALITY]}.
            </Typography>
          </FormControl>

          <FormControl fullWidth margin="normal">
            <InputLabel>On failure</InputLabel>
            <Select
              label="On failure"
              value={limitSeverity}
              onChange={(e) => setLimitSeverity(e.target.value)}
            >
              <MenuItem value="alert">Notify the owner of this queue</MenuItem>
              <MenuItem value="warn">Show in the review queue only</MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLimitDialog(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveLimit}
            disabled={saving || !limitTestId || (Boolean(limitSupplier) && !limitNotes.trim())}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default SpecLimits;
