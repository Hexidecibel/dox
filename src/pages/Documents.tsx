import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Grid,
  TextField,
  InputAdornment,
  Chip,
  Button,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Pagination,
  useMediaQuery,
  useTheme,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import {
  Search as SearchIcon,
  Add as AddIcon,
  Close as CloseIcon,
  CloudUpload as UploadIcon,
  InsertDriveFile as FileIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document } from '../lib/types';
import { DocumentCard } from '../components/DocumentCard';
import { RoleGuard } from '../components/RoleGuard';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';

const ITEMS_PER_PAGE = 12;

const statusOptions = ['active', 'archived'];

export function Documents() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  // New document dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newTags, setNewTags] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createTenantId, setCreateTenantId] = useState<string>('');
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [newDocChangeNotes, setNewDocChangeNotes] = useState('');
  const [createStatus, setCreateStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pre-select tenant when dialog opens and reset file state
  useEffect(() => {
    if (createOpen) {
      setCreateError('');
      setNewDocFile(null);
      setNewDocChangeNotes('');
      setCreateStatus('');
      setDragOver(false);
      if (isSuperAdmin) {
        setCreateTenantId(selectedTenantId || '');
      } else {
        setCreateTenantId(user?.tenant_id || '');
      }
    }
  }, [createOpen, isSuperAdmin, selectedTenantId, user?.tenant_id]);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) {
      setNewDocFile(droppedFile);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const loadDocuments = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.documents.list({
        page,
        limit: ITEMS_PER_PAGE,
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
        tenantId: selectedTenantId || undefined,
      });
      setDocuments(result.documents);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments();
  }, [page, statusFilter, categoryFilter, selectedTenantId]);

  const handleCreateDocument = async () => {
    if (!newTitle.trim()) return;

    const tenantId = isSuperAdmin ? createTenantId : user?.tenant_id;
    if (!tenantId) {
      setCreateError('A tenant must be selected to create a document.');
      return;
    }

    setCreating(true);
    setCreateError('');
    setCreateStatus('Creating document...');
    try {
      const newDoc = await api.documents.create({
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        category: newCategory.trim() || undefined,
        tags: newTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        tenantId,
      });

      if (newDocFile && newDoc.id) {
        setCreateStatus('Uploading file...');
        await api.documents.upload(newDoc.id, newDocFile, newDocChangeNotes.trim() || undefined);
      }

      setCreateOpen(false);
      setNewTitle('');
      setNewDescription('');
      setNewCategory('');
      setNewTags('');
      setNewDocFile(null);
      setNewDocChangeNotes('');
      setCreateError('');
      setCreateStatus('');

      if (newDoc.id) {
        navigate(`/documents/${newDoc.id}`);
      } else {
        loadDocuments();
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create document');
      setCreateStatus('');
    } finally {
      setCreating(false);
    }
  };

  const filteredDocs = search
    ? documents.filter(
        (d) =>
          d.title.toLowerCase().includes(search.toLowerCase()) ||
          d.description?.toLowerCase().includes(search.toLowerCase()) ||
          d.category?.toLowerCase().includes(search.toLowerCase())
      )
    : documents;

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Documents
        </Typography>
        <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            New Document
          </Button>
        </RoleGuard>
      </Box>

      {/* Search and Filters */}
      <Box sx={{ mb: 3 }}>
        <TextField
          placeholder="Search documents..."
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
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
            Status:
          </Typography>
          <Chip
            label="All"
            size="small"
            variant={statusFilter === '' ? 'filled' : 'outlined'}
            color={statusFilter === '' ? 'primary' : 'default'}
            onClick={() => { setStatusFilter(''); setPage(1); }}
          />
          {statusOptions.map((status) => (
            <Chip
              key={status}
              label={status}
              size="small"
              variant={statusFilter === status ? 'filled' : 'outlined'}
              color={statusFilter === status ? 'primary' : 'default'}
              onClick={() => { setStatusFilter(status); setPage(1); }}
              sx={{ textTransform: 'capitalize' }}
            />
          ))}
          {categoryFilter && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 2 }, mr: 0.5 }}>
                Category:
              </Typography>
              <Chip
                label={categoryFilter}
                size="small"
                color="secondary"
                onDelete={() => { setCategoryFilter(''); setPage(1); }}
              />
            </>
          )}
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : filteredDocs.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No documents found
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {search ? 'Try a different search term.' : 'Upload your first document to get started.'}
          </Typography>
        </Box>
      ) : (
        <>
          <Grid container spacing={2}>
            {filteredDocs.map((doc) => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={doc.id}>
                <DocumentCard document={doc} />
              </Grid>
            ))}
          </Grid>
          {totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
              <Pagination
                count={totalPages}
                page={page}
                onChange={(_, p) => setPage(p)}
                color="primary"
              />
            </Box>
          )}
        </>
      )}

      {/* Create Document Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Create New Document
          <IconButton onClick={() => setCreateOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {createError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {createError}
            </Alert>
          )}
          {isSuperAdmin && (
            <FormControl fullWidth sx={{ mt: 1, mb: 2 }}>
              <InputLabel id="create-tenant-label">Tenant</InputLabel>
              <Select
                labelId="create-tenant-label"
                value={createTenantId}
                label="Tenant"
                onChange={(e) => setCreateTenantId(e.target.value)}
                disabled={creating}
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
            label="Title"
            fullWidth
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            disabled={creating}
            autoFocus
            sx={{ mt: isSuperAdmin ? 0 : 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={3}
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            disabled={creating}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Category"
            fullWidth
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            disabled={creating}
            placeholder="e.g., Regulatory, Compliance, Safety"
            sx={{ mb: 2 }}
          />
          <TextField
            label="Tags"
            fullWidth
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            disabled={creating}
            placeholder="Comma-separated tags"
            helperText="Separate tags with commas"
            sx={{ mb: 2 }}
          />

          {/* File attachment (optional) */}
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
            Attach file (optional)
          </Typography>
          <Box
            onDrop={handleFileDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            sx={{
              border: '2px dashed',
              borderColor: dragOver ? 'primary.main' : 'divider',
              borderRadius: 1.5,
              p: { xs: 2, sm: 3 },
              textAlign: 'center',
              cursor: creating ? 'default' : 'pointer',
              bgcolor: dragOver ? 'action.hover' : 'transparent',
              transition: 'all 0.2s',
              mb: 2,
              minHeight: { xs: 80, sm: 'auto' },
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: creating ? 'none' : 'auto',
              '&:hover': {
                borderColor: 'primary.main',
                bgcolor: 'action.hover',
              },
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setNewDocFile(f);
                // Reset so the same file can be re-selected
                e.target.value = '';
              }}
            />
            {newDocFile ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <FileIcon color="primary" />
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    {newDocFile.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatFileSize(newDocFile.size)}
                  </Typography>
                </Box>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNewDocFile(null);
                    setNewDocChangeNotes('');
                  }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            ) : (
              <>
                <UploadIcon sx={{ fontSize: 36, color: 'text.secondary', mb: 0.5 }} />
                <Typography variant="body2">
                  {isMobile ? 'Tap to select a file' : 'Drag and drop a file, or click to browse'}
                </Typography>
              </>
            )}
          </Box>

          {newDocFile && (
            <TextField
              label="Change Notes"
              placeholder="Notes for this initial version..."
              multiline
              rows={2}
              fullWidth
              value={newDocChangeNotes}
              onChange={(e) => setNewDocChangeNotes(e.target.value)}
              disabled={creating}
            />
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {createStatus && (
            <Typography variant="body2" color="text.secondary" sx={{ mr: 'auto' }}>
              {createStatus}
            </Typography>
          )}
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreateDocument}
            disabled={!newTitle.trim() || creating || (isSuperAdmin && !createTenantId)}
            startIcon={creating ? <CircularProgress size={18} color="inherit" /> : undefined}
          >
            {creating ? (createStatus || 'Creating...') : (newDocFile ? 'Create & Upload' : 'Create')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
