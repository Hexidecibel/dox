import { AppBar, Toolbar, Typography, Button, Box, Chip, TextField, InputAdornment, useMediaQuery, useTheme, IconButton } from '@mui/material';
import { Search as SearchIcon, Logout as LogoutIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const roleColors: Record<string, 'primary' | 'secondary' | 'default'> = {
  admin: 'primary',
  user: 'secondary',
  reader: 'default',
};

export function Navbar() {
  const { user, logout, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  if (!isAuthenticated) return null;

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        bgcolor: 'background.paper',
        color: 'text.primary',
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Toolbar>
        <Box sx={{ cursor: 'pointer', mr: 3, flexShrink: 0 }} onClick={() => navigate('/dashboard')}>
          <img src="/logo.svg" alt="Dox" height={28} />
        </Box>

        {!isMobile && (
          <TextField
            placeholder="Search documents..."
            size="small"
            sx={{ flex: 1, maxWidth: 400 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const value = (e.target as HTMLInputElement).value;
                if (value.trim()) {
                  navigate(`/search?q=${encodeURIComponent(value.trim())}`);
                }
              }
            }}
          />
        )}

        {isMobile && (
          <IconButton onClick={() => navigate('/search')} sx={{ ml: 'auto' }}>
            <SearchIcon />
          </IconButton>
        )}

        <Box sx={{ flex: 1 }} />

        {user && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            {!isMobile && (
              <>
                <Typography variant="body2" fontWeight={500}>
                  {user.name}
                </Typography>
                <Chip
                  label={user.role}
                  size="small"
                  color={roleColors[user.role] || 'default'}
                  sx={{ textTransform: 'capitalize', fontSize: '0.7rem' }}
                />
              </>
            )}
            <Button
              size="small"
              startIcon={<LogoutIcon />}
              onClick={logout}
              sx={{ color: 'text.secondary' }}
            >
              {isMobile ? '' : 'Sign Out'}
            </Button>
          </Box>
        )}
      </Toolbar>
    </AppBar>
  );
}
