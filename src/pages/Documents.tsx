import { useCallback, useMemo, useRef, useState } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { SearchWorkspace, type SearchSelectionAction } from '../components/search/SearchWorkspace';
import { AddToOrderDialog, describePickResult } from '../components/orders/AddToOrderDialog';
import { RoleGuard } from '../components/RoleGuard';
import { useTenant } from '../contexts/TenantContext';
import { useAuth } from '../contexts/AuthContext';
import { useModuleAccess } from '../contexts/ModuleAccessContext';
import { HelpWell } from '../components/HelpWell';
import { helpContent } from '../lib/helpContent';

/**
 * Documents — the same search workspace as /search (search redesign Phase 2),
 * opened as a library: everything on file is listed until something is asked,
 * and the facet rail starts open. Typing a lot, a date, a PO or an invoice here
 * gets the same covering / likely / nothing-covers answer as /search.
 */
export function Documents() {
  const { selectedTenantId } = useTenant();
  const { user } = useAuth();
  const { isVisible } = useModuleAccess();
  const navigate = useNavigate();

  // "Add to order" (migration 0134): the selected documents go onto an open
  // order or a new one. Offered only to someone who can build an order -- not
  // a read-only account, and not where Order Fulfillment is switched off.
  const canBuildOrders = !!user && user.role !== 'reader' && isVisible('fulfillment');
  const [orderPick, setOrderPick] = useState<string[] | null>(null);
  const settle = useRef<((notice: string | null) => void) | null>(null);
  const finishPick = useCallback((notice: string | null) => {
    settle.current?.(notice);
    settle.current = null;
    setOrderPick(null);
  }, []);
  const addToOrder = useMemo<SearchSelectionAction | undefined>(
    () =>
      canBuildOrders
        ? {
            label: 'Add to order',
            testId: 'add-to-order',
            // Resolves when the dialog closes: with what happened, or null when
            // the person backed out and the selection should stay.
            onRun: (docs) =>
              new Promise<string | null>((resolve) => {
                settle.current = resolve;
                setOrderPick(docs.map((d) => d.id));
              }),
          }
        : undefined,
    [canBuildOrders],
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Documents
        </Typography>
        <RoleGuard roles={['super_admin', 'org_admin', 'user']}>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => navigate('/documents/new')}>
            Add Document
          </Button>
        </RoleGuard>
      </Box>

      <HelpWell id="documents.list" title={helpContent.documents.list?.headline ?? 'Documents'}>
        {helpContent.documents.list?.well ?? helpContent.documents.well}
      </HelpWell>

      <SearchWorkspace
        surface="documents"
        syncToUrl
        tenantId={selectedTenantId || undefined}
        enableExport={isVisible('library')}
        exportSender={user ? { name: user.name || user.email, email: user.email } : undefined}
        selectionAction={addToOrder}
      />

      <AddToOrderDialog
        open={orderPick !== null}
        tenantId={selectedTenantId || undefined}
        documentIds={orderPick ?? []}
        onClose={() => finishPick(null)}
        onAdded={({ orderNumber, response }) => finishPick(`${describePickResult(orderNumber, response)} Open Orders to review and send.`)}
      />
    </Box>
  );
}
