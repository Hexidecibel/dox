import {
  Box,
  Typography,
  Paper,
  Chip,
  Alert,
  Switch,
  FormControlLabel,
  Divider,
} from '@mui/material';
import {
  CheckCircle as CheckIcon,
} from '@mui/icons-material';

import type { ConnectorFieldMappings } from './doxFields';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';
import { CORE_FIELD_DEFINITIONS } from './doxFields';
import { HelpWell } from '../HelpWell';
import { InfoTooltip } from '../InfoTooltip';
import { helpContent } from '../../lib/helpContent';

interface WizardState {
  name: string;
  config: Record<string, unknown>;
  fieldMappings: ConnectorFieldMappings;
  credentials: Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
  sample: DiscoverSchemaResponse | null;
}

interface StepProps {
  state: WizardState;
  onChange: (updates: Partial<WizardState>) => void;
}

function SummarySection({ state }: { state: WizardState }) {
  const hasCredentials = state.credentials && Object.keys(state.credentials).some(
    (k) => k !== 'auth_method' && (state.credentials as Record<string, unknown>)[k]
  );

  // Collect all canonical field keys + extended keys that have at least one
  // source label bound. These drive the "Mapped fields" chip list below.
  const mappedFields: string[] = [];
  for (const def of CORE_FIELD_DEFINITIONS) {
    const core = state.fieldMappings?.core?.[def.key];
    if (core?.enabled && core.source_labels.length > 0) {
      mappedFields.push(def.key);
    }
  }
  for (const ext of state.fieldMappings?.extended ?? []) {
    if (ext.source_labels.length > 0) mappedFields.push(ext.key);
  }

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
        Summary
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" fontWeight={600}>
            {state.name || 'Unnamed connector'}
          </Typography>
        </Box>

        {state.sample && (
          <Typography variant="body2" color="text.secondary">
            Sample: <strong>{state.sample.file_name}</strong> · {state.sample.layout_hint}
          </Typography>
        )}

        {state.schedule && (
          <Typography variant="body2" color="text.secondary">
            Schedule: <code>{state.schedule}</code>
          </Typography>
        )}

        {mappedFields.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
              Mapped fields
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {mappedFields.map((field) => (
                <Chip key={field} label={field} size="small" variant="outlined" />
              ))}
            </Box>
          </Box>
        )}

        <Typography variant="body2" color="text.secondary">
          {hasCredentials ? (
            <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <CheckIcon fontSize="small" color="success" />
              Credentials configured
            </Box>
          ) : (
            'No credentials'
          )}
        </Typography>
      </Box>
    </Paper>
  );
}

export function StepTestAndActivate({ state, onChange }: StepProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <HelpWell
        id="connectors.wizard.step.save"
        title={helpContent.connectors.wizard.steps.save.headline}
      >
        {helpContent.connectors.wizard.steps.save.well}
      </HelpWell>

      <Typography variant="h6" fontWeight={600}>
        Review & Activate
      </Typography>

      <SummarySection state={state} />

      <Divider />

      <Alert severity="info">
        After saving, configure intake doors on the connector detail page —
        manual upload (drop a file), email (send to your tenant inbox), and
        the rest of the doors as those slices come online.
      </Alert>

      <Divider />

      {/* Activate toggle */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <FormControlLabel
            control={
              <Switch
                checked={state.active}
                onChange={(e) => onChange({ active: e.target.checked })}
              />
            }
            label="Activate this connector"
          />
          <InfoTooltip text={helpContent.connectors.wizard.steps.save.tooltips.activate} />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 7 }}>
          When active, this connector will automatically process incoming data.
        </Typography>
      </Box>
    </Box>
  );
}
