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
} from '@mui/icons-material';
import PdfViewer from '../components/PdfViewer';
import { api } from '../lib/api';
import type { ApiDocumentType, ProcessingResult, ProcessingResponse } from '../lib/types';
import { AUTH_TOKEN_KEY } from '../lib/types';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';

type Stage = 'upload' | 'processing' | 'review';

interface EditableResult {
  file: File;
  result: ProcessingResult;
  editedFields: Record<string, string>;
  productName: string;
  importing: boolean;
  imported: boolean;
  importError?: string;
  documentId?: string;
  confidenceScore: number;
  autoIngesting: boolean;
  correctionsSaved: boolean;
  ratingSubmitted?: 'up' | 'down';
}

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

  // Stage 2 state
  const [showSlowMessage, setShowSlowMessage] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<{ current: number; total: number; fileName: string } | null>(null);

  // Stage 3 state
  const [editableResults, setEditableResults] = useState<EditableResult[]>([]);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Resolve effective tenant ID
  const effectiveTenantId = isSuperAdmin ? tenantId : (user?.tenant_id || '');

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

  // Show slow message after 5 seconds during processing
  useEffect(() => {
    if (stage === 'processing') {
      setShowSlowMessage(false);
      const timer = setTimeout(() => setShowSlowMessage(true), 5000);
      return () => clearTimeout(timer);
    }
    setShowSlowMessage(false);
  }, [stage]);

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

  // Stage 2: Process files (one at a time for per-file progress)
  const handleProcess = async () => {
    if (!effectiveTenantId) {
      setError('Please select a tenant.');
      return;
    }

    setStage('processing');
    setError('');
    setProcessingStatus({ current: 0, total: files.length, fileName: '' });

    try {
      const allResults: ProcessingResult[] = [];
      let docTypeInfo: ProcessingResponse['document_type'] | null = null;

      for (let i = 0; i < files.length; i++) {
        setProcessingStatus({ current: i + 1, total: files.length, fileName: files[i].name });
        try {
          const response = await api.processing.process([files[i]], documentTypeId, effectiveTenantId);
          if (!docTypeInfo) docTypeInfo = response.document_type;
          allResults.push(...response.results.map(r => ({ ...r, file_index: i })));
        } catch (err) {
          allResults.push({
            file_name: files[i].name,
            file_index: i,
            status: 'error',
            error_message: err instanceof Error ? err.message : 'Processing failed',
            fields: {},
            product_names: [],
            confidence: 'low',
            confidence_score: 0,
          });
        }
      }

      if (!docTypeInfo) {
        throw new Error('Processing failed for all files');
      }

      const autoIngestThreshold = docTypeInfo.auto_ingest_threshold ?? 0.8;

      // Build editable results
      const editable: EditableResult[] = allResults.map((result, i) => ({
        file: files[result.file_index] || files[i],
        result,
        editedFields: Object.fromEntries(
          Object.entries(result.fields).map(([k, v]) => [k, v || ''])
        ),
        productName: result.product_names[0] || '',
        importing: false,
        imported: false,
        confidenceScore: result.confidence_score,
        autoIngesting: false,
        correctionsSaved: false,
      }));

      setEditableResults(editable);
      setProcessingStatus(null);
      setStage('review');

      // Auto-ingest high confidence results (skip duplicates)
      for (let i = 0; i < editable.length; i++) {
        const item = editable[i];
        if (item.result.status === 'success' && item.confidenceScore >= autoIngestThreshold && !item.result.duplicate) {
          setEditableResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, autoIngesting: true } : r
          ));
          // Use a small delay to allow state to render
          setTimeout(() => handleImport(i), 100 * i);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed');
      setProcessingStatus(null);
      setStage('upload');
    }
  };

  // Stage 3: Import a single file
  const handleImport = async (index: number) => {
    const item = editableResults[index];
    if (!item || item.imported || item.result.status === 'error') return;

    // Mark importing
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, importing: true, importError: undefined } : r
    ));

    try {
      // Auto-save correction as training example if fields were edited
      const fieldsChanged = Object.keys(item.editedFields).some(
        k => item.editedFields[k] !== (item.result.fields[k] || '')
      );
      if (fieldsChanged && documentTypeId) {
        try {
          await api.extractionExamples.create({
            document_type_id: documentTypeId,
            tenant_id: effectiveTenantId || undefined,
            input_text: item.result.extracted_text_preview || '',
            ai_output: JSON.stringify(item.result.fields),
            corrected_output: JSON.stringify(item.editedFields),
            score: 0.8,
          });
          setEditableResults(prev => prev.map((r, i) =>
            i === index ? { ...r, correctionsSaved: true } : r
          ));
        } catch {
          // Non-critical -- don't block import
        }
      }

      // 1. Resolve product if name provided
      let productId: string | undefined;
      if (item.productName.trim()) {
        const prodResult = await api.products.lookupOrCreate({
          name: item.productName.trim(),
          tenant_id: effectiveTenantId,
        });
        productId = prodResult.product.id;
      }

      // 2. Build FormData for ingest
      const form = new FormData();
      form.append('file', item.file);
      form.append('tenant_id', effectiveTenantId);
      form.append('external_ref', `import-${Date.now()}-${index}-${item.file.name}`);
      form.append('title', item.file.name.replace(/\.[^/.]+$/, ''));
      form.append('document_type_id', documentTypeId);

      // Map well-known fields
      if (item.editedFields.lot_number) form.append('lot_number', item.editedFields.lot_number);
      if (item.editedFields.po_number) form.append('po_number', item.editedFields.po_number);
      if (item.editedFields.expiration_date) form.append('expiration_date', item.editedFields.expiration_date);
      if (item.editedFields.code_date) form.append('code_date', item.editedFields.code_date);

      if (productId) {
        form.append('product_ids', JSON.stringify([{ product_id: productId }]));
      }

      // 3. Call ingest via direct fetch (multipart form)
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

      // Mark imported
      setEditableResults(prev => prev.map((r, i) =>
        i === index ? { ...r, importing: false, imported: true, autoIngesting: false, documentId: result.document.id } : r
      ));

      setSnackbar({ open: true, message: `Imported ${item.file.name}`, severity: 'success' });
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
      if (!item.imported && item.result.status !== 'error' && !item.importError) {
        await handleImport(i);
      }
    }
  };

  // Reset to stage 1
  const handleStartOver = () => {
    setFiles([]);
    setDocumentTypeId('');
    setEditableResults([]);
    setError('');
    setProcessingStatus(null);
    setStage('upload');
  };

  // Update editable field
  const updateField = (index: number, fieldName: string, value: string) => {
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, editedFields: { ...r.editedFields, [fieldName]: value } } : r
    ));
  };

  // Update product name
  const updateProductName = (index: number, value: string) => {
    setEditableResults(prev => prev.map((r, i) =>
      i === index ? { ...r, productName: value } : r
    ));
  };

  // Rate extraction quality
  const handleRate = async (index: number, score: number) => {
    const item = editableResults[index];
    if (!item) return;
    try {
      await api.extractionExamples.create({
        document_type_id: documentTypeId,
        tenant_id: effectiveTenantId || undefined,
        input_text: item.result.extracted_text_preview || '',
        ai_output: JSON.stringify(item.result.fields),
        corrected_output: JSON.stringify(item.editedFields),
        score,
      });
      setEditableResults(prev => prev.map((r, i) =>
        i === index ? { ...r, ratingSubmitted: score >= 0.5 ? 'up' as const : 'down' as const } : r
      ));
      setSnackbar({ open: true, message: 'Rating saved', severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: 'Failed to save rating', severity: 'error' });
    }
  };

  const confidenceColor = (c: string): 'success' | 'warning' | 'error' => {
    if (c === 'high') return 'success';
    if (c === 'medium') return 'warning';
    return 'error';
  };

  const importableCount = editableResults.filter(r => !r.imported && r.result.status !== 'error' && !r.importError).length;
  const importedCount = editableResults.filter(r => r.imported).length;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Import
        </Typography>
        {stage === 'review' && (
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

          {/* Document type selector */}
          <FormControl fullWidth sx={{ mb: 3 }}>
            <InputLabel>Document Type</InputLabel>
            <Select
              value={documentTypeId}
              onChange={(e) => setDocumentTypeId(e.target.value)}
              label="Document Type"
              required
              disabled={documentTypes.length === 0}
            >
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
            {effectiveTenantId && documentTypes.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                No document types found for this tenant. Create one in Document Types admin first.
              </Typography>
            )}
          </FormControl>

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

          {/* Process button */}
          <Button
            variant="contained"
            size="large"
            onClick={handleProcess}
            disabled={files.length === 0 || !documentTypeId || (isSuperAdmin && !tenantId)}
            startIcon={<UploadIcon />}
            fullWidth={isMobile}
          >
            Process {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : ''}
          </Button>
        </Box>
      )}

      {/* Stage 2: Processing */}
      {stage === 'processing' && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <CircularProgress size={48} sx={{ mb: 2 }} />
          <Typography variant="h6" gutterBottom>
            {processingStatus
              ? `Processing file ${processingStatus.current} of ${processingStatus.total}`
              : `Processing ${files.length} file${files.length > 1 ? 's' : ''}...`}
          </Typography>
          {processingStatus && processingStatus.fileName && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {processingStatus.fileName}
            </Typography>
          )}
          <LinearProgress
            variant={processingStatus ? 'determinate' : 'indeterminate'}
            value={processingStatus ? (processingStatus.current / processingStatus.total) * 100 : undefined}
            sx={{ maxWidth: 400, mx: 'auto', mb: 2 }}
          />
          <Typography variant="body2" color="text.secondary">
            Extracting fields using AI
          </Typography>
          {showSlowMessage && (
            <Alert severity="info" sx={{ maxWidth: 500, mx: 'auto', mt: 3 }}>
              The AI model may take up to 60 seconds on first request while it loads into memory.
            </Alert>
          )}
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

          {/* Results cards */}
          {editableResults.map((item, index) => (
            <Card key={index} variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                {/* Header row */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
                  <FileIcon color="primary" fontSize="small" />
                  <Typography variant="subtitle1" fontWeight={600} sx={{ flex: 1 }}>
                    {item.file.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatFileSize(item.file.size)}
                  </Typography>
                  {item.result.status === 'success' && (
                    <>
                      <Chip
                        label={item.result.confidence}
                        size="small"
                        color={confidenceColor(item.result.confidence)}
                        variant="outlined"
                      />
                      <Typography variant="body2" fontWeight={600} color="text.secondary">
                        {Math.round(item.confidenceScore * 100)}%
                      </Typography>
                    </>
                  )}
                  {item.autoIngesting && !item.imported && (
                    <Chip label="Auto-importing..." size="small" color="info" icon={<CircularProgress size={14} />} />
                  )}
                  {item.imported && item.autoIngesting && (
                    <Chip label="Auto-imported" size="small" color="success" icon={<CheckIcon />} />
                  )}
                  {item.imported && !item.autoIngesting && (
                    <Chip label="Imported" size="small" color="success" icon={<CheckIcon />} />
                  )}
                </Box>

                {/* Error state */}
                {item.result.status === 'error' && (
                  <Alert severity="error">
                    {item.result.error_message || 'Processing failed for this file.'}
                  </Alert>
                )}

                {/* Import error */}
                {item.importError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    Import failed: {item.importError}
                  </Alert>
                )}

                {/* Duplicate warning */}
                {item.result.duplicate && !item.imported && (
                  <Alert
                    severity="warning"
                    sx={{ mb: 2 }}
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        startIcon={<OpenIcon />}
                        onClick={() => navigate(`/documents/${item.result.duplicate!.document_id}`)}
                      >
                        View Existing
                      </Button>
                    }
                  >
                    This file appears to be a duplicate of &ldquo;{item.result.duplicate.document_title}&rdquo;.
                    Importing will add a new version.
                  </Alert>
                )}

                {/* Success state: split layout with preview + editable fields */}
                {item.result.status === 'success' && !item.imported && (
                  <Box sx={{ display: 'flex', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
                    {/* File preview */}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <LocalFilePreview file={item.file} />
                    </Box>

                    {/* Editable fields */}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      {/* Extracted text preview */}
                      {item.result.extracted_text_preview && (
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
                              {item.result.extracted_text_preview}
                            </Typography>
                          </AccordionDetails>
                        </Accordion>
                      )}

                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                        {Object.entries(item.editedFields).map(([fieldName, fieldValue]) => (
                          <TextField
                            key={fieldName}
                            label={fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                            value={fieldValue}
                            onChange={(e) => updateField(index, fieldName, e.target.value)}
                            size="small"
                            fullWidth
                            disabled={item.importing}
                          />
                        ))}

                        {/* Product name */}
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
              {item.result.status === 'success' && !item.imported && (
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
          ))}
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
