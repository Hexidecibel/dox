import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Pagination,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  InputAdornment,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSupplier } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

const ITEMS_PER_PAGE = 20;

export function Suppliers() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<ApiSupplier | null>(null);
  const [formName, setFormName] = useState('');
  const [formAliases, setFormAliases] = useState('');
  const [saving, setSaving] = useState(false);

  const tenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : user?.tenant_id || undefined;

  const loadSuppliers = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.suppliers.list({
        search: search || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: tenantId,
      });
      setSuppliers(result.suppliers);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuppliers();
  }, [page, selectedTenantId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadSuppliers();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const openCreate = () => {
    setEditingSupplier(null);
    setFormName('');
    setFormAliases('');
    setDialogOpen(true);
  };

  const openEdit = (supplier: ApiSupplier) => {
    setEditingSupplier(supplier);
    setFormName(supplier.name);
    setFormAliases(supplier.aliases || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingSupplier) {
        const aliasArray = formAliases.trim()
          ? formAliases.split(',').map(a => a.trim()).filter(Boolean)
          : [];
        await api.suppliers.update(editingSupplier.id, {
          name: formName.trim(),
          aliases: aliasArray,
        });
      } else {
        const createTenantId = tenantId || user?.tenant_id;
        if (!createTenantId) {
          setError('No tenant selected. Please select a tenant before creating a supplier.');
          setSaving(false);
          return;
        }
        await api.suppliers.create({
          name: formName.trim(),
          aliases: formAliases.trim() || undefined,
          tenant_id: createTenantId,
        });
      }
      setDialogOpen(false);
      loadSuppliers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save supplier');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (supplier: ApiSupplier) => {
    try {
      await api.suppliers.update(supplier.id, { active: !supplier.active });
      loadSuppliers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update supplier');
    }
  };

  const parseAliases = (aliases: string | null): string[] => {
    if (!aliases) return [];
    try {
      const parsed = JSON.parse(aliases);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return aliases.split(',').map(a => a.trim()).filter(Boolean);
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  if (loading && suppliers.length === 0) {
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
          Suppliers
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Supplier
        </Button>
      </Box>

      <HelpWell id="suppliers.list" title={helpContent.suppliers.list?.headline ?? 'Suppliers'}>
        {helpContent.suppliers.list?.well ?? helpContent.suppliers.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        placeholder="Search suppliers..."
        fullWidth
        size="small"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 2 }}
      />

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {suppliers.length === 0 ? (
            <EmptyState
              title={search ? 'No suppliers match your search' : helpContent.suppliers.list?.emptyTitle ?? 'No suppliers yet'}
              description={search
                ? 'Clear the search box to see every supplier in your tenant.'
                : helpContent.suppliers.list?.emptyDescription}
              actionLabel={search ? undefined : 'Add supplier'}
              onAction={search ? undefined : openCreate}
            />
          ) : (
            suppliers.map((supplier) => (
              <Card
                key={supplier.id}
                variant="outlined"
                sx={{ cursor: 'pointer' }}
                onClick={() => navigate(`/admin/suppliers/${supplier.id}`)}
              >
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {supplier.name}
                      </Typography>
                      {supplier.aliases && (
                        <Typography variant="caption" color="text.secondary">
                          {parseAliases(supplier.aliases).join(', ')}
                        </Typography>
                      )}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                      <IconButton size="small" onClick={() => openEdit(supplier)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(supplier)}>
                        {supplier.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={supplier.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={supplier.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : suppliers.length === 0 ? (
        <EmptyState
          title={search ? 'No suppliers match your search' : helpContent.suppliers.list?.emptyTitle ?? 'No suppliers yet'}
          description={search
            ? 'Clear the search box to see every supplier in your tenant.'
            : helpContent.suppliers.list?.emptyDescription}
          actionLabel={search ? undefined : 'Add supplier'}
          onAction={search ? undefined : openCreate}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Name
                    <InfoTooltip text={helpContent.suppliers.list?.columnTooltips?.name} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Aliases
                    <InfoTooltip text={helpContent.suppliers.list?.columnTooltips?.aliases} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.suppliers.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created
                    <InfoTooltip text={helpContent.suppliers.list?.columnTooltips?.created} />
                  </Box>
                </TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {suppliers.map((supplier) => (
                  <TableRow
                    key={supplier.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/admin/suppliers/${supplier.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} color="primary">
                        {supplier.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        {parseAliases(supplier.aliases).map((alias) => (
                          <Chip key={alias} label={alias} size="small" variant="outlined" />
                        ))}
                        {parseAliases(supplier.aliases).length === 0 && (
                          <Typography variant="body2" color="text.secondary">-</Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={supplier.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={supplier.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(supplier.created_at)}</TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(supplier)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={supplier.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(supplier)}>
                          {supplier.active ? (
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

      {totalPages > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, p) => setPage(p)}
            color="primary"
          />
        </Box>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingSupplier ? 'Edit Supplier' : 'Add Supplier'}
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
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            autoFocus
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Aliases"
            fullWidth
            value={formAliases}
            onChange={(e) => setFormAliases(e.target.value)}
            disabled={saving}
            helperText="Comma-separated alternate names (e.g. 'ABC Corp, ABC Industries')"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || saving}
          >
            {saving ? 'Saving...' : editingSupplier ? 'Save Changes' : 'Add Supplier'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
