import { useState, useEffect, useRef, useCallback } from 'react';
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
  Paper,
  Alert,
  Chip,
  IconButton,
  Autocomplete,
  CircularProgress,
  Divider,
  FormHelperText,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  CloudUpload as UploadIcon,
  Close as CloseIcon,
  InsertDriveFile as FileIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiDocumentType, ApiProduct, RenewalType } from '../lib/types';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import SupplierAutocomplete, { type SupplierValue } from '../components/SupplierAutocomplete';
import { HelpWell } from '../components/HelpWell';

const RENEWAL_OPTIONS: { value: RenewalType; label: string; hasInterval: boolean }[] = [
  { value: 'renewal_application', label: 'Renewal application (must re-file before it lapses)', hasInterval: true },
  { value: 'hard_expiry', label: 'Hard expiry (expires on a date, no renewal)', hasInterval: false },
  { value: 'keep_current', label: 'Keep current (keep latest on file, no cadence)', hasInterval: false },
  { value: 'review_cycle', label: 'Review cycle (periodic review)', hasInterval: true },
];

const OWNER_SUGGESTIONS = ['QA', 'Insurance', 'Finance', 'Ops', 'Admin'];
const APPLIES_TO_SUGGESTIONS = ['Kent', 'Portland', 'company'];

/**
 * "Add Document" — the manual single-doc registry upload path.
 *
 * A QA manager uploads ONE file and sets rich metadata by hand (nothing is
 * AI-extracted — that's the Import flow). Posts to POST /api/documents/ingest.
 * Deliberately does NOT deal with versions / archives / renditions.
 */
