import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { StepFieldMapping } from '../../components/connectors/StepFieldMapping';
import { StepTestAndActivate } from '../../components/connectors/StepTestAndActivate';

type ConnectorType = 'email' | 'api_poll' | 'webhook' | 'file_watch';
type SystemType = 'erp' | 'wms' | 'other';

interface WizardState {
  connectorType: ConnectorType | null;
  name: string;
  systemType: SystemType;
  config: Record<string, unknown>;
  fieldMappings: Record<string, string>;
  credentials: Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
}

const STEPS = ['Choose Type', 'Basic Info', 'Connection Settings', 'Field Mapping', 'Test & Activate'];

const CONNECTOR_TYPE_OPTIONS: {
  type: ConnectorType;
  label: string;
  description: string;
  icon: React.ReactNode;
  recommended?: boolean;
}[] = [
  {
    type: 'email',
    label: 'Email Parser',
    description: 'Parse orders from automated ERP emails',
    icon: <EmailIcon sx={{ fontSize: 40 }} />,
    recommended: true,
  },
  {
    type: 'api_poll',
    label: 'API Connection',
    description: 'Connect directly to your ERP/WMS REST API',
    icon: <SyncIcon sx={{ fontSize: 40 }} />,
  },
  {
    type: 'webhook',
    label: 'Webhook Receiver',
    description: 'Receive data pushed from your systems',
    icon: <WebhookIcon sx={{ fontSize: 40 }} />,
  },
  {
    type: 'file_watch',
    label: 'File Watcher',
    description: 'Monitor for CSV or Excel file drops',
    icon: <FileIcon sx={{ fontSize: 40 }} />,
  },
];

const DEFAULT_CONFIGS: Record<ConnectorType, Record<string, unknown>> = {
  email: {
    subject_patterns: [],
    sender_filter: '',
    parsing_prompt: '',
  },
  api_poll: {
    base_url: '',
    endpoint: '',
    method: 'GET',
    headers: {},
  },
  webhook: {
    secret: '',
    path_prefix: '',
  },
  file_watch: {
    path: '',
    pattern: '*.csv',
    format: 'csv',
  },
};

const DEFAULT_FIELD_MAPPINGS: Record<ConnectorType, Record<string, string>> = {
  email: {
    customer_name: '',
    order_number: '',
    items: '',
  },
  api_poll: {
    customer_name: '',
    order_number: '',
    items: '',
  },
  webhook: {
    customer_name: '',
    order_number: '',
    items: '',
  },
  file_watch: {
    customer_name: '',
    order_number: '',
    items: '',
  },
};

const initialState: WizardState = {
  connectorType: null,
  name: '',
  systemType: 'erp',
  config: {},
  fieldMappings: {},
  credentials: null,
  schedule: null,
  active: false,
};

