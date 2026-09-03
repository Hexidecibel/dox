/**
 * ModuleRoute — the per-surface gate, and the panel it renders when it says no.
 *
 * WHY A PANEL AND NOT A REDIRECT. A gated surface is reached three ways: a
 * link in the rail (which is already filtered, so this rarely fires), a
 * bookmark, and a URL somebody pasted into a chat. The last two are the whole
 * point. Bouncing them to /dashboard produces a person staring at a screen
 * they did not ask for, with no way to tell a retired feature from a
 * permission problem from a bug — and the colleague who sent the link gets
 * "it doesn't work for me" and nothing else. So the surface explains itself,
 * in place, at the URL that was opened.
 *
 * WHY IT NAMES WHICH CONJUNCT FAILED. Visibility is an AND of three
 * independent things, each fixed by a different person on a different screen:
 *
 *   1. the tenant has the module switched on   → Settings ▸ Modules, top half
 *   2. this person's department is not scoped away from it
 *                                              → Settings ▸ Modules, the grid
 *   3. this person's role is high enough        → Settings ▸ Users
 *
 * "I enabled it for QA and she still cannot see it" is the predictable
 * support question, and it has three different answers. A panel that says
 * only "no access" makes it unanswerable without a database, so each branch
 * below names its own layer and the screen that changes it.
 *
 * ROLE IS CHECKED LAST, and that ordering is deliberate: the module layers
 * are organization-wide facts, so telling somebody "your role is too low" for
 * a module their company does not even have would send them to argue with the
 * wrong person.
 */

import { Link as RouterLink, Navigate } from 'react-router-dom';
import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';
import { MODULES } from '../lib/types';
import type { ModuleKey, Role } from '../lib/types';

export interface ModuleRouteProps {
  /** The surface's module; `null` is always on and never gated. */
  module: ModuleKey | null;
  /** The surface's permission tier; undefined means every authenticated role. */
  roles?: Role[];
  children: React.ReactNode;
}

/**
 * Role keys are database values ('org_admin'); the panel is read by the
 * person who was refused, so it spells them the way the Users screen does.
 */
const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'system administrator',
  org_admin: 'administrator',
  user: 'standard user',
  reader: 'read-only',
};

function listRoles(roles: Role[]): string {
  const names = roles.map((r) => ROLE_LABELS[r]);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** One consistent frame, so the three refusals read as one feature. */
function DeniedPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ maxWidth: 620 }}>
      <Alert severity="info" variant="outlined" icon={false}>
        <AlertTitle sx={{ fontWeight: 700 }}>{title}</AlertTitle>
        <Typography variant="body2" component="div" sx={{ color: 'text.secondary' }}>
          {children}
        </Typography>
        <Button component={RouterLink} to="/dashboard" size="small" sx={{ mt: 1.5 }}>
          Back to dashboard
        </Button>
      </Alert>
    </Box>
  );
}

export function ModuleRoute({ module, roles, children }: ModuleRouteProps) {
  const { user } = useAuth();
  const { tenantEnabled, visible, functions } = useModuleAccess();

  // No session at all is not this component's question — `ProtectedRoute`
  // upstream has already sent them to /login — but a render can still land
  // here for one frame, and a panel would be the wrong thing to show.
  if (!user) return <Navigate to="/login" replace />;

  if (module !== null && !visible.includes(module)) {
    const label = MODULES[module].label;

    // Layer 1: the tenant ceiling. Nobody in the organization has this.
    if (!tenantEnabled.includes(module)) {
      return (
        <DeniedPanel title={`${label} is switched off for your organization`}>
          Nobody here has access to {label} at the moment — this is an
          organization-wide setting, not something about your account. An
          administrator can switch it back on under <strong>Settings ▸ Modules</strong>.
        </DeniedPanel>
      );
    }

    // Layer 2: the function filter. The company has it; this person's
    // department has been scoped away from it, which is a row somebody wrote.
    return (
      <DeniedPanel title={`${label} is not part of your role's access`}>
        Your organization uses {label}, but the{' '}
        {functions.length > 0 ? (
          <>
            department{functions.length > 1 ? 's' : ''} you belong to (
            <strong>{functions.join(', ')}</strong>)
          </>
        ) : (
          <>department you belong to</>
        )}{' '}
        {functions.length > 1 ? 'have' : 'has'} been scoped to a smaller set of
        screens. An administrator changes that on the function grid under{' '}
        <strong>Settings ▸ Modules</strong>.
      </DeniedPanel>
    );
  }

  // Layer 3: the permission tier — the oldest of the three, and the only one
  // that is a security boundary rather than a scope control.
  if (roles && !roles.includes(user.role)) {
    return (
      <DeniedPanel title="Your account does not have access to this page">
        This page is for {listRoles(roles)} accounts; yours is{' '}
        <strong>{ROLE_LABELS[user.role]}</strong>. An administrator can change
        your role under <strong>Settings ▸ Users</strong>.
      </DeniedPanel>
    );
  }

  return <>{children}</>;
}
