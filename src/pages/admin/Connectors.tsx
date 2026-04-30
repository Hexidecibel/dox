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
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

const ITEMS_PER_PAGE = 20;

interface Connector {
  id: string;
  name: string;
  /** Phase B0.5 — globally-unique URL-safe handle. NULL only on legacy
   * rows that pre-date the backfill; the list rows fall back to id
   * gracefully in that case. */
  slug: string | null;
  config: string | Record<string, unknown>;
  schedule: string | null;
  active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
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

      <HelpWell id="connectors.list" title={helpContent.connectors.list.headline}>
        {helpContent.connectors.list.well}
      </HelpWell>

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
            <EmptyState
              title={helpContent.connectors.list.emptyTitle ?? 'No connectors yet'}
              description={helpContent.connectors.list.emptyDescription}
              actionLabel="New connector"
              onAction={() => navigate('/admin/connectors/new')}
            />
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
                      {/* Phase B0.5 slug — shown as a monospace
                          micro-line so admins can spot-check the
                          vendor-facing handle without opening detail. */}
                      {connector.slug && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace', display: 'block' }}
                        >
                          {connector.slug}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.secondary">
                        Last run: {formatRelativeTime(connector.last_run_at)}
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                      {/* Engineering escape hatch — raw JSON edit bypasses wizard validations
                          (email scoping, field-mapping shape, type coercion). super_admin only. */}
                      {isSuperAdmin && (
                        <IconButton size="small" onClick={() => openEdit(connector)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      )}
                      <IconButton size="small" color="error" onClick={() => handleDelete(connector)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      label={connector.active ? 'Active' : 'Draft'}
                      size="small"
                      color={connector.active ? 'success' : 'warning'}
                      variant={connector.active ? 'outlined' : 'filled'}
                    />
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : connectors.length === 0 ? (
        <EmptyState
          title={helpContent.connectors.list.emptyTitle ?? 'No connectors yet'}
          description={helpContent.connectors.list.emptyDescription}
          actionLabel="New connector"
          onAction={() => navigate('/admin/connectors/new')}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Slug
                    <InfoTooltip text={helpContent.connectors.list.columnTooltips.slug} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Last Run
                    <InfoTooltip text={helpContent.connectors.list.columnTooltips.lastRun} />
                  </Box>
                </TableCell>
                <TableCell>
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                    Status
                    <InfoTooltip text={helpContent.connectors.list.columnTooltips.status} />
                  </Box>
                </TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connectors.map((connector) => (
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
                      <Typography
                        variant="body2"
                        sx={{ fontFamily: 'monospace' }}
                        color="text.secondary"
                      >
                        {connector.slug || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {formatRelativeTime(connector.last_run_at)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={connector.active ? 'Active' : 'Draft'}
                        size="small"
                        color={connector.active ? 'success' : 'warning'}
                        variant={connector.active ? 'outlined' : 'filled'}
                      />
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      {/* Engineering escape hatch — raw JSON edit bypasses wizard validations
                          (email scoping, field-mapping shape, type coercion). super_admin only. */}
                      {isSuperAdmin && (
                        <Tooltip title="Edit (raw JSON)">
                          <IconButton size="small" onClick={() => openEdit(connector)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip title="Delete">
                        <IconButton size="small" color="error" onClick={() => handleDelete(connector)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
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
