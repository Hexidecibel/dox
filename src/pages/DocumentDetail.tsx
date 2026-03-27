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
  useMediaQuery,
  useTheme,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Download as DownloadIcon,
  CloudUpload as UploadIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Archive as ArchiveIcon,
  MoreVert as MoreIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document, DocumentVersion } from '../lib/types';
import { VersionHistory } from '../components/VersionHistory';
import { UploadDialog } from '../components/UploadDialog';
import { RoleGuard } from '../components/RoleGuard';
import { DocumentPreview } from '../components/DocumentPreview';
import { CopyId } from '../components/CopyId';
import { ProductLinker } from '../components/ProductLinker';
import { useAuth } from '../contexts/AuthContext';

const statusColors: Record<string, 'success' | 'warning' | 'error'> = {
  active: 'success',
  archived: 'warning',
  deleted: 'error',
};

export function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { isReader } = useAuth();
  const [doc, setDoc] = useState<Document | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);

  // Mobile action menu
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);

  // Preview version
  const [previewVersion, setPreviewVersion] = useState<DocumentVersion | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editTags, setEditTags] = useState('');
  const [saving, setSaving] = useState(false);

  const loadDocument = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [document, vers] = await Promise.all([
        api.documents.get(id),
        api.documents.versions(id),
      ]);
      setDoc(document);
      setVersions(vers);
      // Set preview to latest version (or keep current selection if still valid)
      if (vers.length > 0) {
        setPreviewVersion((prev) => {
          if (prev && vers.find((v: { version_number: number }) => v.version_number === prev.version_number)) return prev;
          return vers[0]; // versions are ordered newest first
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocument();
  }, [id]);

  const handleUploadSuccess = () => {
    setUploadOpen(false);
    loadDocument();
  };

  const openEdit = () => {
    if (!doc) return;
    setEditTitle(doc.title);
    setEditDescription(doc.description || '');
    setEditCategory(doc.category || '');
    setEditTags(doc.tags.join(', '));
    setEditOpen(true);
    setAnchorEl(null);
  };

  const handleSaveEdit = async () => {
    if (!doc || !id) return;
    setSaving(true);
    try {
      await api.documents.update(id, {
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
        category: editCategory.trim() || undefined,
        tags: editTags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditOpen(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!id) return;
    setAnchorEl(null);
    if (!confirm('Archive this document? It can be restored later.')) return;
    try {
      await api.documents.update(id, { status: 'archived' });
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive document');
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setAnchorEl(null);
    if (!confirm('Delete this document? This action cannot be undone.')) return;
    try {
      await api.documents.delete(id);
      navigate('/documents');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !doc) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/documents')} sx={{ mb: 2 }}>
          Back to Documents
        </Button>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (!doc) return null;

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: { xs: 1, sm: 2 }, mb: 3 }}>
        <IconButton onClick={() => navigate('/documents')} sx={{ mt: 0.5 }} size={isMobile ? 'small' : 'medium'}>
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant={isMobile ? 'h5' : 'h4'} fontWeight={700} sx={{ wordBreak: 'break-word' }}>
              {doc.title}
            </Typography>
            <Chip
              label={`v${doc.current_version}`}
              size="small"
              color="primary"
              variant="outlined"
            />
            <Chip
              label={doc.status}
              size="small"
              color={statusColors[doc.status] || 'default'}
              variant="filled"
              sx={{ textTransform: 'capitalize' }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              {doc.creator_name && `Created by ${doc.creator_name} · `}
              {formatDate(doc.created_at)} · Updated{' '}
              {formatDate(doc.updated_at)}
            </Typography>
            <CopyId id={doc.id} label="Doc:" />
            {doc.tenant_id && <CopyId id={doc.tenant_id} label="Tenant:" />}
          </Box>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Actions */}
      {isMobile ? (
        <Box sx={{ display: 'flex', gap: 1, mb: 3 }}>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={() => api.documents.download(doc.id)}
            sx={{ flex: 1 }}
          >
            Download
          </Button>
          <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => setUploadOpen(true)}
              sx={{ flex: 1 }}
            >
              Upload
            </Button>
            <IconButton onClick={(e) => setAnchorEl(e.currentTarget)}>
              <MoreIcon />
            </IconButton>
            <Menu anchorEl={anchorEl} open={menuOpen} onClose={() => setAnchorEl(null)}>
              <MenuItem onClick={openEdit}>
                <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
                <ListItemText>Edit</ListItemText>
              </MenuItem>
              <MenuItem onClick={handleArchive}>
                <ListItemIcon><ArchiveIcon fontSize="small" color="warning" /></ListItemIcon>
                <ListItemText>Archive</ListItemText>
              </MenuItem>
              <MenuItem onClick={handleDelete}>
                <ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon>
                <ListItemText>Delete</ListItemText>
              </MenuItem>
            </Menu>
          </RoleGuard>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={() => api.documents.download(doc.id)}
          >
            Download Latest
          </Button>
          <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
            <Button
              variant="outlined"
              startIcon={<UploadIcon />}
              onClick={() => setUploadOpen(true)}
            >
              Upload New Version
            </Button>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={openEdit}>
              Edit
            </Button>
            <Button
              variant="outlined"
              color="warning"
              startIcon={<ArchiveIcon />}
              onClick={handleArchive}
            >
              Archive
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={handleDelete}
            >
              Delete
            </Button>
          </RoleGuard>
        </Box>
      )}

      {/* Document Info */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        {doc.description && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Description
            </Typography>
            <Typography variant="body1">{doc.description}</Typography>
          </Box>
        )}

        {doc.category && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Category
            </Typography>
            <Chip label={doc.category} color="secondary" variant="outlined" size="small" />
          </Box>
        )}

        {doc.tags.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Tags
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {doc.tags.map((tag) => (
                <Chip key={tag} label={tag} size="small" variant="outlined" />
              ))}
            </Box>
          </Box>
        )}

        {doc.documentTypeName && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Document Type
            </Typography>
            <Chip label={doc.documentTypeName} color="info" variant="outlined" size="small" />
          </Box>
        )}

        {(doc.lotNumber || doc.poNumber || doc.codeDate || doc.expirationDate) && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              Metadata
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {doc.lotNumber && (
                <Chip label={`Lot: ${doc.lotNumber}`} size="small" variant="outlined" />
              )}
              {doc.poNumber && (
                <Chip label={`PO: ${doc.poNumber}`} size="small" variant="outlined" />
              )}
              {doc.codeDate && (
                <Chip label={`Code Date: ${doc.codeDate}`} size="small" variant="outlined" />
              )}
              {doc.expirationDate && (
                <Chip label={`Expires: ${doc.expirationDate}`} size="small" variant="outlined" />
              )}
            </Box>
          </Box>
        )}

        {doc.external_ref && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>
              External Reference
            </Typography>
            <Chip
              label={`Ref: ${doc.external_ref}`}
              size="small"
              color="info"
              variant="outlined"
            />
          </Box>
        )}

        {doc.source_metadata && (() => {
          try {
            const meta = JSON.parse(doc.source_metadata);
            return (
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Ingestion Source
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {meta.source && (
                    <Chip label={`Source: ${meta.source}`} size="small" variant="outlined" />
                  )}
                  {meta.from && (
                    <Chip label={`From: ${meta.from}`} size="small" variant="outlined" />
                  )}
                  {meta.received_at && (
                    <Chip
                      label={`Received: ${formatDate(meta.received_at)}`}
                      size="small"
                      variant="outlined"
                    />
                  )}
                  {meta.subject && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, width: '100%' }}>
                      Subject: {meta.subject}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          } catch {
            return null;
          }
        })()}
      </Paper>

      {/* Linked Products */}
      <ProductLinker
        documentId={doc.id}
        tenantId={doc.tenant_id}
        readOnly={isReader}
      />

      {/* Document Preview */}
      {previewVersion && (
        <>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            Document Preview
          </Typography>
          <DocumentPreview
            documentId={doc.id}
            versionNumber={previewVersion.version_number}
            fileName={previewVersion.file_name}
            mimeType={previewVersion.mime_type}
          />
        </>
      )}

      {/* Version History */}
      <Typography variant="h6" fontWeight={600} gutterBottom>
        Version History
      </Typography>
      <VersionHistory
        documentId={doc.id}
        versions={versions}
        activeVersion={previewVersion?.version_number}
        onPreviewVersion={(version) => setPreviewVersion(version)}
      />

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        documentId={doc.id}
        onSuccess={handleUploadSuccess}
      />

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle>Edit Document</DialogTitle>
        <DialogContent>
          <TextField
            label="Title"
            fullWidth
            required
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
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
          <TextField
            label="Category"
            fullWidth
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Tags"
            fullWidth
            value={editTags}
            onChange={(e) => setEditTags(e.target.value)}
            disabled={saving}
            helperText="Comma-separated"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveEdit} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
