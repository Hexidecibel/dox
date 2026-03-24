import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import type { Role } from '../lib/types';

interface ProtectedRouteProps {
  roles?: Role[];
  children?: React.ReactNode;
}

export function ProtectedRoute({ roles, children }: ProtectedRouteProps) {
  const { isAuthenticated, loading, user, forcePasswordChange } = useAuth();
  const location = useLocation();

  if (loading) {
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

  if (roles && user && !roles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
