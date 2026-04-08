import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  LinearProgress,
  Alert,
  Chip,
  IconButton,
  Paper,
  Card,
  CardContent,
  CardActions,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Snackbar,
  useMediaQuery,
  useTheme,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Autocomplete,
  Switch,
  FormControlLabel,
  Checkbox,
  Slider,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Close as CloseIcon,
  InsertDriveFile as FileIcon,
  ExpandMore as ExpandMoreIcon,
  CheckCircle as CheckIcon,
  Replay as ReplayIcon,
  OpenInNew as OpenIcon,
  ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon,
  HourglassEmpty as QueuedIcon,
  Sync as ProcessingIcon,
  Error as ErrorIcon,
} from '@mui/icons-material';
import PdfViewer from '../components/PdfViewer';
import { api } from '../lib/api';
import type { ApiDocumentType, ProcessingQueueItem, QueuedResponse, ExtractedTable, ExtractionTemplate, TemplateFieldMapping } from '../lib/types';
import { AUTH_TOKEN_KEY } from '../lib/types';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';

type Stage = 'upload' | 'processing' | 'review';

// === Field assignment helpers ===

/** Maps common AI-extracted field keys for product detection */
const PRODUCT_FIELD_NAMES = new Set([
  'product_name', 'product', 'product_description',
]);

function autoAssignTier(fieldKey: string): string {
  const normalized = fieldKey.toLowerCase().trim();
  if (PRODUCT_FIELD_NAMES.has(normalized)) return 'product_name';
  return 'primary';
}

function humanizeFieldKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// === Interfaces ===

interface QueuedItem {
  id: string;
  fileName: string;
  processingStatus: string;
  result?: ProcessingQueueItem;
  duplicate?: { document_id: string; document_title: string; file_name: string } | null;
}

interface EditableResult {
  file: File;
  queueItem: ProcessingQueueItem;
  editedFields: Record<string, string>;
  fieldAssignments: Record<string, string>;
  dismissedFields: Set<string>;
  productName: string;
  importing: boolean;
  imported: boolean;
  importError?: string;
  documentId?: string;
  confidenceScore: number;
  autoIngesting: boolean;
  correctionsSaved: boolean;
  ratingSubmitted?: 'up' | 'down';
  /** The document_type_id (either user-selected or AI-matched) */
  resolvedDocTypeId: string;
  /** The AI's raw guess label */
  documentTypeGuess: string | null;
  /** Whether the AI matched an existing doc type */
  docTypeMatched: boolean;
}

// === Utility ===

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Inline preview for a local File object (blob URL). */
function LocalFilePreview({ file }: { file: File }) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  if (file.type === 'application/pdf') {
    return (
      <Box sx={{ minHeight: 400, height: '100%' }}>
        <PdfViewer url={previewUrl} fileName={file.name} />
      </Box>
    );
  }

  if (file.type.startsWith('image/')) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
        <img
          src={previewUrl}
          alt={file.name}
          style={{ maxWidth: '100%', maxHeight: 500, objectFit: 'contain', borderRadius: 4 }}
        />
      </Box>
    );
  }

  return (
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
  );
}

