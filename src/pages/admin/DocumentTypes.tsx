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
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiDocumentType } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';

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
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    loadDocumentTypes();
  }, [tenantFilter, selectedTenantId]);

  const openCreate = () => {
    setEditingType(null);
    setFormName('');
    setFormDescription('');
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
    setFormTenantId(dt.tenant_id);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingType) {
        await api.documentTypes.update(editingType.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
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
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No document types found</Typography>
              </CardContent>
            </Card>
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
                    {isSuperAdmin && dt.tenant_name && (
                      <Chip label={dt.tenant_name} size="small" variant="outlined" />
                    )}
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
                <TableCell>Name</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>Description</TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documentTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isSuperAdmin ? 7 : 6} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No document types found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                documentTypes.map((dt) => (
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
                    <TableCell>{formatDate(dt.created_at)}</TableCell>
                    <TableCell align="right">
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
                ))
              )}
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
        <DialogContent>
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
            disabled={!formName.trim() || saving || (!editingType && isSuperAdmin && !formTenantId)}
          >
            {saving ? 'Saving...' : editingType ? 'Save Changes' : 'Add Document Type'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
