import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  TextField,
  CircularProgress,
  Alert,
  Tooltip,
  Tab,
  Tabs,
  Pagination,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Edit as EditIcon,
  ArrowBack as BackIcon,
  PlayArrow as RunIcon,
  Science as TestIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';

const SYSTEM_TYPES = ['erp', 'wms', 'other'] as const;
type SystemType = typeof SYSTEM_TYPES[number];

interface Connector {
  id: string;
  name: string;
  connector_type: string;
  system_type: SystemType;
  config: string | Record<string, unknown>;
  field_mappings: string | Record<string, unknown> | null;
  schedule: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
}

interface ConnectorRun {
  id: string;
  connector_id: string;
  status: 'success' | 'error' | 'partial' | 'running';
  started_at: string;
  completed_at: string | null;
  records_found: number;
  records_created: number;
  records_errored: number;
  error_message: string | null;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <Box role="tabpanel" hidden={value !== index} sx={{ pt: 2 }}>
      {value === index && children}
    </Box>
  );
}

function runStatusColor(status: ConnectorRun['status']): 'success' | 'error' | 'warning' | 'info' {
  switch (status) {
    case 'success': return 'success';
    case 'error': return 'error';
    case 'partial': return 'warning';
    case 'running': return 'info';
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

const RUNS_PER_PAGE = 20;

export function ConnectorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connector, setConnector] = useState<Connector | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState(0);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [formName, setFormName] = useState('');
  const [formSystemType, setFormSystemType] = useState<SystemType>('erp');
  const [formConfig, setFormConfig] = useState('{}');
  const [formFieldMappings, setFormFieldMappings] = useState('{}');
  const [formSchedule, setFormSchedule] = useState('');
  const [saving, setSaving] = useState(false);

  // Runs state
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(false);

  // Action state
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);

  const loadConnector = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.connectors.get(id) as any;
      const c = result.connector;
      setConnector(c);
      setFormName(c.name);
      setFormSystemType(c.system_type);
      setFormConfig(
        typeof c.config === 'string' ? c.config : JSON.stringify(c.config, null, 2)
      );
      setFormFieldMappings(
        c.field_mappings
          ? typeof c.field_mappings === 'string'
            ? c.field_mappings
            : JSON.stringify(c.field_mappings, null, 2)
          : '{}'
      );
      setFormSchedule(c.schedule || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connector');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadRuns = useCallback(async () => {
    if (!id) return;
    setRunsLoading(true);
    try {
      const result = await api.connectors.runs(id, {
        limit: RUNS_PER_PAGE,
        offset: (runsPage - 1) * RUNS_PER_PAGE,
      }) as any;
      setRuns(result.runs);
      setRunsTotal(result.total);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, [id, runsPage]);

  useEffect(() => {
    loadConnector();
  }, [loadConnector]);

  useEffect(() => {
    if (tab === 1) loadRuns();
  }, [tab, loadRuns]);

  const handleSave = async () => {
    if (!id) return;
    try {
      JSON.parse(formConfig);
    } catch {
      setError('Config must be valid JSON');
      return;
    }
    try {
      JSON.parse(formFieldMappings);
    } catch {
      setError('Field mappings must be valid JSON');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const result = await api.connectors.update(id, {
        name: formName.trim(),
        system_type: formSystemType,
        config: JSON.parse(formConfig),
        field_mappings: JSON.parse(formFieldMappings),
        schedule: formSchedule.trim() || undefined,
      }) as any;
      setConnector(result.connector);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connector');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!id) return;
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      const result = await api.connectors.test(id) as any;
      setSuccess(result.message || 'Connection test successful');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleRun = async () => {
    if (!id) return;
    setRunning(true);
    setError('');
    setSuccess('');
    try {
      await api.connectors.run(id);
      setSuccess('Manual run started');
      // Refresh runs tab
      if (tab === 1) loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start manual run');
    } finally {
      setRunning(false);
    }
  };

  const handleToggleActive = async () => {
    if (!id || !connector) return;
    try {
      const result = await api.connectors.update(id, { active: !connector.active }) as any;
      setConnector(result.connector);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update connector');
    }
  };

  const formatConfig = (config: string | Record<string, unknown> | null): string => {
    if (!config) return '{}';
    if (typeof config === 'string') {
      try {
        return JSON.stringify(JSON.parse(config), null, 2);
      } catch {
        return config;
      }
    }
    return JSON.stringify(config, null, 2);
  };

  const runsTotalPages = Math.ceil(runsTotal / RUNS_PER_PAGE);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!connector) {
    return (
      <Box sx={{ py: 4 }}>
        <Alert severity="error">Connector not found</Alert>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/admin/connectors')} sx={{ mt: 2 }}>
          Back to Connectors
        </Button>
      </Box>
    );
  }

  return (
    <Box>
      {/* Back button */}
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/admin/connectors')}
        sx={{ mb: 2 }}
        size="small"
      >
        All Connectors
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {/* Header */}
      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
              <Typography variant="h4" fontWeight={700}>
                {connector.name}
              </Typography>
              <Chip
                label={connector.connector_type.replace('_', ' ')}
                size="small"
                color="primary"
                variant="outlined"
              />
              <Chip
                label={connector.active ? 'Active' : 'Inactive'}
                size="small"
                color={connector.active ? 'success' : 'default'}
                variant="outlined"
              />
            </Box>
            <Typography variant="body2" color="text.secondary">
              System: {connector.system_type.toUpperCase()} &middot; Last run: {formatRelativeTime(connector.last_run_at)}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<EditIcon />}
              onClick={() => navigate(`/admin/connectors/${id}/edit`)}
            >
              Edit
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<TestIcon />}
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? 'Testing...' : 'Test'}
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RunIcon />}
              onClick={handleRun}
              disabled={running || connector.connector_type === 'email'}
            >
              {running ? 'Running...' : 'Manual Run'}
            </Button>
            <Tooltip title={connector.active ? 'Deactivate' : 'Activate'}>
              <Button
                variant="outlined"
                size="small"
                color={connector.active ? 'warning' : 'success'}
                onClick={handleToggleActive}
              >
                {connector.active ? 'Deactivate' : 'Activate'}
              </Button>
            </Tooltip>
          </Box>
        </Box>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Config" />
          <Tab label={`Runs${runsTotal ? ` (${runsTotal})` : ''}`} />
        </Tabs>
      </Box>

      {/* Config Tab */}
      <TabPanel value={tab} index={0}>
        {editing ? (
          <Box>
            <TextField
              label="Name"
              fullWidth
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
            />
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>System Type</InputLabel>
              <Select
                value={formSystemType}
                label="System Type"
                onChange={(e) => setFormSystemType(e.target.value as SystemType)}
                disabled={saving}
              >
                {SYSTEM_TYPES.map((type) => (
                  <MenuItem key={type} value={type}>
                    {type.toUpperCase()}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Schedule"
              fullWidth
              value={formSchedule}
              onChange={(e) => setFormSchedule(e.target.value)}
              disabled={saving}
              helperText="Cron expression or interval"
              sx={{ mb: 2 }}
            />
            <TextField
              label="Config (JSON)"
              fullWidth
              multiline
              rows={8}
              value={formConfig}
              onChange={(e) => setFormConfig(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.85rem' } }}
            />
            <TextField
              label="Field Mappings (JSON)"
              fullWidth
              multiline
              rows={6}
              value={formFieldMappings}
              onChange={(e) => setFormFieldMappings(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
              InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.85rem' } }}
            />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleSave}
                disabled={!formName.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setEditing(false);
                  setFormName(connector.name);
                  setFormSystemType(connector.system_type);
                  setFormConfig(formatConfig(connector.config));
                  setFormFieldMappings(formatConfig(connector.field_mappings));
                  setFormSchedule(connector.schedule || '');
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<EditIcon />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Box>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                System Type
              </Typography>
              <Chip
                label={connector.system_type.toUpperCase()}
                size="small"
                color={connector.system_type === 'erp' ? 'info' : connector.system_type === 'wms' ? 'success' : 'default'}
                variant="outlined"
              />
            </Paper>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Schedule
              </Typography>
              <Typography variant="body2">
                {connector.schedule || 'Not configured'}
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Config
              </Typography>
              <Box
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  bgcolor: 'grey.50',
                  p: 1.5,
                  borderRadius: 1,
                  overflow: 'auto',
                  maxHeight: 400,
                  m: 0,
                }}
              >
                {formatConfig(connector.config)}
              </Box>
            </Paper>

            {connector.field_mappings && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Field Mappings
                </Typography>
                <Box
                  component="pre"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    bgcolor: 'grey.50',
                    p: 1.5,
                    borderRadius: 1,
                    overflow: 'auto',
                    maxHeight: 400,
                    m: 0,
                  }}
                >
                  {formatConfig(connector.field_mappings)}
                </Box>
              </Paper>
            )}
          </Box>
        )}
      </TabPanel>

      {/* Runs Tab */}
      <TabPanel value={tab} index={1}>
        {runsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : runs.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography color="text.secondary">No runs yet</Typography>
          </Paper>
        ) : (
          <>
            <TableContainer component={Paper} variant="outlined">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Completed</TableCell>
                    <TableCell align="right">Found</TableCell>
                    <TableCell align="right">Created</TableCell>
                    <TableCell align="right">Errors</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id} hover>
                      <TableCell>
                        <Chip
                          label={run.status}
                          size="small"
                          color={runStatusColor(run.status)}
                          variant="filled"
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {formatDate(run.started_at)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {run.completed_at ? formatDate(run.completed_at) : '-'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">{run.records_found}</Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">{run.records_created}</Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" color={run.records_errored > 0 ? 'error' : 'text.primary'}>
                          {run.records_errored}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            {runsTotalPages > 1 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
                <Pagination
                  count={runsTotalPages}
                  page={runsPage}
                  onChange={(_, p) => setRunsPage(p)}
                  color="primary"
                />
              </Box>
            )}
          </>
        )}
      </TabPanel>
    </Box>
  );
}
