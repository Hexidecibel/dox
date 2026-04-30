import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../utils/format';
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
  CircularProgress,
  Alert,
  Pagination,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Autocomplete,
  IconButton,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  CardActionArea,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiBundle, ApiProduct } from '../lib/types';
import { useTenant } from '../contexts/TenantContext';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { EmptyState } from '../components/EmptyState';
import { helpContent } from '../lib/helpContent';

const ITEMS_PER_PAGE = 20;

export function Bundles() {
  const navigate = useNavigate();
  const { selectedTenantId } = useTenant();
  const [bundles, setBundles] = useState<ApiBundle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // Create dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formProduct, setFormProduct] = useState<ApiProduct | null>(null);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [saving, setSaving] = useState(false);

  const loadBundles = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.bundles.list({
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: selectedTenantId || undefined,
      });
      setBundles(result.bundles);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bundles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBundles();
  }, [page, selectedTenantId]);

  const loadProducts = async () => {
    try {
      const result = await api.products.list({ active: 1, limit: 200 });
      setProducts(result.products);
    } catch {
      // ignore
    }
  };

  const openCreate = () => {
    setFormName('');
    setFormDescription('');
    setFormProduct(null);
    loadProducts();
    setDialogOpen(true);
  };

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      await api.bundles.create({
        name: formName.trim(),
        description: formDescription.trim() || undefined,
        product_id: formProduct?.id,
      });
      setDialogOpen(false);
      loadBundles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create bundle');
    } finally {
      setSaving(false);
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  if (loading && bundles.length === 0) {
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
          Bundles
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Create Bundle
        </Button>
      </Box>

      <HelpWell id="bundles.list" title={helpContent.bundles.list?.headline ?? 'Bundles'}>
        {helpContent.bundles.list?.well ?? helpContent.bundles.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {bundles.length === 0 ? (
            <EmptyState
              title={helpContent.bundles.list?.emptyTitle ?? 'No bundles yet'}
              description={helpContent.bundles.list?.emptyDescription}
              actionLabel="Create bundle"
              onAction={openCreate}
            />
          ) : (
            bundles.map((bundle) => (
              <Card key={bundle.id} variant="outlined">
                <CardActionArea onClick={() => navigate(`/bundles/${bundle.id}`)}>
                  <CardContent sx={{ pb: '12px !important' }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {bundle.name}
                      </Typography>
                      <Chip
                        label={bundle.status}
                        size="small"
                        color={bundle.status === 'finalized' ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ textTransform: 'capitalize' }}
                      />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      {bundle.product_name && (
                        <Chip label={bundle.product_name} size="small" variant="outlined" />
                      )}
                      <Chip label={`${bundle.item_count || 0} items`} size="small" variant="outlined" />
                    </Box>
                  </CardContent>
                </CardActionArea>
              </Card>
            ))
          )}
        </Box>
      ) : bundles.length === 0 ? (
        <EmptyState
          title={helpContent.bundles.list?.emptyTitle ?? 'No bundles yet'}
          description={helpContent.bundles.list?.emptyDescription}
          actionLabel="Create bundle"
          onAction={openCreate}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Name
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.name} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Product
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.product} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.status} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Items
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.items} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created By
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.createdBy} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Created
                    <InfoTooltip text={helpContent.bundles.list?.columnTooltips?.created} />
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {bundles.map((bundle) => (
                  <TableRow
                    key={bundle.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/bundles/${bundle.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {bundle.name}
                      </Typography>
                      {bundle.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {bundle.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {bundle.product_name ? (
                        <Chip label={bundle.product_name} size="small" variant="outlined" />
                      ) : (
                        <Typography variant="body2" color="text.secondary">-</Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={bundle.status}
                        size="small"
                        color={bundle.status === 'finalized' ? 'success' : 'default'}
                        variant="outlined"
                        sx={{ textTransform: 'capitalize' }}
                      />
                    </TableCell>
                    <TableCell>{bundle.item_count || 0}</TableCell>
                    <TableCell>{bundle.creator_name || '-'}</TableCell>
                    <TableCell>{formatDate(bundle.created_at)}</TableCell>
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

      {/* Create Bundle Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Create Bundle
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
            sx={{ mb: 2 }}
          />
          <Autocomplete
            options={products}
            getOptionLabel={(option) => option.name}
            value={formProduct}
            onChange={(_, value) => setFormProduct(value)}
            renderInput={(params) => (
              <TextField {...params} label="Product (optional)" />
            )}
            disabled={saving}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!formName.trim() || saving}
          >
            {saving ? 'Creating...' : 'Create Bundle'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
