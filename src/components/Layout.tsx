import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Drawer,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Divider,
  Chip,
  Button,
  useMediaQuery,
  useTheme,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Avatar,
} from '@mui/material';
import {
  Menu as MenuIcon,
  Dashboard as DashboardIcon,
  Description as DocsIcon,
  CloudUpload as UploadIcon,
  Search as SearchIcon,
  People as UsersIcon,
  Business as TenantsIcon,
  VpnKey as ApiKeyIcon,
  Logout as LogoutIcon,
  Person as PersonIcon,
  FilterList as FilterIcon,
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { RoleGuard } from './RoleGuard';

const DRAWER_WIDTH = 260;

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  roles?: ('super_admin' | 'org_admin' | 'user' | 'reader')[];
}

const navItems: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: <DashboardIcon /> },
  { label: 'Documents', path: '/documents', icon: <DocsIcon /> },
  { label: 'Upload', path: '/documents?upload=true', icon: <UploadIcon />, roles: ['super_admin', 'org_admin', 'user'] },
  { label: 'Search', path: '/search', icon: <SearchIcon /> },
];

const adminItems: NavItem[] = [
  { label: 'Users', path: '/admin/users', icon: <UsersIcon />, roles: ['super_admin', 'org_admin'] },
  { label: 'API Keys', path: '/admin/api-keys', icon: <ApiKeyIcon />, roles: ['super_admin', 'org_admin'] },
  { label: 'Tenants', path: '/admin/tenants', icon: <TenantsIcon />, roles: ['super_admin'] },
];

const roleColors: Record<string, 'primary' | 'secondary' | 'default'> = {
  super_admin: 'primary',
  org_admin: 'primary',
  user: 'secondary',
  reader: 'default',
};

export function Layout() {
  const { user, logout, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId, setSelectedTenantId } = useTenant();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleNavClick = (path: string) => {
    navigate(path);
    if (isMobile) setMobileOpen(false);
  };

  const isActive = (path: string) => {
    if (path.includes('?')) {
      const [pathname, query] = path.split('?');
      return location.pathname === pathname && location.search.includes(query);
    }
    // For plain paths, also ensure we're not matching a query-param variant
    if (location.pathname === path && location.search.includes('upload=true')) return false;
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const drawerContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ px: 2, py: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <img src="/logo.svg" alt="Dox" height={28} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          Document Management
        </Typography>
      </Box>
      <Divider />

      <List sx={{ flex: 1, px: 1, py: 1 }}>
        {navItems.map((item) => {
          const button = (
            <ListItem key={item.label} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                onClick={() => handleNavClick(item.path)}
                selected={isActive(item.path)}
                sx={{ borderRadius: 1 }}
              >
                <ListItemIcon sx={{ minWidth: 40, color: isActive(item.path) ? 'primary.main' : 'text.secondary' }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: isActive(item.path) ? 600 : 400 }} />
              </ListItemButton>
            </ListItem>
          );
          if (item.roles) {
            return (
              <RoleGuard key={item.label} roles={item.roles}>
                {button}
              </RoleGuard>
            );
          }
          return button;
        })}

        <RoleGuard roles={['super_admin', 'org_admin']}>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="overline" sx={{ px: 2, color: 'text.secondary', fontSize: '0.65rem' }}>
            Administration
          </Typography>
          {adminItems.map((item) => {
            const adminButton = (
              <ListItem key={item.label} disablePadding sx={{ mb: 0.5 }}>
                <ListItemButton
                  onClick={() => handleNavClick(item.path)}
                  selected={isActive(item.path)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemIcon sx={{ minWidth: 40, color: isActive(item.path) ? 'primary.main' : 'text.secondary' }}>
                    {item.icon}
                  </ListItemIcon>
                  <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: isActive(item.path) ? 600 : 400 }} />
                </ListItemButton>
              </ListItem>
            );
            if (item.roles) {
              return (
                <RoleGuard key={item.label} roles={item.roles}>
                  {adminButton}
                </RoleGuard>
              );
            }
            return adminButton;
          })}
        </RoleGuard>
      </List>

      {/* Tenant Selector for super_admin */}
      {isSuperAdmin && tenants.length > 0 && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
              <FilterIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>
                Tenant Filter
              </Typography>
            </Box>
            <FormControl fullWidth size="small">
              <InputLabel>Tenant</InputLabel>
              <Select
                value={selectedTenantId || ''}
                onChange={(e) => setSelectedTenantId(e.target.value || null)}
                label="Tenant"
              >
                <MenuItem value="">All Tenants</MenuItem>
                {tenants.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        </>
      )}

      <Divider />
      <Box sx={{ p: 2 }}>
        {user && (
          <Box sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Avatar
              sx={{
                width: 36,
                height: 36,
                bgcolor: 'primary.main',
                fontSize: '0.8rem',
                fontWeight: 600,
              }}
            >
              {getInitials(user.name)}
            </Avatar>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {user.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" noWrap>
                {user.email}
              </Typography>
            </Box>
            <Chip
              label={user.role.replace('_', ' ')}
              size="small"
              color={roleColors[user.role] || 'default'}
              sx={{ textTransform: 'capitalize', fontSize: '0.65rem', flexShrink: 0 }}
            />
          </Box>
        )}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            fullWidth
            variant="outlined"
            size="small"
            startIcon={<PersonIcon />}
            onClick={() => { navigate('/profile'); if (isMobile) setMobileOpen(false); }}
            sx={{ fontSize: '0.8rem' }}
          >
            Profile
          </Button>
          <Button
            fullWidth
            variant="outlined"
            size="small"
            startIcon={<LogoutIcon />}
            onClick={logout}
            sx={{ fontSize: '0.8rem' }}
          >
            Sign Out
          </Button>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Mobile AppBar */}
      {isMobile && (
        <AppBar
          position="fixed"
          elevation={0}
          sx={{
            zIndex: (t) => t.zIndex.drawer + 1,
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Toolbar>
            <IconButton edge="start" onClick={() => setMobileOpen(!mobileOpen)} sx={{ mr: 1 }}>
              <MenuIcon />
            </IconButton>
            <img src="/logo.svg" alt="Dox" height={24} style={{ flex: 0 }} />
            {user && (
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  bgcolor: 'primary.main',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                }}
              >
                {getInitials(user.name)}
              </Avatar>
            )}
          </Toolbar>
        </AppBar>
      )}

      {/* Sidebar Drawer */}
      <Drawer
        variant={isMobile ? 'temporary' : 'permanent'}
        open={isMobile ? mobileOpen : true}
        onClose={() => setMobileOpen(false)}
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            boxSizing: 'border-box',
          },
        }}
      >
        {drawerContent}
      </Drawer>

      {/* Main content */}
      <Box
        component="main"
        sx={{
          flex: 1,
          p: { xs: 2, sm: 3 },
          mt: isMobile ? 8 : 0,
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        <Outlet />
      </Box>
    </Box>
  );
}
