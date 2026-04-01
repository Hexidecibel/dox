import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  IconButton,
  Chip,
  Paper,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Autocomplete,
  CircularProgress,
  Alert,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  LinkOff as UnlinkIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiDocumentProduct, ApiProduct } from '../lib/types';

interface ProductLinkerProps {
  documentId: string;
  tenantId: string;
  readOnly?: boolean;
}

/** Returns color based on days until expiration */
function expirationColor(expiresAt: string | null): 'success' | 'warning' | 'error' | 'default' {
  if (!expiresAt) return 'default';
  const now = new Date();
  const exp = new Date(expiresAt);
  const diffMs = exp.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return 'error';
  if (diffDays < 30) return 'error';
  if (diffDays < 60) return 'warning';
  return 'success';
}

function formatExpiration(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiration';
  const exp = new Date(expiresAt);
  const now = new Date();
  const diffMs = exp.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const dateStr = exp.toLocaleDateString();
  if (diffDays < 0) return `Expired ${dateStr}`;
  if (diffDays === 0) return `Expires today (${dateStr})`;
  if (diffDays === 1) return `Expires tomorrow (${dateStr})`;
  return `Expires ${dateStr} (${diffDays}d)`;
}

export function ProductLinker({ documentId, tenantId, readOnly = false }: ProductLinkerProps) {
  const [linkedProducts, setLinkedProducts] = useState<ApiDocumentProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  // Add dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ApiProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ApiProduct | null>(null);
  const [addExpiresAt, setAddExpiresAt] = useState('');
  const [addNotes, setAddNotes] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiDocumentProduct | null>(null);
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Confirm unlink state
  const [unlinkTarget, setUnlinkTarget] = useState<ApiDocumentProduct | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const loadLinkedProducts = useCallback(async () => {
    try {
      const result = await api.documentProducts.list(documentId);
      setLinkedProducts(result.products);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load linked products');
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    loadLinkedProducts();
  }, [loadLinkedProducts]);

  // Search products for autocomplete
  useEffect(() => {
    if (!addOpen) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const result = await api.products.list({ search: searchQuery || undefined, active: 1, limit: 20, tenant_id: tenantId });
        // Filter out already-linked products
        const linkedIds = new Set(linkedProducts.map((lp) => lp.product_id));
        setSearchResults(result.products.filter((p) => !linkedIds.has(p.id)));
      } catch {
        // Silently fail search
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, addOpen, linkedProducts]);

  const handleAdd = async () => {
    if (!selectedProduct) return;
    setAdding(true);
    setActionError('');
    try {
      await api.documentProducts.link(documentId, {
        product_id: selectedProduct.id,
        expires_at: addExpiresAt || undefined,
        notes: addNotes.trim() || undefined,
      });
      setAddOpen(false);
      setSelectedProduct(null);
      setAddExpiresAt('');
      setAddNotes('');
      setSearchQuery('');
      await loadLinkedProducts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to link product');
    } finally {
      setAdding(false);
    }
  };

  const openEdit = (dp: ApiDocumentProduct) => {
    setEditTarget(dp);
    setEditExpiresAt(dp.expires_at ? dp.expires_at.split('T')[0] : '');
    setEditNotes(dp.notes || '');
    setEditOpen(true);
    setActionError('');
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    setSaving(true);
    setActionError('');
    try {
      await api.documentProducts.update(documentId, editTarget.product_id, {
        expires_at: editExpiresAt || null,
        notes: editNotes.trim() || null,
      });
      setEditOpen(false);
      setEditTarget(null);
      await loadLinkedProducts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update link');
    } finally {
      setSaving(false);
    }
  };

  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    setUnlinking(true);
    setActionError('');
    try {
      await api.documentProducts.unlink(documentId, unlinkTarget.product_id);
      setUnlinkTarget(null);
      await loadLinkedProducts();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to unlink product');
    } finally {
      setUnlinking(false);
    }
  };

  if (loading) {
    return (
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" fontWeight={600} gutterBottom>
          Linked Products
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6" fontWeight={600}>
          Linked Products
        </Typography>
        {!readOnly && (
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => { setAddOpen(true); setActionError(''); }}
          >
            Add Product
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
      )}

      {linkedProducts.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No products linked to this document.
        </Typography>
      ) : (
        <List disablePadding>
          {linkedProducts.map((dp) => {
            const color = expirationColor(dp.expires_at);
            return (
              <ListItem
                key={dp.product_id}
                sx={{
                  px: { xs: 0, sm: 1 },
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  '&:last-child': { borderBottom: 'none' },
                }}
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="body1" fontWeight={500}>
                        {dp.product_name || dp.product_id}
                      </Typography>
                      <Tooltip title={formatExpiration(dp.expires_at)}>
                        <Chip
                          label={dp.expires_at ? new Date(dp.expires_at).toLocaleDateString() : 'No expiry'}
                          size="small"
                          color={color}
                          variant={color === 'default' ? 'outlined' : 'filled'}
                        />
                      </Tooltip>
                    </Box>
                  }
                  secondary={dp.notes || undefined}
                />
                {!readOnly && (
                  <ListItemSecondaryAction>
                    <Tooltip title="Edit expiration / notes">
                      <IconButton size="small" onClick={() => openEdit(dp)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Unlink product">
                      <IconButton size="small" onClick={() => { setUnlinkTarget(dp); setActionError(''); }}>
                        <UnlinkIcon fontSize="small" color="error" />
                      </IconButton>
                    </Tooltip>
                  </ListItemSecondaryAction>
                )}
              </ListItem>
            );
          })}
        </List>
      )}

      {/* Add Product Dialog */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Link Product</DialogTitle>
        <DialogContent>
          {actionError && (
            <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert>
          )}
          <Autocomplete
            options={searchResults}
            getOptionLabel={(opt) => opt.name}
            value={selectedProduct}
            onChange={(_, value) => setSelectedProduct(value)}
            onInputChange={(_, value) => setSearchQuery(value)}
            loading={searching}
            isOptionEqualToValue={(opt, val) => opt.id === val.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Search products"
                placeholder="Type to search..."
                sx={{ mt: 1 }}
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {searching ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Expiration Date"
            type="date"
            fullWidth
            value={addExpiresAt}
            onChange={(e) => setAddExpiresAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            helperText="Optional. When does this product's association with the document expire?"
            sx={{ mb: 2 }}
          />
          <TextField
            label="Notes"
            fullWidth
            multiline
            rows={2}
            value={addNotes}
            onChange={(e) => setAddNotes(e.target.value)}
            placeholder="Optional notes about this link..."
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setAddOpen(false)} disabled={adding}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleAdd}
            disabled={!selectedProduct || adding}
          >
            {adding ? 'Linking...' : 'Link Product'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Edit Link: {editTarget?.product_name || ''}
        </DialogTitle>
        <DialogContent>
          {actionError && (
            <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert>
          )}
          <TextField
            label="Expiration Date"
            type="date"
            fullWidth
            value={editExpiresAt}
            onChange={(e) => setEditExpiresAt(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Notes"
            fullWidth
            multiline
            rows={2}
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            placeholder="Optional notes..."
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Unlink Confirmation Dialog */}
      <Dialog open={!!unlinkTarget} onClose={() => setUnlinkTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Unlink Product</DialogTitle>
        <DialogContent>
          {actionError && (
            <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert>
          )}
          <Typography>
            Remove <strong>{unlinkTarget?.product_name || unlinkTarget?.product_id}</strong> from this document?
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setUnlinkTarget(null)} disabled={unlinking}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleUnlink}
            disabled={unlinking}
            startIcon={<DeleteIcon />}
          >
            {unlinking ? 'Removing...' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
