import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';

/**
 * The authenticated-shell boundary: is there a session at all, and is the
 * shell ready to be drawn?
 *
 * IT NO LONGER TAKES `roles`. Until module visibility landed, this component
 * answered two questions — "are you signed in" and "is your role allowed
 * here" — and answered the second with a silent `<Navigate to="/dashboard">`.
 * A bookmarked or shared URL that dumps you on the dashboard with no
 * explanation is indistinguishable from a broken link, and the module gate
 * has two MORE ways to refuse (the tenant switched it off; your department is
 * scoped away from it). Three reasons and one wordless redirect is not a
 * design. So all three now live in `ModuleRoute`, which renders a panel
 * naming the one that refused. This file keeps the one question that really
 * does end in a redirect: no session, go and log in.
 *
 * IT WAITS FOR MODULE ACCESS. `GET /api/module-access` resolves after auth,
 * and the nav is rendered from it. Drawing the rail first and pulling items
 * out of it a moment later is worse than the spinner that is already here for
 * auth, so the two loading states are one — deliberately not a second spinner
 * somewhere further in.
 */
export function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  const { isAuthenticated, loading, forcePasswordChange } = useAuth();
  const { loading: modulesLoading } = useModuleAccess();
  const location = useLocation();

  if (loading || modulesLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Force redirect to profile page if password change is required
  if (forcePasswordChange && location.pathname !== '/profile') {
    return <Navigate to="/profile" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