export function DocumentCreate() {
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const effectiveTenantId = isSuperAdmin ? (selectedTenantId || '') : (user?.tenant_id || '');

  // File
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Core fields
  const [title, setTitle] = useState('');
  const [docId, setDocId] = useState('');
  const [description, setDescription] = useState('');

  // Categories (multi) + primary
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [primaryCategoryId, setPrimaryCategoryId] = useState<string>('');

  // Registry list fields
  const [aliases, setAliases] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [appliesTo, setAppliesTo] = useState<string[]>([]);
  const [owner, setOwner] = useState('');

  // Renewal
  const [renewalType, setRenewalType] = useState<RenewalType | ''>('');
  const [renewalIntervalMonths, setRenewalIntervalMonths] = useState('');
  const [renewalDueDate, setRenewalDueDate] = useState('');

  // Dates -> primary_metadata
  const [effectiveDate, setEffectiveDate] = useState('');
  const [reviewDueDate, setReviewDueDate] = useState('');

  // Supplier
  const [supplierValue, setSupplierValue] = useState<SupplierValue>({ supplierName: '', verified: false });

  // Products (collected as product_ids for ingest)
  const [productOptions, setProductOptions] = useState<ApiProduct[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<ApiProduct[]>([]);
  const [productSearching, setProductSearching] = useState(false);

  // Provenance
  const [sourcePath, setSourcePath] = useState('');
  const [sharepointUrl, setSharepointUrl] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load tenant document types (categories).
  useEffect(() => {
    if (!effectiveTenantId) return;
    api.documentTypes
      .list({ tenant_id: effectiveTenantId, active: 1 })
      .then((r) => setDocumentTypes(r.documentTypes || []))
      .catch(() => setDocumentTypes([]));
  }, [effectiveTenantId]);

  // Debounced product search.
  const searchProducts = useCallback((query: string) => {
    if (!effectiveTenantId) return;
    setProductSearching(true);
    api.products
      .list({ search: query || undefined, active: 1, limit: 20, tenant_id: effectiveTenantId })
      .then((r) => setProductOptions(r.products || []))
      .catch(() => setProductOptions([]))
      .finally(() => setProductSearching(false));
  }, [effectiveTenantId]);

  useEffect(() => {
    if (effectiveTenantId) searchProducts('');
  }, [effectiveTenantId, searchProducts]);

  const pickFile = (f: File | null) => {
    setFile(f);
    if (f && !title.trim()) setTitle(f.name.replace(/\.[^/.]+$/, ''));
  };

  const toggleCategory = (id: string, checked: boolean) => {
    setCategoryIds((prev) => {
      const next = checked ? [...prev, id] : prev.filter((c) => c !== id);
      // Keep a valid primary: default to the first selected.
      setPrimaryCategoryId((cur) => {
        if (next.length === 0) return '';
        if (!cur || !next.includes(cur)) return next[0];
        return cur;
      });
      return next;
    });
  };

  const renewalHasInterval = RENEWAL_OPTIONS.find((o) => o.value === renewalType)?.hasInterval;

  const handleSubmit = async () => {
    setError('');
    if (!file) { setError('Please choose a file to upload.'); return; }
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!effectiveTenantId) { setError('Select a tenant first.'); return; }

    setSaving(true);
    try {
      // Resolve supplier (id if picked, else find-or-create a verified name).
      let supplierId: string | undefined = supplierValue.supplierId;
      if (!supplierId && supplierValue.verified && supplierValue.supplierName.trim()) {
        try {
          const r = await api.suppliers.lookupOrCreate({
            name: supplierValue.supplierName.trim(),
            tenant_id: effectiveTenantId,
          });
          supplierId = r.supplier.id;
        } catch { /* leave unset */ }
      }

      // Dates -> primary_metadata.
      const primaryMetadata: Record<string, string | null> = {};
      if (effectiveDate) primaryMetadata.effective_date = effectiveDate;
      if (reviewDueDate) primaryMetadata.review_due_date = reviewDueDate;

      // Provenance -> source_metadata.
      const sourceMetadata: Record<string, unknown> = {};
      if (sourcePath.trim()) sourceMetadata.source_path = sourcePath.trim();
      if (sharepointUrl.trim()) sourceMetadata.sharepoint_url = sharepointUrl.trim();

      const created = await api.documents.ingest({
        file,
        externalRef: docId.trim() || undefined,
        tenantId: effectiveTenantId,
        title: title.trim(),
        description: description.trim() || undefined,
        categories: categoryIds.length > 0 ? categoryIds : undefined,
        primaryCategoryId: primaryCategoryId || undefined,
        aliases: aliases.length > 0 ? aliases : undefined,
        criteria: criteria.length > 0 ? criteria : undefined,
        appliesTo: appliesTo.length > 0 ? appliesTo : undefined,
        owner: owner.trim() || undefined,
        renewalType: renewalType || undefined,
        renewalIntervalMonths:
          renewalHasInterval && renewalIntervalMonths ? parseInt(renewalIntervalMonths, 10) : undefined,
        renewalDueDate: renewalDueDate || undefined,
        supplierId,
        productIds: selectedProducts.length > 0 ? selectedProducts.map((p) => ({ product_id: p.id })) : undefined,
        primaryMetadata: Object.keys(primaryMetadata).length > 0 ? primaryMetadata : undefined,
        sourceMetadata: Object.keys(sourceMetadata).length > 0 ? sourceMetadata : undefined,
      });

      navigate(`/documents/${created.document.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document');
      setSaving(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 860, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate('/documents')}><BackIcon /></IconButton>
        <Typography variant="h4" fontWeight={700}>Add Document</Typography>
      </Box>

      <HelpWell id="documents.create" title="Add a document to the registry">
        Upload one file and describe it by hand. Aliases power natural-language search
        (the names staff might ask for); categories let one document satisfy several
        document-type mappings.
      </HelpWell>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {/* File + core */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Paper
          variant="outlined"
          onClick={() => fileInputRef.current?.click()}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) pickFile(f); }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          sx={{
            border: '2px dashed',
            borderColor: dragOver ? 'primary.main' : 'divider',
            borderRadius: 2,
            p: 3,
            textAlign: 'center',
            cursor: 'pointer',
            mb: 2,
            bgcolor: dragOver ? 'action.hover' : 'transparent',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => { const f = e.target.files?.[0] || null; pickFile(f); e.target.value = ''; }}
          />
          {file ? (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
              <FileIcon color="primary" />
              <Typography variant="body2">{file.name}</Typography>
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ) : (
            <>
              <UploadIcon sx={{ fontSize: 40, color: 'text.secondary', mb: 1 }} />
              <Typography color="text.secondary">Drag a file here, or click to browse</Typography>
            </>
          )}
        </Paper>

        <TextField
          label="Title"
          required
          fullWidth
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          sx={{ mb: 2 }}
        />
        <TextField
          label="Document ID (optional)"
          fullWidth
          value={docId}
          onChange={(e) => setDocId(e.target.value)}
          helperText="External reference / QFD doc_id. Leave blank to auto-generate."
          sx={{ mb: 2 }}
        />
        <TextField
          label="Description"
          fullWidth
          multiline
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Paper>

      {/* Categories */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Categories</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          One document, many mappings. Pick every document type this satisfies, then star the primary.
        </Typography>
        {documentTypes.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No document types defined for this tenant yet.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {documentTypes.map((dt) => {
              const selected = categoryIds.includes(dt.id);
              const isPrimary = primaryCategoryId === dt.id;
              return (
                <Chip
                  key={dt.id}
                  label={dt.name}
                  color={selected ? 'primary' : 'default'}
                  variant={selected ? 'filled' : 'outlined'}
                  onClick={() => toggleCategory(dt.id, !selected)}
                  icon={
                    selected ? (
                      <IconButton
                        size="small"
                        sx={{ p: 0, color: 'inherit' }}
                        onClick={(e) => { e.stopPropagation(); setPrimaryCategoryId(dt.id); }}
                        aria-label="Set as primary category"
                      >
                        {isPrimary ? <StarIcon sx={{ fontSize: 16 }} /> : <StarBorderIcon sx={{ fontSize: 16 }} />}
                      </IconButton>
                    ) : undefined
                  }
                />
              );
            })}
          </Box>
        )}
        {categoryIds.length > 0 && (
          <FormHelperText sx={{ mt: 1 }}>
            Primary: {documentTypes.find((d) => d.id === primaryCategoryId)?.name || '—'} (click the star to change)
          </FormHelperText>
        )}
      </Paper>

      {/* Retrieval + regulatory */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Autocomplete
          multiple
          freeSolo
          options={[]}
          value={aliases}
          onChange={(_, v) => setAliases(v as string[])}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => <Chip label={option} size="small" {...getTagProps({ index })} key={option} />)
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Aliases"
              placeholder="Add a name…"
              helperText="Alternate names staff might ask for — these power natural-language search."
            />
          )}
          sx={{ mb: 2 }}
        />
        <Autocomplete
          multiple
          freeSolo
          options={[]}
          value={criteria}
          onChange={(_, v) => setCriteria(v as string[])}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => <Chip label={option} size="small" {...getTagProps({ index })} key={option} />)
          }
          renderInput={(params) => (
            <TextField {...params} label="Criteria" placeholder="Add a reference…" helperText="Regulatory references / criteria." />
          )}
          sx={{ mb: 2 }}
        />
        <Autocomplete
          multiple
          freeSolo
          options={APPLIES_TO_SUGGESTIONS}
          value={appliesTo}
          onChange={(_, v) => setAppliesTo(v as string[])}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => <Chip label={option} size="small" {...getTagProps({ index })} key={option} />)
          }
          renderInput={(params) => (
            <TextField {...params} label="Applies to" placeholder="Kent, Portland, company…" helperText="Facility / scope." />
          )}
          sx={{ mb: 2 }}
        />
        <Autocomplete
          freeSolo
          options={OWNER_SUGGESTIONS}
          value={owner}
          onInputChange={(_, v) => setOwner(v)}
          renderInput={(params) => <TextField {...params} label="Owner" placeholder="QA, Insurance, Finance…" />}
        />
      </Paper>

      {/* Renewal */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Renewal</Typography>
        <FormControl fullWidth sx={{ mb: 2 }}>
          <InputLabel>Renewal type</InputLabel>
          <Select
            value={renewalType}
            onChange={(e) => setRenewalType(e.target.value as RenewalType | '')}
            label="Renewal type"
          >
            <MenuItem value=""><em>None</em></MenuItem>
            {RENEWAL_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
        {renewalHasInterval && (
          <TextField
            label="Renewal interval (months)"
            type="number"
            fullWidth
            value={renewalIntervalMonths}
            onChange={(e) => setRenewalIntervalMonths(e.target.value)}
            sx={{ mb: 2 }}
          />
        )}
        <TextField
          label="Renewal due date"
          type="date"
          fullWidth
          value={renewalDueDate}
          onChange={(e) => setRenewalDueDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <Divider sx={{ my: 2 }} />
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            label="Effective date"
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ flex: '1 1 200px' }}
          />
          <TextField
            label="Review-due date"
            type="date"
            value={reviewDueDate}
            onChange={(e) => setReviewDueDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ flex: '1 1 200px' }}
          />
        </Box>
      </Paper>

      {/* Supplier + products */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Supplier & products</Typography>
        {effectiveTenantId && (
          <Box sx={{ mb: 2 }}>
            <SupplierAutocomplete
              tenantId={effectiveTenantId}
              value={supplierValue}
              onChange={setSupplierValue}
            />
          </Box>
        )}
        <Autocomplete
          multiple
          options={productOptions}
          value={selectedProducts}
          getOptionLabel={(o) => o.name}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          onChange={(_, v) => setSelectedProducts(v)}
          onInputChange={(_, v) => searchProducts(v)}
          loading={productSearching}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Link products (optional)"
              placeholder="Search products…"
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {productSearching ? <CircularProgress color="inherit" size={16} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
              }}
            />
          )}
        />
      </Paper>

      {/* Provenance */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>Provenance</Typography>
        <TextField
          label="Source path (vault)"
          fullWidth
          value={sourcePath}
          onChange={(e) => setSourcePath(e.target.value)}
          sx={{ mb: 2 }}
        />
        <TextField
          label="SharePoint URL"
          fullWidth
          value={sharepointUrl}
          onChange={(e) => setSharepointUrl(e.target.value)}
        />
      </Paper>

      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mb: 4 }}>
        <Button onClick={() => navigate('/documents')} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <UploadIcon />}
          onClick={handleSubmit}
          disabled={saving || !file || !title.trim()}
        >
          {saving ? 'Creating…' : 'Create Document'}
        </Button>
      </Box>
    </Box>
  );
}
