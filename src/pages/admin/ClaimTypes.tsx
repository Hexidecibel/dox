/**
 * Claims — the layer-3 vocabulary admin (migration 0080).
 *
 * A claim is something a document ASSERTS ("Organic", "Kosher", "GFSI
 * Certified"). Asserting it satisfies nothing; it makes a DIFFERENT document
 * applicable — and possibly missing. What each claim opens is configured in
 * the rules editor (Settings → Claim Rules, or the "Rules" action here).
 *
 * The "Opens" column is the important signal: a claim with 0 rules is
 * detectable but inert, so nothing will ever be reported missing for it.
 */

import { useState, useEffect } from 'react';
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
  Rule as RuleIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiClaimType, ApiRequirement, ClaimSubjectGrain } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { ClaimRequirementsDialog } from '../../components/ClaimRequirementsDialog';

/** Plain-language labels for claim_types.subject_grain. */
const GRAIN_LABELS: Record<ClaimSubjectGrain, string> = {
  any: 'Anything',
  tenant: 'The whole company',
  product: 'A product',
  supplier: 'A supplier',
  facility: 'A facility',
};

const GRAIN_OPTIONS: ClaimSubjectGrain[] = ['any', 'product', 'supplier', 'facility', 'tenant'];

export function ClaimTypes() {
  const [claimTypes, setClaimTypes] = useState<ApiClaimType[]>([]);
  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  const [tenantFilter, setTenantFilter] = useState<string>('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApiClaimType | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formGrain, setFormGrain] = useState<ClaimSubjectGrain>('any');
  const [formTenantId, setFormTenantId] = useState('');
  const [saving, setSaving] = useState(false);

  const [rulesFor, setRulesFor] = useState<ApiClaimType | null>(null);

  const activeTenantId = isSuperAdmin
    ? tenantFilter || selectedTenantId || undefined
    : user?.tenant_id || undefined;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [claims, reqs] = await Promise.all([
        api.claimTypes.list({ tenant_id: activeTenantId }),
        api.requirements.list({ tenant_id: activeTenantId }),
      ]);
      setClaimTypes(claims.claimTypes);
      setRequirements(reqs.requirements);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load claims');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [tenantFilter, selectedTenantId]);

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormGrain('any');
    setFormTenantId(isSuperAdmin ? tenantFilter || selectedTenantId || '' : user?.tenant_id || '');
    setDialogOpen(true);
  };

  const openEdit = (ct: ApiClaimType) => {
    setEditing(ct);
    setFormName(ct.name);
    setFormDescription(ct.description || '');
    setFormGrain((ct.subject_grain as ClaimSubjectGrain) || 'any');
    setFormTenantId(ct.tenant_id);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editing) {
        await api.claimTypes.update(editing.id, {
          name: formName.trim(),
          description: formDescription.trim() || null,
          subject_grain: formGrain,
        });
      } else {
        const tenantId = isSuperAdmin ? formTenantId : user?.tenant_id;
        if (!tenantId) {
          setError('A tenant must be selected.');
          setSaving(false);
          return;
        }
        await api.claimTypes.create({
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          subject_grain: formGrain,
          tenant_id: tenantId,
        });
      }
      setDialogOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save claim');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (ct: ApiClaimType) => {
    try {
      await api.claimTypes.update(ct.id, { active: ct.active ? 0 : 1 });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update claim');
    }
  };

  if (loading && claimTypes.length === 0) {
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
          Claims
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Claim
        </Button>
      </Box>

      <HelpWell id="registry.claims" title="What documents say about themselves">
        A claim is something a document <strong>states</strong> — and stating it is not the same as
        proving it. A sheet that says “Organic” is not an organic certificate; it means the
        certificate is now expected, and missing if nobody sent one. Add the claims your documents
        make here, then use <strong>Rules</strong> to say what each one requires.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

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

      {claimTypes.length === 0 ? (
        <EmptyState
          title="No claims yet"
          description="Add the claims your documents make (Organic, Kosher, audit certified…), or seed a starter pack with bin/create-tenant."
          actionLabel="Add claim"
          onAction={openCreate}
        />
      ) : isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {claimTypes.map((ct) => (
            <Card key={ct.id} variant="outlined">
              <CardContent sx={{ pb: '12px !important' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <Box>
                    <Typography variant="body2" fontWeight={600}>
                      {ct.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      About: {GRAIN_LABELS[(ct.subject_grain as ClaimSubjectGrain) || 'any']}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <IconButton size="small" onClick={() => setRulesFor(ct)}>
                      <RuleIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" onClick={() => openEdit(ct)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Box>
                </Box>
                {ct.requirement_count ? (
                  <Chip size="small" color="primary" label={`Requires ${ct.requirement_count}`} />
                ) : (
                  <Chip size="small" color="warning" label="No rules yet" />
                )}
              </CardContent>
            </Card>
          ))}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Claim</TableCell>
                <TableCell>About</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>
                  <Tooltip title="How many checklist items this claim makes applicable">
                    <span>Opens</span>
                  </Tooltip>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Documents with a confirmed link asserting this claim">
                    <span>Asserted by</span>
                  </Tooltip>
                </TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {claimTypes.map((ct) => (
                <TableRow key={ct.id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {ct.name}
                    </Typography>
                    {ct.description && (
                      <Typography variant="caption" color="text.secondary">
                        {ct.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {GRAIN_LABELS[(ct.subject_grain as ClaimSubjectGrain) || 'any']}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                      {ct.slug}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {ct.requirement_count ? (
                      <Chip
                        size="small"
                        color="primary"
                        variant="outlined"
                        label={`${ct.requirement_count} required`}
                      />
                    ) : (
                      <Chip size="small" color="warning" label="No rules yet" />
                    )}
                  </TableCell>
                  <TableCell align="right">{ct.document_count ?? 0}</TableCell>
                  {isSuperAdmin && <TableCell>{ct.tenant_name || ct.tenant_id}</TableCell>}
                  <TableCell>
                    <Chip
                      label={ct.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={ct.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit what this claim requires">
                      <IconButton size="small" onClick={() => setRulesFor(ct)}>
                        <RuleIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => openEdit(ct)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={ct.active ? 'Deactivate' : 'Activate'}>
                      <IconButton size="small" onClick={() => handleToggleActive(ct)}>
                        {ct.active ? (
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

      <ClaimRequirementsDialog
        open={!!rulesFor}
        claimType={rulesFor}
        requirements={requirements}
        onClose={() => setRulesFor(null)}
        onSaved={() => load()}
      />

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
        fullScreen={isMobile}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editing ? 'Edit Claim' : 'Add Claim'}
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
            label="What the document claims"
            placeholder="e.g. Organic"
            fullWidth
            required
            autoFocus
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>What is the claim about?</InputLabel>
            <Select
              value={formGrain}
              onChange={(e) => setFormGrain(e.target.value as ClaimSubjectGrain)}
              label="What is the claim about?"
              disabled={saving}
            >
              {GRAIN_OPTIONS.map((g) => (
                <MenuItem key={g} value={g}>
                  {GRAIN_LABELS[g]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Notes"
            fullWidth
            multiline
            rows={2}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            disabled={saving}
          />
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
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Claim'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default ClaimTypes;
