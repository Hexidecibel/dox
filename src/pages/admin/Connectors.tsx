import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  CircularProgress,
  Alert,
  Tooltip,
  Pagination,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Close as CloseIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';

const ITEMS_PER_PAGE = 20;

const CONNECTOR_TYPES = ['email', 'api_poll', 'webhook', 'file_watch'] as const;
const SYSTEM_TYPES = ['erp', 'wms', 'other'] as const;

type ConnectorType = typeof CONNECTOR_TYPES[number];
type SystemType = typeof SYSTEM_TYPES[number];

interface Connector {
  id: string;
  name: string;
  connector_type: ConnectorType;
  system_type: SystemType;
  config: string | Record<string, unknown>;
  schedule: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
}

function connectorTypeColor(type: ConnectorType): 'primary' | 'secondary' | 'info' | 'warning' {
  switch (type) {
    case 'email': return 'primary';
    case 'api_poll': return 'secondary';
    case 'webhook': return 'info';
    case 'file_watch': return 'warning';
  }
}

function systemTypeColor(type: SystemType): 'info' | 'success' | 'default' {
  switch (type) {
    case 'erp': return 'info';
    case 'wms': return 'success';
    case 'other': return 'default';
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

export function Connectors() {
  const navigate = useNavigate();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<Connector | null>(null);
  const [formName, setFormName] = useState('');
  const [formConnectorType, setFormConnectorType] = useState<ConnectorType>('email');
  const [formSystemType, setFormSystemType] = useState<SystemType>('erp');
  const [formConfig, setFormConfig] = useState('{}');
  const [formSchedule, setFormSchedule] = useState('');
  const [saving, setSaving] = useState(false);

  const tenantId = isSuperAdmin
    ? (selectedTenantId || undefined)
    : user?.tenant_id || undefined;

  const loadConnectors = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.connectors.list({
        search: search || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: tenantId,
      }) as any;
      setConnectors(result.connectors);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connectors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConnectors();
  }, [page, selectedTenantId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      loadConnectors();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const openEdit = (connector: Connector) => {
    setEditingConnector(connector);
    setFormName(connector.name);
    setFormConnectorType(connector.connector_type);
    setFormSystemType(connector.system_type);
    setFormConfig(
      typeof connector.config === 'string'
        ? connector.config
        : JSON.stringify(connector.config, null, 2)
    );
    setFormSchedule(connector.schedule || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    // Validate JSON config
    try {
      JSON.parse(formConfig);
    } catch {
      setError('Config must be valid JSON');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const data = {
        name: formName.trim(),
        connector_type: formConnectorType,
        system_type: formSystemType,
        config: JSON.parse(formConfig),
        schedule: formSchedule.trim() || undefined,
      };

      if (editingConnector) {
        await api.connectors.update(editingConnector.id, data);
      } else {
        const createTenantId = tenantId || user?.tenant_id;
        if (!createTenantId) {
          setError('No tenant selected. Please select a tenant before creating a connector.');
          setSaving(false);
          return;
        }
        await api.connectors.create({ ...data, tenant_id: createTenantId });
      }
      setDialogOpen(false);
      loadConnectors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save connector');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (connector: Connector) => {
    if (!confirm(`Delete connector "${connector.name}"?`)) return;
    try {
      await api.connectors.delete(connector.id);
      loadConnectors();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete connector');
    }
  };

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

  if (loading && connectors.length === 0) {
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
          Connectors
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/admin/connectors/new')}>
          Add Connector
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        placeholder="Search connectors..."
        fullWidth
        size="small"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon />
            </InputAdornment>
          ),
        }}
        sx={{ mb: 2 }}
      />

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {connectors.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No connectors found</Typography>
              </CardContent>
            </Card>
          ) : (
            connectors.map((connector) => (
              <Card
                key={connector.id}
                variant="outlined"
                sx={{ cursor: 'pointer' }}
                onClick={() => navigate(`/admin/connectors/${connector.id}`)}
              >
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {connector.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Last run: {formatRelativeTime(connector.last_run_at)}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                      <IconButton size="small" onClick={() => openEdit(connector)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => handleDelete(connector)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={connector.connector_type.replace('_', ' ')}
                      size="small"
                      color={connectorTypeColor(connector.connector_type)}
                      variant="outlined"
                    />
                    <Chip
                      label={connector.system_type.toUpperCase()}
                      size="small"
                      color={systemTypeColor(connector.system_type)}
                      variant="outlined"
                    />
                    <Chip
                      label={connector.active ? 'Active' : 'Inactive'}
                      size="small"
                      color={connector.active ? 'success' : 'default'}
                      variant="outlined"
                    />
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
                <TableCell>Type</TableCell>
                <TableCell>System</TableCell>
                <TableCell>Last Run</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connectors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No connectors found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                connectors.map((connector) => (
                  <TableRow
                    key={connector.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/admin/connectors/${connector.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" fontWeight={500} color="primary">
                        {connector.name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={connector.connector_type.replace('_', ' ')}
                        size="small"
                        color={connectorTypeColor(connector.connector_type)}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={connector.system_type.toUpperCase()}
                        size="small"
                        color={systemTypeColor(connector.system_type)}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatRelativeTime(connector.last_run_at)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={connector.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={connector.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(connector)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" onClick={() => handleDelete(connector)}>
                          <DeleteIcon fontSize="small" />
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

      {totalPages > 1 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Pagination
            count={totalPages}
            page={page}
            onChange={(_, p) => setPage(p)}
            color="primary"
          />
        </Box>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingConnector ? 'Edit Connector' : 'Add Connector'}
          <IconButton onClick={() => setDialogOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            fullWidth
            required
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            autoFocus
            sx={{ mt: 1, mb: 2 }}
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Connector Type</InputLabel>
            <Select
              value={formConnectorType}
              label="Connector Type"
              onChange={(e) => setFormConnectorType(e.target.value as ConnectorType)}
              disabled={saving || !!editingConnector}
            >
              {CONNECTOR_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {type.replace('_', ' ')}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
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
            label="Config (JSON)"
            fullWidth
            multiline
            rows={4}
            value={formConfig}
            onChange={(e) => setFormConfig(e.target.value)}
            disabled={saving}
            sx={{ mb: 2, fontFamily: 'monospace' }}
            InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.85rem' } }}
          />
          <TextField
            label="Schedule"
            fullWidth
            value={formSchedule}
            onChange={(e) => setFormSchedule(e.target.value)}
            disabled={saving}
            helperText="Cron expression or interval (e.g. '*/15 * * * *' or 'every 15m')"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || saving}
          >
            {saving ? 'Saving...' : editingConnector ? 'Save Changes' : 'Add Connector'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
