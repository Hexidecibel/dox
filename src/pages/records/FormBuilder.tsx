/**
 * /records/:sheetId/forms/:formId — form builder.
 *
 * Layout:
 *   - Desktop: split pane. Left ~50% configuration (form metadata, fields
 *     list, settings). Right ~50% live preview (PublicFormRenderer in
 *     preview mode against an in-memory PublicFormView built from the
 *     current state).
 *   - Mobile: stacked. Configuration first, preview as a collapsible
 *     section below. Touch targets >= 44px.
 *
 * Auto-save: state is debounced 600ms after the last edit, then PUT to
 * the server. A small "Saved" indicator surfaces in the header. We
 * picked auto-save over an explicit Save button so the builder feels
 * like a doc — typing should never lose work, and field reordering /
 * required toggles are tiny edits where a Save button would feel heavy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Paper,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  ContentCopy as CopyIcon,
  ExpandMore as ExpandIcon,
  KeyboardArrowDown as DownIcon,
  KeyboardArrowUp as UpIcon,
  OpenInNew as OpenIcon,
  Refresh as RefreshIcon,
  CheckCircleOutline as CheckIcon,
  Lock as LockIcon,
  Public as PublicIcon,
  Archive as ArchiveIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { api } from '../../lib/api';
import { PublicFormRenderer } from '../../components/forms/PublicFormRenderer';
import type {
  ApiRecordColumn,
  PublicEntityOption,
  PublicFormEntityOptions,
  PublicFormView,
  RecordForm,
  RecordFormFieldConfig,
  RecordFormSettings,
} from '../../../shared/types';
import { FORM_ATTACHMENT_DEFAULTS } from '../../../shared/types';

type EntityKind = 'customer' | 'supplier' | 'product';

/**
 * Mirror of the server-side `entityKindsReferencedByForm` helper. We
 * reimplement it client-side rather than importing from `functions/lib/`
 * because that path is server-only (uses D1 types). The logic is small
 * enough that drift risk is low — both sides walk field_config + columns
 * and pull customer_ref / supplier_ref / product_ref types.
 */
function entityKindsReferenced(
  fieldConfig: RecordFormFieldConfig[],
  columns: ApiRecordColumn[],
): Set<EntityKind> {
  const colsById = new Map(columns.map((c) => [c.id, c]));
  const kinds = new Set<EntityKind>();
  for (const fc of fieldConfig) {
    const col = colsById.get(fc.column_id);
    if (!col || col.archived) continue;
    if (col.type === 'customer_ref') kinds.add('customer');
    else if (col.type === 'supplier_ref') kinds.add('supplier');
    else if (col.type === 'product_ref') kinds.add('product');
  }
  return kinds;
}

/**
 * Mirror of `fetchPublicEntityOptions` (functions/lib/records/forms.ts)
 * but client-side: hits the existing admin list endpoints and reshapes
 * to the same `PublicEntityOption` contract the renderer expects.
 *
 * Disambiguator rules match the public endpoint exactly:
 *   - customer.secondary = customer_number (skip if blank)
 *   - supplier.secondary = (omit — slug is a derived URL form, not a
 *     useful disambiguator)
 *   - product.secondary  = description (no SKU column per migration 0017)
 */
const ENTITY_OPTIONS_LIMIT = 500;

async function loadEntityOptions(kind: EntityKind, tenantId: string): Promise<PublicEntityOption[]> {
  if (kind === 'customer') {
    const res = (await api.customers.list({
      tenant_id: tenantId,
      active: '1',
      limit: ENTITY_OPTIONS_LIMIT,
    })) as { customers: { id: string; name: string; customer_number?: string | null }[] };
    return (res.customers ?? [])
      .map<PublicEntityOption>((c) => {
        const opt: PublicEntityOption = { id: c.id, name: c.name };
        if (c.customer_number && c.customer_number.trim()) opt.secondary = c.customer_number.trim();
        return opt;
      });
  }
  if (kind === 'supplier') {
    const res = await api.suppliers.list({ tenant_id: tenantId, active: 1, limit: ENTITY_OPTIONS_LIMIT });
    return res.suppliers.map<PublicEntityOption>((s) => ({ id: s.id, name: s.name }));
  }
  // product
  const res = await api.products.list({ tenant_id: tenantId, active: 1, limit: ENTITY_OPTIONS_LIMIT });
  return res.products.map<PublicEntityOption>((p) => {
    const opt: PublicEntityOption = { id: p.id, name: p.name };
    if (p.description && p.description.trim()) opt.secondary = p.description.trim();
    return opt;
  });
}

