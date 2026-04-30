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
  Collapse,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Select,
  InputLabel,
  FormControl,
  Tooltip,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Download as DownloadIcon,
  CloudUpload as UploadIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Archive as ArchiveIcon,
  MoreVert as MoreIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document, DocumentVersion, ApiDocumentType } from '../lib/types';
import { VersionHistory } from '../components/VersionHistory';
import { UploadDialog } from '../components/UploadDialog';
import { RoleGuard } from '../components/RoleGuard';
import { DocumentPreview } from '../components/DocumentPreview';
import { CopyId } from '../components/CopyId';
import { ProductLinker } from '../components/ProductLinker';
import { useAuth } from '../contexts/AuthContext';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { helpContent } from '../lib/helpContent';

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
  const [editDocumentTypeId, setEditDocumentTypeId] = useState('');
  const [saving, setSaving] = useState(false);

  // Metadata inline editing
  const [metaEditing, setMetaEditing] = useState(false);
  const [metaFields, setMetaFields] = useState<Record<string, string>>({});
  const [metaSaving, setMetaSaving] = useState(false);

  // Source metadata collapse
  const [sourceMetaOpen, setSourceMetaOpen] = useState(false);

  // Document types for dropdown
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);

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

  // Sync inline metadata fields when doc loads
  useEffect(() => {
    if (doc) {
      const fields: Record<string, string> = {};
      if (doc.primaryMetadata) {
        for (const [k, v] of Object.entries(doc.primaryMetadata)) {
          fields[k] = v || '';
        }
      }
      setMetaFields(fields);
    }
  }, [doc]);

  // Load document types for the dropdown
  useEffect(() => {
    const loadDocTypes = async () => {
      try {
        const result = await api.documentTypes.list({
          tenant_id: doc?.tenant_id || undefined,
          active: 1,
        });
        setDocumentTypes(result.documentTypes || []);
      } catch {
        // Non-critical, silently ignore
      }
    };
    if (doc?.tenant_id) loadDocTypes();
  }, [doc?.tenant_id]);

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
    setEditDocumentTypeId(doc.documentTypeId || '');
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
        document_type_id: editDocumentTypeId || null,
      });
      setEditOpen(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMetadata = async () => {
    if (!doc || !id) return;
    setMetaSaving(true);
    try {
      // Build primary_metadata from edited fields, stripping empty values
      const newMeta: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(metaFields)) {
        newMeta[k] = v.trim() || null;
      }
      await api.documents.update(id, {
        primary_metadata: Object.values(newMeta).some(v => v) ? newMeta : null,
      });
      setMetaEditing(false);
      loadDocument();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update metadata');
    } finally {
      setMetaSaving(false);
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
            <Tooltip title={helpContent.documents.list?.columnTooltips?.version ?? ''}>
              <Chip
                label={`v${doc.current_version}`}
                size="small"
                color="primary"
                variant="outlined"
              />
            </Tooltip>
            <Tooltip title={helpContent.documents.list?.columnTooltips?.status ?? ''}>
              <Chip
                label={doc.status}
                size="small"
                color={statusColors[doc.status] || 'default'}
                variant="filled"
                sx={{ textTransform: 'capitalize' }}
              />
            </Tooltip>
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

      <HelpWell id="documents.detail" title={helpContent.documents.detail?.headline ?? 'Document detail'}>
        {helpContent.documents.detail?.well ?? helpContent.documents.well}
      </HelpWell>

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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Document Type
              </Typography>
              <InfoTooltip text={helpContent.documents.list?.columnTooltips?.type} />
            </Box>
            <Chip label={doc.documentTypeName} color="info" variant="outlined" size="small" />
          </Box>
        )}

        {/* Supplier */}
        {doc.supplierName && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Supplier
              </Typography>
              <InfoTooltip text={helpContent.documents.list?.columnTooltips?.supplier} />
            </Box>
            <Chip label={doc.supplierName} color="default" variant="outlined" size="small" />
          </Box>
        )}

        {/* Editable Primary Metadata Section */}
        {(doc.primaryMetadata && Object.keys(doc.primaryMetadata).length > 0 || !isReader) && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">
                Metadata
              </Typography>
              {!isReader && !metaEditing && (
                <IconButton size="small" onClick={() => setMetaEditing(true)}>
                  <EditIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
            {metaEditing ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {Object.entries(metaFields).map(([key, value]) => (
                    <TextField
                      key={key}
                      label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      size="small"
                      value={value}
                      onChange={(e) => setMetaFields(prev => ({ ...prev, [key]: e.target.value }))}
                      disabled={metaSaving}
                      sx={{ flex: '1 1 180px' }}
                    />
                  ))}
                </Box>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSaveMetadata}
                    disabled={metaSaving}
                  >
                    {metaSaving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setMetaEditing(false);
                      const fields: Record<string, string> = {};
                      if (doc.primaryMetadata) {
                        for (const [k, v] of Object.entries(doc.primaryMetadata)) {
                          fields[k] = v || '';
                        }
                      }
                      setMetaFields(fields);
                    }}
                    disabled={metaSaving}
                  >
                    Cancel
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {doc.primaryMetadata && Object.entries(doc.primaryMetadata).map(([key, value]) => (
                  value ? (
                    <Chip
                      key={key}
                      label={`${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${value}`}
                      size="small"
                      variant="outlined"
                    />
                  ) : null
                ))}
                {(!doc.primaryMetadata || Object.values(doc.primaryMetadata).every(v => !v)) && !isReader && (
                  <Typography variant="body2" color="text.secondary">No metadata</Typography>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Extended Metadata (collapsed) */}
        {doc.extendedMetadata && Object.keys(doc.extendedMetadata).length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Button
              size="small"
              onClick={() => setSourceMetaOpen(!sourceMetaOpen)}
              endIcon={sourceMetaOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ mb: 0.5, textTransform: 'none', color: 'text.secondary', px: 0, minWidth: 0 }}
            >
              <Typography variant="subtitle2" color="text.secondary">
                Extended Metadata
              </Typography>
            </Button>
            <Collapse in={sourceMetaOpen}>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {Object.entries(doc.extendedMetadata).map(([key, value]) => (
                  value ? (
                    <Chip
                      key={key}
                      label={`${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${value}`}
                      size="small"
                      variant="outlined"
                    />
                  ) : null
                ))}
              </Box>
            </Collapse>
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
            const tables = meta._tables;
            const regularKeys = Object.keys(meta).filter((k) => k !== '_tables');

            return (
              <Box>
                <Button
                  size="small"
                  onClick={() => setSourceMetaOpen(!sourceMetaOpen)}
                  endIcon={sourceMetaOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  sx={{ mb: 0.5, textTransform: 'none', color: 'text.secondary', px: 0, minWidth: 0 }}
                >
                  <Typography variant="subtitle2" color="text.secondary">
                    Source Metadata
                  </Typography>
                </Button>
                <Collapse in={sourceMetaOpen}>
                  {regularKeys.length > 0 && (
                    <Box sx={{ mb: 1 }}>
                      {regularKeys.map((key) => {
                        const value = meta[key];
                        const displayValue =
                          typeof value === 'object' ? JSON.stringify(value) :
                          key.includes('date') || key.includes('_at') ? formatDate(String(value)) :
                          String(value);
                        return (
                          <Box key={key} sx={{ display: 'flex', gap: 1, py: 0.25 }}>
                            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120, fontWeight: 500 }}>
                              {key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}:
                            </Typography>
                            <Typography variant="body2">{displayValue}</Typography>
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                  {tables && Array.isArray(tables) && tables.map((table: { title?: string; headers?: string[]; rows?: string[][] }, idx: number) => (
                    <Box key={idx} sx={{ mb: 2 }}>
                      {table.title && (
                        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                          {table.title}
                        </Typography>
                      )}
                      <TableContainer>
                        <Table size="small" sx={{ '& td, & th': { py: 0.5, px: 1 } }}>
                          {table.headers && (
                            <TableHead>
                              <TableRow>
                                {table.headers.map((h: string, i: number) => (
                                  <TableCell key={i} sx={{ fontWeight: 600 }}>{h}</TableCell>
                                ))}
                              </TableRow>
                            </TableHead>
                          )}
                          <TableBody>
                            {(table.rows || []).map((row: string[], ri: number) => (
                              <TableRow key={ri}>
                                {row.map((cell: string, ci: number) => (
                                  <TableCell key={ci}>{cell}</TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Box>
                  ))}
                </Collapse>
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
            sx={{ mb: 2 }}
          />
          {documentTypes.length > 0 && (
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Document Type</InputLabel>
              <Select
                value={editDocumentTypeId}
                onChange={(e) => setEditDocumentTypeId(e.target.value as string)}
                label="Document Type"
                disabled={saving}
              >
                <MenuItem value="">
                  <em>None</em>
                </MenuItem>
                {documentTypes.map((dt) => (
                  <MenuItem key={dt.id} value={dt.id}>
                    {dt.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {/* Metadata fields are edited inline on the document detail page, not in this dialog */}
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
