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
  InputLabel,
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
  Edit as EditIcon,
  Science as AnalyteIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSpecTest, ApiSpecLimit, ApiSupplier, ApiDocumentType } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { EmptyState } from '../../components/EmptyState';

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
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [t, l, s, d] = await Promise.all([
        api.specTests.list({ tenant_id: activeTenantId }),
        api.specLimits.list({ tenant_id: activeTenantId }),
        api.suppliers.list({ tenant_id: activeTenantId, limit: 200 }).catch(() => ({ suppliers: [] })),
        api.documentTypes.list({ tenant_id: activeTenantId }).catch(() => ({ documentTypes: [] })),
      ]);
      setSpecTests(t.specTests);
      setLimits(l.specLimits);
      setSuppliers((s as { suppliers: ApiSupplier[] }).suppliers || []);
      setDocTypes((d as { documentTypes: ApiDocumentType[] }).documentTypes || []);
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

  const limitsByTest = useMemo(() => {
    const out: Record<string, ApiSpecLimit[]> = {};
    for (const l of limits) (out[l.spec_test_id] ||= []).push(l);
    return out;
  }, [limits]);

  const openCreateTest = () => {
    setEditingTest(null);
    setTestName('');
    setTestAliases('');
    setTestUnit('');
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

  const openCreateLimit = (specTestId?: string) => {
    setEditingLimit(null);
    setLimitTestId(specTestId || specTests[0]?.id || '');
    setLimitOperator('<=');
    setLimitMin('');
    setLimitMax('');
    setLimitUnit(specTests.find((t) => t.id === specTestId)?.default_unit || '');
    setLimitSupplier('');
    setLimitDocType('');
    setLimitSeverity('alert');
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

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        A result outside one of these limits is flagged for the reviewer when the
        COA arrives. Limits never block an approval — they ask for eyes. A limit
        with no supplier applies everywhere; add a narrower one to override it.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {specTests.length === 0 ? (
        <EmptyState
          title="No analytes yet"
          description="Start with the test you care most about — coliform, for instance — and list every spelling your suppliers print for it. Then give it a limit."
          actionLabel="Add Analyte"
          onAction={openCreateTest}
        />
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
                  <TableContainer sx={{ mt: 1.5 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 600 }}>Limit</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>Applies to</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>On failure</TableCell>
                          <TableCell align="right" />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {rows.map((l) => (
                          <TableRow key={l.id} sx={{ opacity: l.active ? 1 : 0.5 }}>
                            <TableCell sx={{ fontWeight: 600 }}>{limitText(l)}</TableCell>
                            <TableCell>{scopeText(l)}</TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                variant="outlined"
                                color={l.severity === 'alert' ? 'error' : 'default'}
                                label={l.severity === 'alert' ? 'Notify owner' : 'Queue only'}
                              />
                            </TableCell>
                            <TableCell align="right">
                              <IconButton size="small" onClick={() => openEditLimit(l)}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                              <IconButton size="small" onClick={() => removeLimit(l)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
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
          <Button variant="contained" onClick={saveLimit} disabled={saving || !limitTestId}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default SpecLimits;
