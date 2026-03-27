import { useState, useEffect, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  Paper,
  Chip,
  CircularProgress,
  Alert,
  Snackbar,
  Divider,
} from '@mui/material';
import {
  Save as SaveIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
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

function applyTemplate(template: string): string {
  let result = template;
  for (const [key, value] of Object.entries(SAMPLE_DATA)) {
    result = result.split(`{${key}}`).join(value);
  }
  return result;
}

export function NamingTemplate() {
  const [template, setTemplate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const inputRef = useRef<HTMLInputElement>(null);

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const effectiveTenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : (user?.tenant_id || undefined);

  const loadTemplate = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.namingTemplates.get(effectiveTenantId);
      setTemplate(result.template?.template || '{title}.{ext}');
    } catch (err) {
      // If no template exists yet, use a sensible default
      setTemplate('{title}.{ext}');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplate();
  }, [effectiveTenantId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.namingTemplates.update({
        template,
        tenant_id: effectiveTenantId,
      });
      setSnackbar({ open: true, message: 'Naming template saved successfully', severity: 'success' });
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to save template',
        severity: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const insertPlaceholder = (placeholder: string) => {
    const input = inputRef.current;
    if (input) {
      const start = input.selectionStart ?? template.length;
      const end = input.selectionEnd ?? template.length;
      const newValue = template.slice(0, start) + placeholder + template.slice(end);
      setTemplate(newValue);
      // Restore cursor position after React re-render
      setTimeout(() => {
        input.focus();
        const newPos = start + placeholder.length;
        input.setSelectionRange(newPos, newPos);
      }, 0);
    } else {
      setTemplate(template + placeholder);
    }
  };

  const preview = applyTemplate(template);

  if (loading) {
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
          Naming Template
        </Typography>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={saving || !template.trim()}
        >
          {saving ? 'Saving...' : 'Save Template'}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Template Pattern
        </Typography>
        <TextField
          fullWidth
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          inputRef={inputRef}
          placeholder="e.g. {doc_type}_{product}_{lot_number}.{ext}"
          sx={{ mb: 2, fontFamily: 'monospace' }}
          InputProps={{
            sx: { fontFamily: 'monospace' },
          }}
        />

        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Available Placeholders
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Click a placeholder to insert it at the cursor position.
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {PLACEHOLDERS.map((p) => (
            <Chip
              key={p.label}
              label={p.label}
              onClick={() => insertPlaceholder(p.label)}
              variant="outlined"
              color="primary"
              clickable
              title={p.description}
              sx={{ fontFamily: 'monospace' }}
            />
          ))}
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Live Preview
        </Typography>
        <Divider sx={{ mb: 2 }} />

        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            Sample output:
          </Typography>
          <Typography
            variant="h6"
            fontFamily="monospace"
            sx={{
              p: 1.5,
              bgcolor: 'action.hover',
              borderRadius: 1,
              wordBreak: 'break-all',
            }}
          >
            {preview || '(empty template)'}
          </Typography>
        </Box>

        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Sample Data Used
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {Object.entries(SAMPLE_DATA).map(([key, value]) => (
            <Box key={key} sx={{ display: 'flex', gap: 1 }}>
              <Typography variant="body2" fontFamily="monospace" color="text.secondary" sx={{ minWidth: 140 }}>
                {`{${key}}`}
              </Typography>
              <Typography variant="body2">
                {value}
              </Typography>
            </Box>
          ))}
        </Box>
      </Paper>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          variant="filled"
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
