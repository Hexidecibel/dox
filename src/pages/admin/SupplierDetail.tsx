import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  Tab,
  Tabs,
  Switch,
  FormControlLabel,
  Select,
  MenuItem,
  Checkbox,
  Slider,
  Divider,
} from '@mui/material';
import {
  Edit as EditIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  ArrowBack as BackIcon,
  Add as AddIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSupplier, ApiProduct, ExtractionTemplate, TemplateFieldMapping } from '../../lib/types';
import type { Document } from '../../lib/types';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ pt: 2 }}>
      {value === index && children}
    </Box>
  );
}

export function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState<ApiSupplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(0);

  // Edit header state
  const [editingHeader, setEditingHeader] = useState(false);
  const [headerName, setHeaderName] = useState('');
  const [headerAliases, setHeaderAliases] = useState('');
  const [savingHeader, setSavingHeader] = useState(false);

  // Products state
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [savingProduct, setSavingProduct] = useState(false);

  // Templates state
  const [templates, setTemplates] = useState<ExtractionTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ExtractionTemplate | null>(null);
  const [templateFieldMappings, setTemplateFieldMappings] = useState<TemplateFieldMapping[]>([]);
  const [templateSampleData, setTemplateSampleData] = useState<Record<string, string>>({});
  const [templateAutoIngest, setTemplateAutoIngest] = useState(false);
  const [templateConfidence, setTemplateConfidence] = useState(0.85);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Documents state
  const [documents, setDocuments] = useState<Document[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsTotal, setDocumentsTotal] = useState(0);

  const parseAliases = (aliases: string | string[] | null): string[] => {
    if (!aliases) return [];
    if (Array.isArray(aliases)) return aliases;
    try {
      const parsed = JSON.parse(aliases);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return String(aliases).split(',').map(a => a.trim()).filter(Boolean);
    }
  };

  const loadSupplier = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.suppliers.get(id);
      setSupplier(result.supplier);
      setHeaderName(result.supplier.name);
      setHeaderAliases(parseAliases(result.supplier.aliases).join(', '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadProducts = useCallback(async () => {
    if (!id) return;
    setProductsLoading(true);
    try {
      const result = await api.products.list({ supplier_id: id });
      setProducts(result.products);
    } catch {
      // Products may not support supplier_id filter yet; silently fail
      setProducts([]);
    } finally {
      setProductsLoading(false);
    }
  }, [id]);

  const loadTemplates = useCallback(async () => {
    if (!id) return;
    setTemplatesLoading(true);
    try {
      const result = await api.extractionTemplates.list({ supplier_id: id });
      setTemplates(result.templates);
    } catch {
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  }, [id]);

  const loadDocuments = useCallback(async () => {
    if (!id) return;
    setDocumentsLoading(true);
    try {
      const result = await api.documents.list({ supplier_id: id, limit: 50 });
      setDocuments(result.documents);
      setDocumentsTotal(result.total);
    } catch {
      setDocuments([]);
    } finally {
      setDocumentsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadSupplier();
  }, [loadSupplier]);

  useEffect(() => {
    if (tab === 0) loadProducts();
    else if (tab === 1) loadTemplates();
    else if (tab === 2) loadDocuments();
  }, [tab, loadProducts, loadTemplates, loadDocuments]);

  const handleSaveHeader = async () => {
    if (!id || !supplier) return;
    setSavingHeader(true);
    setError('');
    try {
      const aliasArray = headerAliases.trim()
        ? headerAliases.split(',').map(a => a.trim()).filter(Boolean)
        : [];
      const result = await api.suppliers.update(id, {
        name: headerName.trim(),
        aliases: aliasArray,
      });
      setSupplier(result.supplier);
      setEditingHeader(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update supplier');
    } finally {
      setSavingHeader(false);
    }
  };

  const handleToggleActive = async () => {
    if (!id || !supplier) return;
    try {
      const result = await api.suppliers.update(id, { active: !supplier.active });
      setSupplier(result.supplier);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update supplier');
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!confirm('Are you sure you want to deactivate this supplier?')) return;
    try {
      await api.suppliers.delete(id);
      navigate('/admin/suppliers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete supplier');
    }
  };

  const handleCreateProduct = async () => {
    if (!supplier) return;
    setSavingProduct(true);
    try {
      await api.products.create({
        name: productName.trim(),
        description: productDescription.trim() || undefined,
        tenant_id: supplier.tenant_id,
      });
      setProductDialogOpen(false);
      setProductName('');
      setProductDescription('');
      loadProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setSavingProduct(false);
    }
  };

  const openEditTemplate = async (template: ExtractionTemplate) => {
    if (!supplier) return;
    setEditingTemplate(template);
    setTemplateFieldMappings([...template.field_mappings]);
    setTemplateAutoIngest(!!template.auto_ingest_enabled);
    setTemplateConfidence(template.confidence_threshold);
    setTemplateSampleData({});

    // Fetch sample data from most recent approved queue item for this template
    try {
      const result = await api.queue.list({
        tenant_id: supplier.tenant_id,
        status: 'approved',
        document_type_id: template.document_type_id,
        limit: 5,
      });
      const items = result.items || [];
      // Find one that matches this supplier
      const match = items.find((item: any) =>
        item.supplier?.toLowerCase() === supplier.name.toLowerCase() ||
        item.template_id === template.id
      ) || items[0];

      if (match?.ai_fields) {
        try {
          const parsed = typeof match.ai_fields === 'string' ? JSON.parse(match.ai_fields) : match.ai_fields;
          const sample: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (v != null) sample[k] = String(v);
          }
          setTemplateSampleData(sample);
        } catch { /* ignore parse errors */ }
      }
    } catch { /* non-critical */ }
  };

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return;
    setSavingTemplate(true);
    try {
      await api.extractionTemplates.update(editingTemplate.id, {
        field_mappings: templateFieldMappings,
        auto_ingest_enabled: templateAutoIngest,
        confidence_threshold: templateConfidence,
      });
      setEditingTemplate(null);
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (templateId: string) => {
    if (!confirm('Delete this extraction template?')) return;
    try {
      await api.extractionTemplates.delete(templateId);
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!supplier) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">Supplier not found</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/admin/suppliers')} sx={{ mt: 2 }}>
          Back to Suppliers
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Back button */}
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/suppliers')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Suppliers
      </Button>

      <HelpWell id="suppliers.detail" title={helpContent.suppliers.detail?.headline ?? 'Supplier detail'}>
        {helpContent.suppliers.detail?.well ?? helpContent.suppliers.well}
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Header */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        {editingHeader ? (
          <Box>
            <TextField
              label="Name"
              fullWidth
              value={headerName}
              onChange={(e) => setHeaderName(e.target.value)}
              disabled={savingHeader}
              sx={{ mb: 2 }}
            />
            <TextField
              label="Aliases"
              fullWidth
              value={headerAliases}
              onChange={(e) => setHeaderAliases(e.target.value)}
              disabled={savingHeader}
              helperText="Comma-separated alternate names"
              sx={{ mb: 2 }}
            />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleSaveHeader}
                disabled={!headerName.trim() || savingHeader}
              >
                {savingHeader ? 'Saving...' : 'Save'}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setEditingHeader(false);
                  setHeaderName(supplier.name);
                  setHeaderAliases(parseAliases(supplier.aliases).join(', '));
                }}
                disabled={savingHeader}
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
                  {supplier.name}
                </Typography>
                <Chip
                  label={supplier.active ? 'Active' : 'Inactive'}
                  size="small"
                  color={supplier.active ? 'success' : 'default'}
                  variant="outlined"
                />
              </Box>
              {parseAliases(supplier.aliases).length > 0 && (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>
                    Aliases:
                  </Typography>
                  {parseAliases(supplier.aliases).map((alias) => (
                    <Chip key={alias} label={alias} size="small" variant="outlined" />
                  ))}
                </Box>
              )}
              <Typography variant="body2" color="text.secondary">
                Created {formatDate(supplier.created_at)}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Tooltip title="Edit">
                <IconButton onClick={() => setEditingHeader(true)}>
                  <EditIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title={supplier.active ? 'Deactivate' : 'Activate'}>
                <IconButton onClick={handleToggleActive}>
                  {supplier.active ? (
                    <BlockIcon color="warning" />
                  ) : (
                    <ActiveIcon color="success" />
                  )}
                </IconButton>
              </Tooltip>
              <Tooltip title="Delete">
                <IconButton color="error" onClick={handleDelete}>
                  <DeleteIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Products" />
          <Tab label="Templates" />
          <Tab label={`Documents${documentsTotal ? ` (${documentsTotal})` : ''}`} />
        </Tabs>
      </Box>

      {/* Products Tab */}
      <TabPanel value={tab} index={0}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" fontWeight={600}>Products</Typography>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={() => setProductDialogOpen(true)}>
            Add Product
          </Button>
        </Box>

        {productsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : products.length === 0 ? (
          <EmptyState
            title="No products linked to this supplier"
            description="Products show up here when they're created against this supplier from the Products page or via connector ingest. Add one to keep the catalog tied to the right vendor."
            actionLabel="Add product"
            onAction={() => setProductDialogOpen(true)}
          />
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>{product.name}</Typography>
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {/* Create Product Dialog */}
        <Dialog open={productDialogOpen} onClose={() => setProductDialogOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            Add Product
            <IconButton onClick={() => setProductDialogOpen(false)} size="small">
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <TextField
              label="Name"
              fullWidth
              required
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              disabled={savingProduct}
              autoFocus
              sx={{ mt: 1, mb: 2 }}
            />
            <TextField
              label="Description"
              fullWidth
              multiline
              rows={3}
              value={productDescription}
              onChange={(e) => setProductDescription(e.target.value)}
              disabled={savingProduct}
            />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setProductDialogOpen(false)} disabled={savingProduct}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleCreateProduct}
              disabled={!productName.trim() || savingProduct}
            >
              {savingProduct ? 'Saving...' : 'Add Product'}
            </Button>
          </DialogActions>
        </Dialog>
      </TabPanel>

      {/* Templates Tab */}
      <TabPanel value={tab} index={1}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" fontWeight={600}>Extraction Templates</Typography>
        </Box>

        {templatesLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : templates.length === 0 ? (
          <EmptyState
            title="No extraction templates yet"
            description="Templates are saved supplier+doc-type field mappings that the AI uses to auto-extract from future docs. They're created from the Review Queue after you correct an AI extraction. Process a doc from this supplier and the option to save a template will appear."
          />
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Document Type</TableCell>
                  <TableCell align="center">Fields</TableCell>
                  <TableCell align="center">Auto-Ingest</TableCell>
                  <TableCell align="center">Confidence</TableCell>
                  <TableCell>Updated</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {template.document_type_name || template.document_type_id}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">
                      <Chip label={template.field_mappings.length} size="small" />
                    </TableCell>
                    <TableCell align="center">
                      <Chip
                        label={template.auto_ingest_enabled ? 'On' : 'Off'}
                        size="small"
                        color={template.auto_ingest_enabled ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="center">
                      <Typography variant="body2">
                        {Math.round(template.confidence_threshold * 100)}%
                      </Typography>
                    </TableCell>
                    <TableCell>{formatDate(template.updated_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEditTemplate(template)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" onClick={() => handleDeleteTemplate(template.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {/* Edit Template Dialog */}
        <Dialog
          open={!!editingTemplate}
          onClose={() => setEditingTemplate(null)}
          maxWidth="md"
          fullWidth
        >
          {editingTemplate && (
            <>
              <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                Edit Template
                <IconButton onClick={() => setEditingTemplate(null)} size="small">
                  <CloseIcon />
                </IconButton>
              </DialogTitle>
              <DialogContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {editingTemplate.document_type_name || 'Template'} for {supplier.name}
                </Typography>

                {/* Field Mappings */}
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  Fields to extract
                </Typography>
                {Object.keys(templateSampleData).length > 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                    Sample values from most recent processed document
                  </Typography>
                )}

                <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Field</TableCell>
                        <TableCell>Sample Value</TableCell>
                        <TableCell>Tier</TableCell>
                        <TableCell align="center">Required</TableCell>
                        <TableCell align="center">Remove</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {templateFieldMappings.map((mapping, i) => (
                        <TableRow key={mapping.field_key}>
                          <TableCell>
                            <Typography variant="body2">
                              {mapping.field_key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                            </Typography>
                            {mapping.aliases && mapping.aliases.length > 0 && (
                              <Typography variant="caption" color="text.secondary">
                                aliases: {mapping.aliases.join(', ')}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" color={templateSampleData[mapping.field_key] ? 'text.primary' : 'text.disabled'} sx={{
                              maxWidth: 180,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                            }}>
                              {templateSampleData[mapping.field_key] ||
                                (mapping.aliases || []).map(a => templateSampleData[a]).find(v => v) ||
                                '—'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Select
                              size="small"
                              value={mapping.tier}
                              onChange={(e) => {
                                const updated = [...templateFieldMappings];
                                updated[i] = { ...updated[i], tier: e.target.value as 'primary' | 'extended' | 'product_name' };
                                setTemplateFieldMappings(updated);
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
                                const updated = [...templateFieldMappings];
                                updated[i] = { ...updated[i], required: e.target.checked };
                                setTemplateFieldMappings(updated);
                              }}
                            />
                          </TableCell>
                          <TableCell align="center">
                            <IconButton
                              size="small"
                              onClick={() => {
                                setTemplateFieldMappings(templateFieldMappings.filter((_, j) => j !== i));
                              }}
                            >
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                      {templateFieldMappings.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} sx={{ textAlign: 'center', py: 2 }}>
                            <Typography variant="body2" color="text.secondary">No fields</Typography>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>

                {/* Auto-ingest settings */}
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Auto-ingest
                </Typography>

                <FormControlLabel
                  control={
                    <Switch
                      checked={templateAutoIngest}
                      onChange={(e) => setTemplateAutoIngest(e.target.checked)}
                    />
                  }
                  label="Enable auto-ingest"
                />

                {templateAutoIngest && (
                  <Box sx={{ mt: 1, px: 1 }}>
                    <Typography variant="body2" gutterBottom>
                      Confidence threshold: {Math.round(templateConfidence * 100)}%
                    </Typography>
                    <Slider
                      value={templateConfidence}
                      onChange={(_, value) => setTemplateConfidence(value as number)}
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
              <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={() => setEditingTemplate(null)} disabled={savingTemplate}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={handleSaveTemplate}
                  disabled={savingTemplate}
                >
                  {savingTemplate ? 'Saving...' : 'Save Changes'}
                </Button>
              </DialogActions>
            </>
          )}
        </Dialog>
      </TabPanel>

      {/* Documents Tab */}
      <TabPanel value={tab} index={2}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" fontWeight={600}>
            Documents{documentsTotal > 0 ? ` (${documentsTotal})` : ''}
          </Typography>
        </Box>

        {documentsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : documents.length === 0 ? (
          <EmptyState
            title="No documents from this supplier yet"
            description="Documents land here once the AI pipeline tags them with this supplier_id (matched against the supplier name + aliases). Check that the supplier's aliases cover every variant name that appears on incoming COAs."
          />
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Title</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Version</TableCell>
                  <TableCell>Updated</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {documents.map((doc) => (
                  <TableRow
                    key={doc.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/documents/${doc.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} color="primary">
                        {doc.title}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {doc.documentTypeName || doc.category || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={doc.status}
                        size="small"
                        color={doc.status === 'active' ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">v{doc.current_version}</Typography>
                    </TableCell>
                    <TableCell>{formatDate(doc.updated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </TabPanel>
    </Box>
  );
}
