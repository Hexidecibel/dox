/**
 * Connector Wizard — file-first flow (Wave 2).
 *
 * Step order (MVP):
 *   0. Name & Type         — pick connector type + name + system type on one card
 *   1. Upload Sample       — drop a CSV/TSV/TXT file (5MB max) to seed discovery
 *   2. Review Schema       — confirm how each detected column maps to dox fields
 *   3. Live Preview        — call preview-extraction and see what the parser would emit
 *  [3.5]. Connection Config — subject filters / base URL / webhook secret (email/api_poll/webhook only)
 *   4. Review & Save       — final summary + activate toggle
 *
 * The Connection Config step is conditionally inserted when the connector
 * type needs it. For file_watch (and future formats that use the upload
 * flow), we skip straight from Live Preview to Review & Save.
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
  Card,
  CardActionArea,
  CardContent,
  Grid,
  Chip,
  Alert,
  CircularProgress,
  Radio,
  RadioGroup,
  FormControl,
  FormControlLabel,
  FormLabel,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Email as EmailIcon,
  Sync as SyncIcon,
  Webhook as WebhookIcon,
  InsertDriveFile as FileIcon,
  ArrowBack as BackIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { StepConnectionConfig } from '../../components/connectors/StepConnectionConfig';
import { StepUploadSample } from '../../components/connectors/StepUploadSample';
import { StepSchemaReview } from '../../components/connectors/StepSchemaReview';
import { StepLivePreview } from '../../components/connectors/StepLivePreview';
import { StepTestAndActivate } from '../../components/connectors/StepTestAndActivate';
import {
  defaultFieldMappings,
  normalizeFieldMappings,
  validateFieldMappings,
  type ConnectorFieldMappings,
} from '../../components/connectors/doxFields';
import { acceptAllHighConfidenceSuggestions } from '../../components/connectors/fieldMappingActions';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';

type ConnectorType = 'email' | 'api_poll' | 'webhook' | 'file_watch';
type SystemType = 'erp' | 'wms' | 'other';

interface WizardState {
  connectorType: ConnectorType | null;
  name: string;
  systemType: SystemType;
  config: Record<string, unknown>;
  fieldMappings: ConnectorFieldMappings;
  credentials: Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
  sample: DiscoverSchemaResponse | null;
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

const CONNECTOR_TYPE_OPTIONS: {
  type: ConnectorType;
  label: string;
  description: string;
  icon: React.ReactNode;
  recommended?: boolean;
  disabled?: boolean;
  badge?: string;
}[] = [
  {
    type: 'file_watch',
    label: 'File Upload / Watch',
    description: 'Upload files directly or watch an R2 bucket for new files',
    icon: <FileIcon sx={{ fontSize: 40 }} />,
    recommended: true,
  },
  {
    type: 'email',
    label: 'Email Parser',
    description: 'Receive documents via email (attachments + body parsing)',
    icon: <EmailIcon sx={{ fontSize: 40 }} />,
  },
  {
    type: 'api_poll',
    label: 'API Connection',
    description: 'Connect directly to your ERP/WMS REST API',
    icon: <SyncIcon sx={{ fontSize: 40 }} />,
    badge: 'Coming soon',
  },
  {
    type: 'webhook',
    label: 'Webhook Receiver',
    description: 'Receive data pushed from your systems',
    icon: <WebhookIcon sx={{ fontSize: 40 }} />,
    badge: 'Coming soon',
  },
];

function connectorNeedsConnectionConfig(type: ConnectorType | null): boolean {
  return type === 'email' || type === 'api_poll' || type === 'webhook';
}

function buildStepLabels(state: WizardState): string[] {
  const base = ['Name & Type', 'Upload Sample', 'Review Schema', 'Live Preview'];
  if (connectorNeedsConnectionConfig(state.connectorType)) {
    base.push('Connection');
  }
  base.push('Review & Save');
  return base;
}

const initialState: WizardState = {
  connectorType: null,
  name: '',
  systemType: 'erp',
  config: {},
  fieldMappings: defaultFieldMappings(),
  credentials: null,
  schedule: null,
  active: false,
  sample: null,
};

export function ConnectorWizard() {
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

  const stepLabels = useMemo(() => buildStepLabels(state), [state]);
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
        const result = await api.connectors.get(connectorId) as { connector: Record<string, unknown> };
        const c = result.connector;
        const config = typeof c.config === 'string' ? JSON.parse(c.config as string) : (c.config || {});
        const mappings = normalizeFieldMappings(c.field_mappings);
        // If this connector has a stored sample and the caller wants to jump
        // straight into the live-preview or review step ("Re-test" / "Remap"),
        // fetch the stored sample from R2 and re-run discovery so the wizard
        // has a populated detected_fields list — not an empty stub.
        const storedSampleKey = (c.sample_r2_key as string | null) || null;
        let rehydratedSample: DiscoverSchemaResponse | null = null;
        if (storedSampleKey && (locationState.startAtStep === 2 || locationState.startAtStep === 3)) {
          try {
            rehydratedSample = await api.connectors.rehydrateSample(connectorId);
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
          connectorType: c.connector_type as ConnectorType,
          name: c.name as string,
          systemType: (c.system_type as SystemType) || 'erp',
          config: config as Record<string, unknown>,
          fieldMappings: mappings,
          credentials: null,
          schedule: (c.schedule as string | null) || null,
          active: !!c.active,
          sample: rehydratedSample,
        });
        // Skip the Name & Type step in edit mode; allow caller to override via location state.
        setActiveStep(locationState.startAtStep ?? 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connector');
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
   * Resolve the "role" of the current active step — the base-step set can
   * include an optional Connection Config slot so integer indices shift
   * depending on connector type. Centralizing the lookup keeps validation /
   * rendering in sync.
   */
  function stepRoleAt(index: number): 'type' | 'upload' | 'review' | 'preview' | 'connection' | 'save' {
    const label = stepLabels[index];
    switch (label) {
      case 'Name & Type': return 'type';
      case 'Upload Sample': return 'upload';
      case 'Review Schema': return 'review';
      case 'Live Preview': return 'preview';
      case 'Connection': return 'connection';
      case 'Review & Save': return 'save';
      default: return 'save';
    }
  }

  const validateStep = (): string | null => {
    const role = stepRoleAt(activeStep);
    switch (role) {
      case 'type':
        if (!state.connectorType) return 'Please select a connector type';
        if (!state.name.trim() || state.name.trim().length < 3) return 'Name must be at least 3 characters';
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
      case 'connection':
        // Email connectors must be scoped — block the Next button when
        // neither a subject pattern nor a sender filter is set. Matches the
        // backend rule in POST /api/connectors + POST/:id/test.
        if (state.connectorType === 'email') {
          const cfg = state.config || {};
          const patterns = Array.isArray(cfg.subject_patterns)
            ? (cfg.subject_patterns as unknown[]).filter(
                (p): p is string => typeof p === 'string' && p.trim().length > 0,
              )
            : [];
          const senderFilter =
            typeof cfg.sender_filter === 'string' ? (cfg.sender_filter as string).trim() : '';
          if (patterns.length === 0 && senderFilter.length === 0) {
            return "Email connectors need at least one subject pattern or a sender filter — otherwise they'll match every inbound email.";
          }
        }
        return null;
      case 'save':
        // Same rule enforced one last time before save so users can't fall
        // through the cracks by skipping validateStep checks via Back/Save.
        if (state.connectorType === 'email') {
          const cfg = state.config || {};
          const patterns = Array.isArray(cfg.subject_patterns)
            ? (cfg.subject_patterns as unknown[]).filter(
                (p): p is string => typeof p === 'string' && p.trim().length > 0,
              )
            : [];
          const senderFilter =
            typeof cfg.sender_filter === 'string' ? (cfg.sender_filter as string).trim() : '';
          if (patterns.length === 0 && senderFilter.length === 0) {
            return "Email connectors need at least one subject pattern or a sender filter — otherwise they'll match every inbound email.";
          }
        }
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
        connector_type: state.connectorType,
        system_type: state.systemType,
        config: state.config,
        field_mappings: state.fieldMappings,
        schedule: state.schedule || undefined,
        active: activate,
        sample_r2_key: state.sample?.sample_id,
      };

      let resultId: string;
      if (isEditMode && connectorId) {
        const result = await api.connectors.update(connectorId, data) as { connector?: { id?: string } };
        resultId = result.connector?.id || connectorId;
      } else {
        if (!currentTenantId) {
          setError('No tenant selected. Please select a tenant first.');
          setSaving(false);
          return;
        }
        const result = await api.connectors.create({
          name: data.name as string,
          connector_type: data.connector_type as string,
          system_type: data.system_type as string,
          config: data.config as Record<string, unknown>,
          field_mappings: data.field_mappings,
          schedule: data.schedule as string | undefined,
          tenant_id: currentTenantId,
          sample_r2_key: state.sample?.sample_id,
        }) as { connector?: { id?: string }; id?: string };
        resultId = result.connector?.id || result.id || '';
      }
      navigate(`/admin/connectors/${resultId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connector');
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
        onClick={() => navigate('/admin/connectors')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Connectors
      </Button>

      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        {isEditMode ? (locationState.remapMode ? 'Remap Connector' : 'Edit Connector') : 'New Connector'}
      </Typography>

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
        {role === 'type' && (
          <StepNameAndType
            state={state}
            onChange={updateState}
            isEditMode={isEditMode}
          />
        )}
        {role === 'upload' && (
          <StepUploadSample
            sample={state.sample}
            onSample={(sample) => updateState({ sample })}
            currentTenantId={currentTenantId}
          />
        )}
        {role === 'review' && (
          <StepSchemaReview
            sample={state.sample}
            fieldMappings={state.fieldMappings}
            onFieldMappingsChange={(mappings) => updateState({ fieldMappings: mappings })}
          />
        )}
        {role === 'preview' && (
          <StepLivePreview
            sample={state.sample}
            fieldMappings={state.fieldMappings}
          />
        )}
        {role === 'connection' && (
          <StepConnectionConfig state={state} onChange={updateState} />
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
          onClick={() => navigate('/admin/connectors')}
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
// StepNameAndType — merged "Choose Type" + "Basic Info"
// =============================================================================

function StepNameAndType({
  state,
  onChange,
  isEditMode,
}: {
  state: WizardState;
  onChange: (patch: Partial<WizardState>) => void;
  isEditMode: boolean;
}) {
  return (
    <Box>
      <Alert severity="info" sx={{ mb: 3 }}>
        Connectors feed the order pipeline — they create orders and customers from your
        external systems.
      </Alert>

      <TextField
        label="Connector name"
        fullWidth
        required
        value={state.name}
        onChange={(e) => onChange({ name: e.target.value })}
        helperText="A name you'll recognize, like 'Daily ERP Report'"
        sx={{ mb: 3 }}
        error={state.name.length > 0 && state.name.trim().length < 3}
      />

      <FormControl sx={{ mb: 3 }}>
        <FormLabel>System type</FormLabel>
        <RadioGroup
          row
          value={state.systemType}
          onChange={(e) => onChange({ systemType: e.target.value as SystemType })}
        >
          <FormControlLabel value="erp" control={<Radio />} label="ERP" />
          <FormControlLabel value="wms" control={<Radio />} label="WMS" />
          <FormControlLabel value="other" control={<Radio />} label="Other" />
        </RadioGroup>
      </FormControl>

      {isEditMode && state.connectorType ? (
        <Alert severity="info">
          Connector type: <strong>{state.connectorType}</strong> (cannot be changed after creation)
        </Alert>
      ) : (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Connector type
          </Typography>
          <Grid container spacing={2}>
            {CONNECTOR_TYPE_OPTIONS.map((option) => {
              const isSelected = state.connectorType === option.type;
              return (
                <Grid item xs={12} sm={6} key={option.type}>
                  <Card
                    variant="outlined"
                    sx={{
                      border: isSelected ? 2 : 1,
                      borderColor: isSelected ? 'primary.main' : 'divider',
                      bgcolor: isSelected ? 'primary.50' : 'background.paper',
                      transition: 'all 0.15s',
                      height: '100%',
                      opacity: option.disabled ? 0.5 : 1,
                    }}
                  >
                    <CardActionArea
                      disabled={option.disabled}
                      onClick={() => onChange({ connectorType: option.type })}
                      sx={{ height: '100%', p: 2 }}
                    >
                      <CardContent sx={{ textAlign: 'center', p: 0 }}>
                        <Box
                          sx={{
                            color: isSelected ? 'primary.main' : 'text.secondary',
                            mb: 1.5,
                          }}
                        >
                          {option.icon}
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                          <Typography variant="h6" fontWeight={600}>
                            {option.label}
                          </Typography>
                          {option.recommended && (
                            <Chip label="Recommended" size="small" color="primary" variant="outlined" />
                          )}
                          {option.badge && (
                            <Chip label={option.badge} size="small" variant="outlined" />
                          )}
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {option.description}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              );
            })}
          </Grid>
        </Box>
      )}
    </Box>
  );
}
