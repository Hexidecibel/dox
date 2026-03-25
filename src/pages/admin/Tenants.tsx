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
    setDialogOpen(true);
  };

  const openEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    setFormName(tenant.name);
    setFormSlug(tenant.slug);
    setFormDescription(tenant.description || '');
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

  const handleSave = async () => {
    if (!formName.trim() || !formSlug.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (editingTenant) {
        await api.tenants.update(editingTenant.id, {
          name: formName.trim(),
          slug: formSlug.trim(),
          description: formDescription.trim() || undefined,
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

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        // Mobile card layout
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {tenants.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No tenants found</Typography>
              </CardContent>
            </Card>
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
      ) : (
        // Desktop table layout
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tenants.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No tenants found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                tenants.map((tenant) => (
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
                ))
              )}
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
          />
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
