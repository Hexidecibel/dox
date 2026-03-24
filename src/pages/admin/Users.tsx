import { useState, useEffect } from 'react';
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
  MenuItem,
  Select,
  FormControl,
  InputLabel,
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
  Edit as EditIcon,
  Block as BlockIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
  LockReset as LockResetIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type { User, Tenant, Role } from '../../lib/types';
import { CopyId } from '../../components/CopyId';

const roleColors: Record<string, 'primary' | 'secondary' | 'default'> = {
  super_admin: 'primary',
  org_admin: 'primary',
  user: 'secondary',
  reader: 'default',
};

export function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<Role>('reader');
  const [formTenantId, setFormTenantId] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset password dialog state
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetTargetUser, setResetTargetUser] = useState<User | null>(null);
  const [tempPassword, setTempPassword] = useState('');
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [userList, tenantList] = await Promise.all([
        api.users.list(),
        api.tenants.list(),
      ]);
      setUsers(userList);
      setTenants(tenantList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openCreate = () => {
    setEditingUser(null);
    setFormName('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('reader');
    setFormTenantId('');
    setDialogOpen(true);
  };

  const openEdit = (user: User) => {
    setEditingUser(user);
    setFormName(user.name);
    setFormEmail(user.email);
    setFormPassword('');
    setFormRole(user.role);
    setFormTenantId(user.tenant_id || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (editingUser) {
        await api.users.update(editingUser.id, {
          name: formName.trim(),
          email: formEmail.trim(),
          role: formRole,
          tenant_id: formTenantId || undefined,
        });
      } else {
        if (!formPassword) {
          setError('Password is required for new users');
          setSaving(false);
          return;
        }
        await api.users.create({
          name: formName.trim(),
          email: formEmail.trim(),
          password: formPassword,
          role: formRole,
          tenant_id: formTenantId || undefined,
        });
      }
      setDialogOpen(false);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      await api.users.update(user.id, { active: user.active ? 0 : 1 });
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    }
  };

  const openResetConfirm = (user: User) => {
    setResetTargetUser(user);
    setResetConfirmOpen(true);
  };

  const handleResetPassword = async () => {
    if (!resetTargetUser) return;
    setResetting(true);
    setError('');
    try {
      const result = await api.users.resetPassword(resetTargetUser.id);
      setTempPassword(result.temporaryPassword);
      setResetEmailSent(result.emailSent);
      setResetConfirmOpen(false);
      setResetDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
      setResetConfirmOpen(false);
    } finally {
      setResetting(false);
    }
  };

  const handleCopyPassword = async () => {
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  };

  const getTenantName = (tenantId: string | null) => {
    if (!tenantId) return '-';
    const tenant = tenants.find((t) => t.id === tenantId);
    return tenant?.name || tenantId;
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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          User Management
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Add User
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {isMobile ? (
        // Mobile card layout
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {users.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No users found</Typography>
              </CardContent>
            </Card>
          ) : (
            users.map((user) => (
              <Card key={user.id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1 }}>
                    <Box>
                      <Typography variant="body2" fontWeight={600}>
                        {user.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {user.email}
                      </Typography>
                      <Box><CopyId id={user.id} /></Box>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <IconButton size="small" onClick={() => openEdit(user)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" onClick={() => openResetConfirm(user)}>
                        <LockResetIcon fontSize="small" color="info" />
                      </IconButton>
                      <IconButton size="small" onClick={() => handleToggleActive(user)}>
                        {user.active ? (
                          <BlockIcon fontSize="small" color="warning" />
                        ) : (
                          <ActiveIcon fontSize="small" color="success" />
                        )}
                      </IconButton>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip label={user.role} size="small" color={roleColors[user.role] || 'default'} sx={{ textTransform: 'capitalize' }} />
                    <Chip label={user.active ? 'Active' : 'Inactive'} size="small" color={user.active ? 'success' : 'default'} variant="outlined" />
                    {user.tenant_id && (
                      <Chip label={getTenantName(user.tenant_id)} size="small" variant="outlined" />
                    )}
                  </Box>
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        // Desktop table layout
        <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Tenant</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last Login</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No users found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell>
                      <CopyId id={user.id} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {user.name}
                      </Typography>
                    </TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      <Chip
                        label={user.role}
                        size="small"
                        color={roleColors[user.role] || 'default'}
                        sx={{ textTransform: 'capitalize' }}
                      />
                    </TableCell>
                    <TableCell>{getTenantName(user.tenant_id)}</TableCell>
                    <TableCell>
                      <Chip
                        label={user.active ? 'Active' : 'Inactive'}
                        size="small"
                        color={user.active ? 'success' : 'default'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      {user.last_login_at
                        ? new Date(user.last_login_at).toLocaleDateString()
                        : 'Never'}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => openEdit(user)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Reset Password">
                        <IconButton size="small" onClick={() => openResetConfirm(user)}>
                          <LockResetIcon fontSize="small" color="info" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={user.active ? 'Deactivate' : 'Activate'}>
                        <IconButton size="small" onClick={() => handleToggleActive(user)}>
                          {user.active ? (
                            <BlockIcon fontSize="small" color="warning" />
                          ) : (
                            <ActiveIcon fontSize="small" color="success" />
                          )}
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

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth fullScreen={isMobile}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {editingUser ? 'Edit User' : 'Create User'}
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
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Email"
            type="email"
            fullWidth
            required
            value={formEmail}
            onChange={(e) => setFormEmail(e.target.value)}
            disabled={saving}
            sx={{ mb: 2 }}
          />
          {!editingUser && (
            <TextField
              label="Password"
              type="password"
              fullWidth
              required
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              disabled={saving}
              sx={{ mb: 2 }}
            />
          )}
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Role</InputLabel>
            <Select
              value={formRole}
              onChange={(e) => setFormRole(e.target.value as Role)}
              label="Role"
              disabled={saving}
            >
              <MenuItem value="super_admin">Super Admin</MenuItem>
              <MenuItem value="org_admin">Org Admin</MenuItem>
              <MenuItem value="user">User</MenuItem>
              <MenuItem value="reader">Reader</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth>
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
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formName.trim() || !formEmail.trim() || saving}
          >
            {saving ? 'Saving...' : editingUser ? 'Save Changes' : 'Create User'}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Reset Password Confirmation Dialog */}
      <Dialog open={resetConfirmOpen} onClose={() => setResetConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Reset Password</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to reset the password for <strong>{resetTargetUser?.name}</strong> ({resetTargetUser?.email})?
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            This will generate a new temporary password and revoke all active sessions.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setResetConfirmOpen(false)} disabled={resetting}>
            Cancel
          </Button>
          <Button variant="contained" color="warning" onClick={handleResetPassword} disabled={resetting}>
            {resetting ? 'Resetting...' : 'Reset Password'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Temporary Password Result Dialog */}
      <Dialog open={resetDialogOpen} onClose={() => { setResetDialogOpen(false); setTempPassword(''); setCopied(false); }} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Password Reset Successful
          <IconButton onClick={() => { setResetDialogOpen(false); setTempPassword(''); setCopied(false); }} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            A new temporary password has been generated for <strong>{resetTargetUser?.name}</strong>.
          </Typography>
          <Paper variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', bgcolor: 'grey.50' }}>
            <Typography variant="h6" fontFamily="monospace" sx={{ letterSpacing: 1 }}>
              {tempPassword}
            </Typography>
            <Tooltip title={copied ? 'Copied!' : 'Copy to clipboard'}>
              <IconButton onClick={handleCopyPassword} size="small">
                <CopyIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Paper>
          {resetEmailSent && (
            <Alert severity="info" sx={{ mt: 2 }}>
              An email with the new temporary password has been sent to {resetTargetUser?.email}.
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            The user will be required to change their password on next login.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={() => { setResetDialogOpen(false); setTempPassword(''); setCopied(false); }}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
