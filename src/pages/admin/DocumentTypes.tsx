import { useState, useEffect } from 'react';
import { formatDate } from '../../utils/format';
import {
  Box,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Tooltip,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
  Psychology as ExtractionIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import {
  defaultRenewalMonthsForTypeName,
  defaultRenewalPolicyForTypeName,
  renewalPeriodLabel,
  SPEC_SHEET_RENEWAL_MONTHS,
} from '../../../shared/renewalPeriod';
import type { ApiDocumentType } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { DocumentTypeInstructionsDialog } from '../../components/DocumentTypeInstructionsDialog';
import { helpContent } from '../../lib/helpContent';

export function DocumentTypes() {
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  // Filter state
  const [tenantFilter, setTenantFilter] = useState<string>('');

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<ApiDocumentType | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [formAutoIngest, setFormAutoIngest] = useState(false);
  const [formExtractTables, setFormExtractTables] = useState(true);
  /** '' means "no period of its own" — the annual default applies. */
  /**
   * The renewal Select's value. One control for one setting with three states,
   * so its value carries all three: '' = inherit the annual default, 'none' =
   * this type does not renew, and any number = that many months. Split back
   * into `renewal_policy` + `renewal_interval_months` by `renewalPayload()` at
   * save time — the two-column shape is the storage concern, not the form's.
   */
  const [formRenewalMonths, setFormRenewalMonths] = useState('');
  /**
   * Whether the admin has touched the renewal period on THIS dialog. Until
   * they do, a new type follows the name (a spec sheet proposes three years),
   * so the value they see before saving is the value that will be stored.
   */
  const [formRenewalTouched, setFormRenewalTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Extraction-instruction state (migration 0098 — the document-type layer of
   * the prompt stack). Kept as a map keyed by document_type_id rather than
   * fetched per row: the list endpoint pre-joins every active type in one
   * round trip, and the table needs a per-row indicator, so a fan-out of N
   * GETs would buy nothing.
   */
  const [instructionsByType, setInstructionsByType] = useState<
    Record<string, { authored: boolean; supplierOverrides: number }>
  >({});
  const [instructionsFor, setInstructionsFor] = useState<ApiDocumentType | null>(null);

  const loadDocumentTypes = async () => {
    setLoading(true);
    setError('');
    try {
      const tenantId = isSuperAdmin
        ? (tenantFilter || selectedTenantId || undefined)
        : user?.tenant_id || undefined;
      const result = await api.documentTypes.list({
        tenant_id: tenantId,
      });
      setDocumentTypes(result.documentTypes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document types');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Which types already have extraction guidance, and how many suppliers
   * refine each one. Advisory decoration on the list — a failure here must
   * never stop the page rendering the types themselves, so it swallows.
   *
   * super_admin viewing "All Tenants" has no single tenant to ask about, and
   * the endpoint (correctly) refuses; we simply show no indicators then.
   */
  const loadInstructionSummary = async () => {
    const tenantId = isSuperAdmin
      ? (tenantFilter || selectedTenantId || undefined)
      : user?.tenant_id || undefined;
    if (isSuperAdmin && !tenantId) {
      setInstructionsByType({});
      return;
    }
    try {
      const res = await api.documentTypeInstructions.list({ tenant_id: tenantId });
      const next: Record<string, { authored: boolean; supplierOverrides: number }> = {};
      for (const row of res.document_types) {
        next[row.document_type_id] = {
          authored: !!(row.instructions && row.instructions.trim()),
          supplierOverrides: row.supplier_override_count,
        };
      }
      setInstructionsByType(next);
    } catch {
      setInstructionsByType({});
    }
  };

  useEffect(() => {
    loadDocumentTypes();
    void loadInstructionSummary();
  }, [tenantFilter, selectedTenantId]);

  /**
   * Tooltip for the extraction-instructions button. It carries the layering:
   * "3 suppliers refine it" is the thing an admin needs to know before editing
   * type-level text, and there is nowhere else on this row to say it.
   */
  const instructionsTooltip = (dt: ApiDocumentType): string => {
    const summary = instructionsByType[dt.id];
    if (!summary) return 'Extraction instructions';
    const base = summary.authored
      ? 'Extraction instructions (set)'
      : 'Extraction instructions (none yet)';
    if (summary.supplierOverrides === 0) return base;
    return `${base} — ${summary.supplierOverrides} supplier${
      summary.supplierOverrides === 1 ? '' : 's'
    } refine ${summary.supplierOverrides === 1 ? 'it' : 'them'}`;
  };

  const openCreate = () => {
    setEditingType(null);
    setFormName('');
    setFormDescription('');
    setFormAutoIngest(false);
    setFormExtractTables(true);
    setFormRenewalMonths('');
    setFormRenewalTouched(false);
    setFormTenantId(
      isSuperAdmin
        ? (tenantFilter || selectedTenantId || '')
        : (user?.tenant_id || '')
    );
    setDialogOpen(true);
  };

  const openEdit = (dt: ApiDocumentType) => {
    setEditingType(dt);
    setFormName(dt.name);
    setFormDescription(dt.description || '');
    setFormAutoIngest(!!dt.auto_ingest);
    setFormExtractTables(dt.extract_tables !== 0);
    setFormRenewalMonths(
      dt.renewal_policy === 'none'
        ? 'none'
        : dt.renewal_interval_months == null
          ? ''
          : String(dt.renewal_interval_months)
    );
    // An existing type keeps what it has; never re-guess from the name here.
    setFormRenewalTouched(true);
    setFormTenantId(dt.tenant_id);
    setDialogOpen(true);
  };

  // Mirror of the server-side proposal in POST /api/document-types: a new type
  // whose name reads as a specification sheet starts at three years, because
  // both major food-safety schemes define a current spec sheet as one revised
  // or reviewed inside that window. It is only ever a starting value.
  useEffect(() => {
    if (editingType || formRenewalTouched) return;
    const policy = defaultRenewalPolicyForTypeName(formName);
    if (policy === 'none') {
      // A name that reads as a Certificate of Analysis. Those do not renew:
      // each one is superseded by the next lot's certificate, so giving them a
      // cadence puts every COA in the file on the renewal dashboard.
      setFormRenewalMonths('none');
      return;
    }
    const proposed = defaultRenewalMonthsForTypeName(formName);
    setFormRenewalMonths(proposed == null ? '' : String(proposed));
  }, [formName, editingType, formRenewalTouched]);

  /**
   * Split the single Select value into the two columns the API takes.
   * 'none' and '' both send a null interval — under either policy the months
   * column is never read, so leaving a stale number there would only show the
   * next admin a period that does not apply.
   */
  const renewalPayload = (): { renewal_policy: 'inherit' | 'period' | 'none'; renewal_interval_months: number | null } => {
    if (formRenewalMonths === 'none') return { renewal_policy: 'none', renewal_interval_months: null };
    if (!formRenewalMonths) return { renewal_policy: 'inherit', renewal_interval_months: null };
    return { renewal_policy: 'period', renewal_interval_months: Number(formRenewalMonths) };
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingType) {
        await api.documentTypes.update(editingType.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          auto_ingest: formAutoIngest ? 1 : 0,
          extract_tables: formExtractTables ? 1 : 0,
          ...renewalPayload(),
        });
      } else {
        const tenantId = isSuperAdmin ? formTenantId : user?.tenant_id;
        if (!tenantId) {
          setError('A tenant must be selected.');
          setSaving(false);
          return;
        }
        await api.documentTypes.create({
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          tenant_id: tenantId,
          auto_ingest: formAutoIngest ? 1 : 0,
          extract_tables: formExtractTables ? 1 : 0,
          ...renewalPayload(),
        });
      }
      setDialogOpen(false);
      loadDocumentTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document type');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (dt: ApiDocumentType) => {
    try {
      await api.documentTypes.update(dt.id, { active: dt.active ? 0 : 1 });
      loadDocumentTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document type');
    }
  };

  const getTenantName = (tenantId: string) => {
    const tenant = tenants.find((t) => t.id === tenantId);
    return tenant?.name || tenantId;
  };

  if (loading && documentTypes.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Document Types
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Document Type
        </Button>
      </Box>

      <HelpWell id="document_types.list" title={helpContent.document_types.list?.headline ?? 'Document Types'}>
        {helpContent.document_types.list?.well ?? helpContent.document_types.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Tenant filter for super_admin */}
      {isSuperAdmin && (
        <FormControl size="small" sx={{ mb: 2, minWidth: 200 }}>
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

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {documentTypes.length === 0 ? (
            <EmptyState
              title={helpContent.document_types.list?.emptyTitle ?? 'No document types yet'}
              description={helpContent.document_types.list?.emptyDescription}
              actionLabel="Add document type"
              onAction={openCreate}
            />
          ) : (
            documentTypes.map((dt) => (
              <Card key={dt.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {dt.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {dt.slug}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton
                        size="small"
                        onClick={() => setInstructionsFor(dt)}
                        color={instructionsByType[dt.id]?.authored ? 'primary' : 'default'}
                      >
                        <ExtractionIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => openEdit(dt)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(dt)}>
                        {dt.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  {dt.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {dt.description}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={dt.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={dt.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                    <Chip
                      label={`Renews: ${renewalPeriodLabel(dt.renewal_interval_months, dt.renewal_policy)}`}
                      size="small"
                      variant="outlined"
                    />
                    {instructionsByType[dt.id]?.authored && (
                      <Chip label="Extraction guidance" size="small" color="primary" variant="outlined" />
                    )}
                    {isSuperAdmin && dt.tenant_name && (
                      <Chip label={dt.tenant_name} size="small" variant="outlined" />
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : documentTypes.length === 0 ? (
        <EmptyState
          title={helpContent.document_types.list?.emptyTitle ?? 'No document types yet'}
          description={helpContent.document_types.list?.emptyDescription}
          actionLabel="Add document type"
          onAction={openCreate}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Name
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.name} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Slug
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.slug} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Description
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.description} />
                  </Box>
                </TableCell>
                {isSuperAdmin && (
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      Tenant
                      <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.tenant} />
                    </Box>
                  </TableCell>
                )}
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Renewal
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.renewalPeriod} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created
                    <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.created} />
                  </Box>
                </TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documentTypes.map((dt) => (
                  <TableRow key={dt.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {dt.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                        {dt.slug}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dt.description || '-'}
                      </Typography>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell>{dt.tenant_name || getTenantName(dt.tenant_id)}</TableCell>
                    )}
                    <TableCell>
                      <Chip
                        label={dt.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={dt.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {renewalPeriodLabel(dt.renewal_interval_months, dt.renewal_policy)}
                      </Typography>
                    </TableCell>
                    <TableCell>{formatDate(dt.created_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title={instructionsTooltip(dt)}>
                        <IconButton
                          size="small"
                          onClick={() => setInstructionsFor(dt)}
                          color={instructionsByType[dt.id]?.authored ? 'primary' : 'default'}
                        >
                          <ExtractionIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(dt)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={dt.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(dt)}>
                          {dt.active ? (
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

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingType ? 'Edit Document Type' : 'Add Document Type'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {isSuperAdmin && !editingType && (
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
            label="Name"
            fullWidth
            required
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            autoFocus
            sx={{ mt: isSuperAdmin && !editingType ? 0 : 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={2}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />

          {/* Renewal setting: policy (0097) + period (0096), one control */}
          <FormControl fullWidth sx={{ mb: 1 }}>
            <InputLabel>Renewal period</InputLabel>
            <Select
              value={formRenewalMonths}
              onChange={(e) => {
                setFormRenewalTouched(true);
                setFormRenewalMonths(e.target.value);
              }}
              label="Renewal period"
              disabled={saving}
            >
              <MenuItem value="">Annual (default)</MenuItem>
              <MenuItem value="none">Does not renew</MenuItem>
              <MenuItem value="6">6 months</MenuItem>
              <MenuItem value="12">1 year</MenuItem>
              <MenuItem value="24">2 years</MenuItem>
              <MenuItem value={String(SPEC_SHEET_RENEWAL_MONTHS)}>
                3 years (specification sheets)
              </MenuItem>
              <MenuItem value="60">5 years</MenuItem>
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            How long a document of this type stays current. Most documents renew annually;
            specification sheets renew at three years, because both major food-safety schemes
            define a current spec sheet as one revised or reviewed inside that window.
            A document that states its own expiry date — an insurance certificate reading
            "expires 09/01/2027" — always overrides this.
            <br />
            Choose <strong>Does not renew</strong> for types that are never re-collected on a
            cadence — a Certificate of Analysis is superseded by the next lot's certificate,
            so it is never overdue. Documents of a non-renewing type stay off the renewal
            dashboard and never trigger a renewal alert.
          </Typography>

          {/* Feature Toggles */}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Features</Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <FormControlLabel
                control={<Switch checked={formAutoIngest} onChange={(e) => setFormAutoIngest(e.target.checked)} disabled={saving} />}
                label="Auto-ingest"
              />
              <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.autoIngest} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5, mb: 1 }}>
              Automatically import high-confidence documents (requires 3+ training examples)
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <FormControlLabel
                control={<Switch checked={formExtractTables} onChange={(e) => setFormExtractTables(e.target.checked)} disabled={saving} />}
                label="Extract tables"
              />
              <InfoTooltip text={helpContent.document_types.list?.columnTooltips?.extractTables} />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
              Extract tabular data like test results and specifications
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || saving || (!editingType && isSuperAdmin && !formTenantId)}
          >
            {saving ? 'Saving...' : editingType ? 'Save Changes' : 'Add Document Type'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Document-type extraction instructions (migration 0098). Mounted on   */}
      {/* the Document Types screen because "how should we read a Certificate  */}
      {/* of Insurance" is a question about the TYPE; the supplier page keeps   */}
      {/* the narrower "…from this supplier" editor that refines it.           */}
      {instructionsFor && (
        <DocumentTypeInstructionsDialog
          open
          onClose={() => setInstructionsFor(null)}
          documentTypeId={instructionsFor.id}
          documentTypeName={instructionsFor.name}
          tenantId={instructionsFor.tenant_id}
          onSaved={() => void loadInstructionSummary()}
        />
      )}
    </Box>
  );
}
