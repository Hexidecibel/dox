import { useState, useEffect } from 'react';
import { formatDate } from '../utils/format';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Alert,
  Chip,
  Divider,
  CircularProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string | null;
  tenant_name: string | null;
  active: number;
  last_login_at: string | null;
  created_at: string;
}

const roleColors: Record<string, 'primary' | 'secondary' | 'default'> = {
  super_admin: 'primary',
  org_admin: 'primary',
  user: 'secondary',
  reader: 'default',
};

export function Profile() {
  const { user, forcePasswordChange, clearForcePasswordChange } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // Password form
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const data = await api.users.me();
        setProfile(data as unknown as UserProfile);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    };
    loadProfile();
  }, []);

  const passwordRequirements = [
    { label: 'At least 8 characters', met: newPassword.length >= 8 },
    { label: 'At most 128 characters', met: newPassword.length > 0 && newPassword.length <= 128 },
    { label: 'Contains an uppercase letter', met: /[A-Z]/.test(newPassword) },
    { label: 'Contains a lowercase letter', met: /[a-z]/.test(newPassword) },
    { label: 'Contains a number', met: /[0-9]/.test(newPassword) },
  ];

  const allRequirementsMet = passwordRequirements.every((r) => r.met);

  const passwordError = (): string | null => {
    if (newPassword && !allRequirementsMet) {
      return 'Password does not meet all requirements';
    }
    if (newPassword && confirmPassword && newPassword !== confirmPassword) {
      return 'Passwords do not match';
    }
    return null;
  };

  const handleChangePassword = async () => {
    const validationError = passwordError();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await api.auth.changePassword(currentPassword, newPassword);
      setSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (forcePasswordChange) {
        clearForcePasswordChange();
        setTimeout(() => navigate('/dashboard', { replace: true }), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
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

  const displayProfile = profile || user;

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', px: { xs: 0, sm: 0 } }}>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        Profile
      </Typography>

      {forcePasswordChange && (
        <Alert severity="warning" sx={{ mb: 2 }} variant="filled">
          You must change your password to continue using the portal.
        </Alert>
      )}

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

      {/* User Info */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
          Account Information
        </Typography>

        <Box sx={{ display: 'grid', gap: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Name
            </Typography>
            <Typography variant="body1" fontWeight={500}>
              {displayProfile?.name}
            </Typography>
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary">
              Email
            </Typography>
            <Typography variant="body1">
              {displayProfile?.email}
            </Typography>
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary">
              Role
            </Typography>
            <Box sx={{ mt: 0.5 }}>
              <Chip
                label={displayProfile?.role}
                size="small"
                color={roleColors[displayProfile?.role || ''] || 'default'}
                sx={{ textTransform: 'capitalize' }}
              />
            </Box>
          </Box>

          {profile?.tenant_name && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Organization
              </Typography>
              <Typography variant="body1">
                {profile.tenant_name}
              </Typography>
            </Box>
          )}

          {profile?.created_at && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                Member Since
              </Typography>
              <Typography variant="body1">
                {formatDate(profile.created_at)}
              </Typography>
            </Box>
          )}
        </Box>
      </Paper>

      {/* Change Password */}
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
          Change Password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Update your password to keep your account secure.
        </Typography>
        <Divider sx={{ mb: 2 }} />

        <TextField
          label="Current Password"
          type="password"
          fullWidth
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={saving}
          sx={{ mb: 2 }}
        />
        <TextField
          label="New Password"
          type="password"
          fullWidth
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={saving}
          sx={{ mb: 1 }}
        />
        {newPassword && (
          <List dense sx={{ mb: 1, py: 0 }}>
            {passwordRequirements.map((req) => (
              <ListItem key={req.label} sx={{ py: 0, px: 1 }}>
                <ListItemIcon sx={{ minWidth: 28 }}>
                  {req.met ? (
                    <CheckCircleIcon fontSize="small" color="success" />
                  ) : (
                    <CancelIcon fontSize="small" color="error" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={req.label}
                  primaryTypographyProps={{
                    variant: 'caption',
                    color: req.met ? 'text.secondary' : 'error',
                  }}
                />
              </ListItem>
            ))}
          </List>
        )}
        <TextField
          label="Confirm New Password"
          type="password"
          fullWidth
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={saving}
          error={!!confirmPassword && newPassword !== confirmPassword}
          helperText={
            confirmPassword && newPassword !== confirmPassword
              ? 'Passwords do not match'
              : undefined
          }
          sx={{ mb: 3 }}
        />

        <Button
          variant="contained"
          onClick={handleChangePassword}
          disabled={
            saving ||
            !currentPassword ||
            !newPassword ||
            !confirmPassword ||
            !!passwordError()
          }
        >
          {saving ? 'Changing...' : 'Change Password'}
        </Button>
      </Paper>
    </Box>
  );
}
