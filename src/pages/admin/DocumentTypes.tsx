import { useState, useEffect, useRef } from 'react';
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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Tooltip,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  Divider,
  Slider,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiDocumentType, ExtractionField } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';

const PLACEHOLDERS = [
  { label: '{title}', description: 'Document title' },
  { label: '{lot_number}', description: 'Lot number' },
  { label: '{po_number}', description: 'PO number' },
  { label: '{code_date}', description: 'Code date' },
  { label: '{expiration_date}', description: 'Expiration date' },
  { label: '{doc_type}', description: 'Document type' },
  { label: '{product}', description: 'Product name' },
  { label: '{date}', description: 'Current date' },
  { label: '{ext}', description: 'File extension' },
];

const SAMPLE_DATA: Record<string, string> = {
  title: 'COA Dairy Gold Butter',
  lot_number: 'LOT-2024-001',
  po_number: 'PO-5678',
  code_date: '2024-06-15',
  expiration_date: '2025-06-15',
  doc_type: 'COA',
  product: 'Butter',
  date: new Date().toISOString().split('T')[0],
  ext: 'pdf',
};

const SUGGESTED_FIELDS = [
  'Lot Number',
  'PO Number',
  'Expiration Date',
  'Code Date',
  'Product Name',
  'Supplier Name',
  'Customer Name',
];

function applyTemplate(template: string): string {
  let result = template;
  for (const [key, value] of Object.entries(SAMPLE_DATA)) {
    result = result.split(`{${key}}`).join(value);
  }
  return result;
}

