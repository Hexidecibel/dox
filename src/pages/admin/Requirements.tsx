/**
 * Requirements — the layer-2 vocabulary admin (migration 0080).
 *
 * A "requirement" is one line item on the tenant's document checklist: the
 * thing a document CLOSES. One spec sheet typically closes several at once.
 * These are per-tenant rows, so a new vertical is configured here rather than
 * built — the page deliberately contains no food-specific language.
 *
 * Structure mirrors admin/DocumentTypes.tsx (same role gate on the API, same
 * tenant filter, same soft-delete via the active flag).
 */

import { useState, useEffect, useMemo } from 'react';
import {
  REQUIREMENT_SCOPES,
  REQUIREMENT_SCOPE_LABELS,
  REQUIREMENT_SCOPE_SHORT,
  normalizeRequirementScope,
  type RequirementScope,
} from '../../../shared/requirementScope';
import type { RequirementScopePreview } from '../../../shared/types';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Add as AddIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiRequirement } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';

/**
 * What the "Satisfied by" number counts, said outright (AJ, 2026-09-20: "reads
 * 0 on every row -- what does that number count?"). It is NOT the types that
 * could close the item; that is "Closed by".
 */
const SATISFIED_BY_TOOLTIP =
  'Approved documents confirmed against this requirement. A suggested link a person has not confirmed is not counted.';

/** Read-only "Closed by: <types>" -- the document-type mapping (migration 0100). */
function closedByText(req: ApiRequirement): string {
  const types = req.closed_by_types ?? [];
  return types.length ? types.join(', ') : 'no document type yet';
}

