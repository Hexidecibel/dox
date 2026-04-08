import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Chip,
  Card,
  CardContent,
  CardActions,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Snackbar,
  Paper,
  FormControlLabel,
  Switch,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  CheckCircle as CheckIcon,
  Cancel as CancelIcon,
  InsertDriveFile as FileIcon,
} from '@mui/icons-material';
import PdfViewer from '../components/PdfViewer';
import { AUTH_TOKEN_KEY } from '../lib/types';
import { api } from '../lib/api';
import type { ProcessingQueueItem, ApiDocumentType } from '../lib/types';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ReviewQueue() {
  const { isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  const [items, setItems] = useState<ProcessingQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [docTypeFilter, setDocTypeFilter] = useState('');
  const [tenantFilter, setTenantFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editedFields, setEditedFields] = useState<Record<string, Record<string, string>>>({});
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({});
  const blobUrlsRef = useRef<Record<string, string>>({});

  const [showAutoIngestedOnly, setShowAutoIngestedOnly] = useState(false);

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(blobUrlsRef.current).forEach(URL.revokeObjectURL);
    };
  }, []);

  // Load file preview when a card is expanded
  const loadPreview = useCallback(async (itemId: string) => {
    if (previewUrls[itemId] || previewLoading[itemId]) return;
    setPreviewLoading(prev => ({ ...prev, [itemId]: true }));
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const res = await fetch(`/api/queue/${itemId}/file`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Failed to fetch file');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlsRef.current[itemId] = url;
      setPreviewUrls(prev => ({ ...prev, [itemId]: url }));
    } catch {
      // Preview load failed silently - user still has fields to work with
    } finally {
      setPreviewLoading(prev => ({ ...prev, [itemId]: false }));
    }
  }, [previewUrls, previewLoading]);

  // Load document types for filter
  useEffect(() => {
    const loadDocTypes = async () => {
      try {
        const tid = isSuperAdmin ? (tenantFilter || selectedTenantId || undefined) : undefined;
        const result = await api.documentTypes.list({ tenant_id: tid, active: 1 });
        setDocumentTypes(result.documentTypes);
      } catch {
        // Silently fail
      }
    };
    loadDocTypes();
  }, [tenantFilter, selectedTenantId, isSuperAdmin]);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, any> = { status: statusFilter || undefined };
      if (docTypeFilter) params.document_type_id = docTypeFilter;
      if (isSuperAdmin && tenantFilter) params.tenant_id = tenantFilter;
      else if (selectedTenantId) params.tenant_id = selectedTenantId;

      const result = await api.queue.list(params);
      setItems(result.items || []);

      // Initialize edited fields for each item
      const fields: Record<string, Record<string, string>> = {};
      const names: Record<string, string> = {};
      for (const item of (result.items || [])) {
        try {
          const parsed = item.ai_fields ? JSON.parse(item.ai_fields) : {};
          fields[item.id] = Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')])
          );
        } catch {
          fields[item.id] = {};
        }
        try {
          const prodNames = item.product_names ? JSON.parse(item.product_names) : [];
          names[item.id] = Array.isArray(prodNames) ? prodNames[0] || '' : '';
        } catch {
          names[item.id] = '';
        }
      }
      setEditedFields(fields);
      setProductNames(names);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, docTypeFilter, tenantFilter, selectedTenantId, isSuperAdmin]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const handleApprove = async (id: string) => {
    setActionLoading(prev => ({ ...prev, [id]: true }));
    try {
      await api.queue.approve(id, {
        fields: editedFields[id],
        product_name: productNames[id] || undefined,
      });
      setSnackbar({ open: true, message: 'Item approved and imported', severity: 'success' });
      loadQueue();
    } catch (err) {
      setSnackbar({ open: true, message: err instanceof Error ? err.message : 'Approval failed', severity: 'error' });
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleReject = async (id: string) => {
    setActionLoading(prev => ({ ...prev, [id]: true }));
    try {
      await api.queue.reject(id);
      setSnackbar({ open: true, message: 'Item rejected', severity: 'success' });
      loadQueue();
    } catch (err) {
      setSnackbar({ open: true, message: err instanceof Error ? err.message : 'Rejection failed', severity: 'error' });
    } finally {
      setActionLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const updateField = (itemId: string, fieldName: string, value: string) => {
    setEditedFields(prev => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || {}), [fieldName]: value },
    }));
  };

  const updateProductName = (itemId: string, value: string) => {
    setProductNames(prev => ({ ...prev, [itemId]: value }));
  };

  const confidenceColor = (score: number | null): 'success' | 'warning' | 'error' => {
    if (score == null) return 'error';
    if (score >= 0.8) return 'success';
    if (score >= 0.5) return 'warning';
    return 'error';
  };

  const filteredItems = showAutoIngestedOnly
    ? items.filter(i => i.auto_ingested === 1)
    : items;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Review Queue
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 1.5, mb: 3, flexWrap: 'wrap', alignItems: 'center' }}>
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
            Status:
          </Typography>
          {['pending', 'approved', 'rejected'].map((s) => (
            <Chip
              key={s}
              label={s.charAt(0).toUpperCase() + s.slice(1)}
              size="small"
              variant={statusFilter === s ? 'filled' : 'outlined'}
              color={statusFilter === s ? 'primary' : 'default'}
              onClick={() => setStatusFilter(s)}
              sx={{ textTransform: 'capitalize' }}
            />
          ))}
        </Box>

        {documentTypes.length > 0 && (
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Document Type</InputLabel>
            <Select
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value)}
              label="Document Type"
            >
              <MenuItem value="">All Types</MenuItem>
              {documentTypes.map((dt) => (
                <MenuItem key={dt.id} value={dt.id}>
                  {dt.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {isSuperAdmin && (
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Tenant</InputLabel>
            <Select
              value={tenantFilter}
              onChange={(e) => setTenantFilter(e.target.value)}
              label="Tenant"
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

        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showAutoIngestedOnly}
              onChange={(e) => setShowAutoIngestedOnly(e.target.checked)}
            />
          }
          label="Auto-ingested only"
          sx={{ ml: 0.5 }}
        />
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : filteredItems.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No items in queue
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {statusFilter === 'pending' ? 'All items have been reviewed.' : `No ${statusFilter} items found.`}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {filteredItems.map((item) => {
            const isExpanded = expandedId === item.id;
            const fields = editedFields[item.id] || {};
            const isActioning = actionLoading[item.id] || false;

            return (
              <Card key={item.id} variant="outlined">
                <CardContent
                  sx={{ cursor: 'pointer' }}
                  onClick={() => {
                    const newId = isExpanded ? null : item.id;
                    setExpandedId(newId);
                    if (newId) loadPreview(newId);
                  }}
                >
                  {/* Header row */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
                      {item.file_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatFileSize(item.file_size)}
                    </Typography>
                    {item.confidence_score != null && (
                      <Chip
                        label={`${Math.round(item.confidence_score * 100)}%`}
                        size="small"
                        color={confidenceColor(item.confidence_score)}
                        variant="outlined"
                      />
                    )}
                    <Chip
                      label={item.status}
                      size="small"
                      color={item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'error' : 'default'}
                      variant="outlined"
                      sx={{ textTransform: 'capitalize' }}
                    />
                    {item.template_id && (
                      <Chip label="Template matched" color="info" size="small" sx={{ ml: 0.5 }} />
                    )}
                    {item.auto_ingested === 1 && (
                      <Chip label="Auto-ingested" color="success" size="small" sx={{ ml: 0.5 }} />
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(item.created_at)}
                    </Typography>
                    <ExpandMoreIcon
                      sx={{
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                        color: 'text.secondary',
                      }}
                    />
                  </Box>
                </CardContent>

                {isExpanded && (
                  <Box sx={{ px: 2, pb: 2 }}>
                    <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' }, mb: 2 }}>
                      {/* File preview */}
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        {previewLoading[item.id] ? (
                          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 300 }}>
                            <CircularProgress />
                          </Box>
                        ) : previewUrls[item.id] ? (
                          item.mime_type === 'application/pdf' ? (
                            <Box sx={{ minHeight: 400, height: '100%' }}>
                              <PdfViewer url={previewUrls[item.id]} fileName={item.file_name} />
                            </Box>
                          ) : item.mime_type.startsWith('image/') ? (
                            <Box sx={{ display: 'flex', justifyContent: 'center', p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
                              <img
                                src={previewUrls[item.id]}
                                alt={item.file_name}
                                style={{ maxWidth: '100%', maxHeight: 500, objectFit: 'contain', borderRadius: 4 }}
                              />
                            </Box>
                          ) : (
                            <Paper
                              variant="outlined"
                              sx={{
                                p: 3,
                                height: '100%',
                                minHeight: 200,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                bgcolor: 'grey.50',
                              }}
                            >
                              <FileIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.5, mb: 1 }} />
                              <Typography variant="body2" color="text.secondary">
                                Preview not available for this file type
                              </Typography>
                            </Paper>
                          )
                        ) : (
                          <Paper
                            variant="outlined"
                            sx={{
                              p: 3,
                              height: '100%',
                              minHeight: 200,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              bgcolor: 'grey.50',
                            }}
                          >
                            <FileIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.5, mb: 1 }} />
                            <Typography variant="body2" color="text.secondary">
                              Preview unavailable
                            </Typography>
                          </Paper>
                        )}
                      </Box>

                      {/* Fields column */}
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        {/* Extracted text preview */}
                        {item.extracted_text && (
                          <Accordion variant="outlined" sx={{ mb: 2 }}>
                            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                              <Typography variant="body2" color="text.secondary">
                                Extracted text
                              </Typography>
                            </AccordionSummary>
                            <AccordionDetails>
                              <Typography
                                variant="body2"
                                sx={{
                                  whiteSpace: 'pre-wrap',
                                  fontFamily: 'monospace',
                                  fontSize: '0.75rem',
                                  maxHeight: 200,
                                  overflow: 'auto',
                                  bgcolor: 'action.hover',
                                  p: 1.5,
                                  borderRadius: 1,
                                }}
                              >
                                {item.extracted_text}
                              </Typography>
                            </AccordionDetails>
                          </Accordion>
                        )}

                        {/* Editable fields */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                          {Object.entries(fields).map(([fieldName, fieldValue]) => (
                            <TextField
                              key={fieldName}
                              label={fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                              value={fieldValue}
                              onChange={(e) => updateField(item.id, fieldName, e.target.value)}
                              size="small"
                              fullWidth
                              disabled={item.status !== 'pending' || isActioning}
                            />
                          ))}

                          <TextField
                            label="Product Name"
                            value={productNames[item.id] || ''}
                            onChange={(e) => updateProductName(item.id, e.target.value)}
                            size="small"
                            fullWidth
                            disabled={item.status !== 'pending' || isActioning}
                            helperText="Will be looked up or created automatically"
                          />
                        </Box>
                      </Box>
                    </Box>

                    {/* Action buttons */}
                    {item.status === 'pending' && (
                      <CardActions sx={{ px: 0, pt: 0 }}>
                        <Button
                          variant="contained"
                          color="success"
                          size="small"
                          onClick={(e) => { e.stopPropagation(); handleApprove(item.id); }}
                          disabled={isActioning}
                          startIcon={isActioning ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="outlined"
                          color="error"
                          size="small"
                          onClick={(e) => { e.stopPropagation(); handleReject(item.id); }}
                          disabled={isActioning}
                          startIcon={<CancelIcon />}
                        >
                          Reject
                        </Button>
                      </CardActions>
                    )}
                  </Box>
                )}
              </Card>
            );
          })}
        </Box>
      )}

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        message={snackbar.message}
      />
    </Box>
  );
}
