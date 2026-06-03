/**
 * Connector Wizard — universal-doors model (Phase B0).
 *
 * Connectors no longer have a per-row type. Every connector exposes every
 * intake door (manual upload, email, plus B2/B3/B4 paths as they land);
 * the wizard scaffolds a typeless connector and the detail page is where
 * partners configure each door.
 *
 * Step order (MVP):
 *   0. Name        — connector name + URL slug
 *   1. Upload Sample — drop a CSV/TSV/XLSX/PDF to seed schema discovery
 *   2. Review Schema — confirm how each detected column maps to dox fields
 *   3. Live Preview  — call preview-extraction to see what the parser emits
 *   4. Review & Save — final summary + activate toggle
 *
 * The historical type-selection step + the per-type Connection Config
 * step were removed in B0. Per-door config (email scoping, R2 watch
 * prefix, etc.) is set on the connector detail page after creation.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  Stepper,
  Step,
  StepLabel,
  TextField,
  Alert,
  CircularProgress,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import {
  CONNECTOR_SLUG_REGEX,
  isValidConnectorSlug,
  slugifyConnectorName,
} from '../../../shared/connectorSlug';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { StepUploadSample } from '../../components/connectors/StepUploadSample';
import { StepSchemaReview } from '../../components/connectors/StepSchemaReview';
import { StepLivePreview } from '../../components/connectors/StepLivePreview';
import { StepTestAndActivate } from '../../components/connectors/StepTestAndActivate';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { helpContent } from '../../lib/helpContent';
import {
  defaultFieldMappings,
  normalizeFieldMappings,
  validateFieldMappings,
  type ConnectorFieldMappings,
} from '../../components/connectors/doxFields';
import { acceptAllHighConfidenceSuggestions } from '../../components/connectors/fieldMappingActions';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';

interface WizardState {
  name: string;
  /**
   * Phase B0.5: globally-unique URL-safe handle. Auto-derived from the
   * name (debounced) until the user types in the slug field; from then
   * on `slugTouched` keeps the slug sticky regardless of name edits.
   */
  slug: string;
  slugTouched: boolean;
  config: Record<string, unknown>;
  fieldMappings: ConnectorFieldMappings;
  credentials: Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
  sample: DiscoverSchemaResponse | null;
  /**
   * Connectors -> Sources refactor: field_mappings are no longer stored on
   * the connector row. The worker reads them from the (supplier_id,
   * document_type_id) extraction profile in `supplier_extraction_instructions`
   * (via GET/PUT /api/extraction-instructions). When this source has a
   * supplier + document type chosen, the Review Schema step loads/saves
   * mappings against that profile. When either is missing (e.g. an
   * internal/order source with whole-stream extraction), mapping is
   * disabled with a hint. These are read from the connector row in edit
   * mode; the wizard itself doesn't author them.
   */
  supplierId: string | null;
  documentTypeId: string | null;
  /** Tenant the profile lookup/save scopes to (needed for super_admin). */
  tenantId: string | null;
}

/**
 * Location state shape accepted by the wizard route. Lets callers
 * (ConnectorDetail "Remap with new sample", etc.) seed the wizard at a
 * specific step without trashing the editing flow.
 */
interface WizardLocationState {
  startAtStep?: number;
  /** When true, treat this as an edit of an existing connector but start at a non-default step. */
  remapMode?: boolean;
}

const STEP_LABELS = [
  'Name',
  'Upload Sample',
  'Review Schema',
  'Live Preview',
  'Review & Save',
] as const;

const initialState: WizardState = {
  name: '',
  slug: '',
  slugTouched: false,
  config: {},
  fieldMappings: defaultFieldMappings(),
  credentials: null,
  schedule: null,
  active: false,
  sample: null,
  supplierId: null,
  documentTypeId: null,
  tenantId: null,
};

