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
import type { ApiProduct } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

const ITEMS_PER_PAGE = 20;

export function Products() {
  const [products, setProducts] = useState<ApiProduct[]>([]);
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
  const [editingProduct, setEditingProduct] = useState<ApiProduct | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const tenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : user?.tenant_id || undefined;

  const loadProducts = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.products.list({
        search: search || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: tenantId,
      });
      setProducts(result.products);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, [page, selectedTenantId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadProducts();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const openCreate = () => {
    setEditingProduct(null);
    setFormName('');
    setFormDescription('');
    setDialogOpen(true);
  };

  const openEdit = (product: ApiProduct) => {
    setEditingProduct(product);
    setFormName(product.name);
    setFormDescription(product.description || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingProduct) {
        await api.products.update(editingProduct.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
        });
      } else {
        const createTenantId = tenantId || user?.tenant_id;
        if (!createTenantId) {
          setError('No tenant selected. Please select a tenant before creating a product.');
          setSaving(false);
          return;
        }
        await api.products.create({
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          tenant_id: createTenantId,
        });
      }
      setDialogOpen(false);
      loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (product: ApiProduct) => {
    try {
      await api.products.update(product.id, { active: product.active ? 0 : 1 });
      loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update product');
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  if (loading && products.length === 0) {
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
          Products
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Product
        </Button>
      </Box>

      <HelpWell id="products.list" title={helpContent.products.list?.headline ?? 'Products'}>
        {helpContent.products.list?.well ?? helpContent.products.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        placeholder="Search products..."
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
          {products.length === 0 ? (
            <EmptyState
              title={search ? 'No products match your search' : helpContent.products.list?.emptyTitle ?? 'No products yet'}
              description={search
                ? 'Clear the search box to see every product in your tenant.'
                : helpContent.products.list?.emptyDescription}
              actionLabel={search ? undefined : 'Add product'}
              onAction={search ? undefined : openCreate}
            />
          ) : (
            products.map((product) => (
              <Card key={product.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {product.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {product.slug}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => openEdit(product)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(product)}>
                        {product.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  {product.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {product.description}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={product.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={product.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : products.length === 0 ? (
        <EmptyState
          title={search ? 'No products match your search' : helpContent.products.list?.emptyTitle ?? 'No products yet'}
          description={search
            ? 'Clear the search box to see every product in your tenant.'
            : helpContent.products.list?.emptyDescription}
          actionLabel={search ? undefined : 'Add product'}
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
                    <InfoTooltip text={helpContent.products.list?.columnTooltips?.name} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Slug
                    <InfoTooltip text={helpContent.products.list?.columnTooltips?.slug} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Description
                    <InfoTooltip text={helpContent.products.list?.columnTooltips?.description} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.products.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {products.map((product) => (
                  <TableRow key={product.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {product.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                        {product.slug}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {product.description || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={product.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={product.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(product.created_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(product)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={product.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(product)}>
                          {product.active ? (
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
          {editingProduct ? 'Edit Product' : 'Add Product'}
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
            disabled={!formName.trim() || saving}
          >
            {saving ? 'Saving...' : editingProduct ? 'Save Changes' : 'Add Product'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
