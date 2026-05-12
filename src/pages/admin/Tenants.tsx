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
  CircularProgress,
  Alert,
  Tooltip,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { Tenant } from '../../lib/types';
import { CopyId } from '../../components/CopyId';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

export function Tenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formDescription, setFormDescription] = useState('');
  // Doc-R1: per-tenant auto-approve threshold. Stored as a string in the
  // form so users can clear it (empty = disabled = null on PUT). When
  // non-empty it must parse as a number in [0, 1].
  const [formAutoApproveThreshold, setFormAutoApproveThreshold] = useState('');
  const [saving, setSaving] = useState(false);

  const loadTenants = async () => {
    setLoading(true);
    try {
      const list = await api.tenants.list();
      setTenants(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTenants();
  }, []);

  const openCreate = () => {
    setEditingTenant(null);
    setFormName('');
    setFormSlug('');
    setFormDescription('');
    setFormAutoApproveThreshold('');
    setDialogOpen(true);
  };

  const openEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setFormName(tenant.name);
    setFormSlug(tenant.slug);
    setFormDescription(tenant.description || '');
    setFormAutoApproveThreshold(
      tenant.auto_approve_threshold != null
        ? String(tenant.auto_approve_threshold)
        : ''
    );
    setDialogOpen(true);
  };

  const handleNameChange = (name: string) => {
    setFormName(name);
    if (!editingTenant) {
      setFormSlug(
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      );
    }
  };

  // Doc-R1: parse the threshold form field. Empty string => null (disabled);
  // anything else must be a finite number in [0, 1]. Returns `undefined` to
  // signal a validation error so the caller can surface it.
  const parseThreshold = (raw: string): number | null | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!isFinite(n) || n < 0 || n > 1) return undefined;
    return n;
  };

  const handleSave = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    const parsedThreshold = parseThreshold(formAutoApproveThreshold);
    if (parsedThreshold === undefined) {
      setError('Auto-approve threshold must be a number between 0 and 1, or empty to disable.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editingTenant) {
        await api.tenants.update(editingTenant.id, {
          name: formName.trim(),
          slug: formSlug.trim(),
          description: formDescription.trim() || undefined,
          auto_approve_threshold: parsedThreshold,
        });
      } else {
        await api.tenants.create({
          name: formName.trim(),
          slug: formSlug.trim(),
          description: formDescription.trim() || undefined,
        });
      }
      setDialogOpen(false);
      loadTenants();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tenant');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tenant: Tenant) => {
    try {
      await api.tenants.update(tenant.id, { active: tenant.active ? 0 : 1 });
      loadTenants();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tenant');
    }
  };

  if (loading) {
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
          Tenant Management
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Tenant
        </Button>
      </Box>

      <HelpWell id="tenants.list" title={helpContent.tenants.list?.headline ?? 'Tenants'}>
        {helpContent.tenants.list?.well ?? helpContent.tenants.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        // Mobile card layout
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {tenants.length === 0 ? (
            <EmptyState
              title={helpContent.tenants.list?.emptyTitle ?? 'No tenants yet'}
              description={helpContent.tenants.list?.emptyDescription}
              actionLabel="Add tenant"
              onAction={openCreate}
            />
          ) : (
            tenants.map((tenant) => (
              <Card key={tenant.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {tenant.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                        {tenant.slug}
                      </Typography>
                      <Box><CopyId id={tenant.id} /></Box>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                      <IconButton size="small" onClick={() => openEdit(tenant)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(tenant)}>
                        {tenant.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  {tenant.description && (
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                      {tenant.description}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Chip label={tenant.active ? 'Active' : 'Inactive'} size="small" color={tenant.active ? 'success' : 'default'} variant="outlined" />
                    <Chip label={formatDate(tenant.created_at)} size="small" variant="outlined" />
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : tenants.length === 0 ? (
        <EmptyState
          title={helpContent.tenants.list?.emptyTitle ?? 'No tenants yet'}
          description={helpContent.tenants.list?.emptyDescription}
          actionLabel="Add tenant"
          onAction={openCreate}
        />
      ) : (
        // Desktop table layout
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    ID
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.id} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Name
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.name} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Slug
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.slug} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Description
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.description} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created
                    <InfoTooltip text={helpContent.tenants.list?.columnTooltips?.created} />
                  </Box>
                </TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tenants.map((tenant) => (
                  <TableRow key={tenant.id} hover>
                    <TableCell>
                      <CopyId id={tenant.id} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {tenant.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace" fontSize="0.85rem">
                        {tenant.slug}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{
                          maxWidth: 300,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tenant.description || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={tenant.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={tenant.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(tenant.created_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(tenant)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={tenant.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(tenant)}>
                          {tenant.active ? (
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
          {editingTenant ? 'Edit Tenant' : 'Create Tenant'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            fullWidth
            required
            value={formName}
            onChange={(e) => handleNameChange(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Slug"
            fullWidth
            required
            value={formSlug}
            onChange={(e) => setFormSlug(e.target.value)}
            disabled={saving}
            helperText="URL-friendly identifier (auto-generated from name)"
            sx={{ mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={3}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          {/* Doc-R1: per-tenant auto-approve threshold. Empty/blank disables
              the feature (every queue item still routes to human review).
              When set (0.0–1.0), processing-queue items whose LLM self-rated
              confidence meets the threshold are auto-approved by the worker
              callback without a manual click. Only meaningful when editing
              an existing tenant — super_admin-only on the backend. */}
          {editingTenant && (
            <TextField
              label="Auto-approve threshold"
              type="number"
              fullWidth
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              value={formAutoApproveThreshold}
              onChange={(e) => setFormAutoApproveThreshold(e.target.value)}
              disabled={saving}
              helperText="0.0–1.0. Leave blank to disable (every doc routes to review). Example: 0.9 auto-approves only very high-confidence extractions."
            />
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || !formSlug.trim() || saving}
          >
            {saving ? 'Saving...' : editingTenant ? 'Save Changes' : 'Create Tenant'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