function parseExtractionFields(raw: string | ExtractionField[] | null): ExtractionField[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function DocumentTypes() {
  const [documentTypes, setDocumentTypes] = useState<ApiDocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId } = useTenant();

  // Filter state
  const [tenantFilter, setTenantFilter] = useState<string>('');

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<ApiDocumentType | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [formNamingFormat, setFormNamingFormat] = useState('');
  const [formExtractFields, setFormExtractFields] = useState<ExtractionField[]>([]);
  const [formAutoIngestThreshold, setFormAutoIngestThreshold] = useState(0.8);
  const [saving, setSaving] = useState(false);

  const [fieldInput, setFieldInput] = useState('');

  const namingInputRef = useRef<HTMLInputElement>(null);

  const loadDocumentTypes = async () => {
    setLoading(true);
    setError('');
    try {
      const tenantId = isSuperAdmin
        ? (tenantFilter || selectedTenantId || undefined)
        : user?.tenant_id || undefined;
      const result = await api.documentTypes.list({
        tenant_id: tenantId,
      });
      setDocumentTypes(result.documentTypes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load document types');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocumentTypes();
  }, [tenantFilter, selectedTenantId]);

  const openCreate = () => {
    setEditingType(null);
    setFormName('');
    setFormDescription('');
    setFormNamingFormat('');
    setFormExtractFields([]);
    setFormAutoIngestThreshold(0.8);
    setFieldInput('');
    setAliasInputs({});
    setFormTenantId(
      isSuperAdmin
        ? (tenantFilter || selectedTenantId || '')
        : (user?.tenant_id || '')
    );
    setDialogOpen(true);
  };

  const openEdit = (dt: ApiDocumentType) => {
    setEditingType(dt);
    setFormName(dt.name);
    setFormDescription(dt.description || '');
    setFormNamingFormat(dt.naming_format || '');
    setFormExtractFields(parseExtractionFields(dt.extraction_fields));
    setFormAutoIngestThreshold((dt as any).auto_ingest_threshold ?? 0.8);
    setFieldInput('');
    setAliasInputs({});
    setFormTenantId(dt.tenant_id);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const extractFields = formExtractFields.length > 0 ? formExtractFields : undefined;
      const namingFormat = formNamingFormat.trim() || undefined;

      if (editingType) {
        await api.documentTypes.update(editingType.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          naming_format: namingFormat ?? null,
          extraction_fields: extractFields ?? null,
          auto_ingest_threshold: formAutoIngestThreshold,
        });
      } else {
        const tenantId = isSuperAdmin ? formTenantId : user?.tenant_id;
        if (!tenantId) {
          setError('A tenant must be selected.');
          setSaving(false);
          return;
        }
        await api.documentTypes.create({
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          tenant_id: tenantId,
          naming_format: namingFormat,
          extraction_fields: extractFields,
          auto_ingest_threshold: formAutoIngestThreshold,
        });
      }
      setDialogOpen(false);
      loadDocumentTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document type');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (dt: ApiDocumentType) => {
    try {
      await api.documentTypes.update(dt.id, { active: dt.active ? 0 : 1 });
      loadDocumentTypes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document type');
    }
  };

  const insertPlaceholder = (placeholder: string) => {
    const input = namingInputRef.current;
    if (input) {
      const start = input.selectionStart ?? formNamingFormat.length;
      const end = input.selectionEnd ?? formNamingFormat.length;
      const newValue = formNamingFormat.slice(0, start) + placeholder + formNamingFormat.slice(end);
      setFormNamingFormat(newValue);
      setTimeout(() => {
        input.focus();
        const newPos = start + placeholder.length;
        input.setSelectionRange(newPos, newPos);
      }, 0);
    } else {
      setFormNamingFormat(formNamingFormat + placeholder);
    }
  };

  const addField = (name: string) => {
    if (!name.trim() || formExtractFields.some((f) => f.name === name.trim())) return;
    setFormExtractFields([...formExtractFields, { name: name.trim() }]);
    setFieldInput('');
  };

  const removeField = (name: string) => {
    setFormExtractFields(formExtractFields.filter((f) => f.name !== name));
  };

  const updateFieldHint = (name: string, hint: string) => {
    setFormExtractFields(
      formExtractFields.map((f) =>
        f.name === name ? { ...f, hint: hint || undefined } : f
      )
    );
  };

  const addFieldAlias = (name: string, alias: string) => {
    if (!alias.trim()) return;
    setFormExtractFields(
      formExtractFields.map((f) => {
        if (f.name !== name) return f;
        const existing = f.aliases || [];
        if (existing.includes(alias.trim())) return f;
        return { ...f, aliases: [...existing, alias.trim()] };
      })
    );
  };

  const removeFieldAlias = (name: string, alias: string) => {
    setFormExtractFields(
      formExtractFields.map((f) => {
        if (f.name !== name) return f;
        const updated = (f.aliases || []).filter((a) => a !== alias);
        return { ...f, aliases: updated.length > 0 ? updated : undefined };
      })
    );
  };

  const [aliasInputs, setAliasInputs] = useState<Record<string, string>>({});

  const handleFieldKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (fieldInput.trim()) {
        addField(fieldInput.trim());
      }
    }
  };

  const availableSuggestions = SUGGESTED_FIELDS.filter(
    (s) => !formExtractFields.some((f) => f.name === s)
  );

  const getTenantName = (tenantId: string) => {
    const tenant = tenants.find((t) => t.id === tenantId);
    return tenant?.name || tenantId;
  };

  const namingPreview = formNamingFormat ? applyTemplate(formNamingFormat) : '';

  if (loading && documentTypes.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Document Types
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add Document Type
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Tenant filter for super_admin */}
      {isSuperAdmin && (
        <FormControl size="small" sx={{ mb: 2, minWidth: 200 }}>
          <InputLabel>Filter by Tenant</InputLabel>
          <Select
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            label="Filter by Tenant"
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

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {documentTypes.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No document types found</Typography>
              </CardContent>
            </Card>
          ) : (
            documentTypes.map((dt) => (
              <Card key={dt.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {dt.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {dt.slug}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => openEdit(dt)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(dt)}>
                        {dt.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  {dt.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {dt.description}
                    </Typography>
                  )}
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={dt.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={dt.active ? 'success' : 'default'}
                      variant="outlined"
                    />
                    {isSuperAdmin && dt.tenant_name && (
                      <Chip label={dt.tenant_name} size="small" variant="outlined" />
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Slug</TableCell>
                <TableCell>Description</TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documentTypes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isSuperAdmin ? 7 : 6} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No document types found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                documentTypes.map((dt) => (
                  <TableRow key={dt.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {dt.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" fontFamily="monospace">
                        {dt.slug}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dt.description || '-'}
                      </Typography>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell>{dt.tenant_name || getTenantName(dt.tenant_id)}</TableCell>
                    )}
                    <TableCell>
                      <Chip
                        label={dt.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={dt.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>{formatDate(dt.created_at)}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(dt)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={dt.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(dt)}>
                          {dt.active ? (
                            <BlockIcon fontSize="small" color="warning" />
                          ) : (
                            <ActiveIcon fontSize="small" color="success" />
                          )}
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingType ? 'Edit Document Type' : 'Add Document Type'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {isSuperAdmin && !editingType && (
            <FormControl fullWidth sx={{ mt: 1, mb: 2 }}>
              <InputLabel>Tenant</InputLabel>
              <Select
                value={formTenantId}
                onChange={(e) => setFormTenantId(e.target.value)}
                label="Tenant"
                disabled={saving}
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
            label="Name"
            fullWidth
            required
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            autoFocus
            sx={{ mt: isSuperAdmin && !editingType ? 0 : 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={2}
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />

          <Divider sx={{ my: 1 }} />

          {/* Naming Format Section */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Naming Format (optional)
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Define how files of this type are named during ingest. Click placeholders to insert.
            </Typography>
            <TextField
              fullWidth
              value={formNamingFormat}
              onChange={(e) => setFormNamingFormat(e.target.value)}
              inputRef={namingInputRef}
              placeholder="e.g. {doc_type}_{product}_{lot_number}.{ext}"
              disabled={saving}
              size="small"
              InputProps={{
                sx: { fontFamily: 'monospace' },
              }}
              sx={{ mb: 1.5 }}
            />
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
              {PLACEHOLDERS.map((p) => (
                <Chip
                  key={p.label}
                  label={p.label}
                  onClick={() => insertPlaceholder(p.label)}
                  variant="outlined"
                  color="primary"
                  size="small"
                  clickable
                  title={p.description}
                  disabled={saving}
                  sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}
                />
              ))}
            </Box>
            {namingPreview && (
              <Box sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Preview:
                </Typography>
                <Typography variant="body2" fontFamily="monospace" sx={{ wordBreak: 'break-all' }}>
                  {namingPreview}
                </Typography>
              </Box>
            )}
          </Box>

          <Divider sx={{ my: 1 }} />

          {/* Extraction Fields Section */}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Extraction Fields
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Add fields to extract for this document type. Type a name and press Enter, or click a suggestion.
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
              <TextField
                fullWidth
                size="small"
                placeholder="e.g. Batch ID, Manufacturer, Weight..."
                value={fieldInput}
                onChange={(e) => setFieldInput(e.target.value)}
                onKeyDown={handleFieldKeyDown}
                disabled={saving}
              />
              <Button
                variant="outlined"
                size="small"
                onClick={() => fieldInput.trim() && addField(fieldInput.trim())}
                disabled={saving || !fieldInput.trim()}
                sx={{ whiteSpace: 'nowrap' }}
              >
                Add
              </Button>
            </Box>
            {availableSuggestions.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                {availableSuggestions.map((s) => (
                  <Chip
                    key={s}
                    label={s}
                    size="small"
                    variant="outlined"
                    clickable
                    onClick={() => addField(s)}
                    disabled={saving}
                    sx={{ fontSize: '0.75rem' }}
                  />
                ))}
              </Box>
            )}
            {formExtractFields.length > 0 && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {formExtractFields.map((ef) => (
                  <Box
                    key={ef.name}
                    sx={{
                      py: 1,
                      px: 1.5,
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <Chip
                      label={ef.name}
                      onDelete={() => removeField(ef.name)}
                      size="small"
                      disabled={saving}
                      sx={{ mb: 0.75 }}
                    />
                    <TextField
                      fullWidth
                      size="small"
                      placeholder="Optional hint for AI extraction..."
                      value={ef.hint || ''}
                      onChange={(e) => updateFieldHint(ef.name, e.target.value)}
                      disabled={saving}
                      sx={{ mb: 0.75, '& .MuiInputBase-input': { fontSize: '0.8rem', py: 0.5 } }}
                    />
                    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
                      {(ef.aliases || []).map((alias) => (
                        <Chip
                          key={alias}
                          label={alias}
                          size="small"
                          variant="outlined"
                          onDelete={() => removeFieldAlias(ef.name, alias)}
                          disabled={saving}
                          sx={{ fontSize: '0.7rem', height: 22 }}
                        />
                      ))}
                      <TextField
                        size="small"
                        placeholder="Add alias..."
                        value={aliasInputs[ef.name] || ''}
                        onChange={(e) => setAliasInputs({ ...aliasInputs, [ef.name]: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const val = aliasInputs[ef.name];
                            if (val?.trim()) {
                              addFieldAlias(ef.name, val);
                              setAliasInputs({ ...aliasInputs, [ef.name]: '' });
                            }
                          }
                        }}
                        disabled={saving}
                        sx={{ flex: '0 1 140px', '& .MuiInputBase-input': { fontSize: '0.75rem', py: 0.25, px: 0.75 } }}
                      />
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          <Divider sx={{ my: 1 }} />

          {/* Auto-Ingest Threshold */}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Auto-Ingest Threshold: {Math.round(formAutoIngestThreshold * 100)}%
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Documents above this confidence score will be automatically imported
            </Typography>
            <Slider
              value={formAutoIngestThreshold}
              onChange={(_, val) => setFormAutoIngestThreshold(val as number)}
              min={0.5}
              max={1.0}
              step={0.05}
              marks={[
                { value: 0.5, label: '50%' },
                { value: 0.75, label: '75%' },
                { value: 1.0, label: '100%' },
              ]}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
              disabled={saving}
              sx={{ mx: 1 }}
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || saving || (!editingType && isSuperAdmin && !formTenantId)}
          >
            {saving ? 'Saving...' : editingType ? 'Save Changes' : 'Add Document Type'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
