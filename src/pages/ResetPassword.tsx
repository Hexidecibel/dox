import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Link,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import { Lock as LockIcon } from '@mui/icons-material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import { api } from '../lib/api';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const passwordRequirements = [
    { label: 'At least 8 characters', met: newPassword.length >= 8 },
    { label: 'At most 128 characters', met: newPassword.length > 0 && newPassword.length <= 128 },
    { label: 'Contains an uppercase letter', met: /[A-Z]/.test(newPassword) },
    { label: 'Contains a lowercase letter', met: /[a-z]/.test(newPassword) },
    { label: 'Contains a number', met: /[0-9]/.test(newPassword) },
  ];

  const allRequirementsMet = passwordRequirements.every((r) => r.met);
  const passwordsMatch = newPassword === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allRequirementsMet) {
      setError('Password does not meet all requirements');
      return;
    }
    if (!passwordsMatch) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.auth.resetPassword(token, newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
          p: { xs: 2, sm: 3 },
        }}
      >
        <Card sx={{ maxWidth: 400, width: '100%' }}>
          <CardContent sx={{ p: { xs: 3, sm: 4 }, textAlign: 'center' }}>
            <Alert severity="error" sx={{ mb: 2 }}>
              Invalid reset link. Please request a new password reset.
            </Alert>
            <Link component={RouterLink} to="/forgot-password" variant="body2">
              Request Password Reset
            </Link>
          </CardContent>
        </Card>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: { xs: 2, sm: 3 },
      }}
    >
      <Card sx={{ maxWidth: 400, width: '100%' }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Box sx={{ textAlign: 'center', mb: 3 }}>
            <Box
              sx={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                bgcolor: 'primary.main',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                mx: 'auto',
                mb: 2,
              }}
            >
              <LockIcon sx={{ fontSize: 28, color: 'white' }} />
            </Box>
            <Typography variant="h5" fontWeight={700} color="primary.main">
              Set New Password
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Choose a new password for your account
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {success ? (
            <Box>
              <Alert severity="success" sx={{ mb: 2 }}>
                Password reset successfully. You can now sign in with your new password.
              </Alert>
              <Box sx={{ textAlign: 'center', mt: 2 }}>
                <Link component={RouterLink} to="/login" variant="body2">
                  Go to Sign In
                </Link>
              </Box>
            </Box>
          ) : (
            <Box component="form" onSubmit={handleSubmit}>
              <TextField
                label="New Password"
                type="password"
                fullWidth
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
                autoFocus
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
                disabled={loading}
                error={!!confirmPassword && !passwordsMatch}
                helperText={
                  confirmPassword && !passwordsMatch
                    ? 'Passwords do not match'
                    : undefined
                }
                sx={{ mb: 3 }}
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                size="large"
                disabled={loading || !allRequirementsMet || !passwordsMatch || !confirmPassword}
                sx={{ py: 1.2, mb: 2 }}
              >
                {loading ? <CircularProgress size={24} /> : 'Reset Password'}
              </Button>
              <Box sx={{ textAlign: 'center' }}>
                <Link component={RouterLink} to="/login" variant="body2">
                  Back to Sign In
                </Link>
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
