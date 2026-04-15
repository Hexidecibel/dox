import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Paper,
  Chip,
  Alert,
  Switch,
  FormControlLabel,
  Collapse,
  Divider,
  IconButton,
} from '@mui/material';
import {
  ContentCopy as ContentCopyIcon,
  CheckCircle as CheckIcon,
  CloudUpload as UploadIcon,
} from '@mui/icons-material';

import type { ConnectorFieldMappings } from './doxFields';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';
import { CORE_FIELD_DEFINITIONS } from './doxFields';

interface WizardState {
  connectorType: 'email' | 'api_poll' | 'webhook' | 'file_watch' | null;
  name: string;
  systemType: 'erp' | 'wms' | 'other';
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

const TYPE_LABELS: Record<string, string> = {
  email: 'Email',
  api_poll: 'API Poll',
  webhook: 'Webhook',
  file_watch: 'File Watch',
};

const SYSTEM_LABELS: Record<string, string> = {
  erp: 'ERP',
  wms: 'WMS',
  other: 'Other',
};

function SummarySection({ state }: { state: WizardState }) {
  const hasCredentials = state.credentials && Object.keys(state.credentials).some(
    (k) => k !== 'auth_method' && (state.credentials as Record<string, unknown>)[k]
  );

  const connectionDetails = () => {
    switch (state.connectorType) {
      case 'email': {
        const patterns = (state.config.subject_patterns as string[]) || [];
        return patterns.length > 0
          ? `Subject keywords: ${patterns.join(', ')}`
          : 'No subject filters configured';
      }
      case 'api_poll':
        return (state.config.base_url as string)
          ? `Base URL: ${state.config.base_url}${state.config.endpoint_path || ''}`
          : 'No URL configured';
      case 'webhook': {
        const id = state.config.id as string;
        return id
          ? `Webhook URL: https://supdox.com/api/webhooks/connectors/${id}`
          : 'Webhook URL will be generated after saving';
      }
      case 'file_watch':
        return (state.config.r2_prefix as string)
          ? `Watch path: ${state.config.r2_prefix}`
          : 'No watch path configured';
      default:
        return '';
    }
  };

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
          {state.connectorType && (
            <Chip label={TYPE_LABELS[state.connectorType]} size="small" color="primary" variant="outlined" />
          )}
          <Chip label={SYSTEM_LABELS[state.systemType]} size="small" color="secondary" variant="outlined" />
        </Box>

        <Typography variant="body2" color="text.secondary">
          {connectionDetails()}
        </Typography>

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

function EmailTestSection() {
  const [sampleEmail, setSampleEmail] = useState('');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2">Test Email Parsing</Typography>

      <TextField
        fullWidth
        size="small"
        multiline
        rows={5}
        value={sampleEmail}
        onChange={(e) => setSampleEmail(e.target.value)}
        placeholder="Paste a sample email body here to test parsing..."
        sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace', fontSize: '0.8rem' } }}
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button variant="contained" size="small" disabled>
          Parse
        </Button>
        <Typography variant="caption" color="text.secondary">
          Testing will be available after saving the connector.
        </Typography>
      </Box>
    </Box>
  );
}

function ApiPollTestSection() {
  const [testResult] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2">Test Connection</Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button
          variant="contained"
          size="small"
          disabled={testResult === 'testing'}
        >
          {testResult === 'testing' ? 'Testing...' : 'Test Connection'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Testing will be available after saving the connector.
        </Typography>
      </Box>

      {testResult === 'success' && (
        <Alert severity="success">Connection successful.</Alert>
      )}
      {testResult === 'error' && (
        <Alert severity="error">Connection failed. Check your credentials and URL.</Alert>
      )}
    </Box>
  );
}

function WebhookTestSection({ state }: { state: WizardState }) {
  const [showCurl, setShowCurl] = useState(false);
  const connectorId = state.config.id as string | undefined;
  const webhookUrl = connectorId
    ? `https://supdox.com/api/webhooks/connectors/${connectorId}`
    : null;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const sampleCurl = webhookUrl
    ? `curl -X POST ${webhookUrl} \\
  -H "Content-Type: application/json" \\
  -d '{
    "order_number": "SO-12345",
    "customer_number": "K00123",
    "customer_name": "Acme Corp",
    "items": [
      { "product_code": "SKU-001", "quantity": 10, "lot_number": "LOT-2026-04" }
    ]
  }'`
    : '';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2">Webhook Details</Typography>

      {webhookUrl ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              fullWidth
              size="small"
              value={webhookUrl}
              slotProps={{ input: { readOnly: true } }}
              sx={{ '& .MuiInputBase-input': { fontFamily: 'monospace', fontSize: '0.85rem' } }}
            />
            <IconButton size="small" onClick={() => handleCopy(webhookUrl)}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Box>

          <Box>
            <Button size="small" onClick={() => setShowCurl(!showCurl)}>
              {showCurl ? 'Hide' : 'Show'} sample cURL
            </Button>
            <Collapse in={showCurl}>
              <Paper variant="outlined" sx={{ p: 2, mt: 1, bgcolor: 'grey.50', overflow: 'auto' }}>
                <Typography
                  variant="body2"
                  component="pre"
                  sx={{ fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap', m: 0 }}
                >
                  {sampleCurl}
                </Typography>
              </Paper>
            </Collapse>
          </Box>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Webhook URL will be generated after saving the connector.
        </Typography>
      )}
    </Box>
  );
}

function FileWatchTestSection() {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="subtitle2">Test File Upload</Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<UploadIcon />}
          component="label"
          disabled
        >
          Upload test file
          <input type="file" hidden />
        </Button>
        <Typography variant="caption" color="text.secondary">
          Testing will be available after saving the connector.
        </Typography>
      </Box>
    </Box>
  );
}

export function StepTestAndActivate({ state, onChange }: StepProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography variant="h6" fontWeight={600}>
        Review & Activate
      </Typography>

      <SummarySection state={state} />

      <Divider />

      {/* Test section varies by type */}
      {state.connectorType === 'email' && <EmailTestSection />}
      {state.connectorType === 'api_poll' && <ApiPollTestSection />}
      {state.connectorType === 'webhook' && <WebhookTestSection state={state} />}
      {state.connectorType === 'file_watch' && <FileWatchTestSection />}

      <Divider />

      {/* Activate toggle */}
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={state.active}
              onChange={(e) => onChange({ active: e.target.checked })}
            />
          }
          label="Activate this connector"
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 7 }}>
          When active, this connector will automatically process incoming data.
        </Typography>
      </Box>
    </Box>
  );
}