export function ConnectorWizard() {
  const navigate = useNavigate();
  const { id: connectorId } = useParams<{ id: string }>();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const isEditMode = !!connectorId;

  const [activeStep, setActiveStep] = useState(0);
  const [state, setState] = useState<WizardState>(initialState);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load existing connector in edit mode
  useEffect(() => {
    if (!connectorId) return;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const result = await api.connectors.get(connectorId) as any;
        const c = result.connector;
        const config = typeof c.config === 'string' ? JSON.parse(c.config) : (c.config || {});
        const mappings = c.field_mappings
          ? typeof c.field_mappings === 'string'
            ? JSON.parse(c.field_mappings)
            : c.field_mappings
          : {};
        setState({
          connectorType: c.connector_type,
          name: c.name,
          systemType: c.system_type || 'erp',
          config,
          fieldMappings: mappings,
          credentials: null,
          schedule: c.schedule || null,
          active: c.active,
        });
        // Skip type step in edit mode
        setActiveStep(1);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connector');
      } finally {
        setLoading(false);
      }
    })();
  }, [connectorId]);

  const updateState = (patch: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  };

  const validateStep = (): string | null => {
    switch (activeStep) {
      case 0:
        if (!state.connectorType) return 'Please select a connector type';
        return null;
      case 1:
        if (!state.name.trim() || state.name.trim().length < 3) return 'Name must be at least 3 characters';
        return null;
      case 2:
        return null;
      case 3: {
        // order_number mapping is required
        if (state.connectorType === 'email') {
          // AI mode: order_number must be a key (checkbox checked)
          if (!state.fieldMappings['order_number']) {
            return 'Order Number field mapping is required';
          }
        } else {
          // Manual mode: some source field must map TO order_number
          const mappedValues = Object.values(state.fieldMappings);
          if (!mappedValues.includes('order_number')) {
            return 'Order Number field mapping is required';
          }
        }
        return null;
      }
      default:
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

    // When leaving type step, seed defaults if config is empty
    if (activeStep === 0 && state.connectorType) {
      const currentConfig = Object.keys(state.config).length === 0;
      const currentMappings = Object.keys(state.fieldMappings).length === 0;
      if (currentConfig) {
        const defaults = DEFAULT_CONFIGS[state.connectorType];
        updateState({ config: defaults });
      }
      if (currentMappings) {
        const defaults = DEFAULT_FIELD_MAPPINGS[state.connectorType];
        updateState({ fieldMappings: defaults });
      }
    }

    setActiveStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setError('');
    // In edit mode, don't go back to type step
    if (isEditMode && activeStep === 1) return;
    setActiveStep((prev) => Math.max(prev - 1, 0));
  };

  const handleSave = async (activate: boolean) => {
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
      };

      let resultId: string;
      if (isEditMode && connectorId) {
        const result = await api.connectors.update(connectorId, data) as any;
        resultId = result.connector?.id || connectorId;
      } else {
        const tenantId = isSuperAdmin
          ? (selectedTenantId || user?.tenant_id)
          : user?.tenant_id;
        if (!tenantId) {
          setError('No tenant selected. Please select a tenant first.');
          setSaving(false);
          return;
        }
        const result = await api.connectors.create({
          name: data.name as string,
          connector_type: data.connector_type as string,
          system_type: data.system_type as string,
          config: data.config as Record<string, unknown>,
          field_mappings: data.field_mappings as Record<string, string>,
          schedule: data.schedule as string | undefined,
          tenant_id: tenantId,
        }) as any;
        resultId = result.connector?.id || result.id;
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
        {isEditMode ? 'Edit Connector' : 'New Connector'}
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
        {STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {/* Step content */}
      <Box sx={{ minHeight: 300, mb: 4 }}>
        {activeStep === 0 && (
          <StepChooseType
            selected={state.connectorType}
            onSelect={(type) => updateState({ connectorType: type })}
            isEditMode={isEditMode}
          />
        )}
        {activeStep === 1 && (
          <StepBasicInfo
            name={state.name}
            systemType={state.systemType}
            onNameChange={(name) => updateState({ name })}
            onSystemTypeChange={(systemType) => updateState({ systemType })}
          />
        )}
        {activeStep === 2 && (
          <StepConnectionConfig state={state} onChange={updateState} />
        )}
        {activeStep === 3 && (
          <StepFieldMapping state={state} onChange={updateState} />
        )}
        {activeStep === 4 && (
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

          {activeStep < STEPS.length - 1 ? (
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

// --- Step Components ---

function StepChooseType({
  selected,
  onSelect,
  isEditMode,
}: {
  selected: ConnectorType | null;
  onSelect: (type: ConnectorType) => void;
  isEditMode: boolean;
}) {
  if (isEditMode && selected) {
    const option = CONNECTOR_TYPE_OPTIONS.find((o) => o.type === selected);
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        Connector type: <strong>{option?.label || selected}</strong> (cannot be changed after creation)
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Choose how this connector will receive data from your external system.
      </Typography>
      <Grid container spacing={2}>
        {CONNECTOR_TYPE_OPTIONS.map((option) => {
          const isSelected = selected === option.type;
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
                }}
              >
                <CardActionArea
                  onClick={() => onSelect(option.type)}
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
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, mb: 1 }}>
                      <Typography variant="h6" fontWeight={600}>
                        {option.label}
                      </Typography>
                      {option.recommended && (
                        <Chip label="Recommended" size="small" color="primary" variant="outlined" />
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
  );
}

function StepBasicInfo({
  name,
  systemType,
  onNameChange,
  onSystemTypeChange,
}: {
  name: string;
  systemType: SystemType;
  onNameChange: (name: string) => void;
  onSystemTypeChange: (type: SystemType) => void;
}) {
  return (
    <Box sx={{ maxWidth: 560 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        Connectors feed the order pipeline — they create orders and customers from your external systems.
      </Alert>

      <TextField
        label="Name"
        fullWidth
        required
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        helperText="A name you'll recognize, like 'Daily ERP Report'"
        sx={{ mb: 3 }}
        error={name.length > 0 && name.trim().length < 3}
      />

      <FormControl>
        <FormLabel>System Type</FormLabel>
        <RadioGroup
          value={systemType}
          onChange={(e) => onSystemTypeChange(e.target.value as SystemType)}
        >
          <FormControlLabel value="erp" control={<Radio />} label="ERP (order management)" />
          <FormControlLabel value="wms" control={<Radio />} label="WMS (warehouse/shipping)" />
          <FormControlLabel value="other" control={<Radio />} label="Other" />
        </RadioGroup>
      </FormControl>
    </Box>
  );
}

