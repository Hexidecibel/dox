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
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiEmailDomainMapping, User } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';

export function EmailMappings() {
  const [mappings, setMappings] = useState<ApiEmailDomainMapping[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<ApiEmailDomainMapping | null>(null);
  const [formDomain, setFormDomain] = useState('');
  const [formDefaultUserId, setFormDefaultUserId] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingMapping, setDeletingMapping] = useState<ApiEmailDomainMapping | null>(null);
  const [deleting, setDeleting] = useState(false);

  const effectiveTenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : (user?.tenant_id || undefined);

  const loadMappings = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.emailDomainMappings.list(effectiveTenantId);
      setMappings(result.mappings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load email domain mappings');
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    try {
      const result = await api.users.list();
      setUsers(result);
    } catch {
      // Non-critical, user selector will just be empty
    }
  };

  useEffect(() => {
    loadMappings();
    loadUsers();
  }, [effectiveTenantId]);

  const openCreate = () => {
    setEditingMapping(null);
    setFormDomain('');
    setFormDefaultUserId('');
    setFormTenantId(
      isSuperAdmin
        ? (selectedTenantId || '')
        : (user?.tenant_id || '')
    );
    setDialogOpen(true);
  };

  const openEdit = (mapping: ApiEmailDomainMapping) => {
    setEditingMapping(mapping);
    setFormDomain(mapping.domain);
    setFormDefaultUserId(mapping.default_user_id || '');
    setFormTenantId(mapping.tenant_id);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingMapping) {
        await api.emailDomainMappings.update(editingMapping.id, {
          domain: formDomain.trim(),
          default_user_id: formDefaultUserId || undefined,
        });
      } else {
        const tenantId = isSuperAdmin ? formTenantId : user?.tenant_id;
        if (!tenantId) {
          setError('A tenant must be selected.');
          setSaving(false);
          return;
        }
        await api.emailDomainMappings.create({
          domain: formDomain.trim(),
          default_user_id: formDefaultUserId || undefined,
          tenant_id: tenantId,
        });
      }
      setDialogOpen(false);
      loadMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mapping');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (mapping: ApiEmailDomainMapping) => {
    try {
      await api.emailDomainMappings.update(mapping.id, { active: mapping.active ? 0 : 1 });
      loadMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update mapping');
    }
  };

  const openDelete = (mapping: ApiEmailDomainMapping) => {
    setDeletingMapping(mapping);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingMapping) return;
    setDeleting(true);
    try {
      await api.emailDomainMappings.delete(deletingMapping.id);
      setDeleteDialogOpen(false);
      setDeletingMapping(null);
      loadMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete mapping');
    } finally {
      setDeleting(false);
    }
  };

  const getTenantName = (tenantId: string) => {
    const tenant = tenants.find((t) => t.id === tenantId);
    return tenant?.name || tenantId;
  };

  // Filter users by tenant for the user selector
  const filteredUsers = users.filter((u) => {
    const tid = editingMapping ? editingMapping.tenant_id : formTenantId;
    return !tid || u.tenant_id === tid;
  });

  if (loading && mappings.length === 0) {
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
          Email Domain Mappings
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Mapping
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {mappings.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No email domain mappings found</Typography>
              </CardContent>
            </Card>
          ) : (
            mappings.map((mapping) => (
              <Card key={mapping.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {mapping.domain}
                      </Typography>
                      {isSuperAdmin && mapping.tenant_name && (
                        <Typography variant="caption" color="text.secondary">
                          {mapping.tenant_name}
                        </Typography>
                      )}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => openEdit(mapping)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(mapping)}>
                        {mapping.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                      <IconButton size="small" onClick={() => openDelete(mapping)} color="error">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Box>
                  {mapping.default_user_name && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Default user: {mapping.default_user_name}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={mapping.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={mapping.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Domain</TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Default User</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {mappings.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isSuperAdmin ? 6 : 5} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No email domain mappings found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                mappings.map((mapping) => (
                  <TableRow key={mapping.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} fontFamily="monospace">
                        {mapping.domain}
                      </Typography>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell>{mapping.tenant_name || getTenantName(mapping.tenant_id)}</TableCell>
                    )}
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {mapping.default_user_name || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={mapping.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={mapping.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(mapping.created_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(mapping)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={mapping.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(mapping)}>
                          {mapping.active ? (
                            <BlockIcon fontSize="small" color="warning" />
                          ) : (
                            <ActiveIcon fontSize="small" color="success" />
                          )}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" onClick={() => openDelete(mapping)} color="error">
                          <DeleteIcon fontSize="small" />
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
          {editingMapping ? 'Edit Mapping' : 'Add Mapping'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {isSuperAdmin && !editingMapping && (
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
            label="Domain"
            fullWidth
            required
            value={formDomain}
            onChange={(e) => setFormDomain(e.target.value)}
            disabled={saving}
            autoFocus
            placeholder="e.g. example.com"
            helperText="The email domain to map to this tenant"
            sx={{ mt: isSuperAdmin && !editingMapping ? 0 : 1, mb: 2 }}
          />
          <FormControl fullWidth>
            <InputLabel>Default User (optional)</InputLabel>
            <Select
              value={formDefaultUserId}
              onChange={(e) => setFormDefaultUserId(e.target.value)}
              label="Default User (optional)"
              disabled={saving}
            >
              <MenuItem value="">None</MenuItem>
              {filteredUsers.map((u) => (
                <MenuItem key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formDomain.trim() || saving || (!editingMapping && isSuperAdmin && !formTenantId)}
          >
            {saving ? 'Saving...' : editingMapping ? 'Save Changes' : 'Add Mapping'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Mapping</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the mapping for <strong>{deletingMapping?.domain}</strong>? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