export function SourceWizard() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id: connectorId } = useParams<{ id: string }>();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const isEditMode = !!connectorId;
  const locationState = (location.state || {}) as WizardLocationState;

  const [activeStep, setActiveStep] = useState(0);
  const [state, setState] = useState<WizardState>(initialState);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Which sample_id we've already auto-applied suggestions for. Prevents the
  // "apply high-confidence suggestions on first entry to Review Schema" logic
  // from stomping on the user's manual edits if they go back and forth.
  const appliedSuggestionsForSampleRef = useRef<string | null>(null);

  const stepLabels = useMemo(() => [...STEP_LABELS], []);
  const totalSteps = stepLabels.length;
  const lastStepIndex = totalSteps - 1;

  // Which tenant will receive this connector? Super admins can pick; everyone
  // else is locked to their own. Needed by StepUploadSample so discover-schema
  // knows where to scope the sample.
  const currentTenantId = isSuperAdmin
    ? (selectedTenantId || user?.tenant_id || null)
    : (user?.tenant_id || null);

  // Load existing connector in edit mode
  useEffect(() => {
    if (!connectorId) return;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const result = await api.sources.get(connectorId) as { connector: Record<string, unknown> };
        const c = result.connector;
        const config = typeof c.config === 'string' ? JSON.parse(c.config as string) : (c.config || {});
        const supplierId = (c.supplier_id as string | null) ?? null;
        const documentTypeId = (c.document_type_id as string | null) ?? null;
        const profileTenantId = (c.tenant_id as string | null) ?? null;

        // Connectors -> Sources: when this source has a (supplier, document type)
        // pair, the canonical field_mappings live on the extraction profile —
        // NOT the connector row — because that's what the worker reads. Load
        // them from there so the Review Schema step edits the live profile.
        // Fall back to the connector row's mappings only when no profile row
        // exists yet (or no supplier/doctype is chosen).
        let mappings = normalizeFieldMappings(c.field_mappings);
        if (supplierId && documentTypeId) {
          try {
            const profile = await api.extractionInstructions.get({
              supplier_id: supplierId,
              document_type_id: documentTypeId,
              ...(isSuperAdmin && profileTenantId ? { tenant_id: profileTenantId } : {}),
            });
            if (profile.field_mappings != null) {
              mappings = normalizeFieldMappings(profile.field_mappings);
            }
          } catch (profileErr) {
            // Non-fatal — fall back to the connector-row mappings so the
            // wizard still renders. The profile save on Next/Save will
            // create the row.
            console.warn('Extraction-profile mappings load failed:', profileErr);
          }
        }
        // Always rehydrate the stored sample in edit mode when one exists,
        // regardless of which step we're landing on. Previously this only
        // ran when startAtStep was 2 or 3, which meant bookmarking
        // /admin/sources/:id/edit (no location state -> startAtStep
        // defaults to 1 / Upload) would show an empty upload card and nag
        // the user to re-upload, even though the connector already has a
        // stored sample. Now Upload correctly shows the existing sample
        // and the user can keep it OR overwrite by uploading something new.
        const storedSampleKey = (c.sample_r2_key as string | null) || null;
        let rehydratedSample: DiscoverSchemaResponse | null = null;
        if (storedSampleKey) {
          try {
            rehydratedSample = await api.sources.rehydrateSample(connectorId);
          } catch (hydrateErr) {
            // Non-fatal — fall back to the empty-shell behavior so the
            // wizard can still land the user on the requested step.
            console.warn('Sample rehydrate failed, falling back to stub:', hydrateErr);
            rehydratedSample = {
              sample_id: storedSampleKey,
              source_type: 'csv',
              file_name: 'stored sample',
              size: 0,
              expires_at: 0,
              detected_fields: [],
              sample_rows: [],
              layout_hint: 'Stored sample (rehydrate failed)',
              warnings: [hydrateErr instanceof Error ? hydrateErr.message : String(hydrateErr)],
              suggested_mappings: mappings,
            };
          }
        }

        setState({
          name: c.name as string,
          // Edit mode: trust the persisted slug. Mark touched so any
          // future name edits in this session don't overwrite it.
          slug: (c.slug as string | undefined) || '',
          slugTouched: true,
          config: config as Record<string, unknown>,
          fieldMappings: mappings,
          credentials: null,
          schedule: (c.schedule as string | null) || null,
          active: !!c.active,
          sample: rehydratedSample,
          supplierId,
          documentTypeId,
          tenantId: profileTenantId,
        });
        // Seed the auto-apply guard with the rehydrated sample_id. Without
        // this, the FIRST Back-to-Upload -> Next round-trip in edit mode
        // would re-trigger acceptAllHighConfidenceSuggestions and stomp on
        // whatever manual mappings the user already saved. Treat the
        // rehydrated sample as "already applied" so the guard lets the
        // saved mappings through untouched.
        if (rehydratedSample?.sample_id) {
          appliedSuggestionsForSampleRef.current = rehydratedSample.sample_id;
        }
        // Skip the Name & Type step in edit mode; allow caller to override via location state.
        setActiveStep(locationState.startAtStep ?? 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load source');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorId]);

  const updateState = (patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  };

  /**
   * Resolve the "role" of the current active step. Phase B0: type and
   * connection steps are gone, so the role mapping is now a 1:1 index
   * lookup. We keep the role enum so the per-step rendering switch stays
   * compact and self-documenting.
   */
  function stepRoleAt(index: number): 'name' | 'upload' | 'review' | 'preview' | 'save' {
    const label = stepLabels[index];
    switch (label) {
      case 'Name': return 'name';
      case 'Upload Sample': return 'upload';
      case 'Review Schema': return 'review';
      case 'Live Preview': return 'preview';
      case 'Review & Save': return 'save';
      default: return 'save';
    }
  }

  const validateStep = (): string | null => {
    const role = stepRoleAt(activeStep);
    switch (role) {
      case 'name':
        if (!state.name.trim() || state.name.trim().length < 3) return 'Name must be at least 3 characters';
        // Phase B0.5: slug is required + must match the canonical
        // shape. The auto-fill normally guarantees this but a user
        // who clears the field manually needs a clear inline error.
        if (!state.slug.trim()) return 'Slug is required';
        if (!isValidConnectorSlug(state.slug.trim())) {
          return 'Slug must be lowercase, kebab-case, alphanumeric (1-64 chars)';
        }
        return null;
      case 'upload':
        if (!state.sample) return 'Upload a sample file to continue';
        return null;
      case 'review': {
        const result = validateFieldMappings(state.fieldMappings);
        if (!result.ok) return result.errors[0];
        return null;
      }
      case 'preview':
        return null;
      case 'save':
        return null;
    }
  };

  const handleNext = () => {
    const validationError = validateStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');

    // Auto-apply high-confidence AI suggestions the first time we enter the
    // Review step for a given sample. Start from a CLEAN default mapping
    // (stripped of all source_labels — the built-in aliases like "order_id"
    // would otherwise look like real mappings even though they weren't seen
    // in the sample) and then run acceptAllHighConfidenceSuggestions over
    // the detected fields to pre-apply only candidate_targets at
    // confidence >= 0.7. Low-confidence guesses stay unmapped so the user
    // can review them manually.
    //
    // After this runs once per sample, the user's manual edits are sticky —
    // going back to Upload and clicking Next again won't re-stomp their
    // work unless they replace the sample itself (new sample_id).
    const role = stepRoleAt(activeStep);
    if (role === 'upload' && state.sample) {
      const sampleId = state.sample.sample_id || '';
      if (appliedSuggestionsForSampleRef.current !== sampleId) {
        const base = defaultFieldMappings();
        // Strip the default alias lists so nothing appears mapped that
        // wasn't actually in the uploaded sample.
        for (const key of Object.keys(base.core) as Array<keyof typeof base.core>) {
          base.core[key].source_labels = [];
          base.core[key].enabled = false;
        }
        const merged = acceptAllHighConfidenceSuggestions(base, state.sample.detected_fields);
        // order_number is required by validateFieldMappings; make sure it's
        // enabled even if nothing crossed the confidence threshold. The user
        // will see the "Order Number must be mapped" error and can point it
        // at a detected column.
        if (!merged.core.order_number.enabled) {
          merged.core.order_number.enabled = true;
        }
        updateState({ fieldMappings: merged });
        appliedSuggestionsForSampleRef.current = sampleId;
      }
    }

    setActiveStep((prev) => Math.min(prev + 1, lastStepIndex));
  };

  const handleBack = () => {
    setError('');
    // In edit mode, don't go back before the upload step.
    if (isEditMode && activeStep <= 1) return;
    setActiveStep((prev) => Math.max(prev - 1, 0));
  };

  const handleSave = async (activate: boolean) => {
    // Final client-side guard — email connectors without any filter would
    // otherwise be greedy. Backend enforces the same rule, this just saves a
    // round-trip and gives inline feedback.
    const guard = validateStep();
    if (guard) {
      setError(guard);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data: Record<string, unknown> = {
        name: state.name.trim(),
        config: state.config,
        field_mappings: state.fieldMappings,
        schedule: state.schedule || undefined,
        active: activate,
        sample_r2_key: state.sample?.sample_id,
      };

      let resultId: string;
      let justCreated = false;
      if (isEditMode && connectorId) {
        const result = await api.sources.update(connectorId, data) as { connector?: { id?: string } };
        resultId = result.connector?.id || connectorId;
      } else {
        if (!currentTenantId) {
          setError('No tenant selected. Please select a tenant first.');
          setSaving(false);
          return;
        }
        // Phase B0.5: use the slug-aware variant so a 409 surfaces as a
        // structured `{ ok: false, conflict.suggested }` payload that we
        // can route into an inline Step-Name error with the suggested
        // alternative pre-filled into the slug field.
        const result = await api.sources.createOrConflict({
          name: data.name as string,
          slug: state.slug.trim(),
          config: data.config as Record<string, unknown>,
          field_mappings: data.field_mappings,
          schedule: data.schedule as string | undefined,
          tenant_id: currentTenantId,
          sample_r2_key: state.sample?.sample_id,
        });
        if (!result.ok) {
          // Bounce back to the Name step (index 0) with the suggestion
          // pre-loaded into the slug field. The user can accept or
          // tweak before re-saving.
          updateState({ slug: result.conflict.suggested, slugTouched: true });
          setActiveStep(0);
          setError(
            `Slug "${state.slug.trim()}" is already taken — try "${result.conflict.suggested}" or pick another.`,
          );
          setSaving(false);
          return;
        }
        resultId = result.connector.id;
        justCreated = true;
      }
      // Connectors -> Sources: persist the field_mappings to the
      // (supplier_id, document_type_id) extraction profile — that's where
      // the worker reads them now, NOT the connector row. Only when both
      // are set (an internal/order source without a supplier keeps
      // whole-stream mappings on the connector row and skips this). We
      // fetch the current natural-language instructions first so the
      // mandatory `instructions` field on the PUT doesn't clobber any
      // reviewer-authored guidance for the pair.
      if (state.supplierId && state.documentTypeId) {
        try {
          const scope =
            isSuperAdmin && state.tenantId ? { tenant_id: state.tenantId } : {};
          const existing = await api.extractionInstructions.get({
            supplier_id: state.supplierId,
            document_type_id: state.documentTypeId,
            ...scope,
          });
          await api.extractionInstructions.put({
            supplier_id: state.supplierId,
            document_type_id: state.documentTypeId,
            // Preserve existing guidance; the PUT requires a string.
            instructions: existing.instructions ?? '',
            field_mappings: state.fieldMappings,
            ...scope,
          });
        } catch (profileErr) {
          // Surface but don't block navigation — the connector itself
          // saved fine; the reviewer can re-save mappings from detail.
          console.warn('Saving mappings to extraction profile failed:', profileErr);
        }
      }

      // Phase A2.3: when a connector is freshly created, the detail page
      // hosts the "what now?" affordances (manual upload zone, receive
      // address). Pass a one-time hint via location state so the
      // destination can render a contextual success toast pointing the
      // partner at the right intake path. Edits don't get the hint.
      navigate(`/admin/sources/${resultId}`, {
        state: justCreated ? { justCreated: true } : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save source');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const role = stepRoleAt(activeStep);

  return (
    <Box>
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/sources')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Sources
      </Button>

      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        {isEditMode ? (locationState.remapMode ? 'Remap Source' : 'Edit Source') : 'New Source'}
      </Typography>

      {!isEditMode && (
        <HelpWell id="connectors.wizard" title={helpContent.connectors.wizard.headline}>
          {helpContent.connectors.wizard.well}
        </HelpWell>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Stepper */}
      <Stepper
        activeStep={activeStep}
        orientation={isMobile ? 'vertical' : 'horizontal'}
        sx={{ mb: 4 }}
      >
        {stepLabels.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Step content */}
      <Box sx={{ minHeight: 300, mb: 4 }}>
        {role === 'name' && (
          <StepName state={state} onChange={updateState} />
        )}
        {role === 'upload' && (
          <StepUploadSample
            sample={state.sample}
            onSample={(sample) => updateState({ sample })}
            currentTenantId={currentTenantId}
          />
        )}
        {role === 'review' && (
          <>
            {state.supplierId && state.documentTypeId ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                These mappings are saved to this source's supplier + document-type
                extraction profile — that's where the extraction worker reads them
                from. Editing them here updates the profile for every source that
                shares the same supplier and document type.
              </Alert>
            ) : (
              <Alert severity="warning" sx={{ mb: 2 }}>
                Set a supplier and document type on this source to configure its
                extraction mapping against the shared profile. Until then these
                mappings stay on the source itself and aren't keyed to a profile.
              </Alert>
            )}
            <StepSchemaReview
              sample={state.sample}
              fieldMappings={state.fieldMappings}
              onFieldMappingsChange={(mappings) => updateState({ fieldMappings: mappings })}
            />
          </>
        )}
        {role === 'preview' && (
          <StepLivePreview
            sample={state.sample}
            fieldMappings={state.fieldMappings}
          />
        )}
        {role === 'save' && (
          <StepTestAndActivate state={state} onChange={updateState} />
        )}
      </Box>

      {/* Navigation buttons */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pt: 2,
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <Button
          variant="text"
          onClick={() => navigate('/admin/sources')}
          disabled={saving}
        >
          Cancel
        </Button>

        <Box sx={{ display: 'flex', gap: 1 }}>
          {activeStep > (isEditMode ? 1 : 0) && (
            <Button onClick={handleBack} disabled={saving}>
              Back
            </Button>
          )}

          {activeStep < lastStepIndex ? (
            <Button variant="contained" onClick={handleNext}>
              Next
            </Button>
          ) : (
            <>
              <Button
                variant="outlined"
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save as Draft'}
              </Button>
              <Button
                variant="contained"
                onClick={() => handleSave(true)}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save & Activate'}
              </Button>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// =============================================================================
// StepName — name + URL slug. Phase B0: connector type removed entirely;
// the residual `system_type` metadata field was dropped post-B0 once we
// confirmed nothing branches on it.
// =============================================================================

function StepName({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  // Phase B0.5: auto-populate the slug from the name UNTIL the user
  // touches the slug field. Once `slugTouched` is true, name edits no
  // longer overwrite the slug — this matches the "edit-as-you-go but
  // step out of the way once the user takes over" pattern from the
  // bundle / report naming UIs elsewhere in dox.
  useEffect(() => {
    if (state.slugTouched) return;
    const auto = slugifyConnectorName(state.name);
    if (auto !== state.slug) onChange({ slug: auto });
    // We deliberately depend only on name + slugTouched so re-renders
    // triggered by other state changes don't churn the slug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.name, state.slugTouched]);

  const slugInvalid =
    state.slug.length > 0 && !CONNECTOR_SLUG_REGEX.test(state.slug);

  return (
    <Box>
      <HelpWell id="connectors.wizard.step.name" title={helpContent.connectors.wizard.steps.name.headline}>
        {helpContent.connectors.wizard.steps.name.well}
      </HelpWell>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">Source name</Typography>
        <InfoTooltip text={helpContent.connectors.wizard.steps.name.tooltips.name} />
      </Box>
      <TextField
        label="Source name"
        fullWidth
        required
        value={state.name}
        onChange={(e) => onChange({ name: e.target.value })}
        helperText="A name you'll recognize, like 'Daily ERP Report'"
        sx={{ mb: 3 }}
        error={state.name.length > 0 && state.name.trim().length < 3}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">URL slug</Typography>
        <InfoTooltip text={helpContent.connectors.wizard.steps.name.tooltips.slug} />
      </Box>
      <TextField
        label="URL slug"
        fullWidth
        required
        value={state.slug}
        onChange={(e) =>
          onChange({
            // Lowercase as the user types — saves an extra round-trip
            // through the validator and matches what the server
            // normalizes to anyway.
            slug: e.target.value.toLowerCase(),
            slugTouched: true,
          })
        }
        onBlur={() => {
          // If the user blurs an empty field after touching it, fall
          // back to the auto-generated value rather than leave it
          // empty — empty is a hard validation error and the user
          // probably didn't mean it.
          if (!state.slug.trim()) {
            const auto = slugifyConnectorName(state.name);
            if (auto) onChange({ slug: auto, slugTouched: false });
          }
        }}
        error={slugInvalid}
        helperText={
          slugInvalid
            ? 'Lowercase, kebab-case, alphanumeric only (1-64 chars). Used in vendor URLs.'
            : 'Used in the API endpoint, email address, and public link. Auto-generated from name.'
        }
        sx={{ mb: 3, fontFamily: 'monospace' }}
        InputProps={{ sx: { fontFamily: 'monospace' } }}
      />
    </Box>
  );
}
