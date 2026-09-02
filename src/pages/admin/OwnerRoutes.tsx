/**
 * Owner Routing — Settings page around `OwnerRoutingPanel`.
 *
 * Thin on purpose: it resolves the tenant (a super_admin acts inside the tenant
 * they have selected) and explains the surface; the panel holds the behaviour
 * so it stays testable as a component.
 *
 * This is a Settings page and not a tab on anything, because an owner label is
 * a tenant-wide role — QA, Insurance, Purchasing — and belongs beside Users and
 * Assignments, which are the other two answers to "who is responsible for
 * this?".
 */

import { Box, Typography } from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import OwnerRoutingPanel from '../../components/OwnerRoutingPanel';

export function OwnerRoutes() {
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();

  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        Owner Routing
      </Typography>

      <HelpWell id="registry.owner_routes" title="Who gets told when a record comes due?">
        Documents carry an <strong>Owner</strong> — a role like QA, Accounting, Insurance or
        Purchasing. This page says who is behind each of those roles. A recipient does{' '}
        <strong>not</strong> need a portal account: a plain email address is fine, and is the
        usual answer for a broker or a site manager. Renewal alerts are never broadcast to all
        admins, so a label with nobody behind it means those records are reported as unowned and
        nobody is emailed at all.
      </HelpWell>

      <OwnerRoutingPanel tenantId={tenantId} />
    </Box>
  );
}

export default OwnerRoutes;
