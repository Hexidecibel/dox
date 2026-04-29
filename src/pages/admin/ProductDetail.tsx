import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../../utils/format';
import {
  Box,
  Typography,
  Button,
  Paper,
  Chip,
  IconButton,
  CircularProgress,
  Alert,
  Tooltip,
  TextField,
} from '@mui/material';
import {
  Edit as EditIcon,
  ArrowBack as BackIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiProduct } from '../../lib/types';

/**
 * ProductDetail — minimal info page for a single product. Mirrors the
 * visual style of SupplierDetail / CustomerDetail (back link, header
 * paper with name + status chips, edit affordance, info paper rows).
 *
 * Linked documents and supplier associations are deferred — the
 * documents.list API does not currently filter by product_id, and
 * tenant_products lookups are not exposed in the client API.
 */
export function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editing, setEditing] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const loadProduct = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.products.get(id);
      setProduct(result.product);
      setFormName(result.product.name);
      setFormDescription(result.product.description || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load product');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadProduct();
  }, [loadProduct]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.products.update(id, {
        name: formName.trim(),
        description: formDescription.trim() || undefined,
      });
      setProduct(result.product);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update product');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    if (!id || !product) return;
    try {
      const result = await api.products.update(id, { active: product.active ? 0 : 1 });
      setProduct(result.product);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update product');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!product) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">Product not found</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/admin/products')} sx={{ mt: 2 }}>
          Back to Products
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Back button */}
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/products')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Products
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Header */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        {editing ? (
          <Box>
            <TextField
              label="Name"
              fullWidth
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={saving}
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
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={!formName.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setEditing(false);
                  setFormName(product.name);
                  setFormDescription(product.description || '');
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
                <Typography variant="h4" fontWeight={700}>
                  {product.name}
                </Typography>
                <Chip
                  label={product.active ? 'Active' : 'Inactive'}
                  size="small"
                  color={product.active ? 'success' : 'default'}
                  variant="outlined"
                />
              </Box>
              <Typography variant="body2" color="text.secondary">
                Slug: <Box component="span" sx={{ fontFamily: 'monospace' }}>{product.slug}</Box>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Created {formatDate(product.created_at)}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Tooltip title="Edit">
                <IconButton onClick={() => setEditing(true)}>
                  <EditIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title={product.active ? 'Deactivate' : 'Activate'}>
                <IconButton onClick={handleToggleActive}>
                  {product.active ? (
                    <BlockIcon color="warning" />
                  ) : (
                    <ActiveIcon color="success" />
                  )}
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}
      </Paper>

      {/* Info */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Description
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {product.description || 'No description.'}
        </Typography>
      </Paper>
    </Box>
  );
}
