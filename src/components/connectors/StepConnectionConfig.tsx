import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Alert,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  RadioGroup,
  Radio,
  FormControlLabel,
  IconButton,
  Paper,
  Collapse,
  Button,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ContentCopy as ContentCopyIcon,
} from '@mui/icons-material';

import type { ConnectorFieldMappings } from './doxFields';
import type { DiscoverSchemaResponse } from '../../types/connectorSchema';

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

function updateConfig(state: WizardState, onChange: StepProps['onChange'], key: string, value: unknown) {
  onChange({ config: { ...state.config, [key]: value } });
}

function updateCredentials(state: WizardState, onChange: StepProps['onChange'], key: string, value: unknown) {
  onChange({ credentials: { ...(state.credentials || {}), [key]: value } });
}

/** Chip input for subject keywords */
function ChipInput({
  value,
  onChangeValue,
  label,
  helperText,
}: {
  value: string[];
  onChangeValue: (v: string[]) => void;
  label: string;
  helperText?: string;
}) {
  const [inputValue, setInputValue] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      if (!value.includes(inputValue.trim())) {
        onChangeValue([...value, inputValue.trim()]);
      }
      setInputValue('');
    }
  };

  const handleDelete = (toDelete: string) => {
    onChangeValue(value.filter((v) => v !== toDelete));
  };

  return (
    <Box>
      <TextField
        label={label}
        fullWidth
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        helperText={helperText}
        placeholder="Type and press Enter"
        size="small"
      />
      {value.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
          {value.map((v) => (
            <Chip key={v} label={v} size="small" onDelete={() => handleDelete(v)} />
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Schedule picker shared by API Poll and File Watch */
function SchedulePicker({
  schedule,
  onScheduleChange,
}: {
  schedule: string | null;
  onScheduleChange: (s: string) => void;
}) {
  const presets: Record<string, string> = {
    '*/15 * * * *': 'every_15',
    '0 * * * *': 'every_hour',
  };

  // Determine which radio is selected
  let selected = 'custom';
  let dailyTime = '15:30';
  if (schedule && presets[schedule]) {
    selected = presets[schedule];
  } else if (schedule) {
    const match = schedule.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
    if (match) {
      selected = 'daily';
      dailyTime = `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
    }
  }

  const handleRadio = (value: string) => {
    if (value === 'every_15') onScheduleChange('*/15 * * * *');
    else if (value === 'every_hour') onScheduleChange('0 * * * *');
    else if (value === 'daily') {
      const [h, m] = dailyTime.split(':');
      onScheduleChange(`${parseInt(m, 10)} ${parseInt(h, 10)} * * *`);
    }
    // custom: keep current value
  };

  const handleTimeChange = (time: string) => {
    const [h, m] = time.split(':');
    onScheduleChange(`${parseInt(m, 10)} ${parseInt(h, 10)} * * *`);
  };

  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Schedule
      </Typography>
      <RadioGroup
        value={selected}
        onChange={(e) => handleRadio(e.target.value)}
      >
        <FormControlLabel value="every_15" control={<Radio size="small" />} label="Every 15 minutes" />
        <FormControlLabel value="every_hour" control={<Radio size="small" />} label="Every hour" />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FormControlLabel value="daily" control={<Radio size="small" />} label="Daily at" />
          {selected === 'daily' && (
            <TextField
              type="time"
              size="small"
              value={dailyTime}
              onChange={(e) => handleTimeChange(e.target.value)}
              sx={{ width: 140 }}
            />
          )}
        </Box>
        <FormControlLabel value="custom" control={<Radio size="small" />} label="Custom cron" />
      </RadioGroup>
      {selected === 'custom' && (
        <TextField
          size="small"
          fullWidth
          value={schedule || ''}
          onChange={(e) => onScheduleChange(e.target.value)}
          placeholder="*/15 * * * *"
          helperText="Standard cron expression (minute hour day month weekday)"
          sx={{ mt: 1 }}
        />
      )}
    </Box>
  );
}

function EmailConfig({ state, onChange }: StepProps) {
  const subjectPatterns = (state.config.subject_patterns as string[]) || [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Alert severity="info">
        Emails sent to your inbox will be checked against these rules. Matching emails are automatically parsed for order data.
      </Alert>

      <ChipInput
        label="Subject keywords"
        value={subjectPatterns}
        onChangeValue={(v) => updateConfig(state, onChange, 'subject_patterns', v)}
        helperText="Enter words that appear in the email subject"
      />

      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="body2">Advanced Settings</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Sender filter"
            fullWidth
            size="small"
            value={(state.config.sender_filter as string) || ''}
            onChange={(e) => updateConfig(state, onChange, 'sender_filter', e.target.value)}
            helperText="Only process emails from this sender (email or domain). Leave blank for any sender."
            placeholder="orders@example.com"
          />
          <TextField
            label="Custom parsing instructions"
            fullWidth
            size="small"
            multiline
            rows={3}
            value={(state.config.parsing_prompt as string) || ''}
            onChange={(e) => updateConfig(state, onChange, 'parsing_prompt', e.target.value)}
            helperText="Tell the AI what to look for. Leave blank to use our default parser."
          />
        </AccordionDetails>
      </Accordion>

      <Typography variant="caption" color="text.secondary">
        Supports plain text, HTML, and CSV attachment formats automatically.
      </Typography>
    </Box>
  );
}

function ApiPollConfig({ state, onChange }: StepProps) {
  const authMethod = (state.credentials as Record<string, unknown>)?.auth_method as string || 'none';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <TextField
        label="Base URL"
        required
        fullWidth
        size="small"
        value={(state.config.base_url as string) || ''}
        onChange={(e) => updateConfig(state, onChange, 'base_url', e.target.value)}
        placeholder="https://your-erp.com/api"
      />

      <FormControl fullWidth size="small">
        <InputLabel>Auth method</InputLabel>
        <Select
          value={authMethod}
          label="Auth method"
          onChange={(e) => updateCredentials(state, onChange, 'auth_method', e.target.value)}
        >
          <MenuItem value="none">None</MenuItem>
          <MenuItem value="api_key">API Key</MenuItem>
          <MenuItem value="basic">Basic Auth</MenuItem>
          <MenuItem value="oauth2">OAuth 2.0</MenuItem>
          <MenuItem value="bearer">Bearer Token</MenuItem>
        </Select>
      </FormControl>

      {authMethod === 'api_key' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Header name"
            size="small"
            fullWidth
            value={(state.credentials as Record<string, unknown>)?.header_name as string || 'X-API-Key'}
            onChange={(e) => updateCredentials(state, onChange, 'header_name', e.target.value)}
          />
          <TextField
            label="Key value"
            size="small"
            fullWidth
            type="password"
            value={(state.credentials as Record<string, unknown>)?.api_key as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'api_key', e.target.value)}
          />
        </Box>
      )}

      {authMethod === 'bearer' && (
        <TextField
          label="Bearer token"
          size="small"
          fullWidth
          type="password"
          value={(state.credentials as Record<string, unknown>)?.bearer_token as string || ''}
          onChange={(e) => updateCredentials(state, onChange, 'bearer_token', e.target.value)}
          helperText="The token value (without the 'Bearer ' prefix)"
        />
      )}

      {authMethod === 'basic' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Username"
            size="small"
            fullWidth
            value={(state.credentials as Record<string, unknown>)?.username as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'username', e.target.value)}
          />
          <TextField
            label="Password"
            size="small"
            fullWidth
            type="password"
            value={(state.credentials as Record<string, unknown>)?.password as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'password', e.target.value)}
          />
        </Box>
      )}

      {authMethod === 'oauth2' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Client ID"
            size="small"
            fullWidth
            value={(state.credentials as Record<string, unknown>)?.client_id as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'client_id', e.target.value)}
          />
          <TextField
            label="Client Secret"
            size="small"
            fullWidth
            type="password"
            value={(state.credentials as Record<string, unknown>)?.client_secret as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'client_secret', e.target.value)}
          />
          <TextField
            label="Token URL"
            size="small"
            fullWidth
            value={(state.credentials as Record<string, unknown>)?.token_url as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'token_url', e.target.value)}
            placeholder="https://auth.example.com/oauth/token"
          />
          <TextField
            label="Scope"
            size="small"
            fullWidth
            value={(state.credentials as Record<string, unknown>)?.scope as string || ''}
            onChange={(e) => updateCredentials(state, onChange, 'scope', e.target.value)}
            placeholder="read:orders"
          />
        </Box>
      )}

      <TextField
        label="Endpoint path"
        fullWidth
        size="small"
        value={(state.config.endpoint_path as string) || ''}
        onChange={(e) => updateConfig(state, onChange, 'endpoint_path', e.target.value)}
        placeholder="/orders"
      />

      <SchedulePicker
        schedule={state.schedule}
        onScheduleChange={(s) => onChange({ schedule: s })}
      />
    </Box>
  );
}

function WebhookConfig({ state, onChange }: StepProps) {
  const [showCurl, setShowCurl] = useState(false);
  const connectorId = (state.config.id as string) || null;
  const webhookUrl = connectorId
    ? `https://supdox.com/api/webhooks/connectors/${connectorId}`
    : '';

  const handleCopy = () => {
    if (webhookUrl) {
      navigator.clipboard.writeText(webhookUrl);
    }
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
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <Alert severity="info">
        Configure your external system to send data to the webhook URL below.
      </Alert>

      <Box>
        <TextField
          label="Webhook URL"
          fullWidth
          size="small"
          value={webhookUrl || 'URL will be generated after saving'}
          slotProps={{ input: { readOnly: true } }}
          sx={{
            '& .MuiInputBase-input': { fontFamily: 'monospace', fontSize: '0.875rem' },
          }}
        />
        {webhookUrl && (
          <IconButton size="small" onClick={handleCopy} sx={{ mt: 0.5 }}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        )}
      </Box>

      <TextField
        label="Signing secret"
        fullWidth
        size="small"
        type="password"
        value={(state.credentials as Record<string, unknown>)?.signing_secret as string || ''}
        onChange={(e) => updateCredentials(state, onChange, 'signing_secret', e.target.value)}
        helperText="If your system signs payloads, enter the secret here."
      />

      {webhookUrl && (
        <Box>
          <Button size="small" onClick={() => setShowCurl(!showCurl)}>
            {showCurl ? 'Hide' : 'Show'} sample cURL
          </Button>
          <Collapse in={showCurl}>
            <Paper
              variant="outlined"
              sx={{ p: 2, mt: 1, bgcolor: 'grey.50', overflow: 'auto' }}
            >
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
      )}
    </Box>
  );
}

function FileWatchConfig({ state, onChange }: StepProps) {
  const fileFormat = (state.config.file_format as string) || 'auto';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      <TextField
        label="Watch path"
        fullWidth
        size="small"
        value={(state.config.r2_prefix as string) || ''}
        onChange={(e) => updateConfig(state, onChange, 'r2_prefix', e.target.value)}
        helperText="R2 folder path to monitor. E.g., 'imports/erp/'"
        placeholder="imports/erp/"
      />

      <FormControl fullWidth size="small">
        <InputLabel>File format</InputLabel>
        <Select
          value={fileFormat}
          label="File format"
          onChange={(e) => updateConfig(state, onChange, 'file_format', e.target.value)}
        >
          <MenuItem value="csv">CSV</MenuItem>
          <MenuItem value="xlsx">Excel (XLSX)</MenuItem>
          <MenuItem value="tsv">TSV</MenuItem>
          <MenuItem value="auto">Auto-detect</MenuItem>
        </Select>
      </FormControl>

      {(fileFormat === 'csv' || fileFormat === 'tsv') && (
        <TextField
          label="Delimiter"
          fullWidth
          size="small"
          value={(state.config.delimiter as string) ?? (fileFormat === 'tsv' ? '\\t' : ',')}
          onChange={(e) => updateConfig(state, onChange, 'delimiter', e.target.value)}
        />
      )}

      <SchedulePicker
        schedule={state.schedule}
        onScheduleChange={(s) => onChange({ schedule: s })}
      />
    </Box>
  );
}

export function StepConnectionConfig({ state, onChange }: StepProps) {
  if (!state.connectorType) {
    return (
      <Alert severity="warning">
        Please select a connector type in the previous step.
      </Alert>
    );
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Connection Settings
      </Typography>

      {state.connectorType === 'email' && <EmailConfig state={state} onChange={onChange} />}
      {state.connectorType === 'api_poll' && <ApiPollConfig state={state} onChange={onChange} />}
      {state.connectorType === 'webhook' && <WebhookConfig state={state} onChange={onChange} />}
      {state.connectorType === 'file_watch' && <FileWatchConfig state={state} onChange={onChange} />}
    </Box>
  );
}