/** Collapsible extracted table display */
function ExtractedTableView({ table }: { table: ExtractedTable }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_ROW_LIMIT = 5;
  const needsCollapse = table.rows.length > COLLAPSED_ROW_LIMIT;
  const visibleRows = expanded ? table.rows : table.rows.slice(0, COLLAPSED_ROW_LIMIT);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        {table.name || 'Table'}
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 400, overflow: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {table.headers.map((h, i) => (
                <TableCell key={i} sx={{ fontWeight: 600, bgcolor: 'grey.100', whiteSpace: 'nowrap' }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleRows.map((row, ri) => (
              <TableRow key={ri} hover>
                {row.map((cell, ci) => (
                  <TableCell key={ci} sx={{ whiteSpace: 'nowrap' }}>
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {needsCollapse && (
        <Button size="small" onClick={() => setExpanded(!expanded)} sx={{ mt: 0.5 }}>
          {expanded ? 'Show less' : `Show all ${table.rows.length} rows`}
        </Button>
      )}
    </Box>
  );
}

/** Assignable tiers for non-dismissed fields (no dismiss option in dropdown) */
const FIELD_TIERS = [
  { value: 'primary', label: 'Primary' },
  { value: 'extended', label: 'Extended' },
  { value: 'product_name', label: 'Product Name' },
] as const;

/** Single field row with value editor, tier assignment, and dismiss button */
function FieldRow({
  fieldKey,
  value,
  assignment,
  disabled,
  onValueChange,
  onAssignmentChange,
  onDismiss,
}: {
  fieldKey: string;
  value: string;
  assignment: string;
  disabled: boolean;
  onValueChange: (v: string) => void;
  onAssignmentChange: (tier: string) => void;
  onDismiss: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      <TextField
        label={humanizeFieldKey(fieldKey)}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        size="small"
        fullWidth
        disabled={disabled}
        sx={{ flex: 1 }}
      />
      <Box sx={{ minWidth: 140 }}>
        <FormControl size="small" fullWidth>
          <Select
            value={assignment}
            onChange={(e) => onAssignmentChange(e.target.value)}
            disabled={disabled}
            sx={{ fontSize: '0.8125rem', height: 32 }}
          >
            {FIELD_TIERS.map(r => (
              <MenuItem key={r.value} value={r.value}>
                {r.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
      <IconButton
        size="small"
        onClick={onDismiss}
        disabled={disabled}
        title="Dismiss field"
        sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

/** Processing status indicator for a single queued item */
function ProcessingStatusChip({ status }: { status: string }) {
  switch (status) {
    case 'queued':
      return <Chip icon={<QueuedIcon />} label="Queued" size="small" color="default" variant="outlined" />;
    case 'processing':
      return <Chip icon={<ProcessingIcon />} label="Processing" size="small" color="info" variant="outlined" />;
    case 'ready':
      return <Chip icon={<CheckIcon />} label="Ready" size="small" color="success" variant="outlined" />;
    case 'error':
      return <Chip icon={<ErrorIcon />} label="Error" size="small" color="error" variant="outlined" />;
    default:
      return <Chip label={status} size="small" />;
  }
}

// === Main Component ===

export function Import() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  // Stage 1 state
  const [files, setFiles] = useState<File[]>([]);
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [stage, setStage] = useState<Stage>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Stage 2 state — async polling
  const [queuedItems, setQueuedItems] = useState<QueuedItem[]>([]);
  const [docTypeInfo, setDocTypeInfo] = useState<QueuedResponse['document_type'] | null>(null);

  // Stage 3 state
  const [editableResults, setEditableResults] = useState<EditableResult[]>([]);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' | 'info' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Extraction templates
  const [templates, setTemplates] = useState<Record<string, ExtractionTemplate>>({});
  const [templateDialog, setTemplateDialog] = useState<{
    open: boolean;
    index: number;
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
  const effectiveTenantId = isSuperAdmin ? tenantId : (user?.tenant_id || '');

  // Load suppliers for template dialog
  useEffect(() => {
    const loadSuppliers = async () => {
      try {
        const data = await api.suppliers.list({ tenant_id: effectiveTenantId });
        setSuppliers((data.suppliers || []).map(s => ({ id: s.id, name: s.name })));
      } catch { /* non-critical */ }
    };
    if (effectiveTenantId) loadSuppliers();
  }, [effectiveTenantId]);

  // Load document types
  useEffect(() => {
    const loadDocTypes = async () => {
      try {
        const tid = isSuperAdmin ? (tenantId || selectedTenantId || undefined) : (user?.tenant_id || undefined);
        if (!tid) {
          setDocumentTypes([]);
          return;
        }
        const result = await api.documentTypes.list({ tenant_id: tid, active: 1 });
        setDocumentTypes(result.documentTypes);
      } catch {
        // Silently fail
      }
    };
    loadDocTypes();
  }, [tenantId, selectedTenantId, isSuperAdmin, user?.tenant_id]);

  // Initialize tenant ID
  useEffect(() => {
    if (isSuperAdmin) {
      setTenantId(selectedTenantId || '');
    }
  }, [isSuperAdmin, selectedTenantId]);

  // Poll queued items during processing stage
  useEffect(() => {
    if (stage !== 'processing' || queuedItems.length === 0) return;

    const interval = setInterval(async () => {
      try {
        const updated = await Promise.all(
          queuedItems.map(async (item) => {
            // Skip items that are already done
            if (item.processingStatus === 'ready' || item.processingStatus === 'error') return item;
            // Skip items that failed validation (no ID)
            if (!item.id) return item;
            try {
              const res = await api.queue.get(item.id);
              return {
                ...item,
                processingStatus: res.item.processing_status || item.processingStatus,
                result: res.item,
              };
            } catch {
              return item;
            }
          })
        );
        setQueuedItems(updated);

        // Check if all items are done
        const allDone = updated.every(i => !i.id || i.processingStatus === 'ready' || i.processingStatus === 'error');
        if (allDone) {
          buildEditableResults(updated);
          setStage('review');
        }
      } catch {
        // Polling error — ignore, will retry
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [stage, queuedItems]);

  // Fetch extraction templates for items that have a template_id
  useEffect(() => {
    if (editableResults.length === 0) return;

    const fetchTemplates = async () => {
      const newTemplates: Record<string, ExtractionTemplate> = {};
      for (const result of editableResults) {
        const templateId = result.queueItem.template_id;
        if (templateId && !templates[templateId]) {
          try {
            const { template } = await api.extractionTemplates.get(templateId);
            newTemplates[templateId] = template;
          } catch {
            // Template not found, skip
          }
        }
      }
      if (Object.keys(newTemplates).length > 0) {
        setTemplates(prev => ({ ...prev, ...newTemplates }));
      }
    };

    fetchTemplates();
  }, [editableResults.length]); // Only run when results are first built

  // Apply templates to field assignments when templates load
  useEffect(() => {
    if (Object.keys(templates).length === 0) return;

    setEditableResults(prev => prev.map(result => {
      const templateId = result.queueItem.template_id;
      if (!templateId || !templates[templateId]) return result;

      const template = templates[templateId];
      const mappings = template.field_mappings;

      // Build field assignments from template
      const newAssignments: Record<string, string> = {};
      const newDismissed = new Set<string>();

      // Build alias map
      const aliasMap = new Map<string, TemplateFieldMapping>();
      for (const m of mappings) {
        for (const alias of (m.aliases || [])) {
          aliasMap.set(alias, m);
        }
      }

      for (const key of Object.keys(result.editedFields)) {
        const mapping = mappings.find(m => m.field_key === key) || aliasMap.get(key);
        if (mapping) {
          newAssignments[key] = mapping.tier;
        } else {
          // Field not in template — dismiss it
          newDismissed.add(key);
          newAssignments[key] = 'extended';
        }
      }

      // Find product name from template
      const productMapping = mappings.find(m => m.tier === 'product_name');
      const productName = productMapping ? (result.editedFields[productMapping.field_key] || result.productName) : result.productName;

      return {
        ...result,
        fieldAssignments: Object.keys(newAssignments).length > 0 ? newAssignments : result.fieldAssignments,
        dismissedFields: newDismissed.size > 0 ? newDismissed : result.dismissedFields,
        productName,
      };
    }));
  }, [templates]);

  // Build editable results from completed queue items
  const buildEditableResults = (items: QueuedItem[]) => {
    const autoIngestEnabled = docTypeInfo?.auto_ingest ?? false;

    const editable: EditableResult[] = items
      .filter(item => item.id && item.result && item.processingStatus === 'ready')
      .map((item) => {
        const queueItem = item.result!;

        // Parse AI fields from JSON string
        let fields: Record<string, string | null> = {};
        if (queueItem.ai_fields) {
          try {
            fields = typeof queueItem.ai_fields === 'string'
              ? JSON.parse(queueItem.ai_fields)
              : queueItem.ai_fields;
          } catch {
            fields = {};
          }
        }

        // Parse product names from JSON string
        let productNames: string[] = [];
        if (queueItem.product_names) {
          try {
            productNames = typeof queueItem.product_names === 'string'
              ? JSON.parse(queueItem.product_names)
              : queueItem.product_names;
          } catch {
            productNames = [];
          }
        }

        const safeValue = (v: any): string => {
          if (v === null || v === undefined) return '';
          if (typeof v === 'string') return v;
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        };

        const editedFields: Record<string, string> = {};
        const fieldAssignments: Record<string, string> = {};

        for (const [k, v] of Object.entries(fields)) {
          editedFields[k] = safeValue(v);
          fieldAssignments[k] = autoAssignTier(k);
        }

        // Find the original file by name
        const file = files.find(f => f.name === item.fileName) || files[0];

        // Resolve document type: prefer user-selected, then AI-matched from queue item
        const resolvedDocTypeId = documentTypeId || queueItem.document_type_id || '';
        const documentTypeGuess = (queueItem as any).document_type_guess || null;
        const docTypeMatched = !documentTypeId && !!queueItem.document_type_id;

        return {
          file,
          queueItem,
          editedFields,
          fieldAssignments,
          dismissedFields: new Set<string>(),
          productName: productNames[0] || '',
          importing: false,
          imported: false,
          confidenceScore: queueItem.confidence_score || 0,
          autoIngesting: false,
          correctionsSaved: false,
          resolvedDocTypeId,
          documentTypeGuess,
          docTypeMatched,
        };
      });

    setEditableResults(editable);

    // Auto-ingest high confidence results
    for (let i = 0; i < editable.length; i++) {
      const item = editable[i];
      if (autoIngestEnabled && item.confidenceScore >= 0.7 && !item.queueItem.checksum) {
        // Check for duplicate via checksum in the queue item
      }
    }
  };

  // Drag handlers
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    setFiles(prev => [...prev, ...dropped]);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Stage 2: Submit files for async processing
  const handleProcess = async () => {
    if (!effectiveTenantId) {
      setError('Please select a tenant.');
      return;
    }

    setStage('processing');
    setError('');

    try {
      const response = await api.processing.process(files, effectiveTenantId, documentTypeId || undefined);
      setDocTypeInfo(response.document_type);

      // Initialize queued items for polling
      const items: QueuedItem[] = response.items.map(item => ({
        id: item.id,
        fileName: item.file_name,
        processingStatus: item.id ? 'queued' : 'error',
        duplicate: item.duplicate,
      }));

      setQueuedItems(items);

      // If no valid items were queued, go back
      if (items.every(i => !i.id)) {
        setError('No files could be queued for processing');
        setStage('upload');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed');
      setStage('upload');
    }
  };

  // Stage 3: Import a single file
  const handleImport = async (index: number) => {
    const item = editableResults[index];
    if (!item || item.imported || !item.queueItem) return;

    // Mark importing
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, importing: true, importError: undefined } : r
    ));

    try {
      // Parse fields from queue item
      let aiFields: Record<string, string | null> = {};
      if (item.queueItem.ai_fields) {
        try {
          aiFields = typeof item.queueItem.ai_fields === 'string'
            ? JSON.parse(item.queueItem.ai_fields)
            : item.queueItem.ai_fields;
        } catch { aiFields = {}; }
      }

      // Determine effective doc type for this item
      const itemDocTypeId = documentTypeId || item.resolvedDocTypeId || '';

      // Auto-save correction as training example if fields were edited
      const fieldsChanged = Object.keys(item.editedFields).some(
        k => item.editedFields[k] !== (aiFields[k] || '')
      );
      if (fieldsChanged && itemDocTypeId) {
        try {
          await api.extractionExamples.create({
            document_type_id: itemDocTypeId,
            tenant_id: effectiveTenantId || undefined,
            input_text: (item.queueItem.extracted_text || '').substring(0, 2000),
            ai_output: JSON.stringify(aiFields),
            corrected_output: JSON.stringify(item.editedFields),
            score: 0.8,
            supplier: item.queueItem.supplier || null,
          });
          setEditableResults(prev => prev.map((r, i) =>
            i === index ? { ...r, correctionsSaved: true } : r
          ));
        } catch {
          // Non-critical
        }
      }

      // 1. Resolve product
      let productId: string | undefined;
      const productField = Object.entries(item.fieldAssignments).find(([, tier]) => tier === 'product_name');
      const productNameValue = productField ? item.editedFields[productField[0]] : item.productName;
      if (productNameValue?.trim()) {
        const prodResult = await api.products.lookupOrCreate({
          name: productNameValue.trim(),
          tenant_id: effectiveTenantId,
        });
        productId = prodResult.product.id;
      }

      // 2. Resolve supplier
      let supplierId: string | undefined;
      if (item.queueItem.supplier) {
        try {
          const supplierResult = await api.suppliers.lookupOrCreate({
            name: item.queueItem.supplier,
            tenant_id: effectiveTenantId,
          });
          supplierId = supplierResult.supplier.id;
        } catch {
          // Non-critical
        }
      }

      // 3. Build FormData for ingest
      const form = new FormData();
      form.append('file', item.file);
      form.append('tenant_id', effectiveTenantId);
      form.append('external_ref', `import-${Date.now()}-${index}-${item.file.name}`);
      form.append('title', item.file.name.replace(/\.[^/.]+$/, ''));
      if (itemDocTypeId) {
        form.append('document_type_id', itemDocTypeId);
      }

      if (supplierId) {
        form.append('supplier_id', supplierId);
      }

      if (productId) {
        form.append('product_ids', JSON.stringify([{ product_id: productId }]));
      }

      // Build primary_metadata from "primary" assigned fields
      // Dismissed fields go to extended_metadata
      const primaryMeta: Record<string, string> = {};
      const extendedMeta: Record<string, string> = {};
      for (const [key, value] of Object.entries(item.editedFields)) {
        if (item.dismissedFields.has(key)) {
          if (value) extendedMeta[key] = value;
        } else {
          const tier = item.fieldAssignments[key];
          if (tier === 'primary') {
            if (value) primaryMeta[key] = value;
          } else if (tier === 'extended') {
            if (value) extendedMeta[key] = value;
          }
        }
      }

      if (Object.keys(primaryMeta).length > 0) {
        form.append('primary_metadata', JSON.stringify(primaryMeta));
      }
      if (Object.keys(extendedMeta).length > 0) {
        form.append('extended_metadata', JSON.stringify(extendedMeta));
      }

      // Build source_metadata from tables
      let tables: ExtractedTable[] = [];
      if (item.queueItem.tables) {
        try {
          tables = typeof item.queueItem.tables === 'string'
            ? JSON.parse(item.queueItem.tables)
            : item.queueItem.tables;
        } catch { tables = []; }
      }
      if (tables.length > 0) {
        const sourceMeta: Record<string, unknown> = { _tables: tables };
        form.append('source_metadata', JSON.stringify(sourceMeta));
      }

      // 4. Call ingest
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/documents/ingest', {
        method: 'POST',
        headers,
        body: form,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Ingest failed' }));
        throw new Error(err.error || 'Ingest failed');
      }

      const result = await response.json();

      // Mark the queue item as approved
      try {
        await api.queue.approve(item.queueItem.id, {
          fields: item.editedFields,
          product_name: productNameValue || undefined,
        });
      } catch {
        // Non-critical — document was already ingested
      }

      // Mark imported
      setEditableResults(prev => prev.map((r, i) =>
        i === index ? { ...r, importing: false, imported: true, autoIngesting: false, documentId: result.document.id } : r
      ));

      setSnackbar({ open: true, message: `Imported ${item.file.name}`, severity: 'success' });

      // Prompt to save template if no template existed
      if (!item.queueItem.template_id && (item.queueItem.supplier || supplierId) && itemDocTypeId) {
        // Build field mappings from current assignments
        const mappings: TemplateFieldMapping[] = [];
        let order = 0;
        for (const [key, tier] of Object.entries(item.fieldAssignments)) {
          if (item.dismissedFields.has(key)) continue;
          mappings.push({
            field_key: key,
            tier: tier as 'primary' | 'extended' | 'product_name',
            display_order: order++,
            required: ['lot_number', 'supplier_name', 'product_name'].includes(key),
          });
        }

        // Find doc type name
        const docType = documentTypes.find(dt => dt.id === itemDocTypeId);

        setTemplateDialog({
          open: true,
          index,
          supplierName: item.queueItem.supplier || '',
          supplierId: supplierId || null,
          docTypeName: docType?.name || (item.queueItem as any).document_type_guess || '',
          docTypeId: itemDocTypeId || null,
          fieldMappings: mappings,
          autoIngestEnabled: false,
          confidenceThreshold: 0.85,
        });
      }
    } catch (err) {
      setEditableResults(prev => prev.map((r, i) =>
        i === index ? { ...r, importing: false, importError: err instanceof Error ? err.message : 'Import failed' } : r
      ));
      setSnackbar({ open: true, message: `Failed to import ${item.file.name}`, severity: 'error' });
    }
  };

  // Import all non-imported, non-error results
  const handleImportAll = async () => {
    for (let i = 0; i < editableResults.length; i++) {
      const item = editableResults[i];
      if (!item.imported && !item.importError) {
        await handleImport(i);
      }
    }
  };

  // Reset to stage 1
  const handleStartOver = () => {
    setFiles([]);
    setDocumentTypeId('');
    setEditableResults([]);
    setQueuedItems([]);
    setDocTypeInfo(null);
    setError('');
    setStage('upload');
  };

  // Update editable field
  const updateField = (index: number, fieldName: string, value: string) => {
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, editedFields: { ...r.editedFields, [fieldName]: value } } : r
    ));
  };

  // Update field tier assignment
  const updateFieldAssignment = (index: number, fieldName: string, tier: string) => {
    setEditableResults(prev => prev.map((r, i) => {
      if (i !== index) return r;
      const newAssignments = { ...r.fieldAssignments };

      // product_name is unique -- clear it from any other field first
      if (tier === 'product_name') {
        for (const k of Object.keys(newAssignments)) {
          if (newAssignments[k] === 'product_name') {
            newAssignments[k] = 'primary';
          }
        }
      }

      newAssignments[fieldName] = tier;
      return { ...r, fieldAssignments: newAssignments };
    }));
  };

  // Update product name
  const updateProductName = (index: number, value: string) => {
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, productName: value } : r
    ));
  };

  // Dismiss/restore fields
  const [showDismissed, setShowDismissed] = useState<Record<number, boolean>>({});

  const handleDismiss = (resultIndex: number, fieldKey: string) => {
    setEditableResults(prev => prev.map((item, i) => {
      if (i !== resultIndex) return item;
      const dismissed = new Set(item.dismissedFields);
      dismissed.add(fieldKey);
      return { ...item, dismissedFields: dismissed };
    }));
  };

  const handleRestore = (resultIndex: number, fieldKey: string) => {
    setEditableResults(prev => prev.map((item, i) => {
      if (i !== resultIndex) return item;
      const dismissed = new Set(item.dismissedFields);
      dismissed.delete(fieldKey);
      return { ...item, dismissedFields: dismissed };
    }));
  };

  // Rate extraction quality
  const handleRate = async (index: number, score: number) => {
    const item = editableResults[index];
    if (!item) return;

    // Parse AI fields for the example
    let aiFields: Record<string, string | null> = {};
    if (item.queueItem.ai_fields) {
      try {
        aiFields = typeof item.queueItem.ai_fields === 'string'
          ? JSON.parse(item.queueItem.ai_fields)
          : item.queueItem.ai_fields;
      } catch { aiFields = {}; }
    }

    const ratingDocTypeId = documentTypeId || item.resolvedDocTypeId || '';
    if (!ratingDocTypeId) {
      setSnackbar({ open: true, message: 'Cannot save rating without a document type', severity: 'error' });
      return;
    }

    try {
      await api.extractionExamples.create({
        document_type_id: ratingDocTypeId,
        tenant_id: effectiveTenantId || undefined,
        input_text: (item.queueItem.extracted_text || '').substring(0, 2000),
        ai_output: JSON.stringify(aiFields),
        corrected_output: JSON.stringify(item.editedFields),
        score,
        supplier: item.queueItem.supplier || null,
      });
      setEditableResults(prev => prev.map((r, i) =>
        i === index ? { ...r, ratingSubmitted: score >= 0.5 ? 'up' as const : 'down' as const } : r
      ));
      setSnackbar({ open: true, message: 'Rating saved', severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: 'Failed to save rating', severity: 'error' });
    }
  };

  const confidenceColor = (score: number): 'success' | 'warning' | 'error' => {
    if (score >= 0.8) return 'success';
    if (score >= 0.5) return 'warning';
    return 'error';
  };

  const confidenceLabel = (score: number): string => {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  };

  const importableCount = editableResults.filter(r => !r.imported && !r.importError).length;
  const importedCount = editableResults.filter(r => r.imported).length;

  // Processing stage: count statuses
  const readyCount = queuedItems.filter(i => i.processingStatus === 'ready' || i.processingStatus === 'error').length;
  const totalQueuedCount = queuedItems.filter(i => !!i.id).length;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Import
        </Typography>
        {(stage === 'review' || stage === 'processing') && (
          <Button variant="outlined" startIcon={<ReplayIcon />} onClick={handleStartOver}>
            Start Over
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Stage 1: Upload */}
      {stage === 'upload' && (
        <Box>
          {/* Tenant selector for super_admin */}
          {isSuperAdmin && (
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Tenant</InputLabel>
              <Select
                value={tenantId}
                onChange={(e) => {
                  setTenantId(e.target.value);
                  setDocumentTypeId('');
                }}
                label="Tenant"
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

          {/* Drop zone */}
          <Paper
            variant="outlined"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            sx={{
              border: '2px dashed',
              borderColor: dragOver ? 'primary.main' : 'divider',
              borderRadius: 2,
              p: { xs: 3, sm: 5 },
              textAlign: 'center',
              cursor: 'pointer',
              bgcolor: dragOver ? 'action.hover' : 'transparent',
              transition: 'all 0.2s',
              mb: 2,
              '&:hover': {
                borderColor: 'primary.main',
                bgcolor: 'action.hover',
              },
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const selected = Array.from(e.target.files || []);
                setFiles(prev => [...prev, ...selected]);
                e.target.value = '';
              }}
            />
            <UploadIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
            <Typography variant="h6" color="text.secondary">
              {isMobile ? 'Tap to select files' : 'Drag and drop files here, or click to browse'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Upload one or more documents for AI-powered field extraction
            </Typography>
          </Paper>

          {/* Selected files list */}
          {files.length > 0 && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Selected files ({files.length})
              </Typography>
              {files.map((file, i) => (
                <Box
                  key={`${file.name}-${i}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    py: 0.75,
                    px: 1.5,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    mb: 0.5,
                  }}
                >
                  <FileIcon color="primary" fontSize="small" />
                  <Typography variant="body2" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatFileSize(file.size)}
                  </Typography>
                  <IconButton size="small" onClick={(e) => { e.stopPropagation(); removeFile(i); }}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
              ))}
            </Box>
          )}

          {/* Optional document type selector */}
          {documentTypes.length > 0 && (
            <FormControl fullWidth sx={{ mb: 3 }}>
              <InputLabel shrink>Pre-select document type (optional)</InputLabel>
              <Select
                value={documentTypeId}
                onChange={(e) => setDocumentTypeId(e.target.value)}
                label="Pre-select document type (optional)"
                displayEmpty
                notched
              >
                <MenuItem value="">
                  <em>Let AI detect</em>
                </MenuItem>
                {documentTypes.map((dt) => (
                  <MenuItem key={dt.id} value={dt.id}>
                    {dt.name}
                    {dt.description && (
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        -- {dt.description}
                      </Typography>
                    )}
                  </MenuItem>
                ))}
              </Select>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                Leave empty to let AI detect the document type automatically.
              </Typography>
            </FormControl>
          )}

          {/* Process button */}
          <Button
            variant="contained"
            size="large"
            onClick={handleProcess}
            disabled={files.length === 0 || (isSuperAdmin && !tenantId)}
            startIcon={<UploadIcon />}
            fullWidth={isMobile}
          >
            Process {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''}
          </Button>
        </Box>
      )}

      {/* Stage 2: Processing (async polling) */}
      {stage === 'processing' && (
        <Box sx={{ py: 4 }}>
          <Box sx={{ textAlign: 'center', mb: 4 }}>
            <CircularProgress size={48} sx={{ mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              Processing {totalQueuedCount} file{totalQueuedCount > 1 ? 's' : ''}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={totalQueuedCount > 0 ? (readyCount / totalQueuedCount) * 100 : 0}
              sx={{ maxWidth: 400, mx: 'auto', mb: 2 }}
            />
            <Typography variant="body2" color="text.secondary">
              {readyCount} of {totalQueuedCount} complete
            </Typography>
          </Box>

          {/* Per-file status list */}
          <Box sx={{ maxWidth: 600, mx: 'auto' }}>
            {queuedItems.filter(i => !!i.id).map((item) => (
              <Box
                key={item.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  py: 1,
                  px: 2,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  mb: 0.5,
                }}
              >
                <FileIcon color="primary" fontSize="small" />
                <Typography variant="body2" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.fileName}
                </Typography>
                <ProcessingStatusChip status={item.processingStatus} />
              </Box>
            ))}
          </Box>

          {/* Duplicate warnings */}
          {queuedItems.filter(i => i.duplicate).map((item) => (
            <Alert
              key={item.id}
              severity="warning"
              sx={{ maxWidth: 600, mx: 'auto', mt: 1 }}
            >
              {item.fileName} may be a duplicate of &ldquo;{item.duplicate!.document_title}&rdquo;.
            </Alert>
          ))}
        </Box>
      )}

      {/* Stage 3: Review & Import */}
      {stage === 'review' && (
        <Box>
          {/* Summary bar */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
            <Typography variant="body1">
              {editableResults.length} file{editableResults.length > 1 ? 's' : ''} processed
            </Typography>
            {/* Show errors from processing */}
            {queuedItems.filter(i => i.processingStatus === 'error').length > 0 && (
              <Chip
                label={`${queuedItems.filter(i => i.processingStatus === 'error').length} failed`}
                color="error"
                size="small"
              />
            )}
            {importedCount > 0 && (
              <Chip label={`${importedCount} imported`} color="success" size="small" />
            )}
            {importableCount > 0 && (
              <Button
                variant="contained"
                onClick={handleImportAll}
                size="small"
              >
                Import All ({importableCount})
              </Button>
            )}
          </Box>

          {/* Processing errors */}
          {queuedItems.filter(i => i.processingStatus === 'error').map((item) => (
            <Alert key={item.id} severity="error" sx={{ mb: 1 }}>
              {item.fileName}: {item.result?.error_message || 'Processing failed'}
            </Alert>
          ))}

          {/* Results cards */}
          {editableResults.map((item, index) => {
            // Parse tables and products from queue item for display
            let tables: ExtractedTable[] = [];
            if (item.queueItem.tables) {
              try {
                tables = typeof item.queueItem.tables === 'string'
                  ? JSON.parse(item.queueItem.tables)
                  : item.queueItem.tables;
              } catch { tables = []; }
            }

            let productNames: string[] = [];
            if (item.queueItem.product_names) {
              try {
                productNames = typeof item.queueItem.product_names === 'string'
                  ? JSON.parse(item.queueItem.product_names)
                  : item.queueItem.product_names;
              } catch { productNames = []; }
            }

            const summary = item.queueItem.summary || '';
            const extractedTextPreview = (item.queueItem.extracted_text || '').substring(0, 500);
            const confidence = item.confidenceScore;

            return (
              <Card key={index} variant="outlined" sx={{ mb: 2 }}>
                <CardContent>
                  {/* Header row */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                    <FileIcon color="primary" fontSize="small" />
                    <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
                      {item.file.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatFileSize(item.file.size)}
                    </Typography>
                    <Chip
                      label={confidenceLabel(confidence)}
                      size="small"
                      color={confidenceColor(confidence)}
                      variant="outlined"
                    />
                    <Typography variant="body2" fontWeight={600} color="text.secondary">
                      {Math.round(confidence * 100)}%
                    </Typography>
                    {/* Document type chip */}
                    {(() => {
                      const dtName = documentTypeId
                        ? documentTypes.find(dt => dt.id === documentTypeId)?.name
                        : item.resolvedDocTypeId
                          ? documentTypes.find(dt => dt.id === item.resolvedDocTypeId)?.name
                          : null;
                      if (dtName) {
                        return <Chip label={dtName} size="small" color="success" variant="outlined" />;
                      } else if (item.documentTypeGuess) {
                        return <Chip label={`${item.documentTypeGuess} (new)`} size="small" color="warning" variant="outlined" />;
                      }
                      return null;
                    })()}
                    {item.queueItem.template_id && templates[item.queueItem.template_id] && (
                      <Chip
                        label={`Template: ${templates[item.queueItem.template_id].supplier_name} + ${templates[item.queueItem.template_id].document_type_name}`}
                        color="info"
                        size="small"
                        sx={{ ml: 1 }}
                      />
                    )}
                    {item.queueItem.auto_ingested === 1 && (
                      <Chip label="Auto-ingested" color="success" size="small" sx={{ ml: 1 }} />
                    )}
                    {item.imported && (
                      <Chip label="Imported" size="small" color="success" icon={<CheckIcon />} />
                    )}
                  </Box>

                  {/* Summary text */}
                  {summary && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2, ml: 3.5 }}>
                      {summary}
                    </Typography>
                  )}

                  {/* Duplicate warning */}
                  {(() => {
                    const qItem = queuedItems.find(q => q.id === item.queueItem.id);
                    return qItem?.duplicate && !item.imported ? (
                      <Alert
                        severity="warning"
                        sx={{ mb: 2 }}
                        action={
                          <Button
                            color="inherit"
                            size="small"
                            startIcon={<OpenIcon />}
                            onClick={() => navigate(`/documents/${qItem.duplicate!.document_id}`)}
                          >
                            View Existing
                          </Button>
                        }
                      >
                        This file appears to be a duplicate of &ldquo;{qItem.duplicate.document_title}&rdquo;.
                        Importing will add a new version.
                      </Alert>
                    ) : null;
                  })()}

                  {/* Import error */}
                  {item.importError && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                      Import failed: {item.importError}
                    </Alert>
                  )}

                  {/* Success state: split layout with preview + editable fields */}
                  {!item.imported && (
                    <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
                      {/* File preview */}
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <LocalFilePreview file={item.file} />
                      </Box>

                      {/* Right panel: fields, tables, products */}
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        {/* Extracted text preview */}
                        {extractedTextPreview && (
                          <Accordion variant="outlined" sx={{ mb: 2 }}>
                            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                              <Typography variant="body2" color="text.secondary">
                                Extracted text preview
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
                                {extractedTextPreview}
                              </Typography>
                            </AccordionDetails>
                          </Accordion>
                        )}

                        {/* Section 1: Extracted Fields */}
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          Extracted Fields
                        </Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
                          {Object.entries(item.editedFields)
                            .filter(([fieldName]) => !item.dismissedFields.has(fieldName))
                            .map(([fieldName, fieldValue]) => (
                            <FieldRow
                              key={fieldName}
                              fieldKey={fieldName}
                              value={fieldValue}
                              assignment={item.fieldAssignments[fieldName] || ''}
                              disabled={item.importing}
                              onValueChange={(v) => updateField(index, fieldName, v)}
                              onAssignmentChange={(role) => updateFieldAssignment(index, fieldName, role)}
                              onDismiss={() => handleDismiss(index, fieldName)}
                            />
                          ))}
                        </Box>

                        {/* Dismissed fields */}
                        {item.dismissedFields.size > 0 && (
                          <Box sx={{ mb: 2 }}>
                            <Button
                              size="small"
                              onClick={() => setShowDismissed(prev => ({ ...prev, [index]: !prev[index] }))}
                              sx={{ textTransform: 'none', color: 'text.secondary', mb: 0.5 }}
                            >
                              {showDismissed[index] ? 'Hide' : 'Show'} {item.dismissedFields.size} dismissed field{item.dismissedFields.size !== 1 ? 's' : ''}
                            </Button>
                            {showDismissed[index] && (
                              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                {Array.from(item.dismissedFields).map(fieldKey => (
                                  <Chip
                                    key={fieldKey}
                                    label={`${humanizeFieldKey(fieldKey)}: ${item.editedFields[fieldKey] || '(empty)'}`}
                                    size="small"
                                    variant="outlined"
                                    onDelete={() => handleRestore(index, fieldKey)}
                                    sx={{ opacity: 0.7 }}
                                  />
                                ))}
                              </Box>
                            )}
                          </Box>
                        )}

                        {/* Document Type selector (when not pre-selected) */}
                        {!documentTypeId && (
                          <Box sx={{ mb: 2 }}>
                            <Typography variant="subtitle2" sx={{ mb: 1 }}>
                              Document Type
                            </Typography>
                            <FormControl size="small" fullWidth>
                              <Select
                                value={item.resolvedDocTypeId}
                                onChange={(e) => {
                                  const newId = e.target.value;
                                  setEditableResults(prev => prev.map((r, i) =>
                                    i === index ? { ...r, resolvedDocTypeId: newId, docTypeMatched: !!newId } : r
                                  ));
                                }}
                                displayEmpty
                                disabled={item.importing}
                              >
                                <MenuItem value="">
                                  <em>{item.documentTypeGuess ? `AI guess: ${item.documentTypeGuess}` : 'None'}</em>
                                </MenuItem>
                                {documentTypes.map((dt) => (
                                  <MenuItem key={dt.id} value={dt.id}>
                                    {dt.name}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                            {item.documentTypeGuess && !item.resolvedDocTypeId && (
                              <Typography variant="caption" color="warning.main" sx={{ mt: 0.5, display: 'block' }}>
                                AI detected &ldquo;{item.documentTypeGuess}&rdquo; but no matching type found. Select one above or it will be imported without a type.
                              </Typography>
                            )}
                          </Box>
                        )}

                        {/* Section 2: Tables */}
                        {tables.length > 0 && (
                          <>
                            <Divider sx={{ my: 2 }} />
                            <Accordion variant="outlined" defaultExpanded={tables.length === 1}>
                              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                <Typography variant="subtitle2">
                                  Tables ({tables.length})
                                </Typography>
                              </AccordionSummary>
                              <AccordionDetails>
                                {tables.map((table, ti) => (
                                  <ExtractedTableView key={ti} table={table} />
                                ))}
                                <Typography variant="caption" color="text.secondary">
                                  Tables are saved to document metadata on import.
                                </Typography>
                              </AccordionDetails>
                            </Accordion>
                          </>
                        )}

                        {/* Section 3: Products */}
                        <Divider sx={{ my: 2 }} />
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          Products
                        </Typography>
                        {productNames.length > 0 && (
                          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                            {productNames.map((pn, pi) => (
                              <Chip
                                key={pi}
                                label={pn}
                                size="small"
                                variant="outlined"
                                onClick={() => updateProductName(index, pn)}
                                color={item.productName === pn ? 'primary' : 'default'}
                              />
                            ))}
                          </Box>
                        )}
                        <TextField
                          label="Product Name"
                          value={item.productName}
                          onChange={(e) => updateProductName(index, e.target.value)}
                          size="small"
                          fullWidth
                          disabled={item.importing}
                          helperText="Will be looked up or created automatically"
                        />

                        {/* Rate Extraction */}
                        <Divider sx={{ my: 2 }} />
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="body2" color="text.secondary">
                            Rate Extraction:
                          </Typography>
                          <IconButton
                            size="small"
                            color={item.ratingSubmitted === 'up' ? 'success' : 'default'}
                            onClick={() => handleRate(index, 1.0)}
                            disabled={!!item.ratingSubmitted}
                          >
                            <ThumbUpIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            color={item.ratingSubmitted === 'down' ? 'error' : 'default'}
                            onClick={() => handleRate(index, 0.0)}
                            disabled={!!item.ratingSubmitted}
                          >
                            <ThumbDownIcon fontSize="small" />
                          </IconButton>
                          {item.ratingSubmitted && (
                            <Typography variant="caption" color="text.secondary">
                              Rating saved
                            </Typography>
                          )}
                          {item.correctionsSaved && (
                            <Chip label="Corrections saved" size="small" color="info" variant="outlined" sx={{ ml: 1 }} />
                          )}
                        </Box>
                      </Box>
                    </Box>
                  )}

                  {/* Imported success link */}
                  {item.imported && item.documentId && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                      <Button
                        size="small"
                        startIcon={<OpenIcon />}
                        onClick={() => navigate(`/documents/${item.documentId}`)}
                      >
                        View Document
                      </Button>
                      {/* Rate extraction for imported items */}
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Typography variant="caption" color="text.secondary">
                          Rate:
                        </Typography>
                        <IconButton
                          size="small"
                          color={item.ratingSubmitted === 'up' ? 'success' : 'default'}
                          onClick={() => handleRate(index, 1.0)}
                          disabled={!!item.ratingSubmitted}
                        >
                          <ThumbUpIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                        <IconButton
                          size="small"
                          color={item.ratingSubmitted === 'down' ? 'error' : 'default'}
                          onClick={() => handleRate(index, 0.0)}
                          disabled={!!item.ratingSubmitted}
                        >
                          <ThumbDownIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                        {item.ratingSubmitted && (
                          <Typography variant="caption" color="text.secondary">Saved</Typography>
                        )}
                      </Box>
                    </Box>
                  )}
                </CardContent>

                {/* Action buttons */}
                {!item.imported && (
                  <CardActions sx={{ px: 2, pb: 2 }}>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => handleImport(index)}
                      disabled={item.importing}
                      startIcon={item.importing ? <CircularProgress size={16} color="inherit" /> : undefined}
                    >
                      {item.importing ? 'Importing...' : 'Import'}
                    </Button>
                  </CardActions>
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
