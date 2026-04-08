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
  Autocomplete,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  Slider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Divider,
  IconButton,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  CheckCircle as CheckIcon,
  Cancel as CancelIcon,
  InsertDriveFile as FileIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import PdfViewer from '../components/PdfViewer';
import { AUTH_TOKEN_KEY } from '../lib/types';
import { api } from '../lib/api';
import type { ProcessingQueueItem, ApiDocumentType, TemplateFieldMapping, ExtractedTable } from '../lib/types';
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
  const [dismissedFields, setDismissedFields] = useState<Record<string, Set<string>>>({});
  const [excludedTables, setExcludedTables] = useState<Record<string, Set<number>>>({});
  const [editedTables, setEditedTables] = useState<Record<string, ExtractedTable[]>>({});
  const blobUrlsRef = useRef<Record<string, string>>({});

  const [showAutoIngestedOnly, setShowAutoIngestedOnly] = useState(false);

  // Product autocomplete
  const [productOptions, setProductOptions] = useState<string[]>([]);
  const productSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchProducts = useCallback((query: string) => {
    if (productSearchRef.current) clearTimeout(productSearchRef.current);
    if (!query || query.length < 2) {
      setProductOptions([]);
      return;
    }
    productSearchRef.current = setTimeout(async () => {
      try {
        const tenantId = isSuperAdmin ? (tenantFilter || selectedTenantId || '') : (selectedTenantId || '');
        const result = await api.products.list({ search: query, tenant_id: tenantId, active: 1, limit: 10 });
        setProductOptions((result.products || []).map((p: any) => p.name));
      } catch {
        setProductOptions([]);
      }
    }, 300);
  }, [isSuperAdmin, tenantFilter, selectedTenantId]);

  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Template dialog state
  const [templateDialog, setTemplateDialog] = useState<{
    open: boolean;
    itemId: string;
    supplierName: string;
    supplierId: string | null;
    docTypeName: string;
    docTypeId: string | null;
    fieldMappings: TemplateFieldMapping[];
    autoIngestEnabled: boolean;
    confidenceThreshold: number;
  } | null>(null);

  // Suppliers list (for template dialog autocomplete)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);

  // Resolve effective tenant ID
  const effectiveTenantId = isSuperAdmin ? (tenantFilter || selectedTenantId || '') : (selectedTenantId || '');

  // Load suppliers for template dialog
  useEffect(() => {
    const loadSuppliers = async () => {
      try {
        const data = await api.suppliers.list({ tenant_id: effectiveTenantId });
        setSuppliers((data.suppliers || []).map((s: any) => ({ id: s.id, name: s.name })));
      } catch { /* non-critical */ }
    };
    if (effectiveTenantId) loadSuppliers();
  }, [effectiveTenantId]);

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
      // Initialize edited tables
      const tables: Record<string, ExtractedTable[]> = {};
      for (const item of (result.items || [])) {
        if (item.tables) {
          try {
            tables[item.id] = typeof item.tables === 'string' ? JSON.parse(item.tables) : item.tables;
          } catch {
            tables[item.id] = [];
          }
        }
      }
      setEditedTables(tables);
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
      const item = items.find(i => i.id === id);

      // Use edited fields, falling back to AI fields
      let fields = editedFields[id];
      if (!fields || Object.keys(fields).length === 0) {
        if (item?.ai_fields) {
          try {
            const parsed = typeof item.ai_fields === 'string' ? JSON.parse(item.ai_fields) : item.ai_fields;
            fields = Object.fromEntries(
              Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')])
            );
          } catch { fields = {}; }
        } else {
          fields = {};
        }
      }

      // Use product name, falling back to AI detection
      let productName = productNames[id];
      if (!productName && item?.product_names) {
        try {
          const products = typeof item.product_names === 'string' ? JSON.parse(item.product_names) : item.product_names;
          if (Array.isArray(products) && products.length > 0) {
            productName = products[0];
          }
        } catch { /* ignore */ }
      }

      // Remove dismissed fields before sending
      const primaryFields = { ...fields };
      const dismissed = dismissedFields[id];
      if (dismissed) {
        for (const key of dismissed) {
          delete primaryFields[key];
        }
      }

      await api.queue.approve(id, {
        fields: primaryFields,
        product_name: productName || undefined,
      });
      setSnackbar({ open: true, message: 'Item approved and imported', severity: 'success' });

      // Prompt to save template if no template existed
      if (item && !item.template_id && item.supplier && item.document_type_id) {
        const mappings: TemplateFieldMapping[] = Object.keys(fields).map((key, i) => ({
          field_key: key,
          tier: 'primary' as const,
          display_order: i,
          required: ['lot_number', 'supplier_name', 'product_name'].includes(key),
        }));

        const docType = documentTypes.find((dt: any) => dt.id === item.document_type_id);

        setTemplateDialog({
          open: true,
          itemId: item.id,
          supplierName: item.supplier || '',
          supplierId: null,
          docTypeName: docType?.name || (item as any).document_type_guess || '',
          docTypeId: item.document_type_id || null,
          fieldMappings: mappings,
          autoIngestEnabled: false,
          confidenceThreshold: 0.85,
        });
      }

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

  const dismissField = (itemId: string, fieldKey: string) => {
    setDismissedFields(prev => {
      const current = new Set(prev[itemId] || []);
      current.add(fieldKey);
      return { ...prev, [itemId]: current };
    });
  };

  const restoreField = (itemId: string, fieldKey: string) => {
    setDismissedFields(prev => {
      const current = new Set(prev[itemId] || []);
      current.delete(fieldKey);
      return { ...prev, [itemId]: current };
    });
  };

  const parseTables = (itemId: string): ExtractedTable[] => {
    const item = items.find(i => i.id === itemId);
    if (!item?.tables) return [];
    try {
      return typeof item.tables === 'string' ? JSON.parse(item.tables) : item.tables;
    } catch { return []; }
  };

  const toggleTable = (itemId: string, tableIndex: number) => {
    setExcludedTables(prev => {
      const current = new Set(prev[itemId] || []);
      if (current.has(tableIndex)) {
        current.delete(tableIndex);
      } else {
        current.add(tableIndex);
      }
      return { ...prev, [itemId]: current };
    });
  };

  const getTableCell = (itemId: string, tableIdx: number, rowIdx: number, cellIdx: number): string => {
    const edited = editedTables[itemId];
    if (edited && edited[tableIdx]?.rows[rowIdx]?.[cellIdx] !== undefined) {
      return edited[tableIdx].rows[rowIdx][cellIdx];
    }
    const item = items.find(i => i.id === itemId);
    if (!item?.tables) return '';
    try {
      const tables = typeof item.tables === 'string' ? JSON.parse(item.tables) : item.tables;
      return tables[tableIdx]?.rows[rowIdx]?.[cellIdx] || '';
    } catch { return ''; }
  };

  const updateTableCell = (itemId: string, tableIdx: number, rowIdx: number, cellIdx: number, value: string) => {
    setEditedTables(prev => {
      const itemTables = prev[itemId] ? prev[itemId].map(t => ({ ...t, rows: t.rows.map(r => [...r]) })) : parseTables(itemId);
      if (itemTables[tableIdx]) {
        itemTables[tableIdx].rows[rowIdx][cellIdx] = value;
      }
      return { ...prev, [itemId]: itemTables };
    });
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
            const isProcessing = item.processing_status !== 'ready';

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
                    {isProcessing && (
                      <Chip
                        icon={item.processing_status === 'processing' ? <CircularProgress size={14} /> : undefined}
                        label={item.processing_status === 'queued' ? 'Queued' : 'Processing...'}
                        color="default"
                        size="small"
                        sx={{ ml: 0.5 }}
                      />
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
                          {Object.entries(fields)
                            .filter(([key]) => !dismissedFields[item.id]?.has(key))
                            .map(([fieldName, fieldValue]) => (
                            <Box key={fieldName} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                              <TextField
                                label={fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                value={fieldValue}
                                onChange={(e) => updateField(item.id, fieldName, e.target.value)}
                                size="small"
                                fullWidth
                                disabled={item.status !== 'pending' || isActioning || isProcessing}
                              />
                              <IconButton
                                size="small"
                                onClick={() => dismissField(item.id, fieldName)}
                                disabled={item.status !== 'pending' || isActioning || isProcessing}
                                title="Move to extended metadata"
                              >
                                <CloseIcon fontSize="small" />
                              </IconButton>
                            </Box>
                          ))}

                          {dismissedFields[item.id]?.size > 0 && (
                            <Box sx={{ mt: 1 }}>
                              <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
                                Dismissed (not stored as primary metadata)
                              </Typography>
                              <Box sx={{ pl: 1, borderLeft: '2px solid', borderColor: 'divider' }}>
                                {Array.from(dismissedFields[item.id] || []).map(key => (
                                  <Box key={key} sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.5 }}>
                                    <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                                      {key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: {editedFields[item.id]?.[key] || ''}
                                    </Typography>
                                    <Button
                                      size="small"
                                      onClick={() => restoreField(item.id, key)}
                                      disabled={item.status !== 'pending' || isActioning || isProcessing}
                                    >
                                      Restore
                                    </Button>
                                  </Box>
                                ))}
                              </Box>
                            </Box>
                          )}

                          <Autocomplete
                            freeSolo
                            options={productOptions}
                            value={productNames[item.id] || ''}
                            onInputChange={(_, value) => {
                              updateProductName(item.id, value);
                              searchProducts(value);
                            }}
                            onChange={(_, value) => {
                              updateProductName(item.id, value || '');
                            }}
                            disabled={item.status !== 'pending' || isActioning || isProcessing}
                            renderInput={(params) => (
                              <TextField
                                {...params}
                                label="Product Name"
                                size="small"
                                fullWidth
                                helperText="Type to search existing products, or enter a new name"
                              />
                            )}
                          />
                        </Box>

                        {/* Tables Section */}
                        {(() => {
                          const tables = editedTables[item.id] || parseTables(item.id);
                          return tables.length > 0 ? (
                            <Box sx={{ mt: 2 }}>
                              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                Extracted Tables ({tables.length})
                              </Typography>
                              {tables.map((table, tableIndex) => (
                                <Accordion key={tableIndex} variant="outlined" sx={{ mb: 1 }}>
                                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                                      <Typography variant="body2" fontWeight={600}>
                                        {table.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                      </Typography>
                                      <Chip label={`${table.rows.length} rows`} size="small" />
                                      <Box sx={{ flex: 1 }} />
                                      <Switch
                                        size="small"
                                        checked={!excludedTables[item.id]?.has(tableIndex)}
                                        onChange={(e) => {
                                          e.stopPropagation();
                                          toggleTable(item.id, tableIndex);
                                        }}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                      <Typography variant="caption" color="text.secondary">
                                        {excludedTables[item.id]?.has(tableIndex) ? 'Excluded' : 'Included'}
                                      </Typography>
                                    </Box>
                                  </AccordionSummary>
                                  <AccordionDetails>
                                    <TableContainer>
                                      <Table size="small">
                                        <TableHead>
                                          <TableRow>
                                            {table.headers.map((h, i) => (
                                              <TableCell key={i} sx={{ fontWeight: 600 }}>
                                                {h.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                              </TableCell>
                                            ))}
                                          </TableRow>
                                        </TableHead>
                                        <TableBody>
                                          {table.rows.map((row, rowIdx) => (
                                            <TableRow key={rowIdx}>
                                              {row.map((_cell, cellIdx) => (
                                                <TableCell key={cellIdx}>
                                                  <TextField
                                                    value={getTableCell(item.id, tableIndex, rowIdx, cellIdx)}
                                                    onChange={(e) => updateTableCell(item.id, tableIndex, rowIdx, cellIdx, e.target.value)}
                                                    size="small"
                                                    variant="standard"
                                                    fullWidth
                                                    disabled={item.status !== 'pending' || excludedTables[item.id]?.has(tableIndex)}
                                                    InputProps={{ disableUnderline: item.status !== 'pending' }}
                                                  />
                                                </TableCell>
                                              ))}
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </TableContainer>
                                  </AccordionDetails>
                                </Accordion>
                              ))}
                            </Box>
                          ) : null;
                        })()}
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
                          disabled={isActioning || isProcessing}
                          startIcon={isActioning ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="outlined"
                          color="error"
                          size="small"
                          onClick={(e) => { e.stopPropagation(); handleReject(item.id); }}
                          disabled={isActioning || isProcessing}
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

      {/* Save Template Dialog */}
      <Dialog
        open={!!templateDialog}
        onClose={() => setTemplateDialog(null)}
        maxWidth="sm"
        fullWidth
      >
        {templateDialog && (
          <>
            <DialogTitle>Save Extraction Template</DialogTitle>
            <DialogContent>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Templates remember which fields matter for a supplier + document type combination.
                Future documents that match will have fields pre-mapped automatically, and can
                optionally be ingested without manual review.
              </Typography>

              {/* Supplier */}
              <Autocomplete
                freeSolo
                options={suppliers.map(s => s.name)}
                value={templateDialog.supplierName}
                onChange={(_, value) => {
                  const match = suppliers.find(s => s.name === value);
                  setTemplateDialog(prev => prev ? {
                    ...prev,
                    supplierName: (value as string) || '',
                    supplierId: match?.id || null,
                  } : null);
                }}
                onInputChange={(_, value) => {
                  setTemplateDialog(prev => prev ? {
                    ...prev,
                    supplierName: value,
                    supplierId: suppliers.find(s => s.name === value)?.id || null,
                  } : null);
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Supplier"
                    helperText={templateDialog.supplierId ? 'Existing supplier' : 'Will be created'}
                    fullWidth
                    margin="normal"
                  />
                )}
              />

              {/* Document Type */}
              <Autocomplete
                freeSolo
                options={documentTypes.map(dt => dt.name)}
                value={templateDialog.docTypeName}
                onChange={(_, value) => {
                  const match = documentTypes.find(dt => dt.name === value);
                  setTemplateDialog(prev => prev ? {
                    ...prev,
                    docTypeName: (value as string) || '',
                    docTypeId: match?.id || null,
                  } : null);
                }}
                onInputChange={(_, value) => {
                  setTemplateDialog(prev => prev ? {
                    ...prev,
                    docTypeName: value,
                    docTypeId: documentTypes.find(dt => dt.name === value)?.id || null,
                  } : null);
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Document Type"
                    helperText={templateDialog.docTypeId ? 'Existing type' : 'Will be created'}
                    fullWidth
                    margin="normal"
                  />
                )}
              />

              {/* Field Mappings */}
              <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                Fields to extract
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                These fields will be automatically mapped when documents from this supplier are processed.
                Required fields must be present for auto-ingest to work.
              </Typography>

              <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Field</TableCell>
                      <TableCell>Tier</TableCell>
                      <TableCell align="center">Required</TableCell>
                      <TableCell align="center">Remove</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {templateDialog.fieldMappings.map((mapping, i) => (
                      <TableRow key={mapping.field_key}>
                        <TableCell>
                          <Typography variant="body2">
                            {mapping.field_key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Select
                            size="small"
                            value={mapping.tier}
                            onChange={(e) => {
                              setTemplateDialog(prev => {
                                if (!prev) return null;
                                const updated = [...prev.fieldMappings];
                                updated[i] = { ...updated[i], tier: e.target.value as 'primary' | 'extended' | 'product_name' };
                                return { ...prev, fieldMappings: updated };
                              });
                            }}
                          >
                            <MenuItem value="primary">Primary</MenuItem>
                            <MenuItem value="extended">Extended</MenuItem>
                            <MenuItem value="product_name">Product Name</MenuItem>
                          </Select>
                        </TableCell>
                        <TableCell align="center">
                          <Checkbox
                            size="small"
                            checked={mapping.required}
                            onChange={(e) => {
                              setTemplateDialog(prev => {
                                if (!prev) return null;
                                const updated = [...prev.fieldMappings];
                                updated[i] = { ...updated[i], required: e.target.checked };
                                return { ...prev, fieldMappings: updated };
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell align="center">
                          <IconButton
                            size="small"
                            onClick={() => {
                              setTemplateDialog(prev => {
                                if (!prev) return null;
                                return { ...prev, fieldMappings: prev.fieldMappings.filter((_, j) => j !== i) };
                              });
                            }}
                          >
                            <CloseIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {/* Auto-ingest settings */}
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Auto-ingest
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                When enabled, documents that match this template with high enough confidence
                will be ingested automatically — no manual review needed.
              </Typography>

              <FormControlLabel
                control={
                  <Switch
                    checked={templateDialog.autoIngestEnabled}
                    onChange={(e) => setTemplateDialog(prev => prev ? { ...prev, autoIngestEnabled: e.target.checked } : null)}
                  />
                }
                label="Enable auto-ingest"
              />

              {templateDialog.autoIngestEnabled && (
                <Box sx={{ mt: 1, px: 1 }}>
                  <Typography variant="body2" gutterBottom>
                    Confidence threshold: {Math.round(templateDialog.confidenceThreshold * 100)}%
                  </Typography>
                  <Slider
                    value={templateDialog.confidenceThreshold}
                    onChange={(_, value) => setTemplateDialog(prev => prev ? { ...prev, confidenceThreshold: value as number } : null)}
                    min={0.5}
                    max={1.0}
                    step={0.05}
                    marks={[
                      { value: 0.5, label: '50%' },
                      { value: 0.7, label: '70%' },
                      { value: 0.85, label: '85%' },
                      { value: 1.0, label: '100%' },
                    ]}
                  />
                </Box>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setTemplateDialog(null)}>
                Skip
              </Button>
              <Button
                variant="contained"
                disabled={!templateDialog.supplierName.trim() || !templateDialog.docTypeName.trim() || templateDialog.fieldMappings.length === 0}
                onClick={async () => {
                  if (!templateDialog) return;

                  try {
                    // Resolve or create supplier
                    let supplierId = templateDialog.supplierId;
                    if (!supplierId && templateDialog.supplierName.trim()) {
                      const { supplier } = await api.suppliers.lookupOrCreate({
                        name: templateDialog.supplierName.trim(),
                        tenant_id: effectiveTenantId,
                      });
                      supplierId = supplier.id;
                    }

                    // Resolve or create doc type
                    let docTypeId = templateDialog.docTypeId;
                    if (!docTypeId && templateDialog.docTypeName.trim()) {
                      const { documentType } = await api.documentTypes.create({
                        name: templateDialog.docTypeName.trim(),
                        tenant_id: effectiveTenantId || undefined,
                      });
                      docTypeId = documentType.id;
                    }

                    if (!supplierId || !docTypeId) {
                      throw new Error('Could not resolve supplier or document type');
                    }

                    // Create the template
                    await api.extractionTemplates.create({
                      tenant_id: effectiveTenantId || undefined,
                      supplier_id: supplierId,
                      document_type_id: docTypeId,
                      field_mappings: templateDialog.fieldMappings,
                      auto_ingest_enabled: templateDialog.autoIngestEnabled,
                      confidence_threshold: templateDialog.confidenceThreshold,
                    });

                    setSnackbar({ open: true, message: 'Template saved! Future documents from this supplier will be auto-mapped.', severity: 'success' });
                    setTemplateDialog(null);
                  } catch (err) {
                    setSnackbar({ open: true, message: err instanceof Error ? err.message : 'Failed to save template', severity: 'error' });
                  }
                }}
              >
                Save Template
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
