import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { formatDate } from '../utils/format';
import {
  Box,
  Typography,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Paper,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Autocomplete,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Download as DownloadIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  Lock as FinalizeIcon,
  RemoveCircleOutline as RemoveIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiBundle, ApiBundleItem, ApiProduct } from '../lib/types';
import { DocumentPicker } from '../components/DocumentPicker';
import { RoleGuard } from '../components/RoleGuard';
import { useAuth } from '../contexts/AuthContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';

function formatFileSize(bytes?: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BundleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { isReader } = useAuth();

  const [bundle, setBundle] = useState<ApiBundle | null>(null);
  const [items, setItems] = useState<ApiBundleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editProduct, setEditProduct] = useState<ApiProduct | null>(null);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [saving, setSaving] = useState(false);

  // Document picker
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadBundle = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.bundles.get(id);
      setBundle(data.bundle);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bundle');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBundle();
  }, [id]);

  const loadProducts = async () => {
    try {
      const result = await api.products.list({ active: 1, limit: 200 });
      setProducts(result.products);
    } catch {
      // ignore
    }
  };

  const openEdit = () => {
    if (!bundle) return;
    setEditName(bundle.name);
    setEditDescription(bundle.description || '');
    setEditProduct(bundle.product_id ? { id: bundle.product_id, name: bundle.product_name || '' } as ApiProduct : null);
    loadProducts();
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!bundle || !id) return;
    setSaving(true);
    setError('');
    try {
      await api.bundles.update(id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        product_id: editProduct?.id || null,
      });
      setEditOpen(false);
      loadBundle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update bundle');
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async () => {
    if (!id) return;
    if (!confirm('Finalize this bundle? It will become read-only.')) return;
    try {
      await api.bundles.update(id, { status: 'finalized' });
      loadBundle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to finalize bundle');
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!confirm('Delete this bundle? This action cannot be undone.')) return;
    try {
      await api.bundles.delete(id);
      navigate('/bundles');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete bundle');
    }
  };

  const handleAddDocument = async (documentId: string) => {
    if (!id) return;
    try {
      await api.bundles.addItem(id, { document_id: documentId });
      loadBundle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add document');
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!id) return;
    try {
      await api.bundles.removeItem(id, itemId);
      loadBundle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove document');
    }
  };

  const handleDownload = () => {
    if (!id) return;
    const url = api.bundles.downloadUrl(id);
    window.open(url, '_blank');
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !bundle) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/bundles')} sx={{ mb: 2 }}>
          Back to Bundles
        </Button>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!bundle) return null;

  const isDraft = bundle.status === 'draft';
  const existingDocIds = items.map((i) => i.document_id);

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: { xs: 1, sm: 2 }, mb: 3 }}>
        <IconButton onClick={() => navigate('/bundles')} sx={{ mt: 0.5 }} size={isMobile ? 'small' : 'medium'}>
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant={isMobile ? 'h5' : 'h4'} fontWeight={700} sx={{ wordBreak: 'break-word' }}>
              {bundle.name}
            </Typography>
            <Chip
              label={bundle.status}
              size="small"
              color={bundle.status === 'finalized' ? 'success' : 'default'}
              variant="filled"
              sx={{ textTransform: 'capitalize' }}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {bundle.creator_name && `Created by ${bundle.creator_name} · `}
            {formatDate(bundle.created_at)}
            {bundle.product_name && ` · Product: ${bundle.product_name}`}
          </Typography>
        </Box>
      </Box>

      <HelpWell id="bundles.detail" title={helpContent.bundles.detail?.headline ?? 'Bundle detail'}>
        {helpContent.bundles.detail?.well ?? helpContent.bundles.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={items.length === 0}
        >
          Download ZIP
        </Button>
        <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
          {isDraft && (
            <>
              <Button variant="outlined" startIcon={<EditIcon />} onClick={openEdit}>
                Edit
              </Button>
              <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setPickerOpen(true)}>
                Add Document
              </Button>
              <Button variant="outlined" color="success" startIcon={<FinalizeIcon />} onClick={handleFinalize}>
                Finalize
              </Button>
            </>
          )}
          <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={handleDelete}>
            Delete
          </Button>
        </RoleGuard>
      </Box>

      {/* Bundle Info */}
      {bundle.description && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Description
          </Typography>
          <Typography variant="body1">{bundle.description}</Typography>
        </Paper>
      )}

      {/* Items */}
      <Typography variant="h6" fontWeight={600} gutterBottom>
        Documents ({items.length})
      </Typography>

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {items.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No documents in this bundle</Typography>
              </CardContent>
            </Card>
          ) : (
            items.map((item) => (
              <Card key={item.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {item.document_title || 'Untitled'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.file_name || '-'} · {formatFileSize(item.file_size)}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                        {item.document_type_name && (
                          <Chip label={item.document_type_name} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.7rem' }} />
                        )}
                      </Box>
                    </Box>
                    {isDraft && !isReader && (
                      <IconButton size="small" color="error" onClick={() => handleRemoveItem(item.id)}>
                        <RemoveIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Document</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>File</TableCell>
                <TableCell>Size</TableCell>
                {isDraft && !isReader && <TableCell align="right">Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isDraft && !isReader ? 5 : 4} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No documents in this bundle</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontWeight={500}
                        sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                        onClick={() => navigate(`/documents/${item.document_id}`)}
                      >
                        {item.document_title || 'Untitled'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {item.document_type_name ? (
                        <Chip label={item.document_type_name} size="small" variant="outlined" />
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.file_name || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>{formatFileSize(item.file_size)}</TableCell>
                    {isDraft && !isReader && (
                      <TableCell align="right">
                        <Tooltip title="Remove from bundle">
                          <IconButton size="small" color="error" onClick={() => handleRemoveItem(item.id)}>
                            <RemoveIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Document Picker */}
      <DocumentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(docId) => handleAddDocument(docId)}
        excludeIds={existingDocIds}
      />

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle>Edit Bundle</DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            fullWidth
            required
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          <Autocomplete
            options={products}
            getOptionLabel={(option) => option.name}
            value={editProduct}
            onChange={(_, value) => setEditProduct(value)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField {...params} label="Product (optional)" />
            )}
            disabled={saving}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={!editName.trim() || saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
