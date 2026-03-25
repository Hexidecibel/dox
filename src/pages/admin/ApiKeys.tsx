import { useState, useEffect } from 'react';
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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Tooltip,
  useMediaQuery,
  useTheme,
  Card,
  CardContent,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  ContentCopy as CopyIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { ApiKey, Tenant } from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { CopyId } from '../../components/CopyId';

export function ApiKeys() {
  const { user } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formTenantId, setFormTenantId] = useState('');
  const [formExpiresAt, setFormExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  // Key reveal dialog state
  const [revealOpen, setRevealOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [copied, setCopied] = useState(false);

  // Revoke confirm dialog state
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const isSuperAdmin = user?.role === 'super_admin';

  const loadData = async () => {
    setLoading(true);
    try {
      const [keyList, tenantList] = await Promise.all([
        api.apiKeys.list(),
        api.tenants.list(),
      ]);
      setKeys(keyList);
      setTenants(tenantList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openCreate = () => {
    setFormName('');
    setFormTenantId(isSuperAdmin ? '' : (user?.tenant_id || ''));
    setFormExpiresAt('');
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    setSaving(true);
    setError('');
    try {
      const result = await api.apiKeys.create({
        name: formName.trim(),
        tenantId: formTenantId || undefined,
        expiresAt: formExpiresAt || undefined,
      });
      setCreateOpen(false);
      setNewKey(result.key);
      setRevealOpen(true);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const openRevoke = (key: ApiKey) => {
    setRevokeTarget(key);
    setRevokeOpen(true);
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setError('');
    try {
      await api.apiKeys.revoke(revokeTarget.id);
      setRevokeOpen(false);
      setRevokeTarget(null);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key');
    } finally {
      setRevoking(false);
    }
  };

  const getTenantName = (tenantId: string | null) => {
    if (!tenantId) return '-';
    const tenant = tenants.find((t) => t.id === tenantId);
    return tenant?.name || tenantId;
  };

  const getStatus = (key: ApiKey): { label: string; color: 'success' | 'error' | 'default' } => {
    if (key.revoked) return { label: 'Revoked', color: 'error' };
    if (key.expires_at && new Date(key.expires_at) < new Date()) return { label: 'Expired', color: 'default' };
    return { label: 'Active', color: 'success' };
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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          API Keys
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Create Key
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Create and manage API keys for service integrations
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {keys.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No API keys found</Typography>
              </CardContent>
            </Card>
          ) : (
            keys.map((key) => {
              const status = getStatus(key);
              return (
                <Card key={key.id} variant="outlined">
                  <CardContent sx={{ pb: '12px !important' }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                      <Box>
                        <Typography variant="body2" fontWeight={600}>
                          {key.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                          {key.key_prefix}...
                        </Typography>
                        <Box><CopyId id={key.id} /></Box>
                      </Box>
                      {!key.revoked && (
                        <IconButton size="small" onClick={() => openRevoke(key)} color="error">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      )}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                      <Chip label={status.label} size="small" color={status.color} variant="outlined" />
                      {key.tenant_id && (
                        <Chip label={getTenantName(key.tenant_id)} size="small" variant="outlined" />
                      )}
                    </Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                      Created {formatDate(key.created_at)} | Last used {formatDate(key.last_used_at)}
                    </Typography>
                  </CardContent>
                </Card>
              );
            })
          )}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Key</TableCell>
                <TableCell>Tenant</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Used</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No API keys found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((key) => {
                  const status = getStatus(key);
                  return (
                    <TableRow key={key.id} hover>
                      <TableCell>
                        <CopyId id={key.id} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={500}>
                          {key.name}
                        </Typography>
                        {key.user_name && (
                          <Typography variant="caption" color="text.secondary">
                            {key.user_name}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontFamily="monospace" fontSize="0.8rem">
                          {key.key_prefix}...
                        </Typography>
                      </TableCell>
                      <TableCell>{getTenantName(key.tenant_id)}</TableCell>
                      <TableCell>{formatDate(key.created_at)}</TableCell>
                      <TableCell>{formatDate(key.last_used_at)}</TableCell>
                      <TableCell>
                        <Chip
                          label={status.label}
                          size="small"
                          color={status.color}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell align="right">
                        {!key.revoked && !(key.expires_at && new Date(key.expires_at) < new Date()) && (
                          <Tooltip title="Revoke">
                            <IconButton size="small" onClick={() => openRevoke(key)} color="error">
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Create API Key
          <IconButton onClick={() => setCreateOpen(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <TextField
            label="Name"
            fullWidth
            required
            placeholder='e.g. "MindStudio Email Agent"'
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={saving}
            sx={{ mt: 1, mb: 2 }}
          />
          {isSuperAdmin ? (
            <FormControl fullWidth sx={{ mb: 2 }}>
              <InputLabel>Tenant</InputLabel>
              <Select
                value={formTenantId}
                onChange={(e) => setFormTenantId(e.target.value)}
                label="Tenant"
                disabled={saving}
              >
                <MenuItem value="">None (Global)</MenuItem>
                {tenants.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : (
            <TextField
              label="Tenant"
              fullWidth
              value={getTenantName(user?.tenant_id || null)}
              disabled
              sx={{ mb: 2 }}
            />
          )}
          <TextField
            label="Expiration (optional)"
            type="date"
            fullWidth
            value={formExpiresAt}
            onChange={(e) => setFormExpiresAt(e.target.value)}
            disabled={saving}
            InputLabelProps={{ shrink: true }}
            helperText="Leave empty for no expiration"
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCreateOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!formName.trim() || saving}
          >
            {saving ? 'Creating...' : 'Create Key'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Key Reveal Dialog */}
      <Dialog
        open={revealOpen}
        onClose={() => { setRevealOpen(false); setNewKey(''); setCopied(false); }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          API Key Created
          <IconButton onClick={() => { setRevealOpen(false); setNewKey(''); setCopied(false); }} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Copy this key now. You won't be able to see it again.
          </Alert>
          <Paper
            variant="outlined"
            sx={{
              p: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              bgcolor: 'grey.50',
              gap: 1,
            }}
          >
            <Typography
              variant="body2"
              fontFamily="monospace"
              sx={{
                wordBreak: 'break-all',
                flex: 1,
                fontSize: '0.85rem',
                userSelect: 'all',
              }}
            >
              {newKey}
            </Typography>
            <Tooltip title={copied ? 'Copied!' : 'Copy to clipboard'}>
              <IconButton onClick={handleCopyKey} size="small" sx={{ flexShrink: 0 }}>
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Paper>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={() => { setRevealOpen(false); setNewKey(''); setCopied(false); }}>
            Done
          </Button>
        </DialogActions>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={revokeOpen} onClose={() => setRevokeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Revoke API Key</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to revoke <strong>{revokeTarget?.name}</strong>?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This action cannot be undone. Any integrations using this key will stop working immediately.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRevokeOpen(false)} disabled={revoking}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleRevoke} disabled={revoking}>
            {revoking ? 'Revoking...' : 'Revoke Key'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
