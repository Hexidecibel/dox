import { useAuth } from '../contexts/AuthContext';
import type { Role } from '../lib/types';

interface RoleGuardProps {
  roles: Role[];
  children: React.ReactNode;
}

export function RoleGuard({ roles, children }: RoleGuardProps) {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) {
    return null;
  }

  return <>{children}</>;
}