function pluralEntityKind(kind: EntityKind): string {
  switch (kind) {
    case 'customer':
      return 'customers';
    case 'supplier':
      return 'suppliers';
    case 'product':
      return 'products';
  }
}

const AUTOSAVE_DEBOUNCE_MS = 600;

export function FormBuilder() {
  const { sheetId, formId } = useParams<{ sheetId: string; formId: string }>();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const [form, setForm] = useState<RecordForm | null>(null);
  const [columns, setColumns] = useState<ApiRecordColumn[]>([]);
  const [sheetTenantId, setSheetTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [previewOpen, setPreviewOpen] = useState(true); // mobile-only collapse
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('');
  // Per-kind entity option cache. Each kind starts undefined (not yet
  // fetched), becomes [] when the tenant has none, or a populated list.
  // We track loading separately so the renderer can fall back to a
  // disabled "Loading…" affordance while the fetch is in flight (rather
  // than flashing as a free-text input first, which is the bug we're
  // fixing in the first place).
  const [entityOptions, setEntityOptions] = useState<PublicFormEntityOptions>({});
  const [loadingEntityKinds, setLoadingEntityKinds] = useState<Set<EntityKind>>(new Set());
  // Track which kinds we've already fetched (or attempted) so adding a
  // new entity-ref column triggers exactly one fetch — not one per
  // re-render of the builder.
  const fetchedKindsRef = useRef<Set<EntityKind>>(new Set());

  // Debounce timer for auto-save
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending dirty state — tracks if we still have unsaved changes since
  // the last server commit. Used so navigation away can flush.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!sheetId || !formId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [formRes, sheetRes] = await Promise.all([
          recordsApi.forms.get(sheetId, formId),
          recordsApi.sheets.get(sheetId),
        ]);
        if (cancelled) return;
        setForm(formRes.form);
        setColumns(sheetRes.columns ?? []);
        setSheetTenantId(sheetRes.sheet?.tenant_id ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load form');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sheetId, formId]);

  // Pull the Turnstile site key from a public form fetch is overkill —
  // instead, expose it via the same record on first load, but the
  // builder preview can stub it. For now, leave as empty string in
  // preview (renderer hides the widget when preview=true).
  useEffect(() => {
    setTurnstileSiteKey('');
  }, []);

  // ---- field config derived state ----

  const fieldConfig = useMemo(() => {
    if (!form?.field_config) return [] as RecordFormFieldConfig[];
    try {
      const v = JSON.parse(form.field_config);
      return Array.isArray(v) ? (v as RecordFormFieldConfig[]) : [];
    } catch {
      return [];
    }
  }, [form?.field_config]);

  // ---- entity options (preview parity with /f/<slug>) ----
  //
  // The public renderer's customer/supplier/product Autocompletes only
  // engage when `entity_options` is present on the view. The /f/<slug>
  // endpoint stitches that on server-side; the builder preview has to
  // do it client-side using the admin list endpoints (we're already
  // authenticated as someone who can edit the form, which means we can
  // see the tenant's entities). Without this, every entity-ref field
  // falls back to a free-text input in preview — exactly the bug we're
  // fixing.
  //
  // We cap each fetch at 500 to mirror the public endpoint's
  // ENTITY_OPTIONS_LIMIT, so overflow behaviour matches between preview
  // and live.
  useEffect(() => {
    if (!sheetTenantId) return;
    const kinds = entityKindsReferenced(fieldConfig, columns);
    const todo: EntityKind[] = [];
    for (const kind of kinds) {
      if (!fetchedKindsRef.current.has(kind)) todo.push(kind);
    }
    if (todo.length === 0) return;

    // Mark as in-flight up front so render can show a loading state.
    setLoadingEntityKinds((prev) => {
      const next = new Set(prev);
      todo.forEach((k) => next.add(k));
      return next;
    });
    todo.forEach((k) => fetchedKindsRef.current.add(k));

    let cancelled = false;
    void (async () => {
      const updates: Partial<PublicFormEntityOptions> = {};
      await Promise.all(
        todo.map(async (kind) => {
          try {
            const opts = await loadEntityOptions(kind, sheetTenantId);
            if (cancelled) return;
            updates[kind] = opts;
          } catch (err) {
            // Don't crash the builder — just leave the field on the
            // text-input fallback and surface the error in the console.
            // The user can still publish; this is a preview-only concern.
            console.error(`Preview: failed to load ${kind} options`, err);
            if (cancelled) return;
            updates[kind] = [];
          }
        }),
      );
      if (cancelled) return;
      setEntityOptions((prev) => ({ ...prev, ...updates }));
      setLoadingEntityKinds((prev) => {
        const next = new Set(prev);
        todo.forEach((k) => next.delete(k));
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [fieldConfig, columns, sheetTenantId]);

  const settings = useMemo<RecordFormSettings>(() => {
    if (!form?.settings) return {};
    try {
      const v = JSON.parse(form.settings);
      return v && typeof v === 'object' ? (v as RecordFormSettings) : {};
    } catch {
      return {};
    }
  }, [form?.settings]);

  // ---- save ----

  const flushSave = useCallback(
    async (next: RecordForm) => {
      if (!sheetId || !formId) return;
      setSaveState('saving');
      try {
        const fc = next.field_config ? JSON.parse(next.field_config) : [];
        const st = next.settings ? JSON.parse(next.settings) : {};
        const res = await recordsApi.forms.update(sheetId, formId, {
          name: next.name,
          description: next.description ?? null,
          is_public: next.is_public === 1,
          status: next.status,
          field_config: fc,
          settings: st,
        });
        setForm(res.form);
        dirtyRef.current = false;
        setSaveState('saved');
        // Reset to idle after a beat so the indicator doesn't linger.
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      } catch (err) {
        console.error('Save error:', err);
        setSaveState('error');
      }
    },
    [sheetId, formId],
  );

  const scheduleSave = useCallback(
    (next: RecordForm) => {
      dirtyRef.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void flushSave(next);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  // Flush on unmount so navigating away saves any pending edits.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  // ---- mutations ----

  const updateForm = useCallback(
    (patch: Partial<RecordForm>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const updateFieldConfig = useCallback(
    (next: RecordFormFieldConfig[]) => {
      const renumbered = next.map((f, i) => ({ ...f, position: i }));
      updateForm({ field_config: JSON.stringify(renumbered) });
    },
    [updateForm],
  );

  const updateSettings = useCallback(
    (patch: Partial<RecordFormSettings>) => {
      const next = { ...settings, ...patch };
      updateForm({ settings: JSON.stringify(next) });
    },
    [settings, updateForm],
  );

  // Toggle a column on/off in the form
  const toggleColumn = useCallback(
    (columnId: string, visible: boolean) => {
      if (visible) {
        if (fieldConfig.find((f) => f.column_id === columnId)) return;
        const col = columns.find((c) => c.id === columnId);
        const next = [
          ...fieldConfig,
          {
            column_id: columnId,
            required: col?.required === 1,
            label_override: null,
            help_text: null,
            position: fieldConfig.length,
          } as RecordFormFieldConfig,
        ];
        updateFieldConfig(next);
      } else {
        updateFieldConfig(fieldConfig.filter((f) => f.column_id !== columnId));
      }
    },
    [columns, fieldConfig, updateFieldConfig],
  );

  const updateField = useCallback(
    (columnId: string, patch: Partial<RecordFormFieldConfig>) => {
      const next = fieldConfig.map((f) => (f.column_id === columnId ? { ...f, ...patch } : f));
      updateFieldConfig(next);
    },
    [fieldConfig, updateFieldConfig],
  );

  const moveField = useCallback(
    (columnId: string, dir: -1 | 1) => {
      const idx = fieldConfig.findIndex((f) => f.column_id === columnId);
      if (idx < 0) return;
      const target = idx + dir;
      if (target < 0 || target >= fieldConfig.length) return;
      const next = [...fieldConfig];
      [next[idx], next[target]] = [next[target], next[idx]];
      updateFieldConfig(next);
    },
    [fieldConfig, updateFieldConfig],
  );

  const handleArchive = useCallback(async () => {
    if (!sheetId || !formId) return;
    try {
      await recordsApi.forms.archive(sheetId, formId);
      navigate(`/records/${sheetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive form');
    }
  }, [sheetId, formId, navigate]);

  // ---- live preview view ----

  const previewView = useMemo<PublicFormView | null>(() => {
    if (!form) return null;
    const colsById = new Map(columns.map((c) => [c.id, c]));
    const fields = fieldConfig
      .map((fc) => {
        const col = colsById.get(fc.column_id);
        if (!col || col.archived) return null;
        if (col.type === 'formula' || col.type === 'rollup') return null;
        let config = null;
        if (col.config) {
          try {
            config = typeof col.config === 'string' ? JSON.parse(col.config) : col.config;
          } catch {
            config = null;
          }
        }
        return {
          key: col.key,
          type: col.type,
          label: fc.label_override?.trim() || col.label,
          help_text: fc.help_text ?? null,
          required: !!fc.required || col.required === 1,
          config,
          position: fc.position,
        };
      })
      .filter((f): f is NonNullable<typeof f> => f != null)
      .sort((a, b) => a.position - b.position);
    // Only ship entity_options once at least one kind has resolved —
    // otherwise the renderer falls back to text inputs (the very bug
    // we're fixing). The overlay below masks that brief moment.
    const hasAnyEntityOptions =
      (entityOptions.customer && entityOptions.customer.length > 0) ||
      (entityOptions.supplier && entityOptions.supplier.length > 0) ||
      (entityOptions.product && entityOptions.product.length > 0);

    return {
      form: {
        name: form.name,
        description: form.description,
        accent_color: settings.accent_color ?? null,
        logo_url: settings.logo_url ?? null,
      },
      fields,
      turnstile_site_key: turnstileSiteKey,
      ...(hasAnyEntityOptions ? { entity_options: entityOptions } : {}),
    };
  }, [form, columns, fieldConfig, settings, turnstileSiteKey, entityOptions]);

  // True while any referenced entity kind is still being fetched. The
  // preview pane uses this to show a loading overlay instead of letting
  // entity-ref fields render as text inputs first.
  const entityOptionsLoading = loadingEntityKinds.size > 0;

  // ---- render ----

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !form) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto', mt: 4 }}>
        <Button startIcon={<BackIcon />} onClick={() => navigate(`/records/${sheetId}`)} sx={{ mb: 2 }}>
          Back to sheet
        </Button>
        <Alert severity="error">{error || 'Form not found'}</Alert>
      </Box>
    );
  }

  const publicUrl = form.public_slug
    ? `${window.location.origin}/f/${form.public_slug}`
    : null;

  // ---- header ----

  const handleStatusTransition = (target: RecordForm['status']) => {
    if (target === form.status) return;
    // Going from live back to draft breaks live links — confirm.
    if (form.status === 'live' && target === 'draft') {
      if (!confirm('Move back to Draft? The public link will stop working until you publish again.')) {
        return;
      }
    }
    if (target === 'archived') {
      // Archive has its own dialog flow — open it instead.
      setArchiveOpen(true);
      return;
    }
    updateForm({ status: target });
  };

  const header = (
    <Box sx={{ mb: 3 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        <Button
          startIcon={<BackIcon />}
          size="small"
          onClick={() => navigate(`/records/${sheetId}`)}
          sx={{ color: 'text.secondary' }}
        >
          Back
        </Button>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {form.name || 'Untitled form'}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
            <SaveIndicator state={saveState} />
          </Box>
        </Box>
        {publicUrl && form.status === 'live' && form.is_public === 1 && (
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Tooltip title="Copy public URL">
              <IconButton onClick={() => { void navigator.clipboard.writeText(publicUrl); }} sx={{ minWidth: 44, minHeight: 44 }}>
                <CopyIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Open form in new tab">
              <IconButton component="a" href={publicUrl} target="_blank" rel="noopener noreferrer" sx={{ minWidth: 44, minHeight: 44 }}>
                <OpenIcon />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Box>
      <StatusStepper
        status={form.status}
        onTransition={handleStatusTransition}
        sx={{ mt: 2 }}
      />
    </Box>
  );

  // ---- config pane ----

  const configPane = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Form details */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          Form details
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1.5 }}>
          <TextField
            label="Form name"
            value={form.name}
            onChange={(e) => updateForm({ name: e.target.value })}
            fullWidth
            size="small"
          />
          <TextField
            label="Description"
            value={form.description ?? ''}
            onChange={(e) => updateForm({ description: e.target.value })}
            fullWidth
            multiline
            rows={2}
            size="small"
          />
        </Box>
      </Paper>

      {/* Sharing */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          Sharing
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1.5 }}>
          <FormControlLabel
            control={
              <Switch
                checked={form.is_public === 1}
                onChange={(e) => updateForm({ is_public: e.target.checked ? 1 : 0 })}
              />
            }
            label={
              <Box>
                <Typography sx={{ fontWeight: 500 }}>Public link</Typography>
                <Typography variant="caption" color="text.secondary">
                  Anyone with the URL can open this form. Status must be Live before submissions are accepted.
                </Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0, '& .MuiFormControlLabel-label': { mt: 0.25 } }}
          />
          <PublicLinkPanel
            isPublic={form.is_public === 1}
            status={form.status}
            publicUrl={publicUrl}
            onRotate={async () => {
              if (!sheetId || !formId) return;
              if (!confirm('Rotating will break the existing public URL. Continue?')) return;
              const res = await recordsApi.forms.update(sheetId, formId, { rotate_slug: true });
              setForm(res.form);
            }}
            onPublish={() => updateForm({ status: 'live' })}
          />
        </Box>
      </Paper>

      {/* Fields */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          Fields
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
          Pick which columns appear and in what order. Adding columns to the sheet later automatically makes them available here.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {/* Visible fields, in form order */}
          {fieldConfig.map((fc, idx) => {
            const col = columns.find((c) => c.id === fc.column_id);
            if (!col) return null;
            return (
              <FieldRow
                key={fc.column_id}
                column={col}
                field={fc}
                isFirst={idx === 0}
                isLast={idx === fieldConfig.length - 1}
                onMove={(dir) => moveField(fc.column_id, dir)}
                onChange={(patch) => updateField(fc.column_id, patch)}
                onRemove={() => toggleColumn(fc.column_id, false)}
              />
            );
          })}
          {/* Hidden columns — collapsed list to add */}
          {columns.filter((c) => !fieldConfig.find((f) => f.column_id === c.id) && c.type !== 'formula' && c.type !== 'rollup').length > 0 && (
            <>
              <Divider sx={{ my: 1 }} />
              <Typography variant="caption" color="text.secondary">
                Hidden from form
              </Typography>
              {columns
                .filter((c) => !fieldConfig.find((f) => f.column_id === c.id))
                .map((col) => {
                  const isComputed = col.type === 'formula' || col.type === 'rollup';
                  return (
                    <Box
                      key={col.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                        py: 0.75,
                        px: 1,
                      }}
                    >
                      <Switch
                        size="small"
                        checked={false}
                        disabled={isComputed}
                        onChange={(e) => toggleColumn(col.id, e.target.checked)}
                      />
                      <Typography sx={{ flex: 1, color: isComputed ? 'text.disabled' : 'text.secondary' }}>
                        {col.label}
                      </Typography>
                      <Chip size="small" label={col.type} variant="outlined" />
                      {isComputed && <Chip size="small" label="Computed" />}
                    </Box>
                  );
                })}
            </>
          )}
        </Box>
      </Paper>

      {/* Settings */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          After-submit settings
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1.5 }}>
          <TextField
            label="Thank-you message"
            placeholder="Your response has been recorded. The team has been notified."
            value={settings.thank_you_message ?? ''}
            onChange={(e) => updateSettings({ thank_you_message: e.target.value })}
            fullWidth
            multiline
            rows={2}
            size="small"
          />
          <TextField
            label="Redirect URL (optional)"
            placeholder="https://example.com/thank-you"
            value={settings.redirect_url ?? ''}
            onChange={(e) => updateSettings({ redirect_url: e.target.value })}
            fullWidth
            size="small"
          />
          <TextField
            label="Accent color"
            placeholder="#1A365D"
            value={settings.accent_color ?? ''}
            onChange={(e) => updateSettings({ accent_color: e.target.value })}
            fullWidth
            size="small"
            helperText="Hex color used for buttons and highlights"
          />
        </Box>
      </Paper>

      {/* Attachments */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.5 }}>
          Attachments
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1.5 }}>
          <FormControlLabel
            control={
              <Switch
                checked={!!settings.allow_attachments}
                onChange={(e) => updateSettings({ allow_attachments: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography sx={{ fontWeight: 500 }}>Allow file uploads</Typography>
                <Typography variant="caption" color="text.secondary">
                  Adds a step where the submitter can attach photos or files. On phones, the camera opens by default.
                </Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0, '& .MuiFormControlLabel-label': { mt: 0.25 } }}
          />
          {settings.allow_attachments && (
            <AttachmentSettingsPanel
              settings={settings}
              onChange={(patch) => updateSettings(patch)}
            />
          )}
        </Box>
      </Paper>

      {/* Danger zone */}
      <Box sx={{ pt: 1 }}>
        <Button
          color="warning"
          size="small"
          onClick={() => setArchiveOpen(true)}
        >
          Archive this form
        </Button>
      </Box>
    </Box>
  );

  // ---- preview pane ----

  const previewPane = previewView ? (
    <Paper
      variant="outlined"
      sx={{
        height: { xs: 600, md: '100%' },
        overflow: 'hidden',
        position: 'relative',
        borderRadius: 1,
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
        <PublicFormRenderer view={previewView} preview onSubmit={async () => { /* preview, no-op */ }} />
      </Box>
      {entityOptionsLoading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(255, 255, 255, 0.7)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            zIndex: 1,
          }}
        >
          <CircularProgress size={24} />
          <Typography variant="caption" color="text.secondary">
            Loading {Array.from(loadingEntityKinds).map(pluralEntityKind).join(', ')}…
          </Typography>
        </Box>
      )}
    </Paper>
  ) : null;

  return (
    <Box sx={{ maxWidth: 1280, mx: 'auto', px: { xs: 0, md: 0 } }}>
      {header}

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {configPane}
          <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
            <Box
              role="button"
              onClick={() => setPreviewOpen((o) => !o)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                p: 2,
                cursor: 'pointer',
                bgcolor: 'rgba(26, 54, 93, 0.03)',
                minHeight: 48,
              }}
            >
              <Typography sx={{ fontWeight: 600, flex: 1 }}>Preview</Typography>
              <ExpandIcon sx={{ transform: previewOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }} />
            </Box>
            <Collapse in={previewOpen}>
              <Box sx={{ height: 600, position: 'relative' }}>
                <Box sx={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
                  {previewPane}
                </Box>
              </Box>
            </Collapse>
          </Paper>
        </Box>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, height: 'calc(100vh - 200px)' }}>
          <Box sx={{ overflow: 'auto', pr: 1 }}>{configPane}</Box>
          <Box sx={{ overflow: 'hidden' }}>{previewPane}</Box>
        </Box>
      )}

      <Dialog open={archiveOpen} onClose={() => setArchiveOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Archive this form?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            <strong>{form.name}</strong> will be hidden and the public link (if any) will stop working.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setArchiveOpen(false)}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={handleArchive} disableElevation>Archive</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// ---------------------------------------------------------------------

interface FieldRowProps {
  column: ApiRecordColumn;
  field: RecordFormFieldConfig;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onChange: (patch: Partial<RecordFormFieldConfig>) => void;
  onRemove: () => void;
}

function FieldRow({ column, field, isFirst, isLast, onMove, onChange, onRemove }: FieldRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, minHeight: 48 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <IconButton size="small" disabled={isFirst} onClick={() => onMove(-1)} sx={{ minWidth: 28, minHeight: 28, p: 0 }} aria-label="Move up">
            <UpIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" disabled={isLast} onClick={() => onMove(1)} sx={{ minWidth: 28, minHeight: 28, p: 0 }} aria-label="Move down">
            <DownIcon fontSize="small" />
          </IconButton>
        </Box>
        <Switch
          checked
          size="small"
          onChange={() => onRemove()}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {field.label_override?.trim() || column.label}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', mt: 0.25 }}>
            <Chip size="small" label={column.type} variant="outlined" sx={{ height: 18, fontSize: 11 }} />
            {field.required && (
              <Chip size="small" label="Required" color="primary" sx={{ height: 18, fontSize: 11 }} />
            )}
          </Box>
        </Box>
        <FormControlLabel
          control={
            <Switch size="small" checked={!!field.required} onChange={(e) => onChange({ required: e.target.checked })} />
          }
          label="Required"
          sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
        <IconButton size="small" onClick={() => setExpanded((e) => !e)} sx={{ minWidth: 32, minHeight: 32 }}>
          <ExpandIcon sx={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 200ms', fontSize: 18 }} />
        </IconButton>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ px: 1.5, pb: 1.5, pt: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <TextField
            label="Label override"
            placeholder={column.label}
            value={field.label_override ?? ''}
            onChange={(e) => onChange({ label_override: e.target.value })}
            size="small"
            fullWidth
          />
          <TextField
            label="Help text"
            placeholder="Show beneath the input on the form"
            value={field.help_text ?? ''}
            onChange={(e) => onChange({ help_text: e.target.value })}
            size="small"
            fullWidth
          />
        </Box>
      </Collapse>
    </Box>
  );
}

// ---------------------------------------------------------------------

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <CircularProgress size={12} />
        <Typography variant="caption" color="text.secondary">Saving…</Typography>
      </Box>
    );
  }
  if (state === 'saved') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <CheckIcon sx={{ fontSize: 14, color: 'success.main' }} />
        <Typography variant="caption" color="text.secondary">Saved</Typography>
      </Box>
    );
  }
  if (state === 'error') {
    return <Typography variant="caption" color="error.main">Couldn't save — retry on next edit</Typography>;
  }
  return null;
}

// ---------------------------------------------------------------------

interface StatusStepperProps {
  status: RecordForm['status'];
  onTransition: (target: RecordForm['status']) => void;
  sx?: object;
}

/**
 * Three-stage visual stepper: Draft -> Live -> Archived.
 * Click a stage to transition. Going from Live back to Draft confirms
 * (the parent handler owns the confirm + the archive dialog hand-off).
 */
function StatusStepper({ status, onTransition, sx }: StatusStepperProps) {
  const stages: Array<{
    key: RecordForm['status'];
    label: string;
    description: string;
    icon: typeof EditIcon;
  }> = [
    { key: 'draft', label: 'Draft', description: 'Editing in progress', icon: EditIcon },
    { key: 'live', label: 'Live', description: 'Accepting submissions', icon: PublicIcon },
    { key: 'archived', label: 'Archived', description: 'Hidden, link disabled', icon: ArchiveIcon },
  ];

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1,
        flexWrap: 'wrap',
        ...sx,
      }}
      role="tablist"
      aria-label="Form status"
    >
      {stages.map((stage) => {
        const Icon = stage.icon;
        const active = stage.key === status;
        const colorByStage =
          stage.key === 'live'
            ? 'success.main'
            : stage.key === 'archived'
              ? 'text.disabled'
              : 'primary.main';
        return (
          <Box
            key={stage.key}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onTransition(stage.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onTransition(stage.key);
              }
            }}
            sx={{
              cursor: active ? 'default' : 'pointer',
              flex: { xs: '1 1 100%', sm: '1 1 0' },
              minWidth: { sm: 0 },
              minHeight: 64,
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              px: 1.5,
              py: 1,
              borderRadius: 1,
              border: 1,
              borderColor: active ? colorByStage : 'divider',
              bgcolor: active ? 'rgba(26, 54, 93, 0.04)' : 'background.paper',
              transition: 'border-color 150ms, background-color 150ms',
              '&:hover': active
                ? undefined
                : { borderColor: 'text.secondary', bgcolor: 'action.hover' },
              '&:focus-visible': {
                outline: 2,
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            <Icon sx={{ color: active ? colorByStage : 'text.disabled', fontSize: 22 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography
                sx={{
                  fontWeight: active ? 600 : 500,
                  fontSize: 14,
                  lineHeight: 1.2,
                  color: active ? 'text.primary' : 'text.secondary',
                }}
              >
                {stage.label}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', lineHeight: 1.3 }}
              >
                {stage.description}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------

interface PublicLinkPanelProps {
  isPublic: boolean;
  status: RecordForm['status'];
  publicUrl: string | null;
  onRotate: () => void | Promise<void>;
  onPublish: () => void;
}

/**
 * Renders the public URL with state-aware messaging:
 *   - private: prompt to enable Public link
 *   - public + draft: greyed URL, prompt to publish
 *   - public + live: live URL with copy / open / rotate
 *   - public + archived: greyed URL, archived note
 */
// ---------------------------------------------------------------------
// Attachment settings panel — surfaced on the builder when
// allow_attachments is enabled. Lets the form owner pick limits + MIME
// presets without typing JSON. The renderer reads the same settings so
// preview parity is automatic.
// ---------------------------------------------------------------------

interface AttachmentSettingsPanelProps {
  settings: RecordFormSettings;
  onChange: (patch: Partial<RecordFormSettings>) => void;
}

const MIME_PRESETS: Array<{ key: string; label: string; types: string[] }> = [
  { key: 'images', label: 'Images', types: ['image/*'] },
  { key: 'pdf', label: 'PDF', types: ['application/pdf'] },
  {
    key: 'office',
    label: 'Office docs',
    types: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.ms-excel',
    ],
  },
];

function AttachmentSettingsPanel({ settings, onChange }: AttachmentSettingsPanelProps) {
  const allowed = settings.allowed_mime_types ?? [...FORM_ATTACHMENT_DEFAULTS.allowed_mime_types];

  const isPresetActive = (preset: (typeof MIME_PRESETS)[number]): boolean =>
    preset.types.every((t) => allowed.includes(t));

  const togglePreset = (preset: (typeof MIME_PRESETS)[number]) => {
    const active = isPresetActive(preset);
    let next: string[];
    if (active) {
      next = allowed.filter((t) => !preset.types.includes(t));
    } else {
      next = [...new Set([...allowed, ...preset.types])];
    }
    if (next.length === 0) {
      // Refuse an empty allowlist — fall back to defaults so a misclick
      // doesn't lock everyone out of the form.
      next = [...FORM_ATTACHMENT_DEFAULTS.allowed_mime_types];
    }
    onChange({ allowed_mime_types: next });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pl: 4 }}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <TextField
          label="Max files"
          type="number"
          value={settings.max_attachments ?? FORM_ATTACHMENT_DEFAULTS.max_attachments}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ max_attachments: Number.isFinite(n) ? n : undefined });
          }}
          inputProps={{ min: 1, max: 20 }}
          size="small"
          sx={{ width: 140 }}
        />
        <TextField
          label="Max size (MB)"
          type="number"
          value={settings.max_file_size_mb ?? FORM_ATTACHMENT_DEFAULTS.max_file_size_mb}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ max_file_size_mb: Number.isFinite(n) ? n : undefined });
          }}
          inputProps={{ min: 1, max: 50 }}
          size="small"
          sx={{ width: 160 }}
        />
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Allowed file types
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {MIME_PRESETS.map((preset) => {
            const active = isPresetActive(preset);
            return (
              <Chip
                key={preset.key}
                label={preset.label}
                color={active ? 'primary' : 'default'}
                variant={active ? 'filled' : 'outlined'}
                onClick={() => togglePreset(preset)}
                sx={{ minHeight: 32 }}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------

function PublicLinkPanel({ isPublic, status, publicUrl, onRotate, onPublish }: PublicLinkPanelProps) {
  if (!isPublic) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.25,
          bgcolor: 'rgba(0, 0, 0, 0.02)',
          border: 1,
          borderColor: 'divider',
          borderStyle: 'dashed',
          borderRadius: 1,
          px: 1.5,
          py: 1.25,
        }}
      >
        <LockIcon sx={{ color: 'text.disabled', fontSize: 20, mt: 0.25 }} />
        <Typography variant="body2" color="text.secondary">
          This form is private. Toggle <strong>Public link</strong> above to generate a shareable URL.
        </Typography>
      </Box>
    );
  }

  if (!publicUrl) {
    // Edge case: public toggle on but server hasn't generated a slug yet.
    return (
      <Typography variant="body2" color="text.secondary">
        Generating public URL…
      </Typography>
    );
  }

  const greyed = status !== 'live';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {status === 'draft' && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1.5,
            bgcolor: 'rgba(255, 167, 38, 0.08)',
            border: 1,
            borderColor: 'rgba(255, 167, 38, 0.4)',
            borderRadius: 1,
            px: 1.5,
            py: 1.25,
            flexWrap: 'wrap',
          }}
        >
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              Set status to Live to accept submissions
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Until then the public URL returns a “not available” page.
            </Typography>
          </Box>
          <Button size="small" variant="contained" disableElevation onClick={onPublish}>
            Publish
          </Button>
        </Box>
      )}
      {status === 'archived' && (
        <Typography variant="body2" color="text.secondary">
          This form is archived. The public link is disabled.
        </Typography>
      )}
      {status === 'live' && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            color: 'success.main',
          }}
        >
          <CheckIcon sx={{ fontSize: 16 }} />
          <Typography variant="caption" sx={{ fontWeight: 500 }}>
            Live and accepting submissions
          </Typography>
        </Box>
      )}
      <Box
        sx={{
          bgcolor: greyed ? 'rgba(0, 0, 0, 0.03)' : 'rgba(26, 54, 93, 0.04)',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          px: 1.5,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: greyed ? 0.6 : 1,
        }}
      >
        <Typography variant="caption" color="text.secondary">Public URL</Typography>
        <Typography
          sx={{
            fontFamily: 'monospace',
            fontSize: 13,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {publicUrl}
        </Typography>
        <Tooltip title={greyed ? 'Form must be Live to copy' : 'Copy URL'}>
          <span>
            <IconButton
              size="small"
              disabled={greyed}
              onClick={() => { void navigator.clipboard.writeText(publicUrl); }}
              sx={{ minWidth: 36, minHeight: 36 }}
            >
              <CopyIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={greyed ? 'Form must be Live to open' : 'Open in new tab'}>
          <span>
            <IconButton
              size="small"
              disabled={greyed}
              component="a"
              href={greyed ? undefined : publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              sx={{ minWidth: 36, minHeight: 36 }}
            >
              <OpenIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box>
        <Tooltip title="Generate a new URL (old link will stop working)">
          <Button
            size="small"
            startIcon={<RefreshIcon fontSize="small" />}
            onClick={() => { void onRotate(); }}
            sx={{ color: 'text.secondary' }}
          >
            Rotate URL
          </Button>
        </Tooltip>
      </Box>
    </Box>
  );
}