export function Requirements() {
  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  const [tenantFilter, setTenantFilter] = useState<string>('');
  const [checklistFilter, setChecklistFilter] = useState<string>('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApiRequirement | null>(null);
  const [formName, setFormName] = useState('');
  const [formChecklist, setFormChecklist] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [formScope, setFormScope] = useState<RequirementScope>('supplier');
  const [scopePreview, setScopePreview] = useState<RequirementScopePreview | null>(null);
  const [scopePreviewError, setScopePreviewError] = useState('');
  const [saving, setSaving] = useState(false);

  const activeTenantId = isSuperAdmin
    ? tenantFilter || selectedTenantId || undefined
    : user?.tenant_id || undefined;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.requirements.list({ tenant_id: activeTenantId });
      setRequirements(result.requirements);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load requirements');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [tenantFilter, selectedTenantId]);

  /** Checklist groupings present in the data, for the filter dropdown. */
  const checklists = useMemo(() => {
    const set = new Set<string>();
    for (const r of requirements) if (r.checklist) set.add(r.checklist);
    return [...set].sort();
  }, [requirements]);

  const visible = useMemo(
    () => (checklistFilter ? requirements.filter((r) => r.checklist === checklistFilter) : requirements),
    [requirements, checklistFilter],
  );

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormChecklist(checklistFilter || checklists[0] || '');
    setFormDescription('');
    setFormTenantId(isSuperAdmin ? tenantFilter || selectedTenantId || '' : user?.tenant_id || '');
    setFormScope('supplier');
    setDialogOpen(true);
  };

  const openEdit = (req: ApiRequirement) => {
    setEditing(req);
    setFormName(req.name);
    setFormChecklist(req.checklist || '');
    setFormDescription(req.description || '');
    setFormTenantId(req.tenant_id);
    setFormScope(normalizeRequirementScope(req.scope));
    setDialogOpen(true);
  };

  // Changing an existing requirement's scope moves every supplier it is
  // attached to, so the impact is read BEFORE saving (0123). Read-only.
  const scopeChanged = !!editing && normalizeRequirementScope(editing.scope) !== formScope;
  useEffect(() => {
    setScopePreview(null);
    setScopePreviewError('');
    if (!editing || !scopeChanged) return;
    let cancelled = false;
    api.requirements
      .scopePreview(editing.id, formScope)
      .then((res) => {
        if (!cancelled) setScopePreview(res);
      })
      .catch((err) => {
        if (!cancelled) setScopePreviewError(err instanceof Error ? err.message : 'Preview failed');
      });
    return () => {
      cancelled = true;
    };
  }, [editing, formScope, scopeChanged]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editing) {
        await api.requirements.update(editing.id, {
          name: formName.trim(),
          checklist: formChecklist.trim() || null,
          description: formDescription.trim() || null,
          ...(scopeChanged ? { scope: formScope } : {}),
        });
      } else {
        const tenantId = isSuperAdmin ? formTenantId : user?.tenant_id;
        if (!tenantId) {
          setError('A tenant must be selected.');
          setSaving(false);
          return;
        }
        await api.requirements.create({
          name: formName.trim(),
          checklist: formChecklist.trim() || undefined,
          description: formDescription.trim() || undefined,
          tenant_id: tenantId,
          scope: formScope,
        });
      }
      setDialogOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save requirement');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (req: ApiRequirement) => {
    try {
      await api.requirements.update(req.id, { active: req.active ? 0 : 1 });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update requirement');
    }
  };

  if (loading && requirements.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h4" fontWeight={700}>
          Requirements
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Requirement
        </Button>
      </Box>

      <HelpWell id="registry.requirements" title="What documents have to prove">
        Each row here is one line item you need on file — the thing a document{' '}
        <strong>satisfies</strong>. One document can satisfy several at once (a spec sheet often
        closes half a dozen). Give related items the same group name so the list matches the
        paperwork you already work from. Claims point at these items to say what becomes required.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        {isSuperAdmin && (
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Filter by Tenant</InputLabel>
            <Select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              label="Filter by Tenant"
            >
              <MenuItem value="">All Tenants</MenuItem>
              {tenants.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        {checklists.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Group</InputLabel>
            <Select
              value={checklistFilter}
              onChange={(e) => setChecklistFilter(e.target.value)}
              label="Group"
            >
              <MenuItem value="">All groups</MenuItem>
              {checklists.map((c) => (
                <MenuItem key={c} value={c}>
                  {c}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
      </Box>

      {visible.length === 0 ? (
        <EmptyState
          title="No requirements yet"
          description="Add the line items you need on file, or seed a starter pack with bin/create-tenant."
          actionLabel="Add requirement"
          onAction={openCreate}
        />
      ) : isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {visible.map((req) => (
            <Card key={req.id} variant="outlined">
              <CardContent sx={{ pb: '12px !important' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Box>
                    <Typography variant="body2" fontWeight={600}>
                      {req.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {req.checklist || '—'}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <IconButton size="small" onClick={() => openEdit(req)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" onClick={() => handleToggleActive(req)}>
                      {req.active ? (
                        <BlockIcon fontSize="small" color="warning" />
                      ) : (
                        <ActiveIcon fontSize="small" color="success" />
                      )}
                    </IconButton>
                  </Box>
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${req.document_count ?? 0} documents satisfy`}
                  />
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${req.claim_type_count ?? 0} claims require`}
                  />
                </Box>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
                  Closed by: {closedByText(req)}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Requirement</TableCell>
                <TableCell>Group</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>
                  <Tooltip title="Document types whose approval proposes this item. Edit on Settings > Document Types.">
                    <span>Closed by</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title={SATISFIED_BY_TOOLTIP}>
                    <span>Satisfied by</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Claims that make this item required">
                    <span>Required by claims</span>
                  </Tooltip>
                </TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((req) => (
                <TableRow key={req.id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {req.name}
                      {normalizeRequirementScope(req.scope) !== 'supplier' && (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={REQUIREMENT_SCOPE_SHORT[normalizeRequirementScope(req.scope)]}
                          sx={{ ml: 1 }}
                        />
                      )}
                    </Typography>
                    {req.description && (
                      <Typography variant="caption" color="text.secondary">
                        {req.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{req.checklist || '—'}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                      {req.slug}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color={req.closed_by_types?.length ? 'text.primary' : 'text.secondary'}>
                      {closedByText(req)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{req.document_count ?? 0}</TableCell>
                  <TableCell align="right">{req.claim_type_count ?? 0}</TableCell>
                  {isSuperAdmin && <TableCell>{req.tenant_name || req.tenant_id}</TableCell>}
                  <TableCell>
                    <Chip
                      label={req.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={req.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => openEdit(req)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={req.active ? 'Deactivate' : 'Activate'}>
                      <IconButton size="small" onClick={() => handleToggleActive(req)}>
                        {req.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
        fullScreen={isMobile}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editing ? 'Edit Requirement' : 'Add Requirement'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {isSuperAdmin && !editing && (
            <FormControl fullWidth sx={{ mt: 1, mb: 2 }}>
              <InputLabel>Tenant</InputLabel>
              <Select
                value={formTenantId}
                onChange={(e) => setFormTenantId(e.target.value)}
                label="Tenant"
                disabled={saving}
                required
              >
                {tenants.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <TextField
            label="What has to be on file"
            placeholder="e.g. Allergen Matrix"
            fullWidth
            required
            autoFocus
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Group (optional)"
            placeholder="e.g. Product Specification"
            fullWidth
            value={formChecklist}
            onChange={(e) => setFormChecklist(e.target.value)}
            disabled={saving}
            helperText="Requirements with the same group name are listed together."
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Owed</InputLabel>
            <Select
              value={formScope}
              label="Owed"
              onChange={(e) => setFormScope(e.target.value as RequirementScope)}
              disabled={saving}
            >
              {REQUIREMENT_SCOPES.map((sc) => (
                <MenuItem key={sc} value={sc}>
                  {REQUIREMENT_SCOPE_LABELS[sc]}
                </MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              {formScope === 'product'
                ? 'Owed by every active product of each supplier it is attached to. A document closes it only for the products it is linked to; one linked to no product closes nothing.'
                : formScope === 'lot'
                  ? 'Owed per lot. Per-lot checking has not shipped yet, so for now it is judged once per supplier, and the gap report says so.'
                  : 'Closed once per supplier by any confirmed document.'}
            </Typography>
          </FormControl>
          {scopeChanged && (
            <Alert severity={scopePreview && scopePreview.suppliers_changing > 0 ? 'warning' : 'info'} sx={{ mb: 2 }}>
              {scopePreviewError ? (
                `Could not preview the change: ${scopePreviewError}`
              ) : !scopePreview ? (
                'Working out what this changes…'
              ) : (
                <>
                  {scopePreview.suppliers_considered === 0
                    ? 'No supplier has this requirement, so nothing changes today.'
                    : `${scopePreview.suppliers_changing} of ${scopePreview.suppliers_considered} supplier${
                        scopePreview.suppliers_considered === 1 ? '' : 's'
                      } change status${
                        Object.keys(scopePreview.transitions).length
                          ? ` (${Object.entries(scopePreview.transitions)
                              .map(([k, n]) => `${n} ${k.replace('->', ' → ').replace(/_/g, ' ')}`)
                              .join(', ')})`
                          : ''
                      }.`}
                  {formScope === 'product' && scopePreview.suppliers_considered > 0 && (
                    <>
                      {' '}
                      {scopePreview.product_obligations} product obligation
                      {scopePreview.product_obligations === 1 ? '' : 's'} created,{' '}
                      {scopePreview.product_obligations_satisfied} already closed.
                      {scopePreview.unattributed_documents > 0 &&
                        ` ${scopePreview.unattributed_documents} confirmed document${
                          scopePreview.unattributed_documents === 1 ? ' names' : 's name'
                        } no product and would stop counting.`}
                    </>
                  )}
                  {scopePreview.lot_scope_note && <> {scopePreview.lot_scope_note}</>}
                </>
              )}
            </Alert>
          )}
          <TextField
            label="Notes"
            fullWidth
            multiline
            rows={2}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            disabled={saving}
          />
          {editing && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              Renaming is safe — the internal slug ({editing.slug}) stays the same, so starter-pack
              re-runs and imports keep matching this row.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || saving || (!editing && isSuperAdmin && !formTenantId)}
          >
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Requirement'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Requirements;
