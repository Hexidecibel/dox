import { Fragment, useMemo, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Drawer,
  AppBar,
  Toolbar,
  Typography,
  IconButton,
  Tooltip,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
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
  Logout as LogoutIcon,
  Person as PersonIcon,
  FilterList as FilterIcon,
  HelpOutline as HelpIcon,
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';
import { NotificationsBell } from './NotificationsBell';
import { SetupBanner } from './SetupPrompt';
import { navGroupsForRole, pinnedNavSurfaces } from '../lib/surfaces';
import type { Surface } from '../lib/surfaces';

const DRAWER_WIDTH = 260;

/**
 * The rail is rendered from `src/lib/surfaces.tsx` — the same rows that
 * produce the routes in `App.tsx`. There is deliberately no `navItems` array
 * here any more: this file and App.tsx used to be two independent lists of
 * paths and had already drifted in both directions on production, which is
 * how a `user` came to see the Out-of-Spec link and be bounced by the route.
 *
 * Items are GROUPED BY MODULE, with a `ListSubheader` per group and a divider
 * between them. Not collapsible: there is nowhere to persist per-user collapse
 * state, and collapsing would re-hide exactly what grouping just made
 * findable. Empty groups drop their heading — same shape as `Settings.tsx`.
 *
 * THE TENANT MODULE FILTER IS APPLIED HERE, and again on every route in
 * App.tsx. Both, deliberately: filtering only the rail would leave every
 * surface reachable by URL, and gating only the routes would leave links in
 * the sidebar that all end in a refusal panel. The set comes from
 * `ModuleAccessContext`; `ProtectedRoute` has already waited for it, so the
 * rail is drawn once with the right items rather than drawn and then pruned.
 */

const roleColors: Record<string, 'primary' | 'secondary' | 'default'> = {
  super_admin: 'primary',
  org_admin: 'primary',
  user: 'secondary',
  reader: 'default',
};

export function Layout() {
  const { user, logout, isSuperAdmin } = useAuth();
  const { tenants, selectedTenantId, setSelectedTenantId } = useTenant();
  const { visible: visibleModules } = useModuleAccess();
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
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  // One computation per role or visibility change, shared by both blocks of
  // the rail. Pinned surfaces belong to no module, so they need no set.
  const navGroups = useMemo(
    () => navGroupsForRole(user?.role, visibleModules),
    [user?.role, visibleModules]
  );
  const pinned = useMemo(() => pinnedNavSurfaces(user?.role), [user?.role]);

  // Every rail entry looks the same whether it is grouped or pinned; the only
  // thing a surface contributes is its label, icon and path.
  const renderNavItem = (surface: Surface) => {
    const active = isActive(surface.path);
    return (
      <ListItem key={surface.path} disablePadding sx={{ mb: 0.5 }}>
        <ListItemButton
          onClick={() => handleNavClick(surface.path)}
          selected={active}
          sx={{ borderRadius: 1 }}
        >
          <ListItemIcon sx={{ minWidth: 40, color: active ? 'primary.main' : 'text.secondary' }}>
            {surface.nav!.icon}
          </ListItemIcon>
          <ListItemText
            primary={surface.nav!.label}
            primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: active ? 600 : 400 }}
          />
        </ListItemButton>
      </ListItem>
    );
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
        {navGroups.map((group, idx) => (
          <Fragment key={group.module ?? 'always-on'}>
            {group.heading && (
              <>
                {idx > 0 && <Divider sx={{ my: 1 }} />}
                <ListSubheader
                  disableSticky
                  disableGutters
                  sx={{
                    px: 2,
                    lineHeight: 2.2,
                    bgcolor: 'transparent',
                    color: 'text.secondary',
                    fontSize: '0.65rem',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  {group.heading}
                </ListSubheader>
              </>
            )}
            {group.items.map(renderNavItem)}
          </Fragment>
        ))}

        {pinned.length > 0 && <Divider sx={{ my: 1.5 }} />}
        {pinned.map(renderNavItem)}
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
            <Box sx={{ flex: 1 }} />
            <NotificationsBell />
            <Tooltip title="Help">
              <IconButton onClick={() => handleNavClick('/help')} sx={{ mr: 1 }}>
                <HelpIcon />
              </IconButton>
            </Tooltip>
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

      {/* Desktop top bar — hosts the Help shortcut. */}
      {!isMobile && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            right: 0,
            zIndex: (t) => t.zIndex.drawer + 1,
            p: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          <NotificationsBell />
          <Tooltip title="Help">
            <IconButton onClick={() => navigate('/help')}>
              <HelpIcon />
            </IconButton>
          </Tooltip>
        </Box>
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
        {/* The first-run offer. Renders nothing unless the tenant has no
            completed setup run AND no documents, and it is dismissible per
            browser — never a modal, because a super_admin scoping into a fresh
            tenant mid-demo must not be ambushed. */}
        <SetupBanner />
        <Outlet />
      </Box>
    </Box>
  );
}
