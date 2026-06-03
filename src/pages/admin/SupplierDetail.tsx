import { useState, useEffect, useCallback, Fragment } from 'react';
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
  Collapse,
} from '@mui/material';
import {
  Edit as EditIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  ArrowBack as BackIcon,
  Add as AddIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  School as TeachIcon,
  KeyboardArrowDown as ExpandMoreIcon,
  KeyboardArrowRight as ExpandRightIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiSupplier, ApiProduct, ExtractionTemplate, TemplateFieldMapping } from '../../lib/types';
import type { Document, SupplierExtractionInstructionsListRow, LotListItem, ApiDocumentType } from '../../lib/types';
import { LotDetailPanel, LotBadges } from '../../components/LotDetailPanel';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';
import ExtractionInstructionsBox from '../ExtractionInstructionsBox';

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

/**
 * Expandable product row for the SupplierDetail Products tab (Part A).
 * Level 1 -> 2: expanding the product lazy-loads its lots via
 * api.lots.list({ supplier_id, product_id }), newest first. Each lot row
 * is itself expandable (level 2 -> 3) into a LotDetailPanel. Loaded data
 * is cached on the component so re-expanding doesn't refetch.
 */
function ProductLotsRow({
  product,
  supplierId,
}: {
  product: ApiProduct;
  supplierId: string;
}) {
  const [open, setOpen] = useState(false);
  const [lots, setLots] = useState<LotListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openLotId, setOpenLotId] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && lots === null && !loading) {
      setLoading(true);
      setError('');
      try {
        const result = await api.lots.list({ supplier_id: supplierId, product_id: product.id });
        setLots(result.lots);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load lots');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <TableRow hover sx={{ cursor: 'pointer', '& > *': { borderBottom: open ? 'unset' : undefined } }} onClick={toggle}>
        <TableCell sx={{ width: 48 }}>
          <IconButton size="small">
            {open ? <ExpandMoreIcon fontSize="small" /> : <ExpandRightIcon fontSize="small" />}
          </IconButton>
        </TableCell>
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
      <TableRow>
        <TableCell sx={{ py: 0, borderBottom: open ? undefined : 'none' }} colSpan={5}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 2 }}>
              {loading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <CircularProgress size={22} />
                </Box>
              ) : error ? (
                <Alert severity="error">{error}</Alert>
              ) : !lots || lots.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1 }}>
                  No lots recorded for this product yet.
                </Typography>
              ) : (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: 40 }} />
                        <TableCell>Lot #</TableCell>
                        <TableCell>Code / Exp Date</TableCell>
                        <TableCell>Activity</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {lots.map((lot) => {
                        const lotOpen = openLotId === lot.id;
                        return (
                          <Fragment key={lot.id}>
                            <TableRow
                              hover
                              sx={{ cursor: 'pointer' }}
                              onClick={() => setOpenLotId(lotOpen ? null : lot.id)}
                            >
                              <TableCell>
                                <IconButton size="small">
                                  {lotOpen ? <ExpandMoreIcon fontSize="small" /> : <ExpandRightIcon fontSize="small" />}
                                </IconButton>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" fontWeight={500}>{lot.lot_number}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary">
                                  {lot.code_date ? formatDate(lot.code_date) : '—'}
                                  {lot.expiration_date ? ` / exp ${formatDate(lot.expiration_date)}` : ''}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <LotBadges
                                  coaCount={lot.coa_document_count}
                                  matchedOrderCount={lot.matched_order_count}
                                  suggestedCount={lot.suggested_count}
                                />
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell sx={{ py: 0, borderBottom: lotOpen ? undefined : 'none' }} colSpan={4}>
                                <Collapse in={lotOpen} timeout="auto" unmountOnExit>
                                  <Box sx={{ py: 1 }}>
                                    <LotDetailPanel lotId={lot.id} />
                                  </Box>
                                </Collapse>
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
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

  // Extraction Instructions state (R2.a — proactive editor surface).
  // The list endpoint returns one row per active doc type in the tenant,
  // with `instructions` left null where the reviewer hasn't authored
  // guidance yet. We render every row so the user can pre-write guidance
  // before the first bad parse, not after.
  const [instructionsRows, setInstructionsRows] = useState<SupplierExtractionInstructionsListRow[]>([]);
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [instructionsError, setInstructionsError] = useState('');

  // Document Types state (per-supplier doctype management). The list call
  // passes supplier_id so it returns global (supplier_id NULL) + this
  // supplier's own types; we split them in the render so "owned" vs
  // "global (shared)" are clearly separated. Only owned ones are editable.
  const [docTypes, setDocTypes] = useState<ApiDocumentType[]>([]);
  const [docTypesLoading, setDocTypesLoading] = useState(false);
  const [docTypeDialogOpen, setDocTypeDialogOpen] = useState(false);
  const [editingDocType, setEditingDocType] = useState<ApiDocumentType | null>(null);
  const [dtName, setDtName] = useState('');
  const [dtDescription, setDtDescription] = useState('');
  const [dtAutoIngest, setDtAutoIngest] = useState(false);
  const [dtExtractTables, setDtExtractTables] = useState(true);
  const [savingDocType, setSavingDocType] = useState(false);

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

  const loadInstructions = useCallback(async () => {
    if (!id || !supplier) return;
    setInstructionsLoading(true);
    setInstructionsError('');
    try {
      // super_admin needs an explicit tenant_id (matches the single-pair
      // endpoint). Non-admin paths inherit tenant from the JWT.
      const result = await api.extractionInstructions.listBySupplier({
        supplier_id: id,
        tenant_id: supplier.tenant_id,
      });
      setInstructionsRows(result.document_types);
    } catch (err) {
      setInstructionsRows([]);
      setInstructionsError(err instanceof Error ? err.message : 'Failed to load extraction instructions');
    } finally {
      setInstructionsLoading(false);
    }
  }, [id, supplier]);

  const loadDocTypes = useCallback(async () => {
    if (!id || !supplier) return;
    setDocTypesLoading(true);
    try {
      const result = await api.documentTypes.list({
        tenant_id: supplier.tenant_id,
        supplier_id: id,
      });
      setDocTypes(result.documentTypes);
    } catch (err) {
      setDocTypes([]);
      setError(err instanceof Error ? err.message : 'Failed to load document types');
    } finally {
      setDocTypesLoading(false);
    }
  }, [id, supplier]);

  useEffect(() => {
    loadSupplier();
  }, [loadSupplier]);

  useEffect(() => {
    if (tab === 0) loadProducts();
    else if (tab === 1) loadTemplates();
    else if (tab === 2) loadDocuments();
    else if (tab === 3) loadInstructions();
    else if (tab === 4) loadDocTypes();
  }, [tab, loadProducts, loadTemplates, loadDocuments, loadInstructions, loadDocTypes]);

  const openCreateDocType = () => {
    setEditingDocType(null);
    setDtName('');
    setDtDescription('');
    setDtAutoIngest(false);
    setDtExtractTables(true);
    setDocTypeDialogOpen(true);
  };

  const openEditDocType = (dt: ApiDocumentType) => {
    setEditingDocType(dt);
    setDtName(dt.name);
    setDtDescription(dt.description || '');
    setDtAutoIngest(!!dt.auto_ingest);
    setDtExtractTables(dt.extract_tables !== 0);
    setDocTypeDialogOpen(true);
  };

  const handleSaveDocType = async () => {
    if (!supplier) return;
    setSavingDocType(true);
    setError('');
    try {
      if (editingDocType) {
        await api.documentTypes.update(editingDocType.id, {
          name: dtName.trim(),
          description: dtDescription.trim() || undefined,
          auto_ingest: dtAutoIngest ? 1 : 0,
          extract_tables: dtExtractTables ? 1 : 0,
        });
      } else {
        await api.documentTypes.create({
          name: dtName.trim(),
          description: dtDescription.trim() || undefined,
          tenant_id: supplier.tenant_id,
          // Owned by THIS supplier (vs the global DocumentTypes admin page
          // which leaves supplier_id null for shared types).
          supplier_id: supplier.id,
          auto_ingest: dtAutoIngest ? 1 : 0,
          extract_tables: dtExtractTables ? 1 : 0,
        });
      }
      setDocTypeDialogOpen(false);
      loadDocTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document type');
    } finally {
      setSavingDocType(false);
    }
  };

  const handleToggleDocTypeActive = async (dt: ApiDocumentType) => {
    try {
      await api.documentTypes.update(dt.id, { active: dt.active ? 0 : 1 });
      loadDocTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document type');
    }
  };

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
          <Tab label="Extraction Instructions" />
          <Tab label="Document Types" />
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
                  <TableCell sx={{ width: 48 }} />
                  <TableCell>Name</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {products.map((product) => (
                  <ProductLotsRow key={product.id} product={product} supplierId={supplier.id} />
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

      {/* Extraction Instructions Tab (R2.a) */}
      {/* Proactive editor — lets an org_admin write reviewer guidance for any */}
      {/* (supplier, doc_type) pair BEFORE the first bad parse, instead of    */}
      {/* reactively from the Review Queue post-error. One section per active */}
      {/* doc type in the tenant; rendered with ExtractionInstructionsBox, the */}
      {/* same component the Review Queue uses so the save/load contract is   */}
      {/* identical.                                                          */}
      <TabPanel value={tab} index={3}>
        <Box sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={600}>
            Extraction Instructions
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Natural-language guidance the AI uses when extracting fields from this supplier's
            documents. Set this once per document type and it applies to every future
            extraction — no need to wait for a bad parse in the Review Queue.
          </Typography>
        </Box>

        {instructionsError && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setInstructionsError('')}>
            {instructionsError}
          </Alert>
        )}

        {instructionsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : instructionsRows.length === 0 ? (
          <EmptyState
            title="No document types defined"
            description="Extraction instructions are scoped to a (supplier, document type) pair. Add document types to this tenant first — once you have at least one, this tab will let you write reviewer guidance per type."
          />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {instructionsRows.map((row) => (
              <Paper key={row.document_type_id} variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 0.5 }}>
                  {row.document_type_name}
                </Typography>
                <ExtractionInstructionsBox
                  supplierId={supplier.id}
                  supplierName={supplier.name}
                  docTypeId={row.document_type_id}
                  docTypeName={row.document_type_name}
                  tenantId={supplier.tenant_id}
                />
              </Paper>
            ))}
          </Box>
        )}
      </TabPanel>

      {/* Document Types Tab — per-supplier doctype management. */}
      {/* The list call is scoped with supplier_id, so it returns global   */}
      {/* (supplier_id NULL, shared across the tenant) + this supplier's    */}
      {/* own types. Owned ones are editable here; global ones are shown    */}
      {/* read-only for reference and managed on the global admin page.     */}
      <TabPanel value={tab} index={4}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" fontWeight={600}>Document Types</Typography>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={openCreateDocType}>
            Add Document Type
          </Button>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Types owned by this supplier, plus the global (shared) types available to every
          supplier in the tenant. Global types are managed on the Document Types admin page.
        </Typography>

        {docTypesLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          (() => {
            const owned = docTypes.filter((dt) => dt.supplier_id === supplier.id);
            const global = docTypes.filter((dt) => !dt.supplier_id);
            return (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
                    This supplier's types
                  </Typography>
                  {owned.length === 0 ? (
                    <EmptyState
                      title="No supplier-specific document types yet"
                      description="Create a document type owned by this supplier when its documents need their own type that isn't shared tenant-wide. Shared types appear under Global types below."
                      actionLabel="Add document type"
                      onAction={openCreateDocType}
                    />
                  ) : (
                    <TableContainer component={Paper} variant="outlined">
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Name</TableCell>
                            <TableCell>Slug</TableCell>
                            <TableCell>Description</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell align="right">Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {owned.map((dt) => (
                            <TableRow key={dt.id} hover>
                              <TableCell>
                                <Typography variant="body2" fontWeight={500}>{dt.name}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                                  {dt.slug}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {dt.description || '-'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Chip
                                  label={dt.active ? 'Active' : 'Inactive'}
                                  size="small"
                                  color={dt.active ? 'success' : 'default'}
                                  variant="outlined"
                                />
                              </TableCell>
                              <TableCell align="right">
                                <Tooltip title="Teach the AI how to read this supplier's documents of this type">
                                  <IconButton
                                    size="small"
                                    color="primary"
                                    onClick={() =>
                                      navigate(`/teach?supplier_id=${supplier.id}&document_type_id=${dt.id}`)
                                    }
                                  >
                                    <TeachIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                                <Tooltip title="Edit">
                                  <IconButton size="small" onClick={() => openEditDocType(dt)}>
                                    <EditIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                                <Tooltip title={dt.active ? 'Deactivate' : 'Activate'}>
                                  <IconButton size="small" onClick={() => handleToggleDocTypeActive(dt)}>
                                    {dt.active ? (
                                      <BlockIcon fontSize="small" color="warning" />
                                    ) : (
                                      <ActiveIcon fontSize="small" color="success" />
                                    )}
                                  </IconButton>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Box>

                {global.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
                      Global types (shared)
                    </Typography>
                    <TableContainer component={Paper} variant="outlined">
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Name</TableCell>
                            <TableCell>Slug</TableCell>
                            <TableCell>Description</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell align="right">Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {global.map((dt) => (
                            <TableRow key={dt.id} hover>
                              <TableCell>
                                <Typography variant="body2" fontWeight={500}>{dt.name}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                                  {dt.slug}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {dt.description || '-'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Chip
                                  label={dt.active ? 'Active' : 'Inactive'}
                                  size="small"
                                  color={dt.active ? 'success' : 'default'}
                                  variant="outlined"
                                />
                              </TableCell>
                              <TableCell align="right">
                                <Tooltip title="Teach the AI how to read this supplier's documents of this type">
                                  <IconButton
                                    size="small"
                                    color="primary"
                                    onClick={() =>
                                      navigate(`/teach?supplier_id=${supplier.id}&document_type_id=${dt.id}`)
                                    }
                                  >
                                    <TeachIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Box>
                )}
              </Box>
            );
          })()
        )}

        {/* Create/Edit doctype dialog — mirrors the global DocumentTypes */}
        {/* admin form (name, description, auto-ingest, extract-tables).   */}
        <Dialog open={docTypeDialogOpen} onClose={() => setDocTypeDialogOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {editingDocType ? 'Edit Document Type' : 'Add Document Type'}
            <IconButton onClick={() => setDocTypeDialogOpen(false)} size="small">
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent dividers>
            <TextField
              label="Name"
              fullWidth
              required
              value={dtName}
              onChange={(e) => setDtName(e.target.value)}
              disabled={savingDocType}
              autoFocus
              sx={{ mt: 1, mb: 2 }}
            />
            <TextField
              label="Description"
              fullWidth
              multiline
              rows={2}
              value={dtDescription}
              onChange={(e) => setDtDescription(e.target.value)}
              disabled={savingDocType}
              sx={{ mb: 2 }}
            />
            <FormControlLabel
              control={<Switch checked={dtAutoIngest} onChange={(e) => setDtAutoIngest(e.target.checked)} disabled={savingDocType} />}
              label="Auto-ingest"
            />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5, mb: 1 }}>
              Automatically import high-confidence documents (requires 3+ training examples)
            </Typography>
            <FormControlLabel
              control={<Switch checked={dtExtractTables} onChange={(e) => setDtExtractTables(e.target.checked)} disabled={savingDocType} />}
              label="Extract tables"
            />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
              Extract tabular data like test results and specifications
            </Typography>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setDocTypeDialogOpen(false)} disabled={savingDocType}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleSaveDocType}
              disabled={!dtName.trim() || savingDocType}
            >
              {savingDocType ? 'Saving...' : editingDocType ? 'Save Changes' : 'Add Document Type'}
            </Button>
          </DialogActions>
        </Dialog>
      </TabPanel>
    </Box>
  );
}
